# Build provenance and historical ABI 2 evidence

The compiler corrections and pinned dependency provenance below also apply to ABI 3. The old artifact hashes, SDK statements and acceptance snapshot are historical; current implementation and results are in [OptiFlow](../../docs/OPTIFLOW.md). Rebuild the player and bridge as a matched pair. Keep the unaligned-vector-move compiler correction.

## ABI 3 local artifacts, 2026-09-05

- `streamee-optiflow-mpv.exe`: SHA-256 `0981790FC1810EF99783806122215B8130B45E351412F75761D4055001AEB9A7`.
- `streamee_optiflow_d3d11.dll`: SHA-256 `837BB027B4AF9CCC5D29AF27BEEE3D53A82BCC5D9DEC7B2C516133F8F710F4A2`.
- zimg revision `67e0603271c080e22c8429856dd4a8a56587e61e` needed the same
  unaligned-vector safeguard: screenshot capture crashed at a `vmovdqa %ymm0`
  stack store in `GraphBuilder::impl::build_subgraph`. Rebuilt the pinned source
  in `winbuild-build/optiflow-zimg` with the corrected existing cross wrappers,
  `--host=x86_64-w64-mingw32 --disable-shared` and the existing install prefix.
  Stale graphengine objects from its source directory required forcing the
  `libzimg_internal.la` target to rebuild in the separate build directory.
  Relinked MPV; Dolby Vision screenshot capture and ten unit executables passed.
- Native ABI 2 player/bridge copies remain under
  `%LOCALAPPDATA%/streamee-optiflow-history/2026-09-05/abi2-*`.
- The previous ABI 3 player is preserved as `abi3-before-host-validation-mpv.exe`
  in that history directory. The current player adds metadata validation and
  corrects the distinction between Dolby Vision metadata loss and resource
  changes. CPU metadata/host checks passed; this artifact has not been through
  restarted GPU playback yet. The bridge and its shader defaults are unchanged.
- The current bridge compiles the two local NVOF interface headers, preserving
  notices, and embeds compiled custom HLSL. Former claims below that no headers
  are used refer only to the retired ABI 2 implementation.

# Local Windows player build (WIP)

**Restored for user-requested format testing (2026-09-04):** the native artifact
below was quarantined, then restored unchanged with automatic selection enabled.
It still produces corrupted NV12 chroma at 1080p/4K in isolated pixel probes.
The previous acceptance checks established cadence/interoperability, not colour
correctness. The compatibility backend and quarantined backup remain available.

This records the local development artifact validated on 2026-09-04. It is not
a release/redistribution clearance. The generated executable and bridge remain
local, ignored MPV assets, like the normal bundled player. NVIDIA SDK/runtime
files are not build inputs and must never be included in this bundle.

## Provenance

- MPV v0.41.0, upstream commit `41f6a645068483470267271e1d09966ca3b9f413`.
- Apply `mpv/mpv-v0.41.0.patch` and copy `mpv/vf_streamee_optiflow.c` and
  `include/bridge.h` using the overlay instructions in this directory's README.
- Windows dependency recipes: `shinchiro/mpv-winbuild-cmake`, commit
  `cd1edc11dc6887a50f705717619d879f5a93a488`.
- Private MSYS2 environment, cross GCC 14.4.0, Binutils 2.45.1, Meson 1.12.0.
- FFmpeg `818e5d965be955be8842ee3a4cdd7b43ab81661d`, reporting
  `N-126404-g818e5d965`, GPL version 3 or later.
- libplacebo reports `v7.371.0 (v7.360.0-124-g3330a51-dirty)` with the recipe's
  local dependency setup; libass 0.17.5.

Sources: <https://github.com/mpv-player/mpv>,
<https://github.com/shinchiro/mpv-winbuild-cmake>,
<https://github.com/FFmpeg/FFmpeg>, <https://code.videolan.org/videolan/libplacebo>.

Before public distribution, preserve the complete corresponding source,
dependency revisions, patches, build scripts and license notices for the actual
binary. Upstream links alone are not a substitute for that release work.

