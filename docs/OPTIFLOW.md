# Custom OptiFlow — implementation and acceptance

OptiFlow is experimental. NVFRUC quality parity and the 16.7 ms 4K interpolation
budget have **not** passed acceptance. Shader defaults remain provisional.

## Runtime

The custom MPV v0.41.0 filter borrows FFmpeg's D3D11 decoder device and lock.
Bridge ABI 3 receives resource extent, visible crop, chroma location, colour
interpretation, source timestamps, array slices, eligibility and destination.
It loads only the driver-installed `nvofapi64.dll` using the system-library
search. The two NVOF interface headers retain their original notices. No SDK
sample, NVFRUC DLL or CUDA runtime is in the production loading chain.

The bridge copies NV12/P010 decoder slices into reusable shader resources.
Full-resolution 8-bit luma analysis supplies motion only. Bidirectional NVOFA
uses the slow quality preset, a queried 4×4 grid and confidence costs. Local
photometric refinement, consistency validation, edge-guided flow propagation,
dense expansion, inverse midpoint warping and multiscale hole repair run in
build-time compiled HLSL. Original encoded Y/UV signals supply output colour;
P010 quantizes once to ten bits and clears the unused six bits. Only four
scene-cut control counters are mapped; playback never transfers CPU pixels.

Scene cuts discard synthesis and copy the earlier source. Cuts, metadata holds,
seeks and discontinuities reset temporal hints. GPU timestamp spans include
driver scheduling and synchronization; they are not isolated kernel timings.
One lookahead emits each original followed by its timestamp midpoint, drains
the last original once, and keeps its final source duration.

MPV owns metadata. HDR10/HLG preserve the source signal and interpretation.
Compatible generated frames retain static metadata. Dolby Vision compares
active decoded reshape fields; enhancement-layer reconstruction is unsupported.
HDR10+ compares canonical T.35 payloads, accepts recognized single-window
metadata, and rejects unsupported versions or spatial maps. Changing, missing
or unsupported dynamic metadata holds the earlier frame with its metadata.
This does not add Dolby Vision or HDR10+ display signalling to the renderer.

OptiFlow stays ahead of upscaling. The VSR controller bypasses its NV12-forcing
stage for high-precision and native/dynamic HDR. RTX HDR remains limited to
eligible SDR. Settings migrates old enable/clock values only when the new key
is absent. Clock control remains explicit and opt-in; measurements use automatic
clocks. Missing assets, ABI mismatch, unsupported input and engine failures
preserve ordinary playback, without the former VapourSynth FRUC fallback.

## Local evidence (RTX 4090, 2026-09-05)

- 157 frontend tests passed; focused Rust and native C ABI/input checks passed.
- Native padded 1080p and 4K NV12/P010 probes checked borrowed originals,
  constant chroma, ten-bit packing, rational midpoint times, metadata holds
  and scene cuts. Final 4K P010 known 4-pixel translation MAE was 0.00032 code
  values, versus repetition 16.92864 and blending 2.84947. This periodic fixture
  is narrow and does not establish general interpolation quality.
- Preloaded 4K P010 GPU fixtures, 100 warmed samples: wall p50 31.086 ms,
  p95 32.057 ms, p99 32.584 ms; GPU-span p95 25.942 ms. Target is missed.
  Allocated bridge textures use about 758 MB at native 4K and 764 MB with
  decoder padding to 2176 rows, excluding decoder/renderer allocations.
- Ten-second 4K30 PQ-tagged synthetic playback: P010/BT.2020/PQ retained,
  300 inputs → 599 outputs, 299 synthesized, zero held/bypassed, five renderer
  drops. The fixture is a signal/metadata exercise, not mastered HDR artwork.
- Five-minute 4K30 PQ + audio, minimized `gpu-next`, automatic clocks:
  9,000 inputs → 17,999 outputs, 8,999 synthesized, zero held/bypassed,
  zero decoder drops and one renderer drop (unchanged after startup).
  Bridge allocation stayed at 763,863,744 bytes. Maximum sampled A/V error
  was 0.688 ms; last timestamp sample was 299.633 s; elapsed 301.735 s including
  startup. Sampled GPU-span p95 after warmup was 25.283 ms, so the stage budget
  remains unmet. This test predates the varying-chroma reconstruction correction.
- Varying-chroma stationary P010 at padded 1080p passed with exact generated
  luma/chroma and zero invalid packing after reconstructing UV directly at
  source chroma sites. Ten pinned MPV unit executables passed, including
  semantic Dolby Vision/HDR10+ comparison and conservative version/bounds tests.

## Validation still required before acceptance

### Latest ABI 3 checks

