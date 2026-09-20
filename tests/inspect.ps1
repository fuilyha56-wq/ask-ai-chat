$ErrorActionPreference = "SilentlyContinue"
Write-Output "== workers =="
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ask_ai_worker' } | ForEach-Object {
    Write-Output ("PID={0} PARENT={1} CREATED={2}" -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate)
}
Write-Output "== python main.py tree =="
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'main\.py' } | ForEach-Object {
    Write-Output ("PID={0} PARENT={1} CMD={2}" -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine.Substring(0, [Math]::Min(120, $_.CommandLine.Length)))
}
Write-Output "== parents of workers =="
$ws = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ask_ai_worker' }
foreach ($w in $ws) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($w.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($p) { Write-Output ("worker {0} <- parent {1} ({2})" -f $w.ProcessId, $p.ProcessId, $p.Name) }
    else { Write-Output ("worker {0} <- parent {1} (GONE)" -f $w.ProcessId, $w.ParentProcessId) }
}
