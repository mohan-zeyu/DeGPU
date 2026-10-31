param([Parameter(Mandatory=$true)][string]$Network)
$ErrorActionPreference = 'Stop'
$uri = $Network.TrimEnd('/') + '/network.json'
try { $info = Invoke-RestMethod -Uri $uri -TimeoutSec 10 }
catch { throw "Cannot reach $uri. Check Host terminal, LAN IPv4, port 8600 and firewall. $($_.Exception.Message)" }
if (-not $info.registry -or -not $info.chain_id) { throw 'Response is not a DeGPU network.' }
[PSCustomObject]@{ Network=$Network; ChainId=$info.chain_id; Registry=$info.registry; FaucetETH=([decimal]$info.faucet_wei / 1000000000000000000) } | Format-List
Write-Host 'Connection OK. Compare both URL and Registry across participants.'
