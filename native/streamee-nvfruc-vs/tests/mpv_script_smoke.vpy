import builtins
import os

import vapoursynth as vs

core = vs.core
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

builtins.video_in = core.std.Splice(frames, mismatch=False)
script_path = os.environ["STREAMEE_NVFRUC_MPV_SCRIPT"]
with open(script_path, "rb") as script_file:
    exec(compile(script_file.read(), script_path, "exec"), globals())
