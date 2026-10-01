# Native D3D11 OptiFlow (experimental)

ABI 3 uses the NVIDIA driver optical-flow API and custom HLSL synthesis on
NV12/P010. There is no NVFRUC playback fallback. See [architecture and current
acceptance status](../../docs/OPTIFLOW.md). Historical ABI 2 results are in
[the preserved record](../../docs/NVFRUC-NATIVE-HISTORY.md).

## Bridge build

Windows x64 requires CMake, Visual Studio C++ build tools and Windows SDK FXC.
The two interface headers in `include/nvof` retain their supplied notices.
Shaders compile to embedded bytecode during this build; playback needs no
shader compiler, SDK import or CUDA runtime.

```powershell
cmake -S native/streamee-nvfruc-d3d11 -B "$env:TEMP/streamee-optiflow-v3" -G 'Visual Studio 17 2022' -A x64
cmake --build "$env:TEMP/streamee-optiflow-v3" --config Release -j 4
ctest --test-dir "$env:TEMP/streamee-optiflow-v3" -C Release --output-on-failure
& "$env:TEMP/streamee-optiflow-v3/Release/optiflow_pixels.exe" --run-gpu-probe 1920 1080 10 12
& "$env:TEMP/streamee-optiflow-v3/Release/optiflow_pixels.exe" --run-gpu-probe 3840 2160 10 100 --performance-only
```

GPU probes are explicit and should run without other playback. The quality
probe reads pixels for verification; the performance probe preloads fixtures
and excludes CPU pixel generation/readback from measured submissions.

## Custom MPV

Use the pinned MPV v0.41.0 source and the existing toolchain. Apply `mpv/prepare.ps1`
to the exact checkout; it verifies the revision, registers the filter and copies
its ABI/metadata policy and executable metadata tests. Retain all corrections
in [the Windows build record](BUILD-WINDOWS.md), especially
`-Wa,-muse-unaligned-vector-move`.

The existing final build consumes `winbuild-sources/mpv-release`, not the separate
`mpv-0.41` checkout. Copy the prepared overlay to that pinned source archive when
using the existing build. Its `winbuild-build/optiflow-final` build directory
runs `ninja -j4 mpv.exe test/optiflow-metadata.exe`. In the private MSYS2 shell set
`PKG_CONFIG_LIBDIR` and `PKG_CONFIG_PATH` to the cross-install
`winbuild-build/install/x86_64-w64-mingw32/lib/pkgconfig`; regeneration otherwise
cannot locate libplacebo feature metadata. Do not regenerate the top-level
Windows dependency recipes.

Stage `mpv.exe` as `mpv/streamee-optiflow-mpv.exe` with the matching
`streamee_optiflow_d3d11.dll`. Back up older local artifacts first. Never mix ABI
versions. The player still uses the existing adjacent `VSScript.dll` dependency.

`tests/player-probe.ps1` launches a bounded hidden/minimized isolated player with
an absolute bridge path and captures native counts, colour parameters, GPU
spans, drops and A/V sync. Use `-Paced -Audio` for paced sync measurements; audio
volume is zero. `-Mode baseline`, `software`, `missing-bridge`, `vsr` and `seek`
exercise distinct paths. Do not use `vsr` mode with HDR input; the application
controller gates that combination. `-NullRenderer` does not prove GPU rendering
and may prevent D3D11 decode negotiation.

Use `-Mode seek -Paced -Seconds 20` with a clip of at least ten seconds to check
pause/resume and three exact seeks. The probe requires a stable paused
timestamp and active synthesis following every seek; missing completion fails
the probe. Run `-Mode native` separately through natural EOF to check `2N-1`
output cadence without seek resets.

## Checks without GPU playback

`ctest --test-dir <native-build> -C Release --output-on-failure` runs three
CPU-only executables. `optiflow_filter_host` compiles the production filter's
scheduling/cleanup code with fake pins, image ownership and bridge callbacks.
It covers rational and variable timestamps, `2N-1` natural EOF, final duration,
metadata holds, caption deduplication, format/colour/device transitions,
backpressure, processing/allocation/initialization failure, reset recovery and
64 repeated lifecycles. It does not emulate D3D resource operations or driver
failure itself. The C ABI and configuration contracts are separate tests.

The pinned MPV `test/optiflow-metadata.exe` checks real MPV metadata ownership,
semantic equality and rejection of malformed or unsupported metadata. The
opt-in `test/optiflow-metadata-decode.exe <local-video>` decodes at most 120
frames on two CPU threads and runs the policy on actual MPV images. It never
opens a hardware device or renders output. Build both targets with the same
Meson environment as the player. The decode probe requires a local dynamic-HDR
sample and is not automatically registered with CTest/Meson.

Root `npm test` exercises mocked VSR/RTX HDR transitions and diagnostics in
headless MPV (`vo=null`, no media), and the clock helper with mocked driver
commands. `cargo test --manifest-path src-tauri/Cargo.toml --lib` covers driver
preflight states without loading the driver in those tests. Actual display,
device-loss and clock-elevation checks remain opt-in live validations.
