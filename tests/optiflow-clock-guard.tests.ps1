$ErrorActionPreference = 'Stop'
$guardPath = Join-Path $PSScriptRoot '../src-tauri/src/optiflow_clock_guard.ps1'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $guardPath),[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
# Load only these pure/control functions, never the elevated entry point.
foreach($name in @('Should-Lock','Test-OptiflowActive','Reset-Clocks','Player-Command')) {
    $node=$ast.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name},$true)
    if(!$node){throw "Missing function $name"}
    . ([scriptblock]::Create($node.Extent.Text))
}
# Exercise real IPC parsing with in-memory streams, never a live player or GPU.
$script:requestId=0
$writer=[IO.StringWriter]::new()
$data=[Text.Encoding]::UTF8.GetBytes("{`"event`":`"file-loaded`"}`n{`"request_id`":90,`"error`":`"success`"}`n{`"request_id`":1,`"error`":`"success`",`"data`":123}`n{`"event`":`"playback-restart`"}`n{`"request_id`":2,`"error`":`"success`",`"data`":false}`n{`"request_id`":3,`"error`":`"property unavailable`"}`n")
$reader=[IO.StreamReader]::new([IO.MemoryStream]::new($data))
try {
    if((Player-Command @('get_property','pid')) -ne 123){throw 'Events or stale replies broke IPC correlation'}
    if((Player-Command @('get_property','pause')) -ne $false){throw 'Boolean reply lost'}
    $rejected=$false
    try{$null=Player-Command @('get_property','missing')}catch{$rejected=$_.Exception.Message -match 'property unavailable'}
    if(!$rejected){throw 'Command failure was not surfaced'}
    $disconnected=$false
    try{$null=Player-Command @('get_property','pid')}catch{$disconnected=$_.Exception.Message -match 'disconnected'}
    if(!$disconnected){throw 'EOF was not surfaced'}
    $sent=@($writer.ToString().Trim() -split '\r?\n' | ForEach-Object {ConvertFrom-Json $_})
    if(($sent.request_id -join ',') -ne '1,2,3,4'){throw 'Request IDs were reused'}
} finally { $reader.Dispose();$writer.Dispose() }
$cases=0
foreach($allowed in @($false,$true)) { foreach($paused in @($false,$true)) {
foreach($idle in @($false,$true)) { foreach($fruc in @($false,$true)) {
foreach($fresh in @($false,$true)) {
    $actual=Should-Lock $allowed $paused $idle $fruc $fresh
    $expected=$allowed -and !$paused -and !$idle -and $fruc -and $fresh
    if($actual -ne $expected){throw 'Clock activation predicate mismatch'}
    $cases++
}}}}}
if(Should-Lock $true $null $false $true $true){throw 'Unknown pause state must not lock'}
if(Should-Lock $true $false $false $null $true){throw 'Unknown OptiFlow state must not lock'}
$activeFilter=@([pscustomobject]@{label='streamee-optiflow';enabled=$true})
if(!(Test-OptiflowActive $activeFilter ([pscustomobject]@{state='active'}))){throw 'Active native session was rejected'}
foreach($state in @('waiting','ready','bypassed',$null)) {
    if(Test-OptiflowActive $activeFilter ([pscustomobject]@{state=$state})){throw 'Inactive/bypassed native session permitted clock locking'}
}
if(Test-OptiflowActive $activeFilter $null){throw 'Missing native metadata permitted clock locking'}
if(Test-OptiflowActive @() ([pscustomobject]@{state='active'})){throw 'Stale native state permitted clock locking'}
$activeFilter[0].enabled=$false
if(Test-OptiflowActive $activeFilter ([pscustomobject]@{state='active'})){throw 'Disabled filter permitted clock locking'}
$script:calls=0; $script:reject=$false
function Driver-Command($arguments) {
    $script:calls++
    if(($arguments -join ' ') -ne '-i 0 --reset-gpu-clocks'){throw 'Unexpected driver command'}
    if($script:reject){throw 'Simulated driver failure'}
}
function Start-Sleep { param($Milliseconds) }
$script:owned=$false; Reset-Clocks
if($script:calls -ne 0){throw 'Reset touched clocks without ownership'}
$script:owned=$true; Reset-Clocks
if($script:calls -ne 1 -or $script:owned){throw 'Reset did not release ownership'}
$script:calls=0;$script:owned=$true;$script:reject=$true
$failed=$false
try{Reset-Clocks}catch{$failed=$true}
if(!$failed -or $script:calls -ne 3 -or !$script:owned){throw 'Reset retry behavior failed'}
Write-Output "$cases activation cases, unknown-state rejection, ownership and reset retries passed; no GPU commands executed"
