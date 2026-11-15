<#
.SYNOPSIS
  Registers Video Player with Windows as an app that opens video files
  (current user only, no admin rights needed), or removes that registration.

.DESCRIPTION
  After registering, Video Player appears under "Open with" and in
  Settings > Apps > Default apps. Windows does not let a program make itself
  the default: you confirm that once in Settings, which this script opens.

  The registration points at this folder and its node_modules\electron, so run
  it again if you move the project.

.EXAMPLE
  npm run register
  npm run register -- -Extensions .mp4,.mov,.mkv
  npm run unregister
#>
param(
  [string[]]$Extensions = @('.mp4'),
  [switch]$Unregister,
  [switch]$NoSettings   # do not open the Settings page afterwards
)

$ErrorActionPreference = 'Stop'
# Via "npm run register -- -Extensions .mp4,.mov" the list arrives as one string.
$Extensions = @($Extensions | ForEach-Object { $_ -split ',' } | Where-Object { $_.Trim() })

$AppName  = 'Video Player'
$ProgIdPrefix = 'VideoPlayer'                 # one class per extension: VideoPlayer.mp4, ...
$Classes  = 'HKCU:\Software\Classes'
$AppKey   = 'HKCU:\Software\VideoPlayer'      # holds the app's "Capabilities"
$Registered = 'HKCU:\Software\RegisteredApplications'

$Root     = Split-Path -Parent $PSScriptRoot
$Electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'

# New-Item -Force would wipe a key that already exists, so only create missing ones.
function Use-Key([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -Path $Path -Force | Out-Null }
  $Path
}

function Remove-Value([string]$Path, [string]$Name) {
  if ((Test-Path -LiteralPath $Path) -and ($null -ne (Get-Item -LiteralPath $Path).GetValue($Name, $null))) {
    Remove-ItemProperty -LiteralPath $Path -Name $Name
  }
}

function Send-AssociationsChanged {
  Add-Type -Namespace VideoPlayerSetup -Name Shell -MemberDefinition @'
[DllImport("shell32.dll")]
public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
'@
  [VideoPlayerSetup.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)  # SHCNE_ASSOCCHANGED
}

if ($Unregister) {
  Get-ChildItem -LiteralPath $Classes | Where-Object { $_.PSChildName -like "$ProgIdPrefix.*" } | ForEach-Object {
    $progId = $_.PSChildName
    $ext = $progId.Substring($ProgIdPrefix.Length)
    Remove-Value "$Classes\$ext\OpenWithProgids" $progId
    Remove-Item -LiteralPath $_.PSPath -Recurse
    Write-Host "Removed $progId"
  }
  Remove-Value $Registered $AppName
  if (Test-Path -LiteralPath $AppKey) { Remove-Item -LiteralPath $AppKey -Recurse }
  Send-AssociationsChanged
  Write-Host "$AppName is no longer registered. File types it was the default for go back to Windows' choice."
  return
}

if (-not (Test-Path -LiteralPath $Electron)) {
  throw "Electron is not installed. Run 'npm install' in $Root first."
}

$command = '"{0}" "{1}" "%1"' -f $Electron, $Root
# Icon for the files themselves: Windows' stock video-file icon when available.
$stockIcons = Join-Path $env:SystemRoot 'System32\wmploc.dll'
$fileIcon = if (Test-Path -LiteralPath $stockIcons) { "$stockIcons,-730" } else { "$Electron,0" }

$associations = Use-Key "$AppKey\Capabilities\FileAssociations"
Set-ItemProperty -LiteralPath "$AppKey\Capabilities" -Name ApplicationName -Value $AppName
Set-ItemProperty -LiteralPath "$AppKey\Capabilities" -Name ApplicationDescription `
  -Value 'Timecode overlay, frame and shot stepping, audio scrubbing, shot-grouped notes.'

foreach ($extension in $Extensions) {
  $ext = '.' + $extension.Trim().TrimStart('.').ToLowerInvariant()
  $progId = "$ProgIdPrefix$ext"
  $class = Use-Key "$Classes\$progId"

  Set-Item -LiteralPath $class -Value ('{0} video' -f $ext.TrimStart('.').ToUpperInvariant())   # "Type" column in Explorer
  Set-Item -LiteralPath (Use-Key "$class\DefaultIcon") -Value $fileIcon
  Set-ItemProperty -LiteralPath (Use-Key "$class\shell\open") -Name FriendlyAppName -Value $AppName
  Set-Item -LiteralPath (Use-Key "$class\shell\open\command") -Value $command
  $application = Use-Key "$class\Application"
  Set-ItemProperty -LiteralPath $application -Name ApplicationName -Value $AppName
  Set-ItemProperty -LiteralPath $application -Name ApplicationIcon -Value "$Electron,0"

  # Offer this class for the extension ("Open with"), and list it among the app's file types.
  Set-ItemProperty -LiteralPath (Use-Key "$Classes\$ext\OpenWithProgids") -Name $progId -Value ''
  Set-ItemProperty -LiteralPath $associations -Name $ext -Value $progId
  Write-Host "Registered $progId -> $command"
}

Set-ItemProperty -LiteralPath (Use-Key $Registered) -Name $AppName -Value 'Software\VideoPlayer\Capabilities'
Send-AssociationsChanged

Write-Host ''
Write-Host "$AppName can now open: $($Extensions -join ', ')"
Write-Host 'To make it the default, choose it once in Settings > Apps > Default apps > Video Player'
Write-Host '(or right-click a file > Open with > Choose another app > Video Player > Always).'
if (-not $NoSettings) {
  Start-Process ('ms-settings:defaultapps?registeredAppUser=' + [uri]::EscapeDataString($AppName))
}
