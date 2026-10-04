# Custom OptiFlow — implementation and acceptance

OptiFlow is experimental. NVFRUC quality parity and the 16.7 ms 4K interpolation
budget have **not** passed acceptance. Shader defaults remain provisional.

## Occlusion follow-up (RTX 4090, 2026-10-03)

The user reported broken/ghosted limb and pedal edges in the development build.
The exact online sequence was unavailable, so this pass uses an analytic dark
moving silhouette against a bright patterned background with thin rails, a
public Blender teaser and two short extracts from authorized local media.
The earlier quality/memory follow-up below is the baseline for these comparisons.

Three reconstruction changes address boundary errors: distant repaired flow
seeds must also fit the receiving pixel's motion; conflicting warped Y/UV
surfaces choose the better endpoint match; and uncovered pixels identical in
both endpoints retain their detail rather than a distant hole-fill average.
The disagreement threshold remains conservative after tighter thresholds
regressed footage. A second scene-cut condition combines broad encoded-luma
change with less than 10% reliable flow coverage, catching moderate-range cuts
that the earlier bright-cut thresholds missed. It uses the same four scalar
GPU counters and adds no playback pixel readback.

| Padded 1080p P010 moving silhouette | Earlier follow-up | This follow-up |
| --- | ---: | ---: |
| Full-frame luma MAE | 6.85157 | 0.34165 |
| Changing-pixel luma MAE | 7.43709 | 4.19489 |
| Changing pixels with error above 8% of encoded range | 23,912 | 13,761 |

The severe-error count falls 42.5%; it does not reach zero. MAE uses native
ten-bit code values. NV12 silhouette MAE is 0.08010 versus blending 0.92624.
The saved `occlusion-comparison.png` shows the identical synthetic midpoint,
reference and before/after reconstruction; it is not the user's online scene.

Held-out decoded footage uses 59 consecutive frames, feeding even frames and
comparing synthesis to the real odd frames. This doubles endpoint motion
relative to ordinary playback and does not validate dynamic HDR metadata.
The deliberately inserted metadata-hold pair is excluded from quality totals.

| Extract | Earlier luma MAE | This luma MAE |
| --- | ---: | ---: |
| Public Blender teaser, 1280×720 NV12 | 0.69024 | 0.68694 |
| Local 900-second extract, 1920×804 P010, continuous pairs | 1.34285 | 1.33795 |
| Local 1800-second extract, 1920×804 P010 | 4.07743 | 3.96177 |

