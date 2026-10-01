# Historical NVFRUC native implementation (retired 2026-09-05)

The following is preserved evidence for the former ABI 2 implementation. Playback no longer loads this engine. See [current OptiFlow](OPTIFLOW.md).

# Native D3D11 OptiFlow backend (WIP)

This directory contains Streamee's experimental GPU-resident NVIDIA Optical
Flow FRUC integration for Windows. It is separate from RIFE. Streamee does not
compile, download, or redistribute NVIDIA SDK source, headers, libraries, or
license documents; the runtime is loaded only from the absolute folder imported
by the user.

The existing VapourSynth implementation remains the compatibility fallback.
Native assets and automatic selection have been restored at the user's request
for format testing. Pixel probes still reproduce NV12 chroma corruption at
1920x1080 and 3840x2176 on the local runtime/driver. This restoration is not a
colour-correctness fix or playback acceptance; native remains experimental.

## Architecture

`streamee_optiflow_d3d11.dll` exposes the versioned C ABI in `include/bridge.h`.
The MPV filter in `mpv/vf_streamee_optiflow.c` borrows FFmpeg's D3D11 device and
NV12 decoder textures, including their real array slices and padded resource
extent. The bridge copies those slices into shared FRUC input textures, uses a
shared D3D11 fence for synchronization, and copies the completed result directly
into a frame allocated from MPV's D3D11 hardware-frame pool.

There is no CPU map, pixel upload, or readback in the playback path. It remains
GPU-resident rather than copy-free: GPU copies are still required around the
opaque runtime resources. The older allocating ABI remains for the standalone
probe, while MPV uses `submit_into` so it does not add a second output copy or a
separate COM-backed frame lifetime.

The first input primes the sequence. Each later input produces a midpoint frame
followed by the current original, so `N` inputs drain to `2N - 1` outputs. The
filter preserves visible dimensions and frame metadata, halves frame durations,
doubles nominal frame rate, drains at EOF, and reconstructs its session after a
seek. FFmpeg's D3D11 device lock serializes decoder and bridge access.
The native filter retains the system D3D11 module for the player process lifetime
so surviving decoder/output objects cannot call into an unloaded implementation
after the dynamically loaded FRUC module is released.

Unsupported software frames, non-NV12 formats, 10-bit/HDR input, incompatible
devices, and runtime failures pass original frames through. Format conversion is
never silently introduced. Calls inside the proprietary runtime are opaque and
may block, so hardware probes must run under an external process deadline.

## Build and CPU-only checks

From an x64 Visual Studio developer shell:

```powershell
cmake -S native/streamee-nvfruc-d3d11 -B "$env:TEMP/streamee-nvfruc-d3d11" -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build "$env:TEMP/streamee-nvfruc-d3d11"
ctest --test-dir "$env:TEMP/streamee-nvfruc-d3d11" --output-on-failure
```

CTest covers input contracts and the C ABI without opening a GPU or proprietary
runtime. `tests/native-probe.ps1` exercises decoded MPV frames. The standalone
probe's explicit `--run-gpu-probe <absolute-runtime-directory>` mode performs a
test-only readback for pixel comparison; readback is not part of playback.

## MPV source overlay

The internal MPV filter targets MPV v0.41.0 at commit
`41f6a645068483470267271e1d09966ca3b9f413`. Run:

```powershell
powershell -NoProfile -File native/streamee-nvfruc-d3d11/mpv/prepare.ps1 -Source <separate-mpv-checkout>
```

The script verifies the exact revision, applies only the filter-registration
patch, and copies the two Streamee-owned filter files. A custom source build is
required because MPV does not expose internal hardware-frame filters as external
plugins. Streamee installs that result under the distinct name
`streamee-optiflow-mpv.exe`; it does not replace the normal player.
See [the Windows build record](BUILD-WINDOWS.md) for the local artifact hashes,
required compiler safeguards, dependency setup and release-source obligations.

## Local validation snapshot

**Superseded acceptance:** the throughput/interoperability results below did not
check full-resolution colour integrity. The strengthened probe now verifies
input upload, the shared input copy, and constant UV values in every returned
frame. `--run-gpu-probe <runtime> 1920 1080` and `3840 2176` fail the UV check;
the default 640x360 test passes. The padded height is not the sole cause.
Fence waits, keyed mutexes and alternate bindings did not resolve the failure;
those experimental changes were discarded. Re-enable native selection only
after full-resolution pixel tests and fresh in-app playback both pass.

On 2026-09-04 with an RTX 4090, driver 610.62, Windows HDR off, and the locally
imported SDK 5.0.7 runtime:

- The moving-pattern standalone probe returned five textures; four differed
  pixel-for-pixel from both adjacent inputs. One was marked as a driver repeat.
- A real 1080p D3D11 decode produced 143 outputs from 72 inputs and exited cleanly.
- OptiFlow followed by NVIDIA VSR produced 3840x2160 D3D11 NV12 output and exited
  cleanly after output allocation moved into FFmpeg's hardware-frame pool.
- Missing-runtime, software-decode, and P010 cases passed originals through and
  exited cleanly. P010 fallback is proven; PQ metadata was not present in that
  generated fixture, so this is not a PQ-validation claim.
- A seek reconstructed the native session and completed cleanly.
- A ten-second 4K/24 input produced 479 outputs from 240 inputs in 4.951 seconds
  (about 96.8 output frames/second) in an untimed isolated run. The same file
  through the production VapourSynth backend took 9.954 seconds.

These results establish interoperability and isolated throughput on one system.
They do not prove paced in-app presentation, visual quality across real content,
cross-GPU compatibility, or lower power consumption.
