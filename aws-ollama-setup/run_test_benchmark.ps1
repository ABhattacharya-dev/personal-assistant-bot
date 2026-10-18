$endpoint = "http://13.201.33.5:8080/api/chat"

$systemPrompt = @"
You are an expense extraction assistant.
If the user's message is an expense (in English, Hinglish, or Bengali), extract it and return ONLY a valid JSON object with keys:
"item": string (name of item or service),
"amount": number (numerical value of expense),
"currency": string (e.g. "INR").
If it is a reminder or not an expense, return:
"type": "reminder" or "other",
"details": string.
Do NOT include markdown formatting, backticks, or any explanation. Output raw JSON only.
"@

$testCases = @(
    "rickshaw 10",
    "auto 40 diye diyechi",
    "kal subah 9 baje yaad dilana",
    "chai aur biscuit 25 rupaye",
    "bajaar theke mach 250 taka kinlam",
    "dinner at restaurant 850 rs",
    "call mom at 5pm",
    "petrol 500",
    "dokan theke dim 60 taka dilam",
    "bought groceries for 1200"
)

Write-Host "Running 10 test messages on Qwen 2.5 (3B)..." -ForegroundColor Cyan
$results = @()
$validJsonCount = 0
$totalLatency = 0

foreach ($msg in $testCases) {
    $payload = @{
        model = "qwen2.5:3b"
        messages = @(
            @{ role = "system"; content = $systemPrompt },
            @{ role = "user"; content = $msg }
        )
        stream = $false
    } | ConvertTo-Json -Depth 5

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $resp = Invoke-RestMethod -Uri $endpoint -Method POST -Body $payload -ContentType "application/json" -TimeoutSec 60
        $sw.Stop()
        $latency = [math]::Round($sw.Elapsed.TotalSeconds, 2)
        $totalLatency += $latency

        $content = $resp.choices[0].message.content.Trim()
        # Clean markdown code block fences if any
        $cleaned = $content -replace '^```json\s*', '' -replace '^```\s*', '' -replace '\s*```$', ''
        
        $isValid = $false
        try {
            $parsed = $cleaned | ConvertFrom-Json
            if ($parsed) {
                $isValid = $true
                $validJsonCount++
            }
        } catch {}

        # Rough token estimate
        $estTokens = [math]::Max(1, [int]($content.Length / 4))
        $tps = if ($latency -gt 0) { [math]::Round($estTokens / $latency, 1) } else { 0 }

        $results += [PSCustomObject]@{
            Message = $msg
            LatencySec = $latency
            ValidJSON = $isValid
            Output = ($content -replace "`r?`n", " ")
        }
    } catch {
        $sw.Stop()
        $results += [PSCustomObject]@{
            Message = $msg
            LatencySec = [math]::Round($sw.Elapsed.TotalSeconds, 2)
            ValidJSON = $false
            Output = "ERROR: $_"
        }
    }
}

$results | Format-Table -AutoSize
Write-Host ""
Write-Host "================ SUMMARY ================" -ForegroundColor Green
Write-Host "Total Messages Tested : $($testCases.Count)"
Write-Host "Valid JSON Responses  : $validJsonCount / $($testCases.Count) ($([math]::Round(100 * $validJsonCount / $testCases.Count, 1))%)"
Write-Host "Average Latency       : $([math]::Round($totalLatency / $testCases.Count, 2)) seconds"
Write-Host "=========================================" -ForegroundColor Green
