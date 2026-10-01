# NVIDIA Optical Flow FRUC integration (WIP)

Streamee's NVIDIA Optical Flow FRUC path is an experimental, optional 2x frame-interpolation system. It is separate from RIFE and SmoothVideo Project (SVP).

## What Streamee ships

Streamee uses its own GPL-3.0-or-later VapourSynth compatibility adapter and Python integration script. A separate D3D11 bridge and custom MPV filter remain under development. Both implementations dynamically call a runtime that the user imports on their own computer.

**Native backend restored for testing (2026-09-04):** at the user's request, the unchanged native executable and automatic selection are restored for testing other formats. Full-resolution probes still reproduce NV12 colour corruption at 1080p and 4K. This is not a colour fix or playback acceptance. The existing VapourSynth backend remains the fallback when native assets are absent.

Streamee does **not** ship or download NVIDIA Optical Flow SDK headers, sample source, libraries, documentation, or NVIDIA's license agreement. The repository ignores root folders named `Optical_Flow_SDK_*` so a developer's local SDK copy cannot be committed accidentally.

## User-provided runtime

The WIP release recognizes the Windows x64 runtime from NVIDIA Optical Flow SDK 5.0.7:

- `NvOFFRUC.dll`
- `cudart64_110.dll`

The user must obtain the SDK from NVIDIA and accept any terms that apply to it. The Settings import action accepts the SDK root, the `NvOFFRUC` subtree, the sample folder, or its `bin/win64` folder. Before importing, Streamee verifies exact supported file sizes and SHA-256 hashes and requires valid NVIDIA Corporation Authenticode signatures. Imported files are stored under `%LOCALAPPDATA%\Streamee\nvfruc-runtime\v5.0.7` and are not added to an installer or update package.

## Current support boundary

### Advanced GPU clock control (experimental)

Settings includes a separate, off-by-default **Advanced GPU clock control** section with minimum and maximum graphics clocks in MHz. Save the range, then start a new NVFRUC playback session. Windows requests administrator approval for a hidden Windows PowerShell helper; declining leaves normal playback available. Streamee itself does not run elevated.

This is a whole-GPU setting, not a per-application NVIDIA profile. It supports exactly one NVIDIA GPU, checks the driver-reported maximum, and never changes memory clocks, voltage, or power limits. Unsupported driver commands fail without preventing video playback. Avoid using another clock-tuning tool simultaneously.

The helper applies the range only when the matching player is unpaused, non-idle, has the NVFRUC filter enabled, and receives a fresh authorization heartbeat from Streamee. Pause, stop, changed/disabled clock settings, disabled NVFRUC, lost IPC/heartbeat, or app/player exit cause restoration of automatic graphics clocks. Range changes need a new playback session and approval. A separate guard survives a Streamee crash; its own forced termination, OS shutdown failure, or a driver reset failure can still require manual recovery. Cleanup restores driver defaults, not pre-existing custom locks. In an Administrator terminal, recovery is `nvidia-smi -i 0 --reset-gpu-clocks`.

The lifecycle logic is tested without changing real GPU clocks. Real UAC approval and hardware lock/reset behavior must be verified on the installed driver.

### Video support

- Windows 10 or newer
- NVIDIA Turing-generation GPU or newer
- NVIDIA display driver 511.65 or newer
- 2x output only
- Constant-format 8-bit YUV 4:2:0 video with even dimensions
- One stateful FRUC sequence per active filter

Unsupported pixel formats pass through unchanged. Native HDR and 10-bit input are outside the current WIP boundary. Seeking reconstructs the active filter and starts a new interpolation sequence.

The adapter probes runtime/GPU initialization before negotiating its output rate. Initialization failure logs a warning and returns the original video at its original rate. A later processing failure logs a warning and disables interpolation for that filter instance; source frames are repeated at the already-negotiated rate to preserve playback timing. A seek or new playback creates a new filter and retries initialization. SVP remains blocked until the NVFRUC player session ends, even if the setting is turned off during playback.

## Runtime architecture

