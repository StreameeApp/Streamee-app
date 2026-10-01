param(
    [ValidateSet('baseline1080','vsr1080','optiflow1080','combined1080','baseline4k','optiflow4k','combined4k')]
    [string]$Case = 'combined1080',
    [ValidateRange(2,60)][int]$Seconds = 10
)
$ErrorActionPreference = 'Stop'
$Case = $Case.ToLowerInvariant()
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
if (Get-Process mpv -ErrorAction SilentlyContinue) { throw 'Stop playback before running isolated GPU profiles' }
$width = if ($Case.EndsWith('4k')) { 3840 } else { 1920 }
$height = if ($width -eq 3840) { 2160 } else { 1080 }
$fruc = $Case.StartsWith('optiflow') -or $Case.StartsWith('combined')
$vsr = $Case.StartsWith('vsr') -or $Case.StartsWith('combined')
$arguments = @('--no-config','--load-scripts=no','--vo=gpu-next','--gpu-api=d3d11',
    '--gpu-context=d3d11','--window-minimized=yes','--focus-on=never','--geometry=640x360+0+0',
    '--ao=null','--untimed','--d3d11-sync-interval=0','--term-status-msg=',
    '--script=mpv/scripts/streamee_optiflow_stats.lua',
    '--script=mpv/scripts/streamee_vsr.lua',
    '--script=native/streamee-nvfruc-vs/tests/gpu-profile.lua',
    "--script-opts=streamee_vsr-enabled=$(if ($vsr) {'yes'} else {'no'}),streamee_vsr-rtx_hdr=no")
if ($fruc) {
    $arguments += '--vf=@streamee-nvfruc:vapoursynth=file=mpv/scripts/streamee_nvfruc.py:buffered-frames=2:concurrent-frames=1'
}
$pipe = '\\.\pipe\streamee-gpu-profile-' + [guid]::NewGuid().ToString('N')
$arguments += "--input-ipc-server=$pipe"
$arguments += "av://lavfi:testsrc2=size=${width}x${height}:rate=24:duration=$Seconds"
$start = [Diagnostics.ProcessStartInfo]::new((Join-Path $root 'mpv/mpv.exe'))
$start.WorkingDirectory = $root
$start.Arguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = 'Hidden'
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.EnvironmentVariables['STREAMEE_NVFRUC_PLUGIN'] = Join-Path $root 'mpv/vs-plugins/streamee_nvfruc.dll'
$start.EnvironmentVariables['STREAMEE_NVFRUC_RUNTIME'] = Join-Path $env:LOCALAPPDATA 'Streamee/nvfruc-runtime/v5.0.7'
$start.EnvironmentVariables['STREAMEE_NVFRUC_STATS_PIPE'] = $pipe
$start.EnvironmentVariables['STREAMEE_PROFILE_FRUC'] = $(if ($fruc) { 'yes' } else { 'no' })
$start.EnvironmentVariables['STREAMEE_PROFILE_VSR'] = $(if ($vsr -and $width -lt 3840) { 'yes' } else { 'no' })
$start.EnvironmentVariables['STREAMEE_PROFILE_WIDTH'] = "$width"
$start.EnvironmentVariables['STREAMEE_PROFILE_HEIGHT'] = "$height"
$child = [Diagnostics.Process]::Start($start)
try {
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    if (!$child.WaitForExit(60000)) { $child.Kill(); throw 'GPU profile exceeded 60 seconds' }
    $text = $stdout.Result + $stderr.Result
    if ($child.ExitCode -ne 0) { throw "GPU profile failed: $text" }
    $json = ($text -split '\r?\n' | Where-Object { $_ -match 'OPTIFLOW_GPU_PROFILE ' } | Select-Object -Last 1) -replace '^.*OPTIFLOW_GPU_PROFILE ', ''
    if (!$json) { throw "Missing GPU profile result: $text" }
    $result = $json | ConvertFrom-Json
    if (!$result.valid) { throw "GPU profile did not exercise its expected chain: $json" }
    [pscustomobject]@{case=$Case;sourceSeconds=$Seconds;result=$result} | ConvertTo-Json -Depth 15 -Compress
} finally { $child.Dispose() }
