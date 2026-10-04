[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$InstallDir)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$installPrefix = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\') + '\'
$helperNames = @('streameenode.exe', 'node.exe', 'mpv.exe', 'python.exe', 'python3.exe', 'ffmpeg.exe', 'fpcalc.exe')
$deadline = [DateTime]::UtcNow.AddSeconds(10)

function Get-InstalledHelpers {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in $helperNames -and $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

try {
    do {
        $helpers = @(Get-InstalledHelpers)
        if ($helpers.Count -eq 0) { exit 0 }
        foreach ($helper in $helpers) {
            $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($helper.ProcessId)"
            # Do not stop a different process if Windows has recycled a PID.
            if ($current -and $current.CreationDate -eq $helper.CreationDate -and
                $current.ExecutablePath -eq $helper.ExecutablePath) {
                Stop-Process -Id $helper.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (@(Get-InstalledHelpers).Count -ne 0) {
        throw 'Playback helpers are still running. Restart Windows before installing Streamee.'
    }
} catch {
    Write-Output $_.Exception.Message
    exit 1
}
