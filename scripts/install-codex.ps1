[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectPath,
  [string]$Name = 'harmonyos-preview',
  [string]$CodexCommand = 'codex',
  [string]$NodeCommand = 'node',
  [string]$HdcCommand = '',
  [string]$PreviewUrl = '',
  [switch]$AutoStartPreview,
  [switch]$CheckOnly,
  [switch]$SkipDeviceCheck,
  [switch]$RequireDevice,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Resolve-Executable([string]$Value) {
  if ([IO.Path]::IsPathRooted($Value)) {
    if (!(Test-Path -LiteralPath $Value -PathType Leaf)) { throw "Executable not found: $Value" }
    return (Resolve-Path -LiteralPath $Value).Path
  }
  $command = @(Get-Command $Value -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1
  if (!$command) { throw "Executable not found on PATH: $Value" }
  return [string]$command.Source
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Executable $($Arguments -join ' ')" }
}

$project = (Resolve-Path -LiteralPath $ProjectPath -ErrorAction Stop).Path
if (!(Test-Path -LiteralPath $project -PathType Container)) { throw "HarmonyOS project path is not a directory: $project" }

$scriptRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$entry = (Resolve-Path -LiteralPath (Join-Path $scriptRoot '..\bin\harmonyos-preview.mjs') -ErrorAction Stop).Path
$node = Resolve-Executable $NodeCommand
$nodeVersion = (& $node '--version').Trim()
if ($nodeVersion -notmatch '^v(\d+)\.') { throw "Unable to read Node.js version: $nodeVersion" }
if ([int]$Matches[1] -lt 20) { throw "Node.js 20 or newer is required; found $nodeVersion" }

$devices = @()
$hdc = if ($HdcCommand) { Resolve-Executable $HdcCommand } else { $null }
if (!$SkipDeviceCheck) {
  if (!$hdc) { $hdc = Resolve-Executable 'hdc' }
  $hdcOutput = & $hdc 'list' 'targets'
  if ($LASTEXITCODE -ne 0) { throw "HDC device discovery failed: $hdcOutput" }
  $devices = @($hdcOutput | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -and $_ -ne '[Empty]' -and $_ -notmatch '^\[.*\]$' })
  if (!$devices.Count) {
    if ($RequireDevice) { throw 'No HarmonyOS device or emulator is connected.' }
    Write-Warning 'No HarmonyOS device or emulator is connected. Install can continue; connect HDC before previewing.'
  }
}

Write-Output "Project: $project"
Write-Output "Node: $nodeVersion"
if ($devices.Count) { Write-Output "HDC devices: $($devices -join ', ')" }

if ($CheckOnly) {
  Write-Output 'Check complete; Codex MCP configuration was not changed.'
  exit 0
}

$codex = Resolve-Executable $CodexCommand
$existing = & $codex 'mcp' 'get' $Name 2>$null
if ($LASTEXITCODE -eq 0 -and !$Force) {
  Write-Output "Codex MCP server '$Name' is already registered. Use -Force to replace it."
  exit 0
}
if ($LASTEXITCODE -eq 0 -and $Force) { Invoke-Checked $codex @('mcp', 'remove', $Name) }

$mcpArguments = @('mcp', 'add', $Name, '--env', "HARMONY_PROJECT=$project")
if ($hdc) { $mcpArguments += @('--env', "HDC=$hdc") }
if ($PreviewUrl) { $mcpArguments += @('--env', "HARMONY_PREVIEW_URL=$PreviewUrl") }
if ($AutoStartPreview) { $mcpArguments += @('--env', 'HARMONY_PREVIEW_AUTOSTART=1') }
$mcpArguments += @('--', $node, $entry, '--mcp')
Invoke-Checked $codex $mcpArguments
Write-Output "Installed Codex MCP server '$Name'."
Write-Output "Verify with: codex mcp get $Name"
