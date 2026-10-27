param([int]$BackendPort = 3101, [int]$FrontendPort = 3100)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$testDirectory = Join-Path $projectRoot '.cache/hostless-compose'
New-Item -ItemType Directory -Path $testDirectory -Force | Out-Null
$overridePath = Join-Path $testDirectory 'override.yml'
$emptyEnvironment = Join-Path $testDirectory 'empty.env'
Set-Content -LiteralPath $emptyEnvironment -Value '# Synthetic test: do not load real .env' -Encoding utf8
$hash = & node -e "require('./backend/dist/security/SharedAdminAuth').createPasswordHash('synthetic-compose-only').then(console.log)"
if ($LASTEXITCODE -ne 0) { throw 'Build backend before running this test.' }
$template = @'
services:
  backend:
    image: footpredictor-hostless-compose:local
    env_file: !reset []
    environment:
      TURSO_DATABASE_URL: file:/app/data/synthetic-hostless-compose.db
      TURSO_AUTH_TOKEN: synthetic-local-token
      SHARED_ADMIN_PASSWORD_HASH: __HASH__
      ODDS_API_KEY: ""
      ODDS_API_T15_KEY: ""
      THE_ODDS_API_KEY: ""
      API_FOOTBALL_KEY: ""
      RESEARCH_T15_SCHEDULER_ENABLED: "false"
      AUTO_BET_ENABLED: "false"
      PLAYER_DATA_ENABLED: "false"
      PLAYER_AVAILABILITY_ENABLED: "false"
      LINEUP_REFRESH_SCHEDULER_ENABLED: "false"
    ports: !override
      - "127.0.0.1:__BACKEND__:3001"
  frontend:
    image: footpredictor-hostless-frontend:local
    ports: !override
      - "127.0.0.1:__FRONTEND__:80"
'@
$template = $template.Replace('__HASH__', $hash.Trim().Replace('$', '$$')).Replace('__BACKEND__', [string]$BackendPort).Replace('__FRONTEND__', [string]$FrontendPort)
Set-Content -LiteralPath $overridePath -Value $template -Encoding utf8
$composeArguments = @('compose', '--project-name', 'footpredictor-hostless-acceptance', '--env-file', $emptyEnvironment,
    '-f', (Join-Path $projectRoot 'docker-compose.yml'), '-f', $overridePath)
Push-Location $projectRoot
try {
    & docker @composeArguments config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Compose validation failed (requires Compose supporting !reset and !override).' }
    & docker @composeArguments up -d --build --wait backend frontend
    if ($LASTEXITCODE -ne 0) { throw 'Compose startup failed.' }
    $health = Invoke-WebRequest -Uri "http://localhost:$BackendPort/api/health" -UseBasicParsing
    $frontend = Invoke-WebRequest -Uri "http://localhost:$FrontendPort/" -UseBasicParsing
    $proxy = Invoke-WebRequest -Uri "http://localhost:$FrontendPort/api/health" -UseBasicParsing
    $login = Invoke-WebRequest -Uri "http://localhost:$BackendPort/api/auth/login" -Method Post -ContentType 'application/json' -Headers @{ Origin = 'http://localhost:3000' } -Body '{"password":"synthetic-compose-only"}' -UseBasicParsing
    if ($health.StatusCode -ne 200 -or $frontend.StatusCode -ne 200 -or $proxy.StatusCode -ne 200 -or $login.StatusCode -ne 200) { throw 'HTTP smoke failed.' }
    Write-Output "PASS: production backend, frontend and API proxy; synthetic local database; ports $BackendPort/$FrontendPort."
    & docker @composeArguments ps
} finally { Pop-Location }
