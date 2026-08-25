$ErrorActionPreference = 'Stop'

function Get-VersionParts {
    param([Parameter(Mandatory = $true)][string]$Version)

    if ($Version -notmatch '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$') {
        throw "Version must be in semantic format x.y.z, got '$Version'."
    }

    return [pscustomobject]@{
        Major = [int]$Matches.major
        Minor = [int]$Matches.minor
        Patch = [int]$Matches.patch
    }
}

function New-BumpedVersion {
    param(
        [Parameter(Mandatory = $true)][string]$CurrentVersion,
        [Parameter(Mandatory = $true)][string]$Mode
    )

    $parts = Get-VersionParts -Version $CurrentVersion

    switch ($Mode.ToLowerInvariant()) {
        'major' { return ('{0}.{1}.{2}' -f ($parts.Major + 1), 0, 0) }
        'minor' { return ('{0}.{1}.{2}' -f $parts.Major, ($parts.Minor + 1), 0) }
        'patch' { return ('{0}.{1}.{2}' -f $parts.Major, $parts.Minor, ($parts.Patch + 1)) }
        default { throw "Unsupported bump mode '$Mode'. Use patch, minor, major, or an explicit version." }
    }
}

$modeOrVersion = if ($args.Count -gt 0) { $args[0] } else { 'patch' }

$root = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $root 'package.json'
$packageLockPath = Join-Path $root 'package-lock.json'
$tauriConfigPath = Join-Path $root 'src-tauri\tauri.conf.json'
$cargoTomlPath = Join-Path $root 'src-tauri\Cargo.toml'

$packageContent = Get-Content -LiteralPath $packageJsonPath -Raw
$package = $packageContent | ConvertFrom-Json
$currentVersion = [string]$package.version

if ($modeOrVersion -match '^\d+\.\d+\.\d+$') {
    $nextVersion = $modeOrVersion
} else {
    $nextVersion = New-BumpedVersion -CurrentVersion $currentVersion -Mode $modeOrVersion
}

$packageVersionPattern = [regex]::new('("version"\s*:\s*")[^"]+(")')
if (-not $packageVersionPattern.IsMatch($packageContent)) {
    throw "Failed to locate version in $packageJsonPath"
}
$updatedPackage = $packageVersionPattern.Replace(
    $packageContent,
    ('${1}' + $nextVersion + '${2}'),
    1
)
Set-Content -LiteralPath $packageJsonPath -Value $updatedPackage.TrimEnd([char[]]"`r`n")

if (Test-Path -LiteralPath $packageLockPath) {
    $lockContent = Get-Content -LiteralPath $packageLockPath -Raw
    $topLevelVersionPattern = [regex]::new('("version"\s*:\s*")[^"]+(")')
    if (-not $topLevelVersionPattern.IsMatch($lockContent)) {
        throw "Failed to locate top-level version in $packageLockPath"
    }
    $updatedLock = $topLevelVersionPattern.Replace(
        $lockContent,
        ('${1}' + $nextVersion + '${2}'),
        1
    )
    $rootPackageVersionPattern = [regex]::new(
        '("packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"version"\s*:\s*")[^"]+(")'
    )
    if (-not $rootPackageVersionPattern.IsMatch($updatedLock)) {
        throw "Failed to locate root package version in $packageLockPath"
    }
    $updatedLock = $rootPackageVersionPattern.Replace(
        $updatedLock,
        ('${1}' + $nextVersion + '${2}'),
        1
    )
    Set-Content -LiteralPath $packageLockPath -Value $updatedLock.TrimEnd([char[]]"`r`n")
}

$tauriContent = Get-Content -LiteralPath $tauriConfigPath -Raw
$tauriVersionPattern = [regex]::new('("version"\s*:\s*")[^"]+(")')
if (-not $tauriVersionPattern.IsMatch($tauriContent)) {
    throw "Failed to locate version in $tauriConfigPath"
}
$updatedTauri = $tauriVersionPattern.Replace(
    $tauriContent,
    ('${1}' + $nextVersion + '${2}'),
    1
)
Set-Content -LiteralPath $tauriConfigPath -Value $updatedTauri.TrimEnd([char[]]"`r`n")

$cargoToml = Get-Content -LiteralPath $cargoTomlPath -Raw
$cargoVersionPattern = [regex]::new(
    '^(version\s*=\s*")[^"]+(")',
    [System.Text.RegularExpressions.RegexOptions]::Multiline
)
if (-not $cargoVersionPattern.IsMatch($cargoToml)) {
    throw "Failed to locate package version in $cargoTomlPath"
}
$updatedCargoToml = $cargoVersionPattern.Replace(
    $cargoToml,
    { param($match) $match.Groups[1].Value + $nextVersion + $match.Groups[2].Value },
    1
)
Set-Content -LiteralPath $cargoTomlPath -Value $updatedCargoToml.TrimEnd([char[]]"`r`n")

Write-Host "Updated Streamee version to $nextVersion"
