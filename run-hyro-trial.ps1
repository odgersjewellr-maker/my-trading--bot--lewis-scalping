# HyroTrader trial runner — invoked every 15 minutes by the scheduled task
# "NKB-HyroTrader-Trial". Credentials from hyrotrader\.env, run config from
# hyro-trial.env (later file wins on conflicts; dotenv never overrides either).
Set-Location "C:\Users\odger\claude-tradingview-mcp-trading"
$log = "hyro-trial.log"
"`n===== $(Get-Date -Format u) =====" | Out-File -Append -Encoding utf8 $log
& node --env-file=hyrotrader/.env --env-file=hyro-trial.env bot.js 2>&1 |
  Out-File -Append -Encoding utf8 $log
"exit $LASTEXITCODE" | Out-File -Append -Encoding utf8 $log
