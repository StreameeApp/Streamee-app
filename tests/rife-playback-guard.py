"""Exercise the playback guard without loading a TensorRT model."""

import ast
import json
import os
import tempfile
from pathlib import Path
from threading import Lock
import unittest
from types import SimpleNamespace


SCRIPT = Path(__file__).resolve().parents[1] / "mpv/scripts/streamee_rife.py"


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


def load_guard(clock, core=None, vs=None):
    tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
    definitions = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef))
                   and node.name in {"RifePlaybackGuard", "guard_playback", "frame_color_properties", "color_conversion_supported"}]
    assert len(definitions) == 4
    namespace = {"Lock": Lock, "monotonic": clock, "core": core, "vs": vs,
                 "matrix_names": dict.fromkeys((1, 4, 5, 6, 7, 9, 10, 12, 13, 14))}
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(SCRIPT), "exec"), namespace)
    return namespace


class PlaybackGuardTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.guard_type = load_guard(self.clock)["RifePlaybackGuard"]

    def warm_up(self, guard, multiplier=2, start=0, cold_first=0.0):
        duration = 1 / (24 * multiplier)
        first_generated = True
        for batch in range(start, start + 1200, 12):
            for n in range(batch, batch + 12):
                self.assertTrue(guard.request(n, duration))
            for n in range(batch, batch + 12):
                if n % multiplier:
                    self.clock.now += cold_first if first_generated and cold_first else 0.015
                    first_generated = False
                else:
                    self.clock.now += 0.001
                guard.complete(n)
                self.assertFalse(guard.recovering)
            if not guard.trial:
                return batch + 12
        self.fail("a healthy parallel pipeline must finish its startup/recovery trial")

    def overload(self, guard, multiplier=2):
        start = self.warm_up(guard, multiplier)
        n = start + 1
        self.assertTrue(guard.request(n, 1 / (24 * multiplier)))
        self.clock.now += 0.4
        guard.complete(n)
        self.assertTrue(guard.recovering)
        return n + 1

    def test_cold_start_does_not_disable_a_healthy_parallel_pipeline(self):
        for multiplier in (2, 3):
            guard = self.guard_type(multiplier, 2)
            self.warm_up(guard, multiplier, cold_first=1.8)
            self.assertFalse(guard.trial)
            self.assertFalse(guard.recovering)

    def test_healthy_playback_keeps_all_interpolation(self):
        for multiplier in (2, 3):
            for streams in (1, 2):
                guard = self.guard_type(multiplier, streams)
                duration = 1 / (24 * multiplier)
                for n in range(300):
                    self.clock.now = n * duration
                    self.assertTrue(guard.request(n, duration))
                    self.clock.now += 0.001
                    guard.complete(n)
                self.assertFalse(guard.recovering)
                self.assertFalse(guard.pending)

    def test_overload_skips_work_instead_of_extending_the_queue(self):
        guard = self.guard_type(2, 2)
        start = self.overload(guard)
        now = self.clock.now
        retry_at = guard.retry_at
        for n in range(start, start + 88):
            self.clock.now = now + (n - start) / 48
            self.assertFalse(guard.request(n, 1 / 48))
            guard.complete(n)
        self.assertEqual(guard.retry_at, retry_at, "fallback must not extend its own cooldown")

    def test_recovery_accepts_cold_latency_when_parallel_throughput_is_healthy(self):
        messages = []
        guard = self.guard_type(3, 2, report=messages.append)
        start = self.overload(guard, 3)
        self.clock.now = guard.retry_at + 0.01
        # A 140 ms isolated frame failed the old 33 ms recovery limit at 3x,
        # even though the warmed parallel pipeline can sustain playback.
        self.warm_up(guard, 3, start=start, cold_first=0.14)
        self.assertFalse(guard.recovering)
        self.assertFalse(guard.trial)
        self.assertEqual(len(messages), 2)

    def test_slow_retries_back_off_and_wait_for_old_work(self):
        guard = self.guard_type(2, 2)
        start = self.warm_up(guard)
        self.assertTrue(guard.request(start + 1, 1 / 48))
        self.assertTrue(guard.request(start + 3, 1 / 48))
        self.clock.now += 0.4
        guard.complete(start + 1)
        self.clock.now = guard.retry_at + 0.01
        self.assertFalse(guard.request(start + 5, 1 / 48), "old inference must drain before retrying")
        guard.complete(start + 5)
        guard.complete(start + 3)
        n = start + 7
        for delay in (4.0, 8.0, 15.0):
            self.clock.now = guard.retry_at + 0.01
            for _ in range(3):
                self.assertTrue(guard.request(n, 1 / 48))
                self.clock.now += 0.4
                guard.complete(n)
                n += 2
            self.assertTrue(guard.recovering)
            self.assertAlmostEqual(guard.retry_at - self.clock.now, delay)

    def test_pause_and_buffering_do_not_look_like_overload(self):
        guard = self.guard_type(2, 2)
        start = self.warm_up(guard)
        for n in range(start, start + 30):
            self.clock.now += 30.0
            self.assertTrue(guard.request(n, 1 / 48))
            guard.complete(n)
        self.assertFalse(guard.recovering)

    def test_slow_playback_does_not_accumulate_false_lateness(self):
        guard = self.guard_type(2, 2)
        start = self.warm_up(guard)
        now = self.clock.now
        for n in range(start, start + 240):
            self.clock.now = now + (n - start) / 24  # Half speed with a 48 fps output timeline.
            self.assertTrue(guard.request(n, 1 / 48))
            self.clock.now += 0.001
            guard.complete(n)
        self.assertFalse(guard.recovering)
        self.clock.now += 0.01
        self.assertTrue(guard.request(start + 241, 1 / 48))
        self.clock.now += 0.4
        guard.complete(start + 241)
        self.assertTrue(guard.recovering, "healthy playback must not bank unlimited time credit")

    def test_parallel_requests_and_completions_can_be_out_of_order(self):
        for multiplier in (2, 3):
            guard = self.guard_type(multiplier, 2)
            duration = 1 / (24 * multiplier)
            start = self.warm_up(guard, multiplier)
            now = self.clock.now
            for batch in range(start, start + 240, 12):
                self.clock.now = now + (batch - start) * duration
                order = [batch + i for i in (7, 4, 0, 11, 2, 6, 9, 5, 3, 1, 10, 8)]
                for n in order:
                    self.assertTrue(guard.request(n, duration))
                self.clock.now += 0.01
                for n in reversed(order):
                    guard.complete(n)
            self.assertFalse(guard.recovering)
            self.assertFalse(guard.pending)

    def test_late_input_while_other_work_is_pending_also_sheds_work(self):
        guard = self.guard_type(2, 2)
        start = self.warm_up(guard)
        self.assertTrue(guard.request(start, 1 / 48))
        self.clock.now += 0.3
        self.assertFalse(guard.request(start + 1, 1 / 48))
        guard.complete(start + 1)
        guard.complete(start)

    def test_half_speed_accepts_capacity_below_the_nominal_source_rate(self):
        guard = self.guard_type(2, 1)
        guard.set_speed(0.5)
        for group in range(120):
            self.clock.now = group / 12
            self.assertTrue(guard.request(2 * group, 1 / 48))
            self.assertTrue(guard.request(2 * group + 1, 1 / 48))
            self.clock.now += 0.001
            guard.complete(2 * group)
            self.clock.now += 0.06
            guard.complete(2 * group + 1)
            self.assertFalse(guard.recovering)
        self.assertFalse(guard.trial)

    def test_speed_changes_retest_a_previously_overloaded_pipeline(self):
        guard = self.guard_type(2, 1)
        self.overload(guard)
        guard.set_speed(0.5)
        self.assertFalse(guard.recovering)
        self.assertTrue(guard.trial)

    def test_variable_durations_can_arrive_out_of_order_without_false_lag(self):
        guard = self.guard_type(2, 2)
        start = self.warm_up(guard)
        self.assertTrue(guard.request(start + 11, 1 / 48))
        self.assertTrue(guard.request(start, 0.5))
        self.clock.now += 0.01
        guard.complete(start + 11)
        guard.complete(start)
        self.assertFalse(guard.recovering)

    def test_sustained_capacity_is_monitored_after_startup(self):
        guard = self.guard_type(2, 1)
        start = self.warm_up(guard)
        for n in range(start + 1, start + 80, 2):
            guard.request(n, 1 / 48)
            self.clock.now += 0.06
            guard.complete(n)
            if guard.recovering:
                break
        self.assertTrue(guard.recovering)