The public fixture is from [Blender's demo archive](https://download.blender.org/demo/movies/elephantsdream_teaser.mp4.zip).
Original local media remains unchanged. Pair 20 of the 900-second extract is a
verified hard cut and is evaluated separately: the new guard holds the earlier
source rather than inventing an intermediate scene. Its odd reference is already
in the next shot, so including that hold in continuous-motion MAE is misleading.
Large-error pixels fall from 6,391 to 5,044 on the public extract, but rise from
390,421 to 397,747 (1.9%) on the 1800-second extract despite lower average error.
These are modest, mixed footage gains; broad visual acceptance remains open.

All eleven GPU quality cases and three native CPU CTests pass. Stationary
NV12/P010 chroma stays exact and P010 packing has zero invalid low bits. The
new moderate-range cut regression fails the earlier implementation and passes
this one. Native 4K allocation remains 625,539,264 bytes. Preloaded 4K P010,
100 warmed submissions: wall p50/p95/p99 changes from 31.521/32.121/32.500 ms
to 31.401/32.574/46.641 ms; GPU-span p95 changes from 26.600 to 29.796 ms.
Scheduling and the tail outlier prevent a speed-improvement claim; the 16.7 ms
budget remains failed.

Final isolated paced playback exits successfully, retains P010/BT.2020/PQ,
and drains 360 inputs to 719 outputs with 359 synthesized, zero held/bypassed,
zero decoder drops and three renderer drops. Pause/resume and all three exact
seeks also complete with synthesis restored. These short checks do not prove
sustained playback, panel HDR, audio sync or the exact reported scene.

The development DLL is staged beside the unchanged ABI 3 player. The installed
app is unchanged; a fresh playback process is needed to load the updated DLL.
Bridge SHA-256: `46893143649CCA331D3529FBE33E4DBA9813876360A582BF3BB438E0AF3B78BE`.
Local logs, raw extracts and captures: `%TEMP%/streamee-optiflow-occlusion-20261003`.

## Earlier quality and memory follow-up (RTX 4090, 2026-10-03)

The previous subpixel failure reproduced with the unchanged bridge. Its coarse
short-motion search sometimes selected a neighbouring local minimum, and the
single refinement could not recover the small motion. Refinement now also starts
at zero when the coarse candidate differs from zero, then selects the better
photometric match with the existing short-motion tie rule. The hardware quality
preset and confidence/metadata policies remain unchanged.

Ground-truth pixel probes compare the same input pair and analytic midpoint:

| Padded 1080p P010 fixture | Previous MAE | Current MAE | Blending MAE |
| --- | ---: | ---: | ---: |
| Horizontal 1.5-pixel motion | 1.11995 | 0.29845 | 0.44756 |
| Horizontal -1.5-pixel motion | 1.16018 | 0.29939 | 0.44768 |
| Horizontal 2.5-pixel motion | 0.57521 | 0.29659 | 1.13415 |
| Diagonal motion (1.5, 1 pixels) | 0.88162 | 0.38643 | 1.11654 |
| Diagonal moving chroma | 0.51042 | 0.25558 | 0.26201 |

These errors are native ten-bit code values, not perceptual scores. The moving
occluder/thin-object full-frame MAE stayed effectively unchanged (0.48745 to
0.48723); changing-pixel MAE changed slightly from 4.47835 to 4.48395. The
0.5-pixel fixture still loses to blending (0.29830 versus 0.25038). Integer
translations and borders, complex footage and broad visual acceptance remain
separate from the improved subpixel cases.

The final hole-fill upsample is fused into packing. It resolves the same fine
pixel and coarse sample without allocating or writing another full-resolution
RGBA32F texture. Captured subpixel and occlusion midpoint luma is byte-identical
before/after this fusion. Stationary varying chroma remains exact at padded
1080p NV12/P010 and native 4K P010, with zero invalid packing. Native 4K P010
bridge allocation falls from 758,249,664 to 625,539,264 bytes, saving 126.6 MiB
(17.5%) without lowering texture precision.

Preloaded 4K P010 probes, 100 warmed submissions at automatic clocks: unchanged
baseline wall p50/p95/p99 was 31.623/32.708/32.841 ms; final was
31.366/32.295/32.865 ms. GPU-span p95 was 23.331 versus 28.406 ms. Scheduling
varied, so this does **not** establish an end-to-end speed improvement. The
16.7 ms stage budget remains failed. Pixel-probe timing includes readback and
idle power transitions and must not be substituted for these preloaded probes.

Three native CPU CTests and the nine-case explicit GPU quality suite passed.
The suite adds reverse/subpixel/diagonal motion, moving chroma, stationary
chroma, occlusion/thin-object and 4K checks. The new better-than-blending gate
fails the original 1.5-pixel implementation and passes the current one. Optional
16-bit PGM captures retain the generated midpoint and analytic ground truth.

Isolated minimized `gpu-next` playback with the existing ABI 3 player and new
bridge drained 240 NV12 inputs to 479 outputs and 360 P010 inputs to 719 outputs,
with no held/bypassed midpoints or decoder drops. Pause/resume and three exact
seeks completed with synthesis restored after each. A separately FFprobe-verified
synthetic BT.2020/PQ ten-bit clip retained P010/BT.2020/PQ and also drained
360 inputs to 719 outputs. These are short signal/lifecycle checks, with renderer
drops; they are not sustained zero-drop, mastered HDR, panel or A/V proof.
The older local fixture named `motion4k10.mp4` is actually eight-bit H.264;
its run is NV12 evidence only. Classification uses decoded properties, not names.

At this earlier checkpoint the development bridge was staged beside the
unchanged ABI 3 player; the installed application retained its previous bridge. No app restart,
installation, display/clock setting changes or Git delivery were performed.
Earlier bridge SHA-256: `9139F547B26913A1642EF9AC7E90AC4A648C4C0D50F120CEA20EF056084360D6`.
Local detailed logs/captures: `%TEMP%/streamee-optiflow-quality-20261003`.

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
