# AgentGuard CHANGES

## [Unreleased] - 2026-06-12

セキュリティレビューに基づく v0.2.0 ハードニング。**デプロイ前に新secret `AGENT_TOKEN` の設定が必須**（下記「動作確認方法」参照）。

### Critical（緊急修正）

- **全エンドポイントを認証必須化**（`src/index.js`, `src/auth.js` 新規）
  - 旧: `/check` `/heartbeat` `/log` `GET /state` `GET /approval` `GET /rules` が無認証で、誰でもなりすまし・状態改ざん・監査ログ汚染が可能だった。
  - 新: `GET /`（ヘルスチェック）以外はすべて `Authorization: Bearer <token>` 必須。エージェント用 `AGENT_TOKEN` と管理用 `ADMIN_TOKEN` の2層。secret未設定時は503でフェイルクローズ。
- **`/heartbeat` の state 汚染を遮断**（`src/index.js`, `src/validate.js` 新規）
  - 旧: `metrics` がそのまま state にスプレッドされ、`lastHeartbeat` や `status` を外部から上書きして heartbeat-lost ルールを無効化できた。
  - 新: `sanitizeMetrics()` で数値メトリクス5種（loopCount / tokensUsed / costUSD / apiCallsPerMin / tokenBurnRate）のみ受理。有限・非負・上限チェック付き。`lastHeartbeat` はサーバー側でのみ設定。
- **自己申告メトリクスによるコストガードバイパスを修正**
  - 旧: `/check` でクライアント送信値が保存値より優先され、暴走エージェント自身が `costUSD: 0` を送ればコストキャップを回避できた。
  - 新: `costUSD` / `tokensUsed` は `max(申告値, 保存値)` の単調増加。リセットは admin 専用の新エンドポイント `POST /reset/:id` のみ。
- **`/log` 経由の監査ログ注入（detchi 連鎖汚染）対策**
  - 旧: 認証なし・フィールド無制限・サイズ無制限で、指示文風テキストを注入可能。注入ログが detchi → pgvector → 検索結果経由で Claude Code への間接プロンプトインジェクションになる連鎖リスクがあった。
  - 新: AGENT_TOKEN 必須 + フィールドホワイトリスト（action/tool/verdict/reason/ruleId/message/level）+ 各2048字キャップ + 由来タグ `source: "agent" | "guard" | "admin"` を全エントリに付与。**detchi 側はベクトル化時に `source` で重み付け・フィルタすること**（agent 由来は信頼度を下げる）。

### High（重要修正）

- **トークン比較の定常時間化 + ブルートフォース対策**（`src/auth.js`）
  - SHA-256 ハッシュ後にXOR比較（タイミング攻撃耐性）。認証失敗 10回/10分（IP単位、KVカウンタ）で 429 ロックアウト。
- **`POST /rules` のスキーマ検証**（`src/validate.js`）
  - verdict 列挙チェック、rule id 形式・重複、waitMs 範囲、条件ネスト深さ ≤10、`matches` の regex は200字以内かつコンパイル検査、`in` は配列50要素以内。不正ルールでエンジンが壊れる/ReDoS する経路を遮断。
- **ReDoS 緩和**（`src/engine.js`）: `paramsText` を10,000字でキャップ。万一の重い regex は Workers の CPU 制限で 500 → wrapper がフェイルクローズでブロック。
- **エラーメッセージの内部情報漏洩を修正**（`src/index.js`）: 500 応答は固定文言 `"internal error"` に。詳細は Worker ログのみ。
- **監査ログのキー衝突を修正**（`src/store.js`): 同一ミリ秒の2エントリが上書きされていた。キーにランダムサフィックスを追加。
- **リクエストボディ 64KB 上限**: KV ストレージ枯渇・書き込みコスト DoS の緩和。
- **wrapper の検知漏れ修正**（`guard-wrapper.ps1`）
  - `rm -fr` / `rm -r -f` / `rm --recursive` が旧 regex `rm\s+.*-[rR][fF]` を素通りしていた → `rm\s+(.*\s)?-{1,2}[^\s-]*[rR]` に修正（実パターン8種で検証済み）。`wrangler.cmd deploy` / `wrangler.exe deploy` も検知対象に追加。
  - `AGENTGUARD_AGENT_TOKEN` 環境変数からトークンを送信。未設定時は警告（ガードは認証必須化によりブロックされる＝フェイルクローズ）。
