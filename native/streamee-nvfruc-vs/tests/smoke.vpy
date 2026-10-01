import os

import vapoursynth as vs

core = vs.core
plugin_path = os.environ["STREAMEE_NVFRUC_PLUGIN"]
runtime_path = os.environ["STREAMEE_NVFRUC_RUNTIME"]

if not hasattr(core, "streamee_nvfruc"):
    core.std.LoadPlugin(path=plugin_path)
frames = []
for x in range(0, 256, 32):
    box = core.std.BlankClip(
        width=64,
        height=64,
        format=vs.YUV420P8,
        length=1,
        fpsnum=24,
        fpsden=1,
        color=[220, 128, 128],
    )
    frames.append(core.std.AddBorders(box, left=x, right=576 - x, top=148, bottom=148, color=[32, 128, 128]))
source = core.std.Splice(frames, mismatch=False)
source = core.std.SetFrameProps(source, _DurationNum=1, _DurationDen=24)
if os.environ.get("STREAMEE_NVFRUC_SOURCE_ONLY") == "1":
    source.set_output()
else:
    interpolated = core.streamee_nvfruc.FrameRate2x(source, runtime=runtime_path)
    interpolated.set_output()