class ColorPropertiesTests(unittest.TestCase):
    def setUp(self):
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        definition = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                          and node.name == "frame_color_properties")
        namespace = {"vs": SimpleNamespace(MATRIX_BT709=1, RANGE_FULL=0, RANGE_LIMITED=1),
                     "matrix_names": {1: "709", 6: "170m", 9: "2020ncl"}}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), str(SCRIPT), "exec"), namespace)
        self.color = namespace["frame_color_properties"]

    def test_mpv_legacy_matrix_and_native_matrix_are_respected(self):
        self.assertEqual(self.color({"_ColorSpace": 9, "_ColorRange": 1}), (9, 1))
        self.assertEqual(self.color({"_ColorSpace": 6, "_ColorRange": 0}), (6, 0))
        self.assertEqual(self.color({"_Matrix": 6, "_ColorSpace": 9}), (6, 1))
        self.assertEqual(self.color({"_Matrix": 2, "_ColorSpace": 9}), (9, 1))

    def test_modern_range_and_unknown_metadata_have_safe_defaults(self):
        self.assertEqual(self.color({"_Range": 1, "_ColorRange": 1}), (1, 0))
        self.assertEqual(self.color({"_Range": 0}), (1, 1))
        self.assertEqual(self.color({"_ColorSpace": 999, "_ColorRange": 99}), (1, 1))
        self.assertEqual(self.color({}), (1, 1))

    def test_advanced_matrices_require_enough_metadata_to_convert_safely(self):
        fake_vs = SimpleNamespace(MATRIX_BT709=1, RANGE_FULL=0, RANGE_LIMITED=1)
        supported = load_guard(Clock(), vs=fake_vs)["color_conversion_supported"]
        for matrix in (10, 12, 13, 14):
            self.assertFalse(supported({"_ColorSpace": matrix}))
        self.assertTrue(supported({"_ColorSpace": 9}))
        self.assertTrue(supported({"_Matrix": 10, "_Transfer": 14}))
        self.assertTrue(supported({"_Matrix": 14, "_Transfer": 16, "_Primaries": 9}))


class PlaybackBridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.clock = Clock()
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        definition = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                          and node.name == "RifePlaybackBridge")
        namespace = {"os": os, "json": json, "tempfile": tempfile, "Lock": Lock,
                     "monotonic": self.clock, "wall_time": lambda: 1000 + self.clock.now}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), str(SCRIPT), "exec"), namespace)
        self.bridge = namespace["RifePlaybackBridge"](directory=self.directory.name, pid=123)
        self.guard = load_guard(self.clock)["RifePlaybackGuard"](2, 1)

    def control(self, **changes):
        value = {"pid": 123, "speed": 0.5, "updatedAt": 1000 + self.clock.now, **changes}
        Path(self.bridge.control_path).write_text(json.dumps(value), encoding="utf-8")

    def test_speed_updates_reject_stale_malformed_and_wrong_player_controls(self):
        self.control()
        self.assertEqual(self.bridge.speed(), 0.5)
        for changes in ({"pid": 456}, {"updatedAt": 0}, {"speed": float("nan")}):
            self.clock.now += 0.3
            self.control(**changes)
            self.assertEqual(self.bridge.speed(), 0.5)
        self.clock.now += 0.3
        Path(self.bridge.control_path).write_text("{", encoding="utf-8")
        self.assertEqual(self.bridge.speed(), 0.5)
        self.clock.now += 0.3
        self.control(speed=2)
        self.assertEqual(self.bridge.speed(), 2)

    def test_published_rates_and_fallback_counters_exclude_repeated_frames(self):
        self.bridge.publish(self.guard)
        for n in (1, 3, 5):
            self.guard.request(n, 1 / 48)
            self.clock.now += 0.4
            self.guard.complete(n)
        self.assertTrue(self.guard.recovering)
        self.assertFalse(self.guard.request(7, 1 / 48))
        self.guard.complete(7)
        self.bridge.publish(self.guard)
        status = json.loads(Path(self.bridge.status_path).read_text(encoding="utf-8"))
        self.assertEqual(status["mode"], "fallback")
        self.assertEqual(status["generatedFrames"], 3)
        self.assertEqual(status["fallbackFrames"], 1)
        self.assertAlmostEqual(status["generatedFps"], 3 / 1.2)
        self.assertEqual(status["sourceFps"], 0)
        self.assertFalse(Path(self.bridge.status_path + ".tmp").exists())


