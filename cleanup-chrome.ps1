# Kill all Edge processes and any Chrome on port 5192, keeping only default Chrome
Get-Process -Name msedge -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Edge processes killed"
# Check what's on 5192
$on5192 = Get-NetTCPConnection -LocalPort 5192 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' }
if ($on5192) {
  Write-Host "Port 5192 has listener: PID $($on5192.OwningProcess)"
} else {
  Write-Host "Port 5192 is free"
}
