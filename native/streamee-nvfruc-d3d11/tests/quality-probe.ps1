param(
    [Parameter(Mandatory)][string]$BuildDirectory,
    [string]$OutputDirectory,
    [switch]$RunGpu
)
$ErrorActionPreference = 'Stop'
if (!$RunGpu) { throw 'GPU quality validation requires -RunGpu and idle playback' }
if (Get-Process mpv,streamee-optiflow-mpv -ErrorAction SilentlyContinue) {
    throw 'Stop playback before isolated GPU quality validation'
}
$probe = Join-Path $BuildDirectory 'Release/optiflow_pixels.exe'
if (!(Test-Path -LiteralPath $probe)) { throw "Missing quality probe: $probe" }
if (!$OutputDirectory) {
    $OutputDirectory = Join-Path $env:TEMP ('streamee-optiflow-quality-' + [guid]::NewGuid().ToString('N'))
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a new output directory to preserve earlier evidence' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$cases = @(
    @{Name='nv12-identity'; Width=1920; Height=1080; Bits=8; Options=@('--identity-chroma')},
    @{Name='p010-identity'; Width=1920; Height=1080; Bits=10; Options=@('--identity-chroma')},
    @{Name='p010-subpixel'; Width=1920; Height=1080; Bits=10; Options=@('--motion','1.5','--require-better-than-blend')},
    @{Name='p010-reverse'; Width=1920; Height=1080; Bits=10; Options=@('--motion','-1.5','--require-better-than-blend')},
    @{Name='nv12-diagonal-chroma'; Width=1920; Height=1080; Bits=8; Options=@('--motion','1.5','--motion-y','1','--varying-chroma','--require-better-than-blend')},
    @{Name='p010-diagonal-chroma'; Width=1920; Height=1080; Bits=10; Options=@('--motion','1.5','--motion-y','1','--varying-chroma','--require-better-than-blend')},
    @{Name='p010-occlusion-thin-object'; Width=1920; Height=1080; Bits=10; Options=@('--occlusion')},
    @{Name='nv12-moving-silhouette'; Width=1920; Height=1080; Bits=8; Options=@('--silhouette','--require-better-than-blend')},
    @{Name='p010-moving-silhouette'; Width=1920; Height=1080; Bits=10; Options=@('--silhouette','--require-better-than-blend')},
    @{Name='p010-4k-identity'; Width=3840; Height=2160; Bits=10; Options=@('--identity-chroma')},
    @{Name='p010-4k-subpixel'; Width=3840; Height=2160; Bits=10; Options=@('--motion','1.5','--require-better-than-blend')}
)
foreach ($case in $cases) {
    $prefix = Join-Path $OutputDirectory $case.Name
    $probeArguments = @('--run-gpu-probe', $case.Width, $case.Height, $case.Bits, 12) +
        $case.Options + @('--dump-prefix', $prefix)
    & $probe @probeArguments | Tee-Object -FilePath "$prefix.txt"
    if ($LASTEXITCODE -ne 0) { throw "GPU quality case failed: $($case.Name)" }
}
"Passed $($cases.Count) GPU quality cases. Evidence: $OutputDirectory"
