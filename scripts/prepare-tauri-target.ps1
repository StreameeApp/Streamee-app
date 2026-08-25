$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$targetRoot = Join-Path $root 'src-tauri\target'
$stampPath = Join-Path $targetRoot '.streamee-workspace-path'
$staleScanStampPath = Join-Path $targetRoot '.streamee-stale-scan'
$currentRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
$staleRoots = @('C:\Streamee', 'C:\@My APPs\Streamee')
$staleScanKey = "$currentRoot|$($staleRoots -join '|')"
$forceClean = $false
foreach ($arg in $args) {
    if ($arg -match '^(?:-ForceClean|--force-clean)$') {
        $forceClean = $true
    }
}

function Remove-TargetChild {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path -LiteralPath $Path) {
        if (Test-Path -LiteralPath $Path -PathType Container) {
            $cmd = "takeown /F `"$Path`" /R /D Y >NUL 2>&1 & icacls `"$Path`" /grant `"$($env:USERNAME):F`" /T /C >NUL 2>&1 & attrib -R -S -H `"$Path\*`" /S /D >NUL 2>&1 & rmdir /S /Q `"$Path`""
            cmd /c $cmd | Out-Null
        } else {
            Remove-Item -LiteralPath $Path -Force
        }

        if (Test-Path -LiteralPath $Path) {
            throw "Failed to remove stale Tauri target artifact: $Path"
        }

        Write-Host "Removed stale Tauri target artifact: $Path"
    }
}

if (-not (Test-Path -LiteralPath $targetRoot)) {
    New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
}

$previousRoot = if (Test-Path -LiteralPath $stampPath) {
    (Get-Content -LiteralPath $stampPath -Raw).Trim()
} else {
    ''
}

$shouldClean = $forceClean -or ($previousRoot -and $previousRoot -ne $currentRoot)

if (-not $shouldClean) {
    $previousStaleScanKey = if (Test-Path -LiteralPath $staleScanStampPath) {
        (Get-Content -LiteralPath $staleScanStampPath -Raw).Trim()
    } else {
        ''
    }

    if ((-not $previousRoot) -and $previousStaleScanKey -ne $staleScanKey) {
        foreach ($staleRoot in $staleRoots) {
            if (Get-ChildItem -LiteralPath $targetRoot -Recurse -File -ErrorAction SilentlyContinue | Select-String -SimpleMatch -Quiet $staleRoot) {
                $shouldClean = $true
                Write-Host "Detected stale build references to '$staleRoot' under $targetRoot."
                break
            }
        }
    }
}

if ($shouldClean) {
    if ($forceClean) {
        Write-Host "Force cleaning Cargo/Tauri target outputs."
    } else {
        Write-Host "Workspace path changed from '$previousRoot' to '$currentRoot'. Resetting stale Cargo/Tauri target outputs."
    }

    foreach ($child in @('debug', 'release', 'build', '.rustc_info.json')) {
        Remove-TargetChild (Join-Path $targetRoot $child)
    }
}

$legacyNodeRuntime = Join-Path $targetRoot 'node-runtime\node.exe'
if (Test-Path -LiteralPath $legacyNodeRuntime) {
    Remove-TargetChild $legacyNodeRuntime
}

Set-Content -LiteralPath $stampPath -Value $currentRoot
Set-Content -LiteralPath $staleScanStampPath -Value $staleScanKey
Write-Host "Tauri target prepared for workspace: $currentRoot"