- **承認タイムアウトの明確化**（懸念#6）
  - wrapper のポーリングタイムアウトを 60秒 → **300秒** に延長（人間の応答猶予）。タイムアウト・サーバー側TTL失効（404 → `expired`）・拒否のいずれも**コマンド中止（デフォルト拒否）**で統一。
  - 解決済み承認の再解決（approved→denied の覆し）を禁止（first-decision-wins、409 応答）。

### Medium（改善）

- **通知のサイレント失敗を解消**（懸念#8、`src/notifier/*`）
  - Webhook URL 未設定時は throw して配信失敗として計上（旧: console.error して正常終了扱い）。
  - `notify()` が `{ok, failed}` を返し、pause/stop 通知の配信失敗は監査ログに `notify_failed` として記録。
  - slack アダプタを `ADAPTERS` に正式登録。チャンネルは `NOTIFY_CHANNELS` var（カンマ区切り、デフォルト `discord`）で選択。
- **Discord embed の文字数制限対応**: title 256 / description 4096 / field value 1024 / fields 25 でクリップ。長い値で通知自体が 400 で消失する問題を修正。
- **エンジンのプロトタイプ汚染読み取り防止**（`src/engine.js`）: `key in facts` → `Object.hasOwn(facts, key)`。`constructor` 等の継承キーが評価対象になる経路を遮断。
- **ルール競合の挙動改善**（懸念#9）: verdict 優先順位（stop > pause > throttle > allow）は従来どおり。同ランク throttle が複数マッチした場合は最長の `waitMs` を採用（旧: 先勝ち）。`api-burst` + `cost-cap` 同時発火は cost-cap (stop/pause) が必ず勝つ — 仕様どおり。
- **agentId / approvalId の形式検証**: agentId は `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`（コロン不可 = KVキー区切り文字の注入防止）、approvalId は UUID 形式のみ受理。
- `package.json` の wrangler を `^4.0.0` に更新（v4 コマンド構文 `wrangler kv namespace create` 前提）。
- 管理操作（killswitch / rules更新 / 承認解決 / カウンタリセット）をすべて監査ログに記録（`source: "admin"`）。

### レビュー結果：問題なしと確認した項目

- **Discord Webhook 漏洩**（懸念#3）: `.dev.vars` は gitignore 済み・全コミット履歴に webhook URL なし・`.wrangler/` も ignore 済み。漏洩なし。
- wrapper のガード到達不能時ブロック（フェイルクローズ）、admin token 未設定時の 401（フェイルクローズ）は v0 から正しく実装済み。

### stop hook ループの根本原因と再発防止設計（懸念#1）

現在このリポジトリにも `~/.claude/settings.json` にも hook は未設定（コード修正対象なし）。原因分析：

1. **`stop_hook_active` 未チェック**: Claude Code は Stop hook の入力 JSON に `stop_hook_active: true` を渡す（既に hook が停止をブロックして継続させた場合）。これを見ずに毎回ブロックすると、完了条件が満たされない限り（＝ファイル名誤指定で永遠に未完了）無限ループする。
2. **hook の reason テキストの誤解釈**（仮説どおり）: ブロック時の reason は transcript に入り、次ターンの Claude への入力になる。「Please type /goal clear...」のような**人間向け操作案内**を書くと、モデルがそれを自分への指示と解釈して `/goal clear` を実行しようとし、失敗 → 再 stop → 再ブロックの増幅ループになる。

