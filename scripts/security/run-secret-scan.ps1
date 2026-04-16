param(
  [ValidateSet('git', 'dir')]
  [string]$Mode = 'git',
  [string]$ReportPath = 'gitleaks-report.sarif'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$repoRootPath = $repoRoot.Path
$configPath = Join-Path $repoRootPath '.gitleaks.toml'
$resolvedReportPath = if ([System.IO.Path]::IsPathRooted($ReportPath)) {
  $ReportPath
} else {
  Join-Path $repoRootPath $ReportPath
}

$reportDir = Split-Path -Parent $resolvedReportPath
if ($reportDir) {
  New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
}

$gitleaksArgs = @(
  $Mode,
  $repoRootPath,
  '--config', $configPath,
  '--redact',
  '--report-format', 'sarif',
  '--report-path', $resolvedReportPath
)

if ($Mode -eq 'git') {
  $gitleaksArgs += '--log-opts=--all'
}

function Convert-ToDockerPath([string]$Path, [string]$RootPath) {
  return ($Path -replace '\\', '/').Replace(($RootPath -replace '\\', '/'), '/repo')
}

Push-Location $repoRootPath
try {
  $gitleaks = Get-Command gitleaks -ErrorAction SilentlyContinue
  if ($gitleaks) {
    & $gitleaks.Source @gitleaksArgs
    exit $LASTEXITCODE
  }

  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if ($docker) {
    $reportForDocker = Convert-ToDockerPath -Path $resolvedReportPath -RootPath $repoRootPath
    $configForDocker = Convert-ToDockerPath -Path $configPath -RootPath $repoRootPath
    $dockerArgs = @(
      'run', '--rm',
      '-v', "${repoRootPath}:/repo",
      'zricethezav/gitleaks:latest'
    )

    if ($Mode -eq 'git') {
      $dockerArgs += @(
        'git', '/repo',
        '--log-opts=--all',
        '--config', $configForDocker,
        '--redact',
        '--report-format', 'sarif',
        '--report-path', $reportForDocker
      )
    } else {
      $dockerArgs += @(
        'dir', '/repo',
        '--config', $configForDocker,
        '--redact',
        '--report-format', 'sarif',
        '--report-path', $reportForDocker
      )
    }

    & $docker.Source @dockerArgs
    exit $LASTEXITCODE
  }

  throw "Gitleaks non trovato. Installa 'gitleaks' oppure usa Docker per eseguire lo scan."
}
finally {
  Pop-Location
}
