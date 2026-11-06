<#
.SYNOPSIS
  Registers "Sunroom Camera" for the current Windows user, or removes it. Sunroom never runs this; you do.

.DESCRIPTION
  Sunroom Camera is the UnityCapture DirectShow filter (MIT, https://github.com/schellingb/UnityCapture),
  fed by the Sunroom desktop app through shared memory. This script writes the COM and DirectShow
  registry entries under HKEY_CURRENT_USER only: no admin rights, nothing machine-wide, nothing at startup.
  It prints every value it will write or delete and asks before doing it, unless you pass -Yes.

  UNVERIFIED: per-user DirectShow registration. No project or Microsoft document shows a capture filter
  registered only under HKCU being listed by Chrome, Zoom or Teams (apps/desktop research notes,
  research/02-platform-plumbing.md section 1.3). Known limits even if it works:
  - Apps run "as administrator" ignore per-user COM entries and will not see the camera.
  - 32-bit apps read the WOW6432Node entries, which point at the 32-bit DLL with its own class ID.
  - No FilterData value is written; whether DirectShow needs it to list a capture source is unverified.
  - Creating HKCU\Software\Classes\CLSID\{860BB310-...}\Instance might hide machine-wide DirectShow
    virtual cameras (for example OBS) from the merged registry view; also unverified.
  If the camera does not appear, undo with -Uninstall and use the machine-wide route instead, as an
  administrator:  regsvr32 "<path>\UnityCaptureFilter64.dll"  (it then appears as "Unity Video Capture").

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File register-virtual-camera.ps1 -Install
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File register-virtual-camera.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Yes,
  # where the filter DLLs live; they are never loaded by this script
  [string]$DllDir = (Join-Path $env:LOCALAPPDATA 'sunroom\vcam')
)
$ErrorActionPreference = 'Stop'
if ($Install -eq $Uninstall) {
  Write-Host 'Pass exactly one of -Install or -Uninstall.'
  exit 2
}

$FriendlyName = 'Sunroom Camera'
$VideoInputCategory = '{860BB310-5D01-11d0-BD3B-00A0C911CE86}'
# The 32-bit build answers only its own class ID (UnityCaptureFilter.cpp 39-45, 1095-1100).
$Views = @(
  @{ Root = 'HKCU:\Software\Classes';             Clsid = '{5C2CD55C-92AD-4999-8666-912BD3E70010}'; Dll = 'UnityCaptureFilter64.dll'; Sha256 = '72812F5363D8ECB45632253F8C8C888844B1B62E27616F3C8CC21064CCDE25E5' },
  @{ Root = 'HKCU:\Software\Classes\WOW6432Node'; Clsid = '{5C2CD55C-92AD-4999-8666-912BD3E70020}'; Dll = 'UnityCaptureFilter32.dll'; Sha256 = 'AA3EBDF03DEA7F3AAB3DD7B724751F49ED71672256B57C6A19AA6809CABF30BA' }
)

function Confirm-Plan([string]$Question) {
  if ($Yes) { return }
  $answer = Read-Host "$Question [y/N]"
  if ($answer -notmatch '^(y|yes)$') {
    Write-Host 'Nothing changed.'
    exit 1
  }
}

# Creates missing keys one level at a time; never touches a key that already exists.
function New-KeyPath([string]$Path) {
  if (Test-Path -LiteralPath $Path) { return }
  New-KeyPath (Split-Path -Parent $Path)
  New-Item -Path (Split-Path -Parent $Path) -Name (Split-Path -Leaf $Path) | Out-Null
}

function Test-EmptyKey([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $key = Get-Item -LiteralPath $Path
  return ($key.SubKeyCount -eq 0) -and ($key.ValueCount -eq 0)
}

if ($Install) {
  $writes = foreach ($v in $Views) {
    $dll = Join-Path $DllDir $v.Dll
    if (-not (Test-Path -LiteralPath $dll)) { throw "Missing $dll. Download it from https://github.com/schellingb/UnityCapture/tree/master/Install first." }
    $hash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash
    if ($hash -ne $v.Sha256) { throw "$dll has SHA-256 $hash, expected $($v.Sha256). Refusing to register an unknown DLL." }
    $clsidKey = "$($v.Root)\CLSID\$($v.Clsid)"
    $instanceKey = "$($v.Root)\CLSID\$VideoInputCategory\Instance\$($v.Clsid)"
    [pscustomobject]@{ Key = $clsidKey; Name = '(default)'; Value = $FriendlyName }
    [pscustomobject]@{ Key = "$clsidKey\InprocServer32"; Name = '(default)'; Value = $dll }
    [pscustomobject]@{ Key = "$clsidKey\InprocServer32"; Name = 'ThreadingModel'; Value = 'Both' }
    [pscustomobject]@{ Key = $instanceKey; Name = 'CLSID'; Value = $v.Clsid }
    [pscustomobject]@{ Key = $instanceKey; Name = 'FriendlyName'; Value = $FriendlyName }
    [pscustomobject]@{ Key = $instanceKey; Name = 'DevicePath'; Value = 'sunroom:camera' }
  }
  Write-Host 'Will write these string values, for the current user only:'
  $writes | ForEach-Object { Write-Host "  $($_.Key)  $($_.Name) = $($_.Value)" }
  Confirm-Plan 'Write them?'
  foreach ($w in $writes) {
    New-KeyPath $w.Key
    Set-ItemProperty -LiteralPath $w.Key -Name $w.Name -Value $w.Value -Type String
  }
  Write-Host "Done. Restart any app that should list `"$FriendlyName`", then open Sunroom; its status line says when an app is reading the camera."
  exit 0
}

$removals = foreach ($v in $Views) {
  $clsidKey = "$($v.Root)\CLSID\$($v.Clsid)"
  $instanceKey = "$($v.Root)\CLSID\$VideoInputCategory\Instance\$($v.Clsid)"
  # only keys this script wrote: anything else under these class IDs is left alone
  if ((Test-Path -LiteralPath $clsidKey) -and (Get-ItemProperty -LiteralPath $clsidKey).'(default)' -eq $FriendlyName) { $clsidKey }
  if ((Test-Path -LiteralPath $instanceKey) -and (Get-ItemProperty -LiteralPath $instanceKey).FriendlyName -eq $FriendlyName) { $instanceKey }
}
if (-not $removals) {
  Write-Host "No per-user `"$FriendlyName`" entries found. Nothing to remove."
  exit 0
}
Write-Host 'Will delete these keys and everything under them, for the current user only:'
$removals | ForEach-Object { Write-Host "  $_" }
Write-Host "Then the per-user $VideoInputCategory keys, only if left empty."
Confirm-Plan 'Delete them?'
$removals | ForEach-Object { Remove-Item -LiteralPath $_ -Recurse }
foreach ($v in $Views) {
  foreach ($k in @("$($v.Root)\CLSID\$VideoInputCategory\Instance", "$($v.Root)\CLSID\$VideoInputCategory")) {
    if (Test-EmptyKey $k) { Remove-Item -LiteralPath $k }
  }
}
Write-Host "Removed. Restart apps that had `"$FriendlyName`" open."
