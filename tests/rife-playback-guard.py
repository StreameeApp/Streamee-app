"""Exercise the playback guard without loading a TensorRT model."""

import ast
from pathlib import Path
from threading import Lock
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "mpv/scripts/streamee_rife.py"


class Clock:
    now = 0.0

    def __call__(self):
        return self.now


def load_guard(clock, core=None, vs=None):
    tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
    definitions = [node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef))
                   and node.name in {"RifePlaybackGuard", "guard_playback"}]
    assert len(definitions) == 2
    namespace = {"Lock": Lock, "monotonic": clock, "core": core, "vs": vs}
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


try:
    import vapoursynth as vs
except ImportError:
    vs = None


@unittest.skipIf(vs is None, "VapourSynth is optional on non-Windows test hosts")
class VapourSynthGuardTests(unittest.TestCase):
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
