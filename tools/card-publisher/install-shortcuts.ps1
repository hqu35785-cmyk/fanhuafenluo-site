[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter()]
  [string]$RepositoryRoot,

  [Parameter()]
  [string]$DesktopDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertFrom-CodePoints {
  param([int[]]$CodePoint)
  return -join ($CodePoint | ForEach-Object { [char]$_ })
}

function ConvertTo-WindowsQuotedArgument {
  param([Parameter(Mandatory = $true)][string]$Value)

  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $slashCount = 0

  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $slashCount += 1
      continue
    }

    if ($character -eq '"') {
      if ($slashCount -gt 0) {
        [void]$builder.Append((('\' * ($slashCount * 2)) -join ''))
      }
      [void]$builder.Append('\"')
      $slashCount = 0
      continue
    }

    if ($slashCount -gt 0) {
      [void]$builder.Append((('\' * $slashCount) -join ''))
      $slashCount = 0
    }
    [void]$builder.Append($character)
  }

  if ($slashCount -gt 0) {
    [void]$builder.Append((('\' * ($slashCount * 2)) -join ''))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Get-NormalizedPath {
  param([AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  try {
    return [System.IO.Path]::GetFullPath($Value).TrimEnd('\')
  }
  catch {
    return $null
  }
}

if ($PSVersionTable.PSEdition -ne 'Desktop' -and -not $IsWindows) {
  throw 'This installer supports Windows only.'
}

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path (Split-Path -Parent $PSCommandPath) '..\..')
  )
}
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).ProviderPath

$launchScript = Join-Path $RepositoryRoot 'tools\card-publisher\launch.vbs'
$launcherScript = Join-Path $RepositoryRoot 'tools\card-publisher\launcher.mjs'
foreach ($requiredFile in @($launchScript, $launcherScript)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required launcher file is missing: $requiredFile"
  }
}

$null = Get-Command node.exe -ErrorAction Stop
$wscriptCommand = Get-Command wscript.exe -ErrorAction Stop
$wscriptPath = $wscriptCommand.Source

$shell = New-Object -ComObject WScript.Shell
try {
  if ([string]::IsNullOrWhiteSpace($DesktopDirectory)) {
    $DesktopDirectory = $shell.SpecialFolders.Item('Desktop')
  }
  $DesktopDirectory = (Resolve-Path -LiteralPath $DesktopDirectory).ProviderPath
  if (-not (Test-Path -LiteralPath $DesktopDirectory -PathType Container)) {
    throw 'The desktop directory does not exist.'
  }

  $quickPublish = ConvertFrom-CodePoints @(0x65B0, 0x7AD9, 0x5FEB, 0x6377, 0x53D1, 0x5E03, 0x5361, 0x7247)
  $publishFanhua = ConvertFrom-CodePoints @(0x65B0, 0x7AD9, 0x53D1, 0x5E03, 0x5230, 0x7E41, 0x82B1, 0x00B7, 0x7EB7, 0x843D)
  $publishPublic = ConvertFrom-CodePoints @(0x65B0, 0x7AD9, 0x53D1, 0x5E03, 0x5230, 0x516C, 0x5F00)
  $quotedLaunchScript = ConvertTo-WindowsQuotedArgument $launchScript

  $definitions = @(
    [pscustomobject]@{
      Name = $quickPublish
      Arguments = $quotedLaunchScript
      Description = 'New-site card publisher - choose a section after opening'
    },
    [pscustomobject]@{
      Name = $publishFanhua
      Arguments = "$quotedLaunchScript --section fanhuafenluo"
      Description = 'New-site card publisher - FanHua FenLuo section'
    },
    [pscustomobject]@{
      Name = $publishPublic
      Arguments = "$quotedLaunchScript --section public"
      Description = 'New-site card publisher - public section'
    }
  )

  $results = foreach ($definition in $definitions) {
    $shortcutPath = Join-Path $DesktopDirectory ($definition.Name + '.lnk')
    $exists = Test-Path -LiteralPath $shortcutPath -PathType Leaf

    if ($exists) {
      $existingShortcut = $shell.CreateShortcut($shortcutPath)
      try {
        $sameTarget = [string]::Equals(
          (Get-NormalizedPath $existingShortcut.TargetPath),
          (Get-NormalizedPath $wscriptPath),
          [System.StringComparison]::OrdinalIgnoreCase
        )
        $sameArguments = [string]::Equals(
          $existingShortcut.Arguments.Trim(),
          $definition.Arguments,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      }
      finally {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($existingShortcut)
      }

      if (-not ($sameTarget -and $sameArguments)) {
        Write-Warning "Skipped an existing user shortcut: $shortcutPath"
        [pscustomobject]@{
          Name = $definition.Name
          Path = $shortcutPath
          Status = 'skipped-existing-different-target'
        }
        continue
      }
    }

    $verb = if ($exists) { 'Refresh shortcut' } else { 'Create shortcut' }
    if (-not $PSCmdlet.ShouldProcess($shortcutPath, $verb)) {
      [pscustomobject]@{
        Name = $definition.Name
        Path = $shortcutPath
        Status = 'planned'
      }
      continue
    }

    $shortcut = $shell.CreateShortcut($shortcutPath)
    try {
      $shortcut.TargetPath = $wscriptPath
      $shortcut.Arguments = $definition.Arguments
      $shortcut.WorkingDirectory = $RepositoryRoot
      $shortcut.Description = $definition.Description
      $shortcut.IconLocation = "$wscriptPath,0"
      $shortcut.WindowStyle = 7
      $shortcut.Save()
    }
    finally {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    }

    $savedShortcut = $shell.CreateShortcut($shortcutPath)
    try {
      if (
        -not [string]::Equals(
          (Get-NormalizedPath $savedShortcut.TargetPath),
          (Get-NormalizedPath $wscriptPath),
          [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [string]::Equals(
          $savedShortcut.Arguments.Trim(),
          $definition.Arguments,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      ) {
        throw "Shortcut verification failed: $shortcutPath"
      }
    }
    finally {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($savedShortcut)
    }

    [pscustomobject]@{
      Name = $definition.Name
      Path = $shortcutPath
      Status = if ($exists) { 'refreshed' } else { 'created' }
    }
  }

  $results
}
finally {
  [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
