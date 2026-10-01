param([Parameter(Mandatory)][string]$Source)
$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path -LiteralPath $Source).Path
$revision = git -C $Source rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision -ne '41f6a645068483470267271e1d09966ca3b9f413') {
    throw 'Requires a separate MPV v0.41.0 checkout at 41f6a645068483470267271e1d09966ca3b9f413'
}
$patch = Join-Path $PSScriptRoot 'mpv-v0.41.0.patch'
git -C $Source apply --reverse --check $patch 2>$null
if ($LASTEXITCODE -ne 0) {
    git -C $Source apply --check $patch
    if ($LASTEXITCODE -ne 0) { throw 'MPV registration patch conflicts; checkout was not changed' }
    git -C $Source apply $patch
    if ($LASTEXITCODE -ne 0) { throw 'MPV registration patch failed' }
}
# These files are owned by this experimental overlay, never upstream files.
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'vf_streamee_optiflow.c') -Destination (Join-Path $Source 'video/filter/vf_streamee_optiflow.c')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../include/bridge.h') -Destination (Join-Path $Source 'video/filter/streamee_optiflow_bridge.h')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'optiflow_metadata.h') -Destination (Join-Path $Source 'video/filter/optiflow_metadata.h')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'optiflow_metadata_test.c') -Destination (Join-Path $Source 'test/optiflow_metadata_test.c')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'optiflow_metadata_decode.c') -Destination (Join-Path $Source 'test/optiflow_metadata_decode.c')
$tests = Join-Path $Source 'test/meson.build'
if (!(Select-String -LiteralPath $tests -SimpleMatch "test('optiflow-metadata'")) {
    Add-Content -LiteralPath $tests -Value @'
# Streamee OptiFlow overlay checks.
optiflow_metadata = executable('optiflow-metadata', 'optiflow_metadata_test.c',
    include_directories: incdir, dependencies: [libavutil, libplacebo],
    link_with: [img_utils, test_utils])
test('optiflow-metadata', optiflow_metadata)
'@
}
if (!(Select-String -LiteralPath $tests -SimpleMatch "executable('optiflow-metadata-decode'")) {
    Add-Content -LiteralPath $tests -Value @'
# Opt-in software metadata sample check; no automatic media/GPU test.
executable('optiflow-metadata-decode', 'optiflow_metadata_decode.c',
    include_directories: incdir, dependencies: [libavutil, libavcodec, libavformat, libplacebo],
    link_with: [img_utils, test_utils])
'@
}
Write-Output 'Experimental filter overlay prepared; no app files or installed player changed.'
