[CmdletBinding()]
param(
  [string]$Version = $env:MARTEN_MCP_VERSION,
  [string]$Repo = $(if ($env:MARTEN_MCP_REPO) { $env:MARTEN_MCP_REPO } else { "stijnVanHorenbeek/marten_mcp" }),
  [ValidateSet("opencode", "copilot")]
  [string]$Client = $(if ($env:MARTEN_MCP_CLIENT) { $env:MARTEN_MCP_CLIENT } else { "opencode" }),
  [ValidateSet("auto", "node", "bun")]
  [string]$Runtime = $(if ($env:MARTEN_MCP_RUNTIME) { $env:MARTEN_MCP_RUNTIME } else { "auto" }),
  [ValidateSet("auto", "sqlite", "json")]
  [string]$Storage = $(if ($env:MARTEN_MCP_STORAGE_MODE) { $env:MARTEN_MCP_STORAGE_MODE } else { "auto" }),
  [string]$InstallDir = $(if ($env:MARTEN_MCP_INSTALL_DIR) { $env:MARTEN_MCP_INSTALL_DIR } else { (Join-Path $env:LOCALAPPDATA "marten-docs-mcp") }),
  [string]$BinDir = $(if ($env:MARTEN_MCP_BIN_DIR) { $env:MARTEN_MCP_BIN_DIR } else { (Join-Path $env:LOCALAPPDATA "marten-docs-mcp\bin") }),
  [string]$CacheDir = $(if ($env:MARTEN_MCP_CACHE_DIR) { $env:MARTEN_MCP_CACHE_DIR } else { (Join-Path $env:LOCALAPPDATA "marten-docs-mcp\cache") }),
  [string]$SqlitePath = $env:MARTEN_MCP_SQLITE_PATH
)

$ErrorActionPreference = "Stop"

if (-not $SqlitePath) {
  $SqlitePath = Join-Path $CacheDir "cache.db"
}

function Get-CommandPathOrNull {
  param([string]$Name)
  $cmd = Get-Command -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    return $null
  }
  return $cmd.Source
}

function Get-LatestTag {
  param([string]$Repository)
  $uri = "https://api.github.com/repos/$Repository/releases/latest"
  $response = Invoke-RestMethod -Uri $uri -Headers @{ "User-Agent" = "marten-docs-mcp-quickinstall" }
  return $response.tag_name
}

function Ensure-Tool {
  param([string]$Tool)
  if (-not (Get-CommandPathOrNull -Name $Tool)) {
    throw "Missing required command: $Tool"
  }
}

Ensure-Tool -Tool "tar"

$tag = $Version
if (-not $tag) {
  $tag = Get-LatestTag -Repository $Repo
}

if (-not $tag) {
  throw "Unable to determine release tag. Pass -Version vX.Y.Z."
}

$archiveUrl = "https://github.com/$Repo/releases/download/$tag/marten-docs-mcp-bundle-$tag.tar.gz"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("marten-docs-mcp-" + [System.Guid]::NewGuid().ToString("N"))
$null = New-Item -ItemType Directory -Path $tempRoot -Force

try {
  $archiveFile = Join-Path $tempRoot "bundle.tar.gz"
  Write-Host "Downloading $archiveUrl"
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archiveFile

  & tar -xzf $archiveFile -C $tempRoot

  $bundleFile = Join-Path $tempRoot "bundle\index.js"
  if (-not (Test-Path $bundleFile)) {
    throw "Invalid release artifact. Missing bundle/index.js"
  }

  $null = New-Item -ItemType Directory -Path $InstallDir -Force
  $null = New-Item -ItemType Directory -Path $BinDir -Force
  $null = New-Item -ItemType Directory -Path $CacheDir -Force

  $installedBundle = Join-Path $InstallDir "index.js"
  Copy-Item -Path $bundleFile -Destination $installedBundle -Force

  $launcherPath = Join-Path $BinDir "marten-docs-mcp.cmd"
  $launcher = @"
@echo off
setlocal

if "%MARTEN_MCP_CACHE_DIR%"=="" set "MARTEN_MCP_CACHE_DIR=$CacheDir"
if "%MARTEN_MCP_STORAGE_MODE%"=="" set "MARTEN_MCP_STORAGE_MODE=$Storage"
if "%MARTEN_MCP_SQLITE_PATH%"=="" set "MARTEN_MCP_SQLITE_PATH=$SqlitePath"

set "RUNTIME=%MARTEN_MCP_RUNTIME%"
if "%RUNTIME%"=="" set "RUNTIME=$Runtime"

if /I "%RUNTIME%"=="bun" goto run_bun
if /I "%RUNTIME%"=="node" goto run_node

where node >nul 2>nul
if %ERRORLEVEL%==0 goto run_node
where bun >nul 2>nul
if %ERRORLEVEL%==0 goto run_bun

echo Neither node nor bun is available on PATH.>&2
exit /b 1

:run_node
node "$installedBundle" %*
exit /b %ERRORLEVEL%

:run_bun
bun "$installedBundle" %*
exit /b %ERRORLEVEL%
"@
  Set-Content -Path $launcherPath -Value $launcher -Encoding ASCII

  Write-Host "Installed marten-docs-mcp $tag at $launcherPath"

  $pathParts = ($env:PATH -split ';') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
  if (-not ($pathParts -contains $BinDir)) {
    Write-Host ""
    Write-Host "NOTE: $BinDir is not currently on PATH."
    Write-Host "Add it to user PATH if your MCP client cannot find marten-docs-mcp.cmd."
  }

  Write-Host ""
  if ($Client -eq "copilot") {
    $snippet = @{
      mcpServers = @{
        "marten-docs" = @{
          type = "local"
          command = $launcherPath
          args = @()
          env = @{
            MARTEN_MCP_CACHE_DIR = $CacheDir
            MARTEN_MCP_STORAGE_MODE = $Storage
            MARTEN_MCP_SQLITE_PATH = $SqlitePath
          }
          tools = @("*")
        }
      }
    } | ConvertTo-Json -Depth 6
    Write-Output $snippet
  }
  else {
    $snippet = @{
      mcp = @{
        "marten-docs" = @{
          type = "local"
          command = @($launcherPath)
          environment = @{
            MARTEN_MCP_CACHE_DIR = $CacheDir
            MARTEN_MCP_STORAGE_MODE = $Storage
            MARTEN_MCP_SQLITE_PATH = $SqlitePath
          }
        }
      }
    } | ConvertTo-Json -Depth 6
    Write-Output $snippet
  }
}
finally {
  if (Test-Path $tempRoot) {
    Remove-Item -Path $tempRoot -Recurse -Force
  }
}
