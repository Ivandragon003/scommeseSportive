param([switch]$PrepareOnly, [switch]$BuildOnly)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$gitRoot = (& git -C $repo rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0 -or (Resolve-Path $gitRoot).Path -ne $repo) { throw 'Repository root mismatch.' }
$head = (& git -C $repo rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve HEAD.' }

# Copy only source and test inputs. Never mount the checkout into a container.
$paths = @(& git -C $repo -c core.quotepath=false ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate source files.' }
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('model-a-linux-' + [Guid]::NewGuid().ToString('N'))
$context = Join-Path $scratch 'context'
$snapshot = Join-Path $context 'snapshot'
New-Item -ItemType Directory -Path $snapshot -Force | Out-Null
try {
  $records = [Collections.Generic.List[string]]::new()
  foreach ($relative in ($paths | Sort-Object -Unique)) {
    if (-not $relative -or $relative -match '(^|/)(\.git|\.ssh|node_modules|dist|artifacts|__pycache__)(/|$)|^(backend/)?data/' -or
        $relative -match '(^|/)(\.npmrc$|\.netrc$|credentials($|\.))|\.(db|sqlite|sqlite3|pem|key|p12|pfx|jks|keystore)(-|$)|\.log$') { continue }
    if ($relative -match '(^|/)\.env($|\.)' -and $relative -notmatch '(^|/)\.env(?:\.[^/]+)?\.example$|(^|/)\.env\.example$') { continue }
    $source = Join-Path $repo $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
    $item = Get-Item -LiteralPath $source -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing link: $relative" }
    $destination = Join-Path $snapshot $relative
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
    if ($relative -match '(^|/)\.env(?:\.[^/]+)?\.example$') {
      if (-not (Get-Command gitleaks -ErrorAction SilentlyContinue)) { throw 'Gitleaks is required to scan environment examples.' }
      & gitleaks dir --no-banner --redact=100 --log-level error -- $destination 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Environment example failed the secret scan: $relative" }
    }
    $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    $records.Add("$hash  $relative")
  }
  if (-not (Test-Path (Join-Path $snapshot 'backend/package-lock.json'))) { throw 'Missing backend lockfile.' }
  $manifest = Join-Path $scratch 'snapshot.sha256'
  [IO.File]::WriteAllLines($manifest, $records, [Text.UTF8Encoding]::new($false))
  Write-Host "HEAD: $head"
  Write-Host "Snapshot files: $($records.Count); manifest SHA256: $((Get-FileHash $manifest -Algorithm SHA256).Hash.ToLowerInvariant())"
  if ($PrepareOnly) { Write-Host 'Snapshot preparation checked; no Docker build or tests run.'; return }

  # Only dependency installation has network access. The test container has none.
  $dockerfile = @'
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
RUN apt-get update && apt-get install -y --no-install-recommends python3 && ln -s /usr/bin/python3 /usr/local/bin/python && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /verify-data && chown node:node /verify-data
WORKDIR /work/backend
COPY snapshot/backend/package.json snapshot/backend/package-lock.json ./
RUN npm ci
COPY snapshot /work/
CMD ["npm", "test", "--", "--test-concurrency=2"]
'@
  [IO.File]::WriteAllText((Join-Path $context 'Dockerfile'), $dockerfile, [Text.UTF8Encoding]::new($false))
  $iidFile = Join-Path $scratch 'image-id'
  & docker build --pull=false --iidfile $iidFile $context
  if ($LASTEXITCODE -ne 0) { throw "Docker build failed: $LASTEXITCODE" }
  $image = (Get-Content -LiteralPath $iidFile -Raw).Trim()
  if ($image -notmatch '^sha256:[0-9a-f]{64}$') { throw 'Unexpected image ID.' }
  if ($BuildOnly) { Write-Host "Dependency image built: $image; no tests run."; return }
  $volume = 'model-a-verification-' + [Guid]::NewGuid().ToString('N')
  if ($volume -notmatch '^model-a-verification-[0-9a-f]{32}$') { throw 'Unexpected verification volume name.' }
  try {
    & docker volume create $volume
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create verification volume.' }
    $write = 'const fs=require("fs");const p="/verify-data/event";const f=fs.openSync(p,"wx");fs.writeFileSync(f,"model-a-volume-test\n");fs.fsyncSync(f);fs.closeSync(f);fs.linkSync(p,p+".link");const d=fs.openSync("/verify-data","r");fs.fsyncSync(d);fs.closeSync(d)'
    $read = 'const fs=require("fs"),crypto=require("crypto");const p="/verify-data/event";const a=fs.readFileSync(p),b=fs.readFileSync(p+".link");if(a.toString()!=="model-a-volume-test\n"||!a.equals(b))process.exit(1);console.log("Volume SHA256: "+crypto.createHash("sha256").update(b).digest("hex"))'
    & docker run --rm --network none --read-only --user node --cap-drop ALL --security-opt no-new-privileges --mount "type=volume,src=$volume,dst=/verify-data" --entrypoint node $image -e $write
    if ($LASTEXITCODE -ne 0) { throw 'Volume write, fsync or hardlink test failed.' }
    & docker run --rm --network none --read-only --user node --cap-drop ALL --security-opt no-new-privileges --mount "type=volume,src=$volume,dst=/verify-data" --entrypoint node $image -e $read
    if ($LASTEXITCODE -ne 0) { throw 'Volume persistence test failed.' }
    Write-Host 'Verification volume survived container replacement; this does not test power loss or hosting.'
  } finally {
    & docker volume rm $volume
    if ($LASTEXITCODE -ne 0) { throw "Could not remove test volume $volume" }
  }
  Write-Host "Running isolated test image $image with no network or host mounts."
  & docker run --rm --network none --cpus 2 --memory 2g --cap-drop ALL --security-opt no-new-privileges $image
  $testExit = $LASTEXITCODE
  if ($testExit -ne 0) { throw "Linux backend suite failed: $testExit" }
  Write-Host 'Linux backend suite passed. Check output for skipped tests.'
} finally {
  # This is a unique directory created above, not a path derived from repository input.
  if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
