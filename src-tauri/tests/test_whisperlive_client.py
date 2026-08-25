import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "src" / "whisperlive_client.py"
SPEC = importlib.util.spec_from_file_location("streamee_whisperlive_client", MODULE_PATH)
CLIENT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(CLIENT)


class WhisperLiveClientTests(unittest.TestCase):
    def test_rollover_waits_for_a_voice_gap(self):
        now = 1000.0
        self.assertFalse(CLIENT.should_rollover(239.9, now, now))
        self.assertFalse(CLIENT.should_rollover(240.0, now - 10.0, now))
        self.assertTrue(CLIENT.should_rollover(240.0, now - 1.0, now))
        self.assertTrue(
            CLIENT.should_rollover(
                CLIENT.MAX_SESSION_AUDIO_SECS + CLIENT.MAX_SESSION_OVERRUN_SECS,
                0.0,
                now,
            )
        )

    def test_planned_rollover_marker_is_detected_independent_of_ffmpeg_exit(self):
        error = f"{CLIENT.RETRYABLE_SESSION_MARKER}: planned session rollover"
        self.assertTrue(CLIENT.is_planned_session_rollover(error))
        self.assertFalse(CLIENT.is_planned_session_rollover("ffmpeg failed"))
        self.assertFalse(CLIENT.is_planned_session_rollover(None))


if __name__ == "__main__":
    unittest.main()