try:
    import vapoursynth as vs
except ImportError:
    vs = None


@unittest.skipIf(vs is None, "VapourSynth is optional on non-Windows test hosts")
class VapourSynthGuardTests(unittest.TestCase):
    def test_unsupported_hdr_metadata_bypasses_the_conversion_branch(self):
        clock = Clock()
        core = vs.core
        functions = load_guard(clock, core, vs)
        source = core.std.BlankClip(width=16, height=16, format=vs.YUV420P10, length=10)
        source = source.std.SetFrameProps(_ColorSpace=14)
        calls = []
        def should_not_run(n, f):
            calls.append(n)
            raise AssertionError("Incomplete ICtCp metadata must not enter RIFE conversion")
        interpolated = core.std.Interleave([source] * 2)
        interpolated = core.std.ModifyFrame(interpolated, clips=interpolated, selector=should_not_run)
        output = functions["guard_playback"](source, interpolated, 2, 2)
        for n in range(8):
            self.assertEqual(bytes(output.get_frame(n)[0]), bytes(source.get_frame(n // 2)[0]))
        self.assertEqual(calls, [])

    def test_lazy_fallback_preserves_pixels_properties_and_variable_durations(self):
        core = vs.core
        for multiplier in (2, 3):
            clock = Clock()
            functions = load_guard(clock, core, vs)
            source = core.std.BlankClip(width=16, height=16, format=vs.YUV420P8, length=60)

            def source_properties(n, f):
                frame = f.copy()
                frame.props["_DurationNum"] = 1 if n % 2 == 0 else 2
                frame.props["_DurationDen"] = 24
                frame.props["_Matrix"] = 9
                frame.props["_ColorRange"] = 1
                frame.props["SourceFrame"] = n
                return frame

            source = core.std.ModifyFrame(source, clips=source, selector=source_properties)
            generated = source.std.BlankClip(color=[235, 128, 128], keep=True)
            generated = core.std.CopyFrameProps(generated, source)
            calls = []

            def slow_inference(n, f):
                calls.append(n)
                clock.now += 0.4
                return f

            generated = core.std.ModifyFrame(generated, clips=generated, selector=slow_inference)
            interpolated = core.std.Interleave([source] + [generated] * (multiplier - 1))
            output = functions["guard_playback"](source, interpolated, multiplier, 2)
            total_duration = 0.0
            saw_fallback = False
            for n in range(48):
                frame = output.get_frame(n)
                expected = source.get_frame(n // multiplier)
                duration = frame.props["_DurationNum"] / frame.props["_DurationDen"]
                self.assertAlmostEqual(duration, expected.props["_DurationNum"] / 24 / multiplier)
                total_duration += duration
                self.assertEqual(frame.props["SourceFrame"], n // multiplier)
                self.assertEqual(frame.props["_Matrix"], 9)
                self.assertEqual(frame.props["_ColorRange"], 1)
                if n % multiplier and not saw_fallback and frame[0][0, 0] == 235:
                    continue
                if n % multiplier:
                    saw_fallback = True
                if saw_fallback or n % multiplier == 0:
                    self.assertEqual(bytes(frame[0]), bytes(expected[0]), "fallback must use source pixels")
            self.assertTrue(saw_fallback)
            self.assertEqual(calls, [0, 1, 2], "fallback must stop evaluating the slow inference branch")
            self.assertGreater(total_duration, 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