The final varying-chroma/subpixel build completed five-minute 4K30 PQ playback:
9,000 inputs → 17,999 outputs, 8,998 synthesized and one scene-cut hold. Three
renderer drops, zero decoder drops, stable 763,863,744-byte bridge allocation;
sampled A/V error after five seconds stayed below 0.955 ms. GPU-span p95/p99
were 29.253/30.035 ms. This misses the stage budget and is not zero-drop proof.

User-supplied local dynamic-HDR samples were verified with FFprobe, rather than
classified by filename. A 3840×1608 Dolby Vision + HDR10+ sample ran for 60
seconds with zero drops, 1,415 synthesized midpoints and 25 metadata holds
(98.26% of computed midpoints synthesized). A separate 3840×2160 Dolby Vision
sample completed with 1,423 synthesized and 16 holds (98.89%), but recorded
66 renderer drops and sampled A/V error up to 39.4 ms after warmup. Full-frame
Dolby Vision performance acceptance therefore fails. No enhancement-layer or
dynamic display-signalling claim is made.

Screenshot capture initially crashed in pinned zimg at an aligned AVX stack
store (`GraphBuilder::impl::build_subgraph`). Rebuilding the same zimg revision
`67e0603271c080e22c8429856dd4a8a56587e61e` with the existing
`-Wa,-muse-unaligned-vector-move` correction fixed the capture repro. Baseline
and interpolated `gpu-next` screenshots showed consistent colour. The images
were sampled at different moments and are not motion-quality comparison proof.

Additional fixed fixtures: stationary varying chroma is exact at padded 1080p
and native 4K P010, and padded 1080p NV12. A moving occluder plus thin object
at 1080p P010 has full-frame MAE 0.48745 versus repetition 4.88478 and blend
3.25791; within changing pixels, 4.47835 versus 47.06861/31.39246. Subpixel
1.5-pixel translation has MAE 1.11995 versus repetition 6.37804 and blend
0.44756, so it still fails to beat blending. These failures remain explicit
acceptance gaps, not accepted tuning defaults.

### Restarted application and lifecycle checks

The rebuilt development app detected driver API 80 and the custom player/bridge
pair. Saved enable and optional clock values matched the legacy preferences.
Playback launched through the app's local-stream command selected the custom
player, synthesized P010 midpoints on a Dolby Vision + HDR10+ sample, and
bypassed the NV12-forcing VSR stage. Source/output colour properties matched,
including Dolby Vision interpretation, PQ, BT.2020 and scene metadata.

Pause held the timestamp; resume and three exact seeks to 20, 5 and 35 seconds
resumed synthesis. There was one initial renderer drop, then zero recorded
drops after each seek reset. These counters reset on seek, so this is lifecycle
evidence, not a zero-drop sustained-playback result. Windows HDR was enabled
during the initial run, switched off through the player observer, and remained
off for a fresh player launch. A window screenshot was inspected for colour
corruption. Panel luminance, HDR signalling and a complete paced HDR-on/off
acceptance matrix remain unverified. Direct command-driven launches must start
the player observer to exercise the application's HDR controls.

Two detached development launches exited unexpectedly; holding the launcher
open for exit-code capture allowed baseline and repeated OptiFlow launches to
remain active. No crash cause was established. The original playback settings
were restored after the checks, including the disabled OptiFlow preference,
and Windows HDR was returned to its initial off state.

The repeatable `seek` probe now verifies a stable paused timestamp, resume and
three completed seeks with active synthesis after each. It passed on 4K P010
HLG. A separate uninterrupted HLG run drained 300 inputs to 599 outputs, with
299 synthesized midpoints and retained HLG/BT.2020 properties. These short runs
do not replace five-minute throughput acceptance.

Current automated checks: 157 frontend tests, 140 Rust tests (two ignored),
two native CTests and the frontend production build passed. A synchronization
experiment removing the post-flow host wait changed 4K submission p95 from
32.101 to 32.150 ms; it was reverted because end-to-end latency did not improve.
The staged playback binaries retain their recorded hashes.

An isolated medium-preset build was tested after the user paused their game.
Its 100-sample 4K submission p95 was 31.666 ms, still above budget. Subpixel
MAE increased to 1.28994 (quality preset: 1.11995); moving-occluder full-frame
MAE increased to 0.56742 (quality preset: 0.48745). Varying-chroma identity was
exact for padded 1080p NV12 and native 4K P010, with no packing errors. The game
remained open and the pixel probes had large timing outliers, so these runs
are screening results, not an uncontended performance comparison. The medium
preset was not promoted; the production source still selects the quality preset.