The experimental native path uses a distinctly named custom MPV executable. Its internal filter borrows D3D11 NV12 decoder frames, submits them through Streamee's D3D11 bridge, and writes the result directly into MPV's D3D11 hardware-frame pool. The playback path does not map, upload, or read back pixel data on the CPU. It is GPU-resident rather than copy-free because GPU copies remain around the opaque runtime resources. See the [native backend notes](../native/streamee-nvfruc-d3d11/README.md).

When native assets are absent, playback uses the existing VapourSynth compatibility backend. That backend decodes a software frame, packs the three YUV planes into NV12, copies the buffer to user-owned CUDA memory, calls the user-provided `NvOFFRUC.dll`, and copies the interpolated NV12 frame back into a VapourSynth frame. No NVIDIA SDK code or header is compiled into either Streamee adapter.

The native filter has been validated with real D3D11 decoded frames, padded 1080p decoder textures, EOF draining, seeking, P010 and missing-runtime fallback, native 4K input, and the OptiFlow-to-VSR chain. A moving-pattern probe confirmed four of five returned textures differed from both adjacent inputs. These checks are local evidence from one RTX 4090 system, not cross-GPU or in-app presentation proof.

VSR runs after NVFRUC so interpolation processes the source resolution; RTX HDR stays after both. Chroma packing/unpacking uses baseline x64 SSE2 with scalar tails, without changing pixel values. Run `ctest --test-dir <adapter-build-directory> --output-on-failure` for scalar-equivalence checks covering unaligned rows and tail widths.

The RTX HDR setting is a saved preference, not unconditional filter activation. Its filter is present only for SDR input while Windows HDR is reported on; switching Windows HDR off removes the filter and restores base contrast. This gating also applies when a non-VSR upscaler is selected.

The adapter also attempts to pin its reusable host staging buffer with CUDA for the filter lifetime, unregistering it during cleanup. If registration fails, ordinary host staging remains available. Two alternating local synthetic 4K runs measured 6.61 seconds without pinning versus 6.30 seconds with pinning, with all 15 comparison frames byte-identical. This is an incremental transfer optimization, not a zero-copy path or proof that combined VSR/HDR playback sustains its target rate.

Contiguous luma planes now use a single bulk copy for packing/unpacking instead of thousands of row copies. Padded strides retain the row-copy path. In a later alternating 4K/240-input-frame probe, two runs each averaged 3.802 seconds of frame-request time before versus 3.620 seconds after (about 4.8% lower). Whole-loop time, including original-frame validation, averaged 6.362 versus 6.188 seconds (about 2.7% lower). Packing plus unpacking averaged 2.812 versus 2.189 ms in the reported sample (about 22% lower). Separate alternating hash runs produced identical SHA-256 for all 479 output frames, all planes, with both adapters. CPU tests also cover contiguous, padded, reversed-source, empty and unaligned planes with padding sentinels. This scene triggered driver repetition, so these measurements establish copy-path cost/parity, not interpolation quality or a real-playback speed/power improvement.

For reproducible comparisons, `compatibility.py --performance-only` runs only the longer probe; add `--fingerprint` to hash every output plane. Compare separate processes with `STREAMEE_NVFRUC_PLUGIN` pointing to each adapter and alternate their order. Hashing is excluded from the reported `frameRequestSeconds`, but can still affect scheduling/cache state; use the non-hash pass for primary timing.

In local headless synthetic 4K/24 fps tests, a ten-second clip took 7.78 seconds with scalar conversion versus 6.56 seconds with SSE2 (two alternating runs each). All planes of 15 generated 4K frames matched the scalar adapter byte-for-byte. These numbers exclude VSR, HDR, and display rendering; they do not establish real-playback performance or power savings.

## Development smoke test

### OptiFlow diagnostics and compatibility matrix

Press **Ctrl+Shift+O** over the player to toggle OptiFlow diagnostics. The overlay shows source and estimated filter FPS, presentation/decoder drop counters, A/V sync, active filter order, and adapter state. `ready` means initialization succeeded; `active` means FRUC processing returned successfully. The driver repeat counter distinguishes repeated output from genuinely new interpolated output. A doubled estimated FPS alone is not proof of interpolation or smooth presentation.

