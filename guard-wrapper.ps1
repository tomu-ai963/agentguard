# guard-wrapper.ps1
# Usage:
#   $env:AGENTGUARD_AGENT_TOKEN = "<AGENT_TOKEN>"   # or set machine-wide
#   . .\guard-wrapper.ps1
#   Invoke-Guarded "wrangler deploy"

$GUARD_URL       = "https://agentguard.inverted-triangle-leef.workers.dev"
$AGENT_ID        = "claude-code-local"
$AGENT_TOKEN     = $env:AGENTGUARD_AGENT_TOKEN
$POLL_INTERVAL   = 5    # seconds
$POLL_TIMEOUT    = 300  # seconds — long enough for a human to notice the ping

if (-not $AGENT_TOKEN) {
    Write-Warning "[AgentGuard] AGENTGUARD_AGENT_TOKEN is not set — guarded commands will be BLOCKED (the guard now requires auth)."
}

function Get-GuardHeaders {
    if ($AGENT_TOKEN) { return @{ Authorization = "Bearer $AGENT_TOKEN" } }
    return @{}
}

# Commands that must pass through AgentGuard (regex → tool name)
# rm pattern: any rm whose options include r/R catches -rf, -fr, -r -f,
# --recursive (over-matching pauses are acceptable; missing one is not).
$GUARDED_COMMANDS = [ordered]@{
    'wrangler(\.cmd|\.exe)?\s+deploy'  = 'wrangler_deploy'
    'npm\s+publish'                    = 'npm_publish'
    'git\s+push'                       = 'git_push'
    'rm\s+(.*\s)?-{1,2}[^\s-]*[rR]'    = 'rm_rf'
    'Remove-Item\b.*-Recurse'          = 'remove_item_recurse'
}

function Get-GuardedTool {
    param([string]$Cmd)
    foreach ($pattern in $GUARDED_COMMANDS.Keys) {
        if ($Cmd -match $pattern) { return $GUARDED_COMMANDS[$pattern] }
    }
    return $null
}

function Invoke-GuardCheck {
    param([string]$ToolName, [string]$Cmd)

    $body = @{
        agentId = $AGENT_ID
        action  = $ToolName
        tool    = $ToolName
        params  = @{ cmd = $Cmd }
        metrics = @{}
    } | ConvertTo-Json -Compress

    try {
        return Invoke-RestMethod -Uri "$GUARD_URL/check" `
            -Method POST `
            -ContentType "application/json" `
            -Headers (Get-GuardHeaders) `
            -Body $body `
            -ErrorAction Stop
    } catch {
        Write-Warning "[AgentGuard] /check failed: $($_.Exception.Message)"
        return $null
    }
}

function Wait-Approval {
    param([string]$ApprovalId)

    $elapsed = 0
    while ($elapsed -lt $POLL_TIMEOUT) {
        Start-Sleep -Seconds $POLL_INTERVAL
        $elapsed += $POLL_INTERVAL
        try {
            $rec = Invoke-RestMethod -Uri "$GUARD_URL/approval/$ApprovalId" `
                -Method GET -Headers (Get-GuardHeaders) -ErrorAction Stop
            if ($rec.status -in @("approved", "denied")) { return $rec.status }
        } catch {
            # 404 = the approval expired server-side (1h TTL): stop polling.
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) {
                return "expired"
            }
            Write-Warning "[AgentGuard] Polling error: $($_.Exception.Message)"
        }
        Write-Host "[AgentGuard] Still waiting... ($elapsed / $POLL_TIMEOUT s)"
    }
    return "timeout"
}

function Invoke-Guarded {
    param([Parameter(Mandatory)][string]$Command)

    $toolName = Get-GuardedTool $Command
    if (-not $toolName) {
        # Not a guarded command — run directly
        Invoke-Expression $Command
        return
    }

    Write-Host ""
    Write-Host "[AgentGuard] Intercepted : $Command"
    Write-Host "[AgentGuard] Tool        : $toolName"
    Write-Host "[AgentGuard] Checking with AgentGuard..."

    $result = Invoke-GuardCheck -ToolName $toolName -Cmd $Command
    if (-not $result) {
        Write-Warning "[AgentGuard] Guard unreachable — command BLOCKED for safety."
        return
    }

    $verdict = $result.verdict
    $reason  = $result.reason

    Write-Host "[AgentGuard] Verdict     : $verdict"
    Write-Host "[AgentGuard] Reason      : $reason"
    Write-Host ""

    switch ($verdict) {
        "allow" {
            Write-Host "[AgentGuard] ✓ Allowed — executing."
            Invoke-Expression $Command
        }

        "throttle" {
            $waitSec = [math]::Ceiling(($result.waitMs ?? 3000) / 1000)
            Write-Host "[AgentGuard] ⏳ Throttled — waiting ${waitSec}s..."
            for ($i = $waitSec; $i -gt 0; $i--) {
                Write-Host "[AgentGuard]   resuming in ${i}s..." -NoNewline
                Write-Host "`r" -NoNewline
                Start-Sleep -Seconds 1
            }
            Write-Host "[AgentGuard] ✓ Resuming — executing."
            Invoke-Expression $Command
        }

        "pause" {
            $approvalId = $result.approvalId
            Write-Host "[AgentGuard] ⏸  PAUSED — human approval required."
            Write-Host "[AgentGuard] Approval ID : $approvalId"
            Write-Host "[AgentGuard] Resolve via :"
            Write-Host "   curl -s $GUARD_URL/approval/$approvalId ``"
            Write-Host "     -X POST -H 'Content-Type: application/json' ``"
            Write-Host "     -H 'Authorization: Bearer <ADMIN_TOKEN>' ``"
            Write-Host "     -d '{""status"":""approved""}'"
            Write-Host ""
            Write-Host "[AgentGuard] Polling every ${POLL_INTERVAL}s (timeout ${POLL_TIMEOUT}s)..."

            $decision = Wait-Approval -ApprovalId $approvalId

            switch ($decision) {
                "approved" {
                    Write-Host "[AgentGuard] ✓ Approved — executing."
                    Invoke-Expression $Command
                }
                "denied" {
                    Write-Host "[AgentGuard] ✗ Denied — command aborted."
                }
                "timeout" {
                    Write-Host "[AgentGuard] ✗ Approval timeout (${POLL_TIMEOUT}s) — command aborted."
                }
                "expired" {
                    Write-Host "[AgentGuard] ✗ Approval expired server-side — command aborted."
                }
            }
        }

        "stop" {
            Write-Host "[AgentGuard] ✗ BLOCKED"
            Write-Host "[AgentGuard] $reason"
        }

        default {
            Write-Warning "[AgentGuard] Unknown verdict '$verdict' — blocking for safety."
        }
    }
}