## Build-specific corrections

The private toolchain required `gettext-devel` and `python-jinja` in addition
to the recipe's normal build prerequisites. Its libvpl MSVC compatibility guard
was restricted to `defined(_MSC_VER) && _MSC_VER < 1400`. The host gperf fallback
needed explicit prototypes for `getenv`, `strncmp`, and `getopt` under C23.

FFmpeg was built without the unavailable `cuda_llvm` feature. D3D11VA, CUVID and
NVDEC remain enabled. MPV's `libavdevice` capture support is disabled to avoid
the static OpenAL/WASAPI duplicate-GUID link conflict; file/network playback,
WASAPI output and ordinary libavfilter processing remain available.

The GCC x86-64-v3 build emitted aligned AVX stack stores that crashed in both
MPV and libplacebo. Both were rebuilt with
`-Wa,-muse-unaligned-vector-move`. Keep that safeguard in the C/C++ compiler
wrappers for subsequent dependency builds too. Do not regenerate the wrappers
and silently discard it. CPU unit tests alone did not expose these GPU-path
crashes; baseline GPU playback is a required build acceptance check.

MPV v0.41.0 needs an import library for the existing `VSScript.dll` export
`getVSScriptAPI`; generate it with `dlltool` and link with `-lvsscript`. Do not
add a second VapourSynth runtime or any NVIDIA DLL to solve this link step.

The final Meson configuration uses the generated Windows cross file,
`--prefer-static --default-library=static`, optimization 3, LTO off, libmpv off,
build-date off, PDF/manpage generation off, tests on, libavdevice off, and
explicitly enables Lua, JavaScript, VapourSynth, SPIRV-Cross, Vulkan, OpenGL,
ANGLE, libarchive, libbluray, dvdnav, uchardet, rubberband, lcms2 and SDL2 gamepad.
C/C++ arguments include the unaligned-vector-move safeguard; C++ link arguments
include `-lvsscript`.

Once dependencies are installed, run the final FFmpeg/MPV steps directly.
Reconfiguring the top-level dependency generator can invalidate completed
download/patch stamps and trigger unnecessary rebuilds or patch reapplication.

## Artifact and acceptance snapshot

The stripped executable is installed locally as `mpv/streamee-optiflow-mpv.exe`,
beside `mpv/streamee_optiflow_d3d11.dll`; the normal `mpv.exe` is unchanged.

| Artifact | SHA-256 |
| --- | --- |
| `streamee-optiflow-mpv.exe` | `C7D10044E17E2D1FC673CACF7511A712B2C9966EC24756A8D2D3618F7574B4B6` |
| `streamee_optiflow_d3d11.dll` | `F1DAE6D465CB3B1928E1D26E172AB9CB43D0638B239F08B3751880CD05D903F7` |

Imports are Windows/graphics-driver libraries and the existing `VSScript.dll`,
not MSYS2 runtime DLLs. The normal MPV configuration was smoke-tested from the
bundle with script autoload disabled. Restarted full-app/script playback is a
separate acceptance step.
An additional isolated run explicitly loaded PlexOSC, the VSR controller, and
OptiFlow diagnostics without Lua errors; that is not a full app/session test.

Local checks passed: nine MPV unit executables; two bridge CTests; focused
native source contracts; baseline 1080p/4K; native 1080p; native followed by VSR
to 4K; missing-runtime/software/P010 fallback; seek; and ten consecutive 4K
start/stop cycles after retaining D3D11 for the native filter's process lifetime.
The stripped executable also passed the VSR chain and bundled-config smoke.

The ten-second 4K fixture produced 479 outputs from 240 inputs in about 5.1
seconds. Its generated outputs were driver repeats, so this is pipeline/cadence
and teardown evidence, not visual-quality or genuine-interpolation evidence.
The separate moving-pattern bridge probe remains the pixel-difference check.
Do not infer paced presentation, lower power, full HDR support, cross-GPU
compatibility, or release-wide dependency stability from these local probes.