The VapourSynth compatibility adapter reports cumulative host wall-time averages for packing, upload, the FRUC call, readback, unpacking, and synchronization. Upload/packing/FRUC/synchronization averages are per input submission; readback/unpacking averages are per generated-frame request. Driver waits are included: these are not isolated GPU kernel timings. Decode, VSR, RTX HDR, and display presentation are excluded. Reports arrive on the first generated request and every 60 requests; sample age remains visible during pauses/stalls. Seeking clears the overlay sample. The latest compatibility-adapter sample is also available through MPV's `user-data/streamee-optiflow-stats` property. The D3D11 backend currently logs its input, output, and repeat totals at teardown; matching live overlay telemetry remains WIP.

The Python bridge forwards these samples through a single background worker with a one-item queue, never blocking a frame callback on IPC. It is separate from the video script so its thread cannot retain the old filter graph after a seek. Diagnostic delivery is best-effort; a stale or missing sample is not evidence that interpolation is currently working. The bridge requires the launch-time `STREAMEE_NVFRUC_STATS_PIPE` variable, so restart the development app after updating the backend. It never alters GPU clocks or enhancement settings.

To run the standalone compatibility matrix with playback stopped or paused, set the two adapter/runtime environment variables below and run:

```powershell
mpv/python.exe native/streamee-nvfruc-vs/tests/compatibility.py
# Optional longer 4K probe, including original-frame parity checks:
mpv/python.exe native/streamee-nvfruc-vs/tests/compatibility.py --performance
```

The test disables plugin auto-loading and checks the loaded adapter path, so an older bundled DLL cannot silently replace the requested build. It checks 1080p 23.976/24/25/29.97/30/60 fps, 4K24, exact original frames, rational timing, unchanged 10-bit SDR/PQ/HLG pixels and color properties, and 4:4:4 bypass. Passing these cases does **not** establish MPV's end-to-end 10-bit/HDR preservation, support on other GPU generations, or smooth 4K with VSR/HDR enabled.

Additional local headless MPV probes using `tests/telemetry-smoke.lua` verified real adapter-to-Lua delivery, SDR 24-to-48 fps negotiation, and 10-bit PQ/HLG fallback retaining output pixel format, transfer characteristics, and 24 fps. These use a null renderer: they do not validate physical HDR display output or visual interpolation quality.

Next performance work remains measurement-driven: compare paced in-app playback with OptiFlow alone, VSR alone, and the combined chain; test HDR only on an HDR-enabled display. Keep source, display, clock settings, and playback segment fixed. The GPU-resident frame path is implemented; broader HDR interpolation support, diagnostic parity for that backend, visual-quality evaluation, power measurement, and cross-GPU validation remain pending.

Separate **native 4K input** from **1080p input upscaled to 4K**: the current VSR policy limits its 2x filter to source dimensions at most 2560x1440, so native 4K already bypasses that scaling stage. Regression tests cover native 4K without redundant VSR, eligible HDR after OptiFlow, and the 1080p OptiFlow -> VSR -> HDR order. A null-renderer probe cannot initialize this build's `d3d11vpp` filter; GPU-rendered enhancement throughput still requires a separate playback experiment. Do not interpret that headless initialization failure as a runtime playback regression.

### Isolated D3D11 processing profiles

With playback stopped, run from the repository root:

```powershell
powershell.exe -NoProfile -File native/streamee-nvfruc-vs/tests/gpu-profile.ps1 -Case combined1080 -Seconds 10
```

Cases: `baseline1080`, `vsr1080`, `optiflow1080`, `combined1080`, `baseline4k`, `optiflow4k`, `combined4k`. The harness uses the production adapter and VSR policy, synthetic 24 fps video, a minimized 640x360 D3D11/gpu-next window, untimed rendering, and a unique IPC pipe. It refuses to run alongside an existing MPV process. It does not change clock locks, app preferences, or Windows HDR; RTX HDR is explicitly off. The process deadline is 60 seconds and terminates only the spawned player on timeout.

