import importlib.util
import pathlib
import unittest

import numpy as np


MODULE_PATH = pathlib.Path(__file__).parents[1] / "src" / "whisperlive_server.py"
SPEC = importlib.util.spec_from_file_location("streamee_whisperlive_server", MODULE_PATH)
SERVER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(SERVER)


class FakeWord:
    def __init__(self, start, end, word):
        self.start = start
        self.end = end
        self.word = word


class FakeSegment:
    def __init__(self, start, end, text, words):
        self.start = start
        self.end = end
        self.text = text
        self.words = words


class FakeInfo:
    language = "en"
    language_probability = 1.0


class FakeModel:
    def transcribe(self, _audio, **_kwargs):
        return iter([
            FakeSegment(
                0.2,
                2.4,
                "old new words",
                [
                    FakeWord(0.2, 1.0, " old"),
                    FakeWord(1.6, 2.0, " new"),
                    FakeWord(2.0, 2.4, " words"),
                ],
            )
        ]), FakeInfo()


class WhisperLiveServerTests(unittest.TestCase):
    def test_selected_track_language_codes_are_normalized(self):
        self.assertEqual(SERVER.normalize_language("eng"), "en")
        self.assertEqual(SERVER.normalize_language("jpn"), "ja")
        self.assertEqual(SERVER.normalize_language("pt-BR"), "pt")
        self.assertIsNone(SERVER.normalize_language("und"))

    def test_normal_dialogue_is_not_removed_as_a_credit(self):
        for text in ("Thank you for coming.", "Stop watching me.", "I need a translator."):
            normalized = SERVER.normalize_text(text)
            self.assertFalse(SERVER.is_credit_or_hallucination_text(text, normalized))
        self.assertTrue(
            SERVER.is_credit_or_hallucination_text(
                "Subtitles by Example", SERVER.normalize_text("Subtitles by Example")
            )
        )

    def test_overlap_words_are_not_emitted_twice(self):
        audio = np.zeros(int(4.5 * SERVER.SAMPLE_RATE), dtype=np.float32)
        segments, voice_gap = SERVER.transcribe_chunk(
            FakeModel(),
            audio,
            "en",
            10.0,
            [],
            False,
            1.5,
        )
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], "new words")
        self.assertEqual(segments[0]["start"], 11.6)
        self.assertTrue(voice_gap)


if __name__ == "__main__":
    unittest.main()
