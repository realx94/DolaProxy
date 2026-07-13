param(
    [int]$DebugPort = 9229,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$exe = Join-Path $env:LOCALAPPDATA 'Cici\Application\app\Cici.exe'

if (-not (Test-Path -LiteralPath $exe)) {
    throw "Dola executable was not found at: $exe"
}

$debugProcess = Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq 'Cici.exe' -and $_.CommandLine -match "remote-debugging-port=$DebugPort" } |
    Select-Object -First 1

if ($debugProcess -and -not $Restart) {
    Write-Host "Dola DevTools is already available at http://127.0.0.1:$DebugPort"
    exit 0
}

$running = Get-Process Cici -ErrorAction SilentlyContinue
if ($running) {
    if (-not $Restart) {
        throw 'Dola is running without DevTools. Restart it with: npm run dola'
    }
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

Start-Process -FilePath $exe -ArgumentList @(
    "--remote-debugging-port=$DebugPort",
    '--remote-allow-origins=*',
    '--registry-web-browser'
) -WindowStyle Normal

$deadline = (Get-Date).AddSeconds(20)
do {
    Start-Sleep -Milliseconds 500
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$DebugPort/json/version" -TimeoutSec 2
        Write-Host "Dola is ready at http://127.0.0.1:$DebugPort"
        exit 0
    } catch {
        if ((Get-Date) -ge $deadline) { throw }
    }
} while ($true)
