"""Compare optimized output with the separately built scalar profiling adapter."""
import os
import vapoursynth as vs

core = vs.core
if not hasattr(core, 'streamee_nvfruc'):
    core.std.LoadPlugin(path=os.environ['STREAMEE_NVFRUC_PLUGIN'])
core.std.LoadPlugin(path=os.environ['STREAMEE_NVFRUC_PROFILE_PLUGIN'])
frames = []
for n in range(8):
    box = core.std.BlankClip(width=256, height=256, length=1,
                            format=vs.YUV420P8, fpsnum=24,
                            color=[80 + n * 15, 30 + n * 20, 220 - n * 20])
    frames.append(core.std.AddBorders(box, left=n * 32, right=3584 - n * 32,
                                     top=952, bottom=952, color=[32, 128, 128]))
source = core.std.Splice(frames)
runtime = os.environ['STREAMEE_NVFRUC_RUNTIME']
baseline = core.streamee_nvfruc_profile.FrameRate2x(source, runtime=runtime)
optimized = core.streamee_nvfruc.FrameRate2x(source, runtime=runtime)
assert baseline.num_frames == optimized.num_frames == 15
assert baseline.fps == optimized.fps == 48
for n in range(15):
    with baseline.get_frame(n) as old, optimized.get_frame(n) as new:
        for plane in range(3):
            assert bytes(old[plane]) == bytes(new[plane]), (n, plane)
optimized.set_output()
