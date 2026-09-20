$ErrorActionPreference = "SilentlyContinue"
$workers = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'ask_ai_worker' } |
    Sort-Object CreationDate
foreach ($w in $workers) {
    Write-Output ("PID={0} CREATED={1}" -f $w.ProcessId, $w.CreationDate)
}
if ($workers.Count -gt 1) {
    $old = $workers | Select-Object -First ($workers.Count - 1)
    foreach ($w in $old) {
        Stop-Process -Id $w.ProcessId -Force
        Write-Output ("killed-old " + $w.ProcessId)
    }
}
