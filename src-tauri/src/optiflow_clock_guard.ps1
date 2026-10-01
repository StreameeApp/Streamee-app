# Embedded into the Rust binary. Only validated numeric values are prepended:
# $ParentId, $PlayerId, $MinimumMHz, $MaximumMHz.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$tool = Join-Path ([Environment]::SystemDirectory) 'nvidia-smi.exe'
$owned = $false
$mutexOwned = $false
$pipe = $null
$requestId = 0
$mutex = [Threading.Mutex]::new($false, 'Global\StreameeOptiflowClockGuard')

function Driver-Command([string[]]$arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new($tool, ($arguments -join ' '))
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(5000)) { $process.Kill(); throw 'NVIDIA driver command timed out' }
        $text = $stdout.Result + $stderr.Result
        if ($process.ExitCode -ne 0 -or $text -match 'not supported|not permitted|failed') {
            throw "NVIDIA driver rejected the clock request: $text"
        }
        return $text.Trim()
    } finally { $process.Dispose() }
}

function Player-Command($command) {
    $script:requestId++
    $id = $script:requestId
    $writer.WriteLine((@{command=$command;request_id=$id} | ConvertTo-Json -Compress -Depth 8))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt 1500) {
        $pending = $reader.ReadLineAsync()
        $remaining = [Math]::Max(1, 1500 - [int]$timer.ElapsedMilliseconds)
        if (!$pending.Wait($remaining)) { throw 'MPV clock guard IPC timeout' }
        if ($null -eq $pending.Result) { throw 'MPV clock guard IPC disconnected' }
        $reply = $pending.Result | ConvertFrom-Json
        # MPV emits asynchronous playback events on the same connection.
        if ($null -ne $reply.event -or $reply.request_id -ne $id) { continue }
        if ($reply.error -ne 'success') { throw "MPV clock guard command failed: $($reply.error)" }
        return $reply.data
    }
    throw 'MPV clock guard IPC timeout'
}

function Report([string]$message) {
    if ($pipe -and $pipe.IsConnected) {
        try { $null = Player-Command @('set_property', 'user-data/streamee-optiflow-clock-status', $message) } catch {}
        try { $null = Player-Command @('show-text', $message, 5000) } catch {}
    }
}

function Test-OptiflowActive($filters, $native) {
    return $native.state -eq 'active' -and @($filters | Where-Object {
        $_.label -eq 'streamee-optiflow' -and $_.enabled -ne $false
    }).Count -gt 0
}

function Should-Lock($allowed, $paused, $idle, $activeOptiflow, $fresh) {
    return $allowed -eq $true -and $paused -eq $false -and $idle -eq $false -and $activeOptiflow -eq $true -and $fresh
}

function Reset-Clocks {
    if (!$script:owned) { return }
    for ($attempt=0; $attempt -lt 3; $attempt++) {
        try {
            $null = Driver-Command @('-i','0','--reset-gpu-clocks')
            $script:owned = $false
            return
        } catch {
            if ($attempt -eq 2) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
}

try {
    if ($MinimumMHz -lt 300 -or $MinimumMHz -gt $MaximumMHz -or $MaximumMHz -gt 5000) {
        throw 'Invalid GPU clock range'
    }
    # Hold process handles so PID reuse cannot extend the lifetime of this guard.
    $parent = [Diagnostics.Process]::GetProcessById($ParentId)
    $player = [Diagnostics.Process]::GetProcessById($PlayerId)
    $null = $parent.Handle
    $null = $player.Handle
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (!$parent.HasExited -and !$player.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        try {
            $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', 'mpvpipe', [IO.Pipes.PipeDirection]::InOut)
            $pipe.Connect(500)
            break
        } catch { if ($pipe) { $pipe.Dispose(); $pipe=$null }; Start-Sleep -Milliseconds 250 }
    }
    if (!$pipe -or !$pipe.IsConnected) { throw 'MPV did not become available for clock control' }
    $writer = [IO.StreamWriter]::new($pipe); $writer.AutoFlush=$true
    $reader = [IO.StreamReader]::new($pipe)
    if ((Player-Command @('get_property','pid')) -ne $PlayerId) { throw 'MPV session changed' }
    # Allow the previous player's watchdog time to restore clocks and exit.
    try { $mutexOwned = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $mutexOwned = $true }
    if (!$mutexOwned) { throw 'Another Streamee clock guard is already active' }
    $gpus = @( (Driver-Command @('--query-gpu=uuid','--format=csv,noheader')) -split '\r?\n' | Where-Object { $_ })
    if ($gpus.Count -ne 1) { throw 'Advanced OptiFlow clock control requires exactly one NVIDIA GPU' }
    $maximum = 0
    $value = Driver-Command @('-i','0','--query-gpu=clocks.max.graphics','--format=csv,noheader,nounits')
    if (![int]::TryParse($value, [ref]$maximum) -or $MaximumMHz -gt $maximum) {
        throw 'Requested maximum exceeds the driver-reported graphics-clock maximum'
    }
    Report 'Advanced GPU clock control approved; waiting for active OptiFlow playback'
    while (!$parent.HasExited -and !$player.HasExited) {
        $allowed = $false
        $fresh = $false
        try {
            $request = Player-Command @('get_property','user-data/streamee-optiflow-clock-allowed')
            $allowed = $request.allowed -eq $true
            $age = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [long]$request.heartbeat
            $fresh = $age -ge 0 -and $age -le 3
        } catch { }
        $paused = Player-Command @('get_property','pause')
        $idle = Player-Command @('get_property','idle-active')
        $filters = Player-Command @('get_property','vf')
        $native = $null
        try { $native = Player-Command @('get_property','vf-metadata/streamee-optiflow') } catch { }
        # A loaded filter can be bypassing after driver/input failure.
        $activeOptiflow = Test-OptiflowActive $filters $native
        $shouldLock = Should-Lock $allowed $paused $idle $activeOptiflow $fresh
        if ($shouldLock -and !$owned) {
            # Even a timeout may have applied the lock; cleanup must attempt reset.
            $owned = $true
            $null = Driver-Command @('-i','0',"--lock-gpu-clocks=$MinimumMHz,$MaximumMHz")
            Report "Advanced GPU clocks locked: $MinimumMHz-$MaximumMHz MHz"
        } elseif (!$shouldLock -and $owned) {
            Reset-Clocks
            Report 'Advanced GPU clocks restored to automatic'
        }
        Start-Sleep -Milliseconds 500
    }
} catch {
    Report "Advanced GPU clock control stopped: $($_.Exception.Message)"
} finally {
    try { Reset-Clocks } catch { Report 'GPU clock reset failed. Restore automatic clocks with nvidia-smi --reset-gpu-clocks.' }
    if ($pipe) { $pipe.Dispose() }
    if ($mutexOwned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
