$ErrorActionPreference='Stop'
$name='MR Enterprises Wholesale LAN'
$existing=Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if($existing){Remove-NetFirewallRule -DisplayName $name}
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4318 -Profile Private -RemoteAddress LocalSubnet | Out-Null
Write-Host 'Wholesale checklist is open only to devices on the local private network.'
Read-Host 'Press Enter to close'
