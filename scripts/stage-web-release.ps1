param([string]$ReleaseName = ('release-' + [guid]::NewGuid().ToString('N')), [int]$ThroughMigration = 9999)
$ErrorActionPreference = 'Stop'
if ($ReleaseName -notmatch '^[A-Za-z0-9_-]+$') { throw 'Use a simple release name.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $projectRoot 'apps/web/dist'
$serverSource = Join-Path $projectRoot 'dist'
if (-not (Test-Path -LiteralPath (Join-Path $serverSource 'apps/api/src/server.js'))) { throw 'Build the server application first.' }
$destination = Join-Path $projectRoot ('work/releases/' + $ReleaseName + '/web')
if (-not (Test-Path -LiteralPath (Join-Path $source 'index.html'))) { throw 'Build the web application first.' }
if (Test-Path -LiteralPath $destination) { throw 'This release already exists.' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $destination -Recurse
$migrationDestination = Join-Path (Split-Path $destination -Parent) 'migrations'
New-Item -ItemType Directory -Path $migrationDestination | Out-Null
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'migrations') -Filter '*.sql' | Where-Object { [int]$_.Name.Substring(0,4) -le $ThroughMigration } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $migrationDestination }
$serverDestination = Join-Path (Split-Path $destination -Parent) 'server'
Copy-Item -LiteralPath $serverSource -Destination $serverDestination -Recurse
[pscustomobject]@{webRoot=$destination;migrationsDir=$migrationDestination;serverEntry=(Join-Path $serverDestination 'apps/api/src/server.js')} | ConvertTo-Json

