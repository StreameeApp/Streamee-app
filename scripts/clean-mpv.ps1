$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot 'src-tauri\target'))

foreach ($configuration in @('debug', 'release')) {
    $mpvBundle = [System.IO.Path]::GetFullPath((Join-Path $targetRoot "$configuration\mpv"))
    if (-not $mpvBundle.StartsWith($targetRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean MPV bundle outside the Tauri target directory: $mpvBundle"
    }

    if (Test-Path -LiteralPath $mpvBundle) {
        Remove-Item -LiteralPath $mpvBundle -Recurse -Force
        Write-Host "Removed generated MPV bundle: $mpvBundle"
    }
}
