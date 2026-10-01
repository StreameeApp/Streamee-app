# GPU conversion experiment — 2026-09-04

## Conclusion

The GPU-only NV12 -> RGBA -> FRUC -> NV12 path is worth an integration
experiment. It passed the isolated colour/motion checks and was faster than
the existing VapourSynth/CUDA backend on matched synthetic input. No player,
bridge, setting, clock or power-profile changes were made by this experiment.
The existing native NV12 bug is not fixed by these results.

## Method

- RTX 4090, driver 610.62, user-imported Optical Flow SDK 5.0.7 runtime.
- Independent C++ program, compiled with MSVC `/O2`, uses the local SDK header.
  It is private diagnostic code, not a distributable app dependency.
- Same D3D11 device for both video-processor conversions and FRUC. Explicit
  BT.709 limited-range YCbCr and full-range RGB settings; automatic video
  processing disabled. Shared RGBA textures supplied to FRUC's ARGB mode.
- Synthetic 8-bit SDR textured image translated four pixels per source frame,
  at 25 fps. Constant U=96/V=160 and in-gamut luma values 96–145.
- Sixteen fixture frames prepared before timing. Each measured mode warms up
  for sixteen input frames, then records sixty-four samples. Two runs per size.
- The comparison uses the same generated pixels, motion, rate and warm-up in
  the bundled VapourSynth adapter; source frames are prepared before timing.
- Each timing includes synchronous GPU completion. The conversion path also
  includes video-view creation per operation, not a cached-view optimization.
- GPU fixture uploads and test-only pixel readbacks are excluded. Compatibility
  timings include that backend's inherent uploads/readbacks and frame handling.
- No media decoding, MPV presentation, VSR, HDR or power measurements are included.

## Timings

Milliseconds per input-frame step, producing one midpoint after priming:

| Size | Both conversions only | Full conversion + FRUC chain | Working compatibility backend |
| --- | --- | --- | --- |
| 1920x1080 | 0.152–0.168 | 3.740–3.775 | 5.242–5.300 |
| 3840x2160 | 0.254–0.256 | 9.246–9.455 | 15.058–15.801 |

Full-chain p95: 4.19–4.22 ms at 1080p, 10.02–10.31 ms at 4K.
The measured full-chain reduction is approximately 28–29% and 37–42%,
respectively. These are component benchmarks, not in-app speedup guarantees.
Do not subtract separately timed modes as precise GPU operation costs: clock
state and scheduling differ across modes.

## Pixel checks

- Textured fixture conversion round-trip: every byte unchanged at both sizes.
- All fifteen checked interior midpoints differed from both adjacent frames;
  FRUC reported no repeats in either sixty-four-frame full-chain timing sample.
- Interior midpoint luma matched the analytically expected two-pixel position:
  mean absolute error 0.0, versus about 4.15 for simply repeating a source frame.
  Border/disocclusion areas were excluded from this ideal-motion comparison.
- No checked UV byte differed from the expected constant by more than two
  8-bit code values. The working backend also generated a distinct midpoint
  with correct constant chroma in its checked final output.
- Separate coloured-box fixture: round-trip mean absolute errors 0.00771
  (1080p) and 0.00386 (4K), maximum 18 at chroma edges. This demonstrates that
  arbitrary coloured video is not guaranteed to round-trip losslessly. That
  fixture produced driver repeats and was not used for interpolation claims.

## Reproduction and remaining work

Private diagnostic files are under the physical directory:

```text
C:\Users\brian\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\streamee-mpv-dev
```

- `conversion-probe.cpp` / `conversion-probe.exe`: GPU conversion, full chain,
  direct RGBA FRUC timing, and pixel/motion checks. Arguments: absolute path
  to imported `NvOFFRUC.dll`, width, height.
- `conversion-compat.py`: matched compatibility timing. Run with bundled
  `mpv/python.exe`, followed by width and height.
- `fruc-direct-diagnostic.cpp`: earlier independent NV12/RGBA diagnostic.

Next acceptance should use actual decoded video, including padded decoder
textures, coloured motion and gradients, correct range/matrix metadata,
seeking, presentation and VSR. Measure power separately. Conversion needs
additional GPU buffers and bandwidth; this probe is not VRAM-use validation.
No 10-bit/HDR support or cross-GPU correctness is claimed.

Video-processor colour settings follow Microsoft's documentation:
[input colour space](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_1/nf-d3d11_1-id3d11videocontext1-videoprocessorsetstreamcolorspace1),
[output colour space](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_1/nf-d3d11_1-id3d11videocontext1-videoprocessorsetoutputcolorspace1).