Validation requires actual GPU render-pass samples, correct output dimensions, the expected active filters, and active native telemetry when OptiFlow is requested. It fails on unexpected HDR, missing filters, fallback, wrong size, or no renderer activity. MPV's FPS estimate remained at 24 during these untimed runs even with native FRUC processing; the result explicitly sets `rateValidated` and `presentationValidated` to false. Render-pass samples reflect the minimized output window, not full-screen 4K presentation; native stage timings include driver waits, not isolated kernel times.

Local results on 2026-09-04, RTX 4090 / driver 610.62, automatic clocks and Windows HDR off, for ten seconds of synthetic input (multiple forward/reverse-order runs):

| Case | Processing elapsed, seconds | Confirmed filter/output |
| --- | --- | --- |
| Baseline 1080p | 1.13–1.18 | 1920x1080 |
| VSR 1080p | 1.64–2.16 after the first run | VSR, 3840x2160 |
| OptiFlow 1080p | 2.65–2.69 | OptiFlow, 1920x1080 |
| OptiFlow + VSR 1080p | 3.16–3.80 | OptiFlow then VSR, 3840x2160 |
| Baseline native 4K | 2.14–2.43 | 3840x2160 |
| OptiFlow native 4K | 7.06–7.08 | OptiFlow, 3840x2160 |
| OptiFlow native 4K, VSR preference enabled | 7.00–7.14 | OptiFlow only, 3840x2160 |

The first VSR-only run took 6.91 seconds; subsequent repetitions above did not reproduce that outlier. Initialization, shader/driver warm-up and automatic clock behavior are not controlled well enough to assign its cause. Adding VSR increased the 1080p native FRUC-call average from roughly 3.7 to 4.1–4.9 ms, consistent with shared GPU work but not proof of a specific driver bottleneck. Native 4K with the VSR preference on/off had the same filter chain and essentially identical elapsed time; no extra scaling stage should be removed there.

The latest telemetry sample reported 180 driver repeats out of 180 generated-frame requests for these synthetic patterns. Therefore these are processing-path measurements, not evidence of newly synthesized frames, visual quality, smooth presentation, or power savings. Verification with representative real video and paced, visible playback remains necessary. HDR profiling was intentionally deferred because Windows HDR was off. This profiling chunk does not change production filter behavior.

From an x64 Visual Studio developer PowerShell, at the repository root:

```powershell
cmake -S native/streamee-nvfruc-vs -B "$env:TEMP/streamee-nvfruc-build" -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build "$env:TEMP/streamee-nvfruc-build"
Copy-Item "$env:TEMP/streamee-nvfruc-build/streamee_nvfruc.dll" mpv/vs-plugins/streamee_nvfruc.dll
```

CMake fetches pinned VapourSynth R70 headers, not NVIDIA SDK files. An offline build can supply `-DVAPOURSYNTH_INCLUDE_DIR=...` pointing to the R70 include directory. Only Streamee's rebuilt adapter belongs in `mpv/vs-plugins`; never copy the NVIDIA runtime there.

Build the adapter with Visual Studio 2022 and CMake, then set these environment variables before running `mpv/VSPipe.exe` against `native/streamee-nvfruc-vs/tests/smoke.vpy`:

- `STREAMEE_NVFRUC_PLUGIN` — absolute path to the built `streamee_nvfruc.dll`
- `STREAMEE_NVFRUC_RUNTIME` — absolute path to the SDK 5.0.7 Windows x64 runtime directory

The eight-frame synthetic source should report 15 output frames at 48 fps.

Runtime import readiness means the recognized files passed verification, not that the current GPU or every video is compatible. Restarted desktop playback, seeking, visual quality, and comparative power consumption still need testing. The user-supplied packaging boundary is not a legal opinion or a redistribution clearance; distribution involving proprietary runtime integration should receive license review.
