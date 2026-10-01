"""Explicit standalone test; never opens media or changes clocks/player settings.

Requires STREAMEE_NVFRUC_PLUGIN and STREAMEE_NVFRUC_RUNTIME. Tests production
Python routing, exact original frames, rational rates, and HDR metadata bypass.
This excludes MPV format negotiation, display rendering, VSR and RTX HDR.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import time

import vapoursynth as vs

parser = argparse.ArgumentParser()
parser.add_argument("--performance", action="store_true",
                    help="Also process 240 moving 4K frames; run with playback stopped")
parser.add_argument("--performance-only", action="store_true",
                    help="Only the 240-frame 4K probe, for alternating adapter comparisons")
parser.add_argument("--fingerprint", action="store_true",
                    help="Hash all output planes, including generated frames, for A/B parity")
args = parser.parse_args()
# Standalone diagnostics must never send samples into the desktop player.
os.environ.pop("STREAMEE_NVFRUC_STATS_PIPE", None)


class TestEnvironment(vs.EnvironmentPolicy):
    # Do not accidentally benchmark the older bundled adapter via auto-loading.
    def on_policy_registered(self, api):
        self.api = api
        self.environment = api.create_environment(vs.DISABLE_AUTO_LOADING)

    def get_current_environment(self):
        return self.environment

    def set_environment(self, environment):
        previous = self.environment
        self.environment = environment
        return previous

    def on_policy_cleared(self):
        pass


policy = TestEnvironment()
vs.register_policy(policy)
core = vs.core
core.std.LoadPlugin(path=os.environ["STREAMEE_NVFRUC_PLUGIN"])
assert Path(core.streamee_nvfruc.plugin_path).resolve() == Path(os.environ["STREAMEE_NVFRUC_PLUGIN"]).resolve()
script = Path(__file__).resolve().parents[3] / "mpv/scripts/streamee_nvfruc.py"
messages = []


def message(_level, text):
    if "STREAMEE_OPTIFLOW " in text:
        messages.append(json.loads(text.split("STREAMEE_OPTIFLOW ", 1)[1]))


handler = core.add_log_handler(message)


def check(width, height, fmt, fpsnum, fpsden, transfer=1, frames=6):
    messages.clear()
    depth = core.get_video_format(fmt).bits_per_sample
    scale = 1 << (depth - 8)
    clips = []
    for n in range(frames):
        offset = (n * 16) % (width - 128)
        box = core.std.BlankClip(width=128, height=128, length=1, format=fmt,
                                fpsnum=fpsnum, fpsden=fpsden,
                                color=[180 * scale, 96 * scale, 160 * scale])
        clips.append(core.std.AddBorders(box, left=offset, right=width-128-offset,
                                         top=0, bottom=height-128,
                                         color=[32 * scale, 128 * scale, 128 * scale]))
    source = core.std.SetFrameProps(core.std.Splice(clips), _Transfer=transfer,
                                   _Primaries=9 if transfer in (16, 18) else 1,
                                   _Matrix=9 if transfer in (16, 18) else 1,
                                   _ColorRange=1, _DurationNum=fpsden, _DurationDen=fpsnum)
    routed = runpy.run_path(str(script), init_globals={"video_in": source})
    output = routed["smooth"]
    supported = fmt == vs.YUV420P8
    assert output.num_frames == (frames * 2 - 1 if supported else frames)
    assert output.fps == source.fps * (2 if supported else 1)
    started = time.perf_counter()
    processing_seconds = 0.0
    fingerprint = hashlib.sha256() if args.fingerprint else None
    for n in range(output.num_frames):
        before_frame = time.perf_counter()
        frame = output.get_frame(n)
        processing_seconds += time.perf_counter() - before_frame
        with frame as actual:
            if fingerprint:
                for plane in range(3):
                    fingerprint.update(bytes(actual[plane]))
            assert actual.props["_Transfer"] == transfer
            assert actual.props["_Primaries"] == (9 if transfer in (16, 18) else 1)
            assert actual.props["_Matrix"] == (9 if transfer in (16, 18) else 1)
            assert actual.props["_ColorRange"] == 1
            assert actual.props["_DurationDen"] == fpsnum * (2 if supported else 1)
            if not supported or n % 2 == 0:
                with source.get_frame(n // 2 if supported else n) as expected:
                    for plane in range(3):
                        assert bytes(actual[plane]) == bytes(expected[plane]), (n, plane)
    elapsed = time.perf_counter() - started
    states = [item["state"] for item in messages]
    assert ("active" in states) if supported else (states == ["unsupported-format"]), states
    assert not any(state.startswith("fallback") for state in states), states
    print(json.dumps({"size": f"{width}x{height}", "format": core.get_video_format(fmt).name,
                      "fps": f"{fpsnum}/{fpsden}", "transfer": transfer,
                      "result": "FRUC processed (see repeat count)" if supported else "unchanged",
                      "seconds": round(elapsed, 3), "frameRequestSeconds": round(processing_seconds, 3),
                      "sha256": fingerprint.hexdigest() if fingerprint else None,
                      "lastTelemetry": messages[-1]}), flush=True)
    vs.clear_outputs()


try:
    if not args.performance_only:
        for rate in ((24000, 1001), (24, 1), (25, 1), (30000, 1001), (30, 1), (60, 1)):
            check(1920, 1080, vs.YUV420P8, *rate)
        check(3840, 2160, vs.YUV420P8, 24, 1)
        for transfer in (1, 16, 18):  # SDR, PQ, HLG: retain 10-bit pixels and metadata.
            check(1920, 1080, vs.YUV420P10, 24000, 1001, transfer)
        check(1920, 1080, vs.YUV444P8, 24, 1)
    if args.performance or args.performance_only:
        check(3840, 2160, vs.YUV420P8, 24, 1, frames=240)
finally:
    core.remove_log_handler(handler)
    vs.clear_outputs()
    policy.api.destroy_environment(policy.environment)
    policy.api.unregister_policy()
