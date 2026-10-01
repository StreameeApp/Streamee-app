"""Exercise a real runtime-load failure without requiring unsupported hardware."""
import os
import tempfile

import vapoursynth as vs

core = vs.core
if not hasattr(core, "streamee_nvfruc"):
    core.std.LoadPlugin(path=os.environ["STREAMEE_NVFRUC_PLUGIN"])
source = core.std.BlankClip(width=640, height=360, format=vs.YUV420P8,
                           length=8, fpsnum=24, color=[64, 128, 128])
with tempfile.TemporaryDirectory(prefix="streamee-nvfruc-fallback-") as empty_runtime:
    result = core.streamee_nvfruc.FrameRate2x(source, runtime=empty_runtime)
    assert result.num_frames == source.num_frames
    assert result.fps == source.fps
    for n in range(result.num_frames):
        with result.get_frame(n) as actual, source.get_frame(n) as expected:
            for plane in range(3):
                assert bytes(actual[plane]) == bytes(expected[plane])
result.set_output()
