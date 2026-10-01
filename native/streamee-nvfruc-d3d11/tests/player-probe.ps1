param(
    [Parameter(Mandatory)][string]$Player,
    [Parameter(Mandatory)][string]$Dependencies,
    [Parameter(Mandatory)][string]$Bridge,
    [Parameter(Mandatory)][string]$Video,
    [Parameter(Mandatory)][string]$Log,
    [ValidateSet('native','baseline','software','missing-bridge','vsr','seek')][string]$Mode='native',
    [int]$Seconds=10,
    [switch]$Paced,
    [switch]$Audio,
    [string]$Screenshot,
    [switch]$NullRenderer
)
$ErrorActionPreference='Stop'
if (Get-Process mpv,streamee-optiflow-mpv -ErrorAction SilentlyContinue) {
    throw 'Stop playback before isolated player validation'
}
$start=[Diagnostics.ProcessStartInfo]::new($Player)
$arguments=@('--no-config','--load-scripts=no','--sub=no',
    '--term-status-msg=','--hwdec=d3d11va','--msg-level=all=info,vf=debug',
    "--length=$Seconds","--log-file=$Log")
if (!$Paced) { $arguments+='--untimed' }
if ($Audio) { $arguments+='--volume=0' } else { $arguments+='--audio=no' }
if ($Mode -eq 'software') { $arguments+='--hwdec=no' }
if ($Mode -ne 'baseline') {
    $filter='@streamee-optiflow:streamee-optiflow'
    if ($Mode -eq 'vsr') { $filter+=',d3d11vpp=scale=2:scaling-mode=nvidia' }
    $arguments+="--vf=$filter"
}
if ($Mode -eq 'seek') { $arguments+="--script=$(Join-Path $PSScriptRoot 'native-seek.lua')" }
if ($NullRenderer) { $arguments+='--vo=null' }
else {
    $arguments+=@('--vo=gpu-next','--gpu-api=d3d11','--gpu-context=d3d11',
        '--window-minimized=yes','--focus-on=never','--geometry=640x360+0+0')
}
$arguments+="--script=$(Join-Path $PSScriptRoot 'player-stats.lua')"
$arguments+=$Video
foreach ($arg in $arguments) { $start.ArgumentList.Add($arg) }
$start.UseShellExecute=$false
$start.CreateNoWindow=$true
$start.WindowStyle='Hidden'
$start.RedirectStandardOutput=$true
$start.RedirectStandardError=$true
$start.Environment['PATH']=$Dependencies+';'+$env:PATH
$start.Environment['STREAMEE_OPTIFLOW_D3D11_BRIDGE']=if($Mode -eq 'missing-bridge') {
    Join-Path $Dependencies 'intentionally-missing-optiflow.dll'
} else { $Bridge }
$start.Environment.Remove('STREAMEE_NVFRUC_RUNTIME') | Out-Null
$start.Environment.Remove('STREAMEE_OPTIFLOW_D3D11_RUNTIME') | Out-Null
if ($Screenshot) { $start.Environment['STREAMEE_OPTIFLOW_PROBE_SCREENSHOT']=$Screenshot }
else { $start.Environment.Remove('STREAMEE_OPTIFLOW_PROBE_SCREENSHOT') | Out-Null }
$watch=[Diagnostics.Stopwatch]::StartNew()
$child=[Diagnostics.Process]::Start($start)
try {
    $stdout=$child.StandardOutput.ReadToEndAsync()
    $stderr=$child.StandardError.ReadToEndAsync()
    if (!$child.WaitForExit(($Seconds+60)*1000)) {
        $child.Kill();$child.WaitForExit();throw 'Isolated player deadline exceeded'
    }
    $watch.Stop()
    $text=$stdout.Result+$stderr.Result
    $text
    "PROBE mode=$Mode elapsedMs=$($watch.ElapsedMilliseconds) exit=$($child.ExitCode) paced=$Paced"
    if ($child.ExitCode -ne 0) { throw 'Player exited unsuccessfully' }
    if ($Mode -eq 'seek' -and ($text -match 'LIFECYCLE_PROBE_FAILED' -or
        $text -notmatch 'LIFECYCLE_PROBE_DONE seeks=3 pause=1 resume=1')) {
        throw 'Pause/resume and repeated seek validation did not complete'
    }
    if ($Mode -in @('native','vsr','seek')) {
        if ($text -notmatch 'OptiFlow NVOFA \+ custom shaders:' -or $text -match 'passing originals|processing failed') {
            throw 'Requested interpolation was not active'
        }
        if ($text -notmatch 'OptiFlow totals: inputs=(\d+) outputs=(\d+) synthesized=(\d+) held=(\d+)') {
            throw 'Missing final interpolation counters'
        }
        if ([long]$Matches[3]+[long]$Matches[4] -le 0) { throw 'No midpoint output' }
        # A --length stop can disconnect pins while lookahead remains queued.
        # The 2N-1 invariant applies to a fully drained natural input EOF.
        if ($Mode -eq 'native' -and $text.Contains('filter input EOF') -and
            [long]$Matches[2] -ne 2*[long]$Matches[1]-1) {
            throw 'Incorrect uninterrupted frame cadence'
        }
    }
} finally { $child.Dispose() }
