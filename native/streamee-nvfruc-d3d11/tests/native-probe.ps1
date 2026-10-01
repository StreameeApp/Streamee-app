param(
    [Parameter(Mandatory)][string]$Player,
    [Parameter(Mandatory)][string]$Dependencies,
    [Parameter(Mandatory)][string]$Bridge,
    [Parameter(Mandatory)][string]$Runtime,
    [Parameter(Mandatory)][string]$Video,
    [ValidateSet('baseline','native','vsr','vsr-only','software','missing-runtime','unsupported','seek')][string]$Mode = 'native',
    [string]$EncodeOutput,
    [ValidateRange(1,60)][int]$TimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
if (Get-Process mpv,streamee-optiflow-mpv -ErrorAction SilentlyContinue) { throw 'Stop playback before isolated native probes' }
foreach ($item in @($Player,$Dependencies,$Bridge,$Video)) {
    if (![IO.Path]::IsPathFullyQualified($item) -or !(Test-Path -LiteralPath $item)) { throw "Missing absolute probe path: $item" }
}
if ($EncodeOutput -and (Test-Path -LiteralPath $EncodeOutput)) { throw 'Refusing to overwrite an existing encoded result' }
$arguments = @('--no-config','--load-scripts=no','--audio=no','--sub=no','--untimed',
    '--term-status-msg=','--msg-level=all=info,vf=debug,vd=v', '--hwdec=d3d11va')
if ($Mode -eq 'software') { $arguments += '--hwdec=no' }
if ($Mode -eq 'seek') {
    $arguments = $arguments | Where-Object { $_ -ne '--untimed' }
    $arguments += @('--speed=2', "--script=$(Join-Path $PSScriptRoot 'native-seek.lua')")
}
if ($Mode -ne 'baseline') {
    $filter = if ($Mode -eq 'vsr-only') { 'd3d11vpp=scale=2:scaling-mode=nvidia' } else { 'streamee-optiflow' }
    if ($Mode -eq 'vsr') { $filter += ',d3d11vpp=scale=2:scaling-mode=nvidia' }
    $arguments += "--vf=$filter"
}
if ($EncodeOutput) {
    $arguments += @("--o=$EncodeOutput",'--of=nut','--ovc=rawvideo','--ofopts=write_index=0')
} else {
    $arguments += @('--vo=gpu-next','--gpu-api=d3d11','--gpu-context=d3d11',
        '--window-minimized=yes','--focus-on=never','--geometry=640x360+0+0','--d3d11-sync-interval=0')
}
$arguments += $Video
$start = [Diagnostics.ProcessStartInfo]::new($Player)
foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = 'Hidden'
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.Environment['PATH'] = $Dependencies + ';' + $env:PATH
$start.Environment['STREAMEE_OPTIFLOW_D3D11_BRIDGE'] = $Bridge
$start.Environment['STREAMEE_OPTIFLOW_D3D11_RUNTIME'] = if ($Mode -eq 'missing-runtime') { Join-Path $Runtime 'intentionally-absent' } else { $Runtime }
$watch = [Diagnostics.Stopwatch]::StartNew()
$child = [Diagnostics.Process]::Start($start)
try {
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    if (!$child.WaitForExit($TimeoutSeconds * 1000)) {
        $child.Kill()
        $child.WaitForExit()
        throw "Native probe timed out; only probe process terminated. $($stdout.Result) $($stderr.Result)"
    }
    $watch.Stop()
    $log = $stdout.Result + $stderr.Result
    $log
    "PROBE mode=$Mode elapsedMs=$($watch.ElapsedMilliseconds) exit=$($child.ExitCode)"
    if ($child.ExitCode -ne 0) { throw 'Native probe failed' }
    if ($Mode -in @('native','vsr','seek') -and $log -notmatch 'Experimental GPU-resident NV12 session:') {
        throw 'Probe did not enter the native hardware path'
    }
    if ($Mode -in @('native','vsr') -and $log -match 'Native OptiFlow failed|passing originals') {
        throw 'Unexpected fallback in native hardware probe'
    }
    if ($Mode -eq 'vsr' -and ($log -match 'Could not create ID3D11VideoProcessorInputView|Disabling filter' -or
        $log -notmatch 'VO: \[gpu-next\] 3840x2160 d3d11\[nv12\]')) {
        throw 'Native OptiFlow to VSR chain did not remain active at 3840x2160'
    }
    if ($Mode -eq 'seek' -and ([regex]::Matches($log, 'Experimental GPU-resident NV12 session:').Count -lt 2 -or
        $log -notmatch 'SEEK_PROBE_DONE')) { throw 'Seek did not recreate the native session cleanly' }
} finally { $child.Dispose() }