The full withheld-ground-truth suite must include subpixel motion, occlusions,
thin objects, borders, gradients and varied chroma, with visual review and the
historical NVFRUC reference. The sample-based dynamic HDR checks and metadata
lifetime unit checks cover only the described cases. Five-minute paced SDR/HDR
runs, full A/V/drop analysis, complete restarted playback controls and Windows
HDR on/off acceptance remain separate from builds and isolated player probes. Do not
infer acceptance from doubled frame counts or the narrow translation result.

## Build and reproduction

### Completed without GPU playback

The latest source review and CPU checks found and fixed these issues:

- Preflight now reports missing files accurately even when stale asset paths
  exist. Missing assets skip driver-library loading entirely.
- HDR10+ fields are validated and normalized before calling the pinned FFmpeg
  serializer, which otherwise divides by unchecked denominators. Invalid
  bounds, zero denominators, nonrepresentable values and unsupported flags
  conservatively hold. Equivalent large rationals avoid integer overflow.
  The pinned decoder's zero country-code member remains compatible with its
  validated outer T.35 header.
- Dolby Vision rejects non-finite active coefficients and invalid pivots.
  Loss/change of its mapping now compares the underlying source interpretation
  for resource reconstruction, while requiring the effective interpretation
  for synthesis. Missing mapping therefore holds instead of dropping a midpoint.
- Closed sessions report zero allocated bytes. Removed filters clear stale
  diagnostics. Optional clock control now requires native `active` state,
  so a loaded filter that is bypassing cannot trigger clock locking.

The production filter's scheduling code is compiled into a CPU-only test
harness with fake bridge/resource callbacks. It passes rational rates
(24000/1001, 24, 25, 30000/1001, 30), variable timestamps, first/last frames,
final duration, `2N-1` natural drain, metadata holds, caption deduplication,
format/colour/device transitions, out-of-order/gapped timestamps, unsupported
input recovery, initialization/processing/allocation failure, backpressure,
queued-frame cleanup, reset recovery and 64 repeated lifecycles. The real
D3D operations and driver errors are deliberately not simulated as hardware proof.

Expanded pinned MPV metadata tests pass active/inactive Dolby Vision polynomial
and MMR data, missing/raw-only/unsupported HDR metadata, HDR10+ serialization
bounds, equivalent rationals and AVBuffer lifetime. A bounded software decoder
read 120 frames from each authorized local sample through the actual MPV image
conversion. The combined Dolby Vision/HDR10+ sample had 117 compatible pairs
and two metadata changes; the Dolby Vision sample had 118 compatible pairs and
one change. Neither had unsupported pairs. These are policy coverage counts,
not actual synthesized output or display-signalling measurements.

Current validation: 157 frontend tests, 142 Rust tests (two ignored), three
native CTests, ten pinned MPV CPU unit executables, frontend production build,
Rust development build and custom MPV build passed. The clock tests execute no
driver commands. Obsolete ABI 2 source-text tests were preserved in local
history and replaced by the executable host tests.

The current player artifact includes these fixes and is staged locally; its
hash is in the build record. Earlier playback numbers above belong to the
previous player. No GPU playback, benchmarks, Windows HDR toggles, real clock
changes or game interruption occurred during this CPU-only work.

Still requiring a separate live session: visual motion quality and NVFRUC
comparison; sustained SDR/P010/HDR playback with all downstream enhancements;
GPU resource transitions and actual unavailable-driver/device-loss paths;
restarted settings/diagnostics and clock elevation/cleanup; panel HDR behaviour;
and reproducing the two unexplained detached app exits with exit-code capture.
Review of Windows application events found only informational WebView messages,
not a crash report establishing their cause. Performance and quality acceptance
remain failed/pending as described above.

See [native build instructions](../native/streamee-nvfruc-d3d11/README.md) and
[pinned player/toolchain corrections](../native/streamee-nvfruc-d3d11/BUILD-WINDOWS.md).
The directory retains its historical name to preserve local build paths.
Historical results are retained in `NVFRUC-*.md`. Retired local adapter/runtime
files were preserved outside production assets under
`%LOCALAPPDATA%/streamee-optiflow-history/2026-09-05`; the user's imported SDK
runtime remains untouched and is not loaded by playback.

Architecture reference: [NVIDIA FRUC sequence](https://docs.nvidia.com/video-technologies/optical-flow-sdk/nvfruc-programming-guide/index.html),
[NVOFA interface](https://docs.nvidia.com/video-technologies/optical-flow-sdk/nvofa-programming-guide/index.html),
[DXGI plane formats](https://learn.microsoft.com/en-us/windows/win32/api/dxgiformat/ne-dxgiformat-dxgi_format).