再発しない hook の設計原則：
- hook 冒頭で `stop_hook_active == true` なら無条件で停止を許可して exit 0
- ループカウンタファイルで最大3回ブロックしたら強制許可（セーフティネット）
- 完了条件ファイルは絶対パスで指定し、**存在チェック失敗時は停止許可側に倒す**（stop ブロックは利便機構であり安全機構ではないため fail-open が正しい）
- reason には「モデルへの作業指示」のみ書く。人間向けのコマンド案内・UI操作説明は絶対に書かない

### 未実装（次のタスク）

- **v1: Discord 承認ボタン**（設計概要）
  - 標準 incoming webhook はボタン（components）を送れないため、**Discord Application（bot）が必要**。承認通知は bot トークンで `POST /channels/:id/messages` に components 付きで送信（`custom_id: "approve:<rid>"` / `"deny:<rid>"`）。
  - Worker に `POST /discord/interactions` を追加し、Developer Portal の Interactions Endpoint URL に設定。**Ed25519 署名検証**（`X-Signature-Ed25519` + `X-Signature-Timestamp` を `DISCORD_PUBLIC_KEY` で `crypto.subtle.verify("Ed25519", ...)` — Workers ネイティブ対応）が必須。署名検証が admin token の代替認証になる。
  - フロー: pause → `createApproval` → bot がボタン付きメッセージ送信 → 押下 → Discord が interactions endpoint に POST → 署名検証 → 押下ユーザー ID を `ADMIN_DISCORD_IDS`（カンマ区切り secret）と照合 → `resolveApproval` → type 7 応答でメッセージを「✅ approved by @user」に更新 → wrapper のポーリングが approved を検出して再開。
  - 必要 secret: `DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY` / `DISCORD_CHANNEL_ID` / `ADMIN_DISCORD_IDS`。
- 承認フローの KV → **Durable Objects** 移行（KV の結果整合性による承認反映遅延の解消、原子的な first-decision-wins）。
- 監査ログの **R2 / Workers Analytics Engine** への移行（KV の list 非効率・件数増加対策。現状は 30日 TTL で自然消滅、懸念#7 の恒久対応）。
- エージェントごとの個別トークン（現状は全エージェント共有の `AGENT_TOKEN`。1台の漏洩が全体に波及する）。
- detchi 側での `source` タグによるベクトル化重み付け・`agent` 由来エントリのプロンプト隔離（インジェクション防御の最終層）。
- stop hook 導入時は上記「再発しない hook の設計原則」に従った実装。

### 動作確認方法

```powershell
# 1) ユニットテスト（ネットワーク・KV 不要、26件）
node test-engine.mjs

# 2) ローカル secrets — .dev.vars に追記（gitignore 済み）
#    ADMIN_TOKEN=...
#    AGENT_TOKEN=...      ← 新規。openssl rand -hex 32 等で生成
#    DISCORD_WEBHOOK_URL=...

# 3) ローカル起動
npm run dev   # wrangler dev → http://localhost:8787

# 4) 認証が効いていることを確認（401 が返れば OK）
curl -s -X POST http://localhost:8787/check -H "Content-Type: application/json" -d '{"agentId":"t1"}'

# 5) AGENT_TOKEN で /check が通ることを確認
curl -s -X POST http://localhost:8787/check `
  -H "Authorization: Bearer <AGENT_TOKEN>" -H "Content-Type: application/json" `
  -d '{"agentId":"t1","action":"deploy","tool":"wrangler_deploy","params":{}}'
#    → verdict: "pause" + approvalId が返る

# 6) コスト単調性の確認: costUSD 3.0 で /check → pause、その後 costUSD 0 を送っても pause のまま
#    リセットは admin で: curl -X POST .../reset/t1 -H "Authorization: Bearer <ADMIN_TOKEN>"

# 7) デプロイ前（本番）— 自分で実行する:
#    npx wrangler secret put AGENT_TOKEN
#    npx wrangler deploy
#    wrapper 利用側: $env:AGENTGUARD_AGENT_TOKEN を設定
```
