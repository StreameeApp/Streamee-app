#!/usr/bin/env python3
"""Minimal streaming transcription server for Streamee.

Uses faster-whisper + websockets directly — no whisper-live package required.
Protocol (compatible with whisperlive_client.py):
  1. Client connects and sends JSON config: {uid, language, model, use_vad}
  2. Server replies: {"uid": ..., "message": "SERVER_READY"}
  3. Client streams float32 PCM binary frames at 16 kHz mono
  4. Server periodically replies: {"uid": ..., "segments": [{start, end, text, completed}]}
  5. Client sends b"END_OF_AUDIO" to flush the final chunk
  6. Server sends remaining segments and closes
"""

import argparse
import asyncio
from collections import deque
import json
import logging
import os
import re
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

SAMPLE_RATE = 16000
# Accumulate this many seconds of audio before each incremental transcription.
# Lower = more responsive subtitles; higher = better accuracy (more context).
TRANSCRIBE_INTERVAL_SECS = 5.0
TRANSCRIBE_OVERLAP_SECS = 2.0
MIN_AUDIO_SECS = 0.35
VOICE_GAP_SECS = 0.65
MAX_PENDING_AUDIO_CHUNKS = 512
DEFAULT_USE_VAD = os.environ.get("STREAMEE_WHISPER_VAD", "0") == "1"
IGNORED_HALLUCINATIONS = {
    "thanks for watching",
    "thanks for watching!",
    "thank you for watching",
    "please subscribe",
    "subscribe for more",
    "subtitles by",
}
IGNORED_PREFIXES = (
    "subtitles by",
    "subtitle by",
    "subtitle editor",
    "edited by",
    "captions by",
)
IGNORED_SUBSTRINGS = (
    "amara.org",
    "opensubtitles",
    "редактор субтитров",
    "субтитр",
)
MAX_RECENT_TEXT_HISTORY = 12
MAX_RECENT_DUPLICATE_WINDOW = 6
CREDIT_LINE_RE = re.compile(r"^(subtitles?|captions?)\s+(by|from)\b", re.IGNORECASE)
EXTRA_IGNORED_SUBSTRINGS = (
    "\u0440\u0435\u0434\u0430\u043a\u0442\u043e\u0440 \u0441\u0443\u0431\u0442\u0438\u0442\u0440\u043e\u0432",
    "\u0441\u0443\u0431\u0442\u0438\u0442\u0440",
)
ISO_639_2_TO_1 = {
    "ara": "ar", "ben": "bn", "cat": "ca", "ces": "cs", "chi": "zh",
    "cze": "cs", "dan": "da", "deu": "de", "dut": "nl", "ell": "el",
    "eng": "en", "fas": "fa", "fin": "fi", "fra": "fr", "fre": "fr",
    "ger": "de", "gre": "el", "heb": "he", "hin": "hi", "hun": "hu",
    "ind": "id", "ita": "it", "jpn": "ja", "kor": "ko", "may": "ms",
    "msa": "ms", "nld": "nl", "nor": "no", "per": "fa", "pol": "pl",
    "por": "pt", "ron": "ro", "rum": "ro", "rus": "ru", "spa": "es",
    "swe": "sv", "tam": "ta", "tel": "te", "tha": "th", "tur": "tr",
    "ukr": "uk", "urd": "ur", "vie": "vi", "zho": "zh",
}


def emit_stdout(payload: dict) -> None:
    """Emit structured JSON to stdout for Rust to read. Silently handles broken pipe."""
    try:
        print(json.dumps(payload), flush=True)
    except (BrokenPipeError, OSError):
        pass


def log(msg: str, level: str = "debug", event: str = "server.message", fields=None) -> None:
    """Emit one structured diagnostic line to stderr for Rust to ingest."""
    try:
        print(json.dumps({
            "level": level,
            "source": "whisper",
            "subsystem": "whisper.server",
            "event": event,
            "message": msg,
            "fields": fields or {},
        }), file=sys.stderr, flush=True)
    except (BrokenPipeError, OSError, ValueError):
        # On Windows, the child process can outlive or lose its stderr handle.
        # Logging must never take down the websocket handler.
        pass


def log_both(msg: str) -> None:
    log(msg, level="error", event="server.error")


class StructuredStderrLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = self.format(record)
        except Exception:
            message = record.getMessage()
        log(message, level=record.levelname.lower(), event="server.python_log")


def configure_python_logging() -> None:
    formatter = logging.Formatter("%(name)s %(levelname)s: %(message)s")
    handler = StructuredStderrLogHandler()
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(formatter)

    for logger_name in ("websockets", "websockets.server", "websockets.protocol", "asyncio"):
        logger = logging.getLogger(logger_name)
        logger.setLevel(logging.DEBUG)
        logger.propagate = False
        if not any(isinstance(existing, StructuredStderrLogHandler) for existing in logger.handlers):
            logger.addHandler(handler)


def normalize_text(text: str) -> str:
    lowered = (text or "").strip().lower()
    return " ".join(lowered.replace(".", " ").replace("!", " ").replace("?", " ").split())


def normalize_language(language: Optional[str]) -> Optional[str]:
    normalized = (language or "").strip().lower().split("-", 1)[0]
    if not normalized or normalized in {"und", "unknown"}:
        return None
    if len(normalized) == 2:
        return normalized
    return ISO_639_2_TO_1.get(normalized)


def is_credit_or_hallucination_text(text: str, normalized: str) -> bool:
    if not normalized:
        return True
    if normalized in {"thank you", "thanks"}:
        return False
    if normalized in IGNORED_HALLUCINATIONS:
        return True
    if CREDIT_LINE_RE.match((text or "").strip()):
        return True
    if any(normalized.startswith(prefix) for prefix in IGNORED_PREFIXES):
        return True
    if any(token in normalized for token in IGNORED_SUBSTRINGS):
        return True
    if any(token in normalized for token in EXTRA_IGNORED_SUBSTRINGS):
        return True
    return False


def should_filter_duplicate_text(
    normalized: str,
    recent_texts: deque[str],
) -> bool:
    if not normalized:
        return True
    if normalized not in recent_texts:
        return False

    duplicate_count = sum(1 for candidate in recent_texts if candidate == normalized)
    if duplicate_count >= 2:
        return True
    return False


async def send_json(websocket, payload: dict, *, context: str) -> None:
    message = json.dumps(payload)
    try:
        await websocket.send(message)
    except Exception as exc:
        log_both(f"send failed during {context}: {type(exc).__name__}: {exc}")
        raise


def resolve_device(requested_mode: str) -> tuple[str, str]:
    requested_mode = (requested_mode or "auto").lower()

    def has_cuda() -> bool:
        try:
            import ctranslate2  # type: ignore
            if hasattr(ctranslate2, "get_cuda_device_count"):
                return int(ctranslate2.get_cuda_device_count()) > 0
        except Exception:
            pass
        return False

    if requested_mode == "cuda":
        if has_cuda():
            return "cuda", os.environ.get("STREAMEE_WHISPER_COMPUTE_TYPE_CUDA", "float16")
        return "cpu", os.environ.get("STREAMEE_WHISPER_COMPUTE_TYPE_CPU", "int8")

    if requested_mode == "cpu":
        return "cpu", os.environ.get("STREAMEE_WHISPER_COMPUTE_TYPE_CPU", "int8")

    if has_cuda():
        return "cuda", os.environ.get("STREAMEE_WHISPER_COMPUTE_TYPE_CUDA", "float16")

    return "cpu", os.environ.get("STREAMEE_WHISPER_COMPUTE_TYPE_CPU", "int8")


def load_model(model_name: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel  # type: ignore
    return WhisperModel(model_name, device=device, compute_type=compute_type)


def transcribe_chunk(
    model,
    audio,
    language: Optional[str],
    offset_secs: float,
    recent_texts: list[str],
    use_vad: bool,
    context_prefix_secs: float,
) -> tuple[list[dict], bool]:
    """Run faster-whisper on a numpy float32 array and return segment dicts."""
    import numpy as np

    duration = len(audio) / SAMPLE_RATE
    log(f"transcribing {duration:.1f}s chunk (offset={offset_secs:.1f}s, language={language or 'auto'})")

    segments_iter, info = model.transcribe(
        audio,
        language=language or None,
        beam_size=3,
        condition_on_previous_text=False,
        initial_prompt=" ".join(recent_texts[-3:]) or None,
        word_timestamps=True,
        no_speech_threshold=0.6,
        compression_ratio_threshold=2.4,
        # VAD can suppress all output on short streaming chunks, which looks like a stall.
        # Keep it opt-in so the streaming path yields text more reliably by default.
        vad_filter=use_vad,
        vad_parameters={"min_silence_duration_ms": 300, "threshold": 0.3},
    )

    result = []
    last_speech_end = 0.0
    for seg in segments_iter:
        words = [
            word
            for word in (getattr(seg, "words", None) or [])
            if float(word.end) > context_prefix_secs + 0.05
        ]
        text = (
            "".join(str(word.word) for word in words).strip()
            if words
            else (seg.text or "").strip()
        )
        segment_start = float(words[0].start) if words else float(seg.start)
        segment_end = float(words[-1].end) if words else float(seg.end)
        if not words and segment_end <= context_prefix_secs + 0.05:
            continue
        if text:
            last_speech_end = max(last_speech_end, min(segment_end, duration))
            # Discard segments that start beyond the actual audio duration (hallucinations).
            if seg.start > duration + 0.5:
                log(f"  discarded hallucinated segment beyond chunk: [{seg.start:.2f}→{seg.end:.2f}] {text}")
                continue
            normalized = normalize_text(text)
            if is_credit_or_hallucination_text(text, normalized):
                log(f"  filtered hallucination/credit: {text}")
                continue
            if should_filter_duplicate_text(
                normalized,
                deque(recent_texts[-MAX_RECENT_DUPLICATE_WINDOW:], maxlen=MAX_RECENT_DUPLICATE_WINDOW),
            ):
                log(f"  filtered repeated low-information segment: {text}")
                continue
            # Clamp end time to the chunk boundary to prevent hallucinated timestamps.
            clamped_end = min(segment_end, duration)
            entry = {
                "start": round(max(segment_start, context_prefix_secs) + offset_secs, 3),
                "end": round(clamped_end + offset_secs, 3),
                "text": text,
                "completed": True,
            }
            result.append(entry)
            log(f"  [{entry['start']:.2f}→{entry['end']:.2f}] {text}")

    log(f"  transcribe finished with {len(result)} segment(s)")

    if not result:
        log(f"  (no segments — detected language: {getattr(info, 'language', 'unknown')}, "
            f"probability: {getattr(info, 'language_probability', 0):.2f})")

    voice_gap = last_speech_end <= 0.0 or duration - last_speech_end >= VOICE_GAP_SECS
    return result, voice_gap


def merge_adjacent_segments(segments: list[dict]) -> list[dict]:
    if not segments:
        return []

    merged: list[dict] = [segments[0].copy()]
    for seg in segments[1:]:
        current = seg.copy()
        last = merged[-1]
        gap = max(0.0, float(current.get("start", 0.0)) - float(last.get("end", 0.0)))
        last_text = str(last.get("text", "")).strip()
        current_text = str(current.get("text", "")).strip()
        last_words = len(last_text.split())
        current_words = len(current_text.split())

        should_merge = (
            gap <= 0.45
            and last_text
            and current_text
            and (
                last_words <= 6
                or current_words <= 6
                or not last_text.endswith((".", "?", "!", "…", ":", ";"))
            )
        )

        if should_merge:
            last["end"] = max(float(last.get("end", 0.0)), float(current.get("end", 0.0)))
            if last_text and current_text:
                last["text"] = f"{last_text} {current_text}".strip()
            last["completed"] = bool(last.get("completed", False) or current.get("completed", False))
            continue

        merged.append(current)

    return merged


async def handle_client(websocket, model, executor: ThreadPoolExecutor) -> None:
    import numpy as np
    try:
        import websockets  # type: ignore
    except Exception:
        websockets = None

    def socket_state() -> str:
        return (
            f"closed={getattr(websocket, 'closed', None)} "
            f"close_code={getattr(websocket, 'close_code', None)} "
            f"close_reason={getattr(websocket, 'close_reason', None)}"
        )

    # Receive initial config (with timeout)
    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=15)
        config = json.loads(raw)
    except Exception as exc:
        log(f"failed to receive client config: {exc}")
        return

    uid: str = config.get("uid", "unknown")
    language = normalize_language(config.get("language"))
    use_vad = bool(config.get("use_vad", DEFAULT_USE_VAD))
    log(f"client connected uid={uid} language={language or 'auto'} vad={use_vad}")

    await send_json(websocket, {"uid": uid, "message": "SERVER_READY"}, context="SERVER_READY")

    loop = asyncio.get_event_loop()
    audio_queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue(maxsize=MAX_PENDING_AUDIO_CHUNKS)
    stats = {
        "pending_samples": 0,
        "total_samples_processed": 0,
        "total_chunks": 0,
    }

    async def transcription_worker() -> None:
        pending_chunks: list[np.ndarray] = []
        pending_samples = 0
        recent_texts: deque[str] = deque(maxlen=MAX_RECENT_TEXT_HISTORY)
        context_tail = np.empty(0, dtype=np.float32)

        def collect_pending() -> np.ndarray:
            nonlocal pending_chunks, pending_samples
            if len(pending_chunks) == 1:
                result = pending_chunks[0]
            else:
                result = np.concatenate(pending_chunks)
            pending_chunks = []
            pending_samples = 0
            stats["pending_samples"] = 0
            return result

        async def transcribe_and_send(audio: np.ndarray, *, flush: bool) -> None:
            nonlocal context_tail
            if len(audio) == 0:
                return
            context_prefix_samples = len(context_tail)
            context_prefix_secs = context_prefix_samples / SAMPLE_RATE
            model_audio = (
                np.concatenate([context_tail, audio])
                if context_prefix_samples > 0
                else audio
            )
            offset = (stats["total_samples_processed"] - context_prefix_samples) / SAMPLE_RATE
            stats["total_samples_processed"] += len(audio)
            segs, voice_gap = await loop.run_in_executor(
                executor,
                transcribe_chunk,
                model,
                model_audio,
                language,
                offset,
                list(recent_texts),
                use_vad,
                context_prefix_secs,
            )
            overlap_samples = min(
                len(model_audio),
                int(TRANSCRIBE_OVERLAP_SECS * SAMPLE_RATE),
            )
            context_tail = model_audio[-overlap_samples:].copy()
            segs = merge_adjacent_segments(segs)
            if segs:
                for seg in segs:
                    normalized = normalize_text(seg.get("text", ""))
                    if normalized:
                        recent_texts.append(normalized)
                phase = "flushed" if flush else "incremental"
                log(f"sending {len(segs)} {phase} segment(s) to uid={uid}")
            if segs or voice_gap:
                phase = "flushed" if flush else "incremental"
                await send_json(
                    websocket,
                    {"uid": uid, "segments": segs, "voice_gap": voice_gap},
                    context=f"{phase} segments uid={uid}",
                )

        try:
            while True:
                message = await audio_queue.get()
                if message is None:
                    log(
                        f"END_OF_AUDIO received after {stats['total_chunks']} chunks, "
                        f"flushing {pending_samples / SAMPLE_RATE:.1f}s remaining"
                    )
                    if pending_samples >= SAMPLE_RATE * MIN_AUDIO_SECS:
                        await transcribe_and_send(collect_pending(), flush=True)
                    break

                chunk = np.frombuffer(message, dtype=np.float32)
                pending_chunks.append(chunk)
                pending_samples += len(chunk)
                stats["pending_samples"] = pending_samples
                stats["total_chunks"] += 1

                if stats["total_chunks"] % 100 == 0:
                    total_secs = (stats["total_samples_processed"] + pending_samples) / SAMPLE_RATE
                    pending_secs = pending_samples / SAMPLE_RATE
                    log(
                        f"received {stats['total_chunks']} chunks uid={uid} "
                        f"buffered={total_secs:.1f}s pending={pending_secs:.1f}s "
                        f"queue_size={audio_queue.qsize()} {socket_state()}"
                    )

                if pending_samples >= SAMPLE_RATE * TRANSCRIBE_INTERVAL_SECS:
                    await transcribe_and_send(collect_pending(), flush=False)

            log(f"transcription worker finished uid={uid} {socket_state()}")
        except Exception as exc:
            log_both(
                f"transcription worker crashed uid={uid}: {type(exc).__name__}: {exc} "
                f"(queue_size={audio_queue.qsize()} pending={pending_samples / SAMPLE_RATE:.1f}s)"
            )
            formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).strip()
            for line in formatted.splitlines():
                log_both(f"trace: {line}")
            raise

    worker_task = asyncio.create_task(transcription_worker())

    try:
        async for message in websocket:
            if worker_task.done():
                await worker_task

            if not isinstance(message, bytes):
                log(
                    f"received websocket message uid={uid} "
                    f"type={type(message).__name__} {socket_state()}"
                )
                continue

            if message == b"END_OF_AUDIO":
                await audio_queue.put(None)
                break

            if audio_queue.full():
                log(
                    f"audio queue full for uid={uid}; applying backpressure "
                    f"(queue_size={audio_queue.qsize()} pending={stats['pending_samples'] / SAMPLE_RATE:.1f}s)"
                )
            await audio_queue.put(message)
            if worker_task.done():
                await worker_task

        log(f"websocket message loop ended normally uid={uid} {socket_state()}")

    except Exception as exc:
        close_code = getattr(websocket, "close_code", None)
        close_reason = getattr(websocket, "close_reason", None)
        log_both(
            f"client handler error uid={uid}: {type(exc).__name__}: {exc} "
            f"(close_code={close_code} close_reason={close_reason})"
        )
        formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).strip()
        for line in formatted.splitlines():
            log_both(f"trace: {line}")
    finally:
        if not worker_task.done():
            try:
                await audio_queue.put(None)
            except Exception:
                pass
        try:
            await worker_task
        except Exception as exc:
            close_code = getattr(websocket, "close_code", None)
            close_reason = getattr(websocket, "close_reason", None)
            log_both(
                f"transcription worker error uid={uid}: {type(exc).__name__}: {exc} "
                f"(close_code={close_code} close_reason={close_reason})"
            )
            formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).strip()
            for line in formatted.splitlines():
                log_both(f"trace: {line}")
        close_code = getattr(websocket, "close_code", None)
        close_reason = getattr(websocket, "close_reason", None)
        total_audio_secs = (stats["total_samples_processed"] + stats["pending_samples"]) / SAMPLE_RATE
        log(
            f"client disconnected uid={uid}, total audio: {total_audio_secs:.1f}s, "
            f"chunks={stats['total_chunks']}, close_code={close_code}, close_reason={close_reason}"
        )


async def serve(port: int, model, max_clients: int) -> None:
    import websockets  # type: ignore

    loop = asyncio.get_running_loop()

    def handle_asyncio_exception(loop, context):
        message = context.get("message", "asyncio exception")
        exc = context.get("exception")
        if exc is not None:
            log_both(f"asyncio loop exception: {message}: {type(exc).__name__}: {exc}")
            formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).strip()
            for line in formatted.splitlines():
                log_both(f"trace: {line}")
        else:
            log_both(f"asyncio loop exception: {message}")

    loop.set_exception_handler(handle_asyncio_exception)
    executor = ThreadPoolExecutor(max_workers=max_clients)

    async def handler(websocket):
        log_both(
            "websocket handler started "
            f"remote={getattr(websocket, 'remote_address', None)} "
            f"path={getattr(websocket, 'path', None)}"
        )
        try:
            await handle_client(websocket, model, executor)
        except Exception as exc:
            log_both(
                "websocket handler bubbled exception "
                f"remote={getattr(websocket, 'remote_address', None)} "
                f"{type(exc).__name__}: {exc}"
            )
            formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).strip()
            for line in formatted.splitlines():
                log_both(f"trace: {line}")
            raise
        finally:
            log_both(
                "websocket handler finished "
                f"remote={getattr(websocket, 'remote_address', None)} "
                f"close_code={getattr(websocket, 'close_code', None)} "
                f"close_reason={getattr(websocket, 'close_reason', None)}"
            )

    async with websockets.serve(
        handler,
        "127.0.0.1",
        port,
        ping_interval=30,
        ping_timeout=10,
        close_timeout=5,
        max_queue=None,
        max_size=None,
        compression=None,
    ):
        emit_stdout({"status": "ready", "port": port})
        log(f"server listening on port {port}")
        await asyncio.Future()  # run forever


def main() -> int:
    parser = argparse.ArgumentParser(description="Streamee transcription server")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--model", default=os.environ.get("STREAMEE_WHISPER_MODEL", "small"))
    parser.add_argument("--device-mode", default=os.environ.get("STREAMEE_WHISPER_DEVICE", "auto"))
    parser.add_argument("--max-clients", type=int, default=4)
    args = parser.parse_args()

    try:
        import faster_whisper  # noqa: F401
    except ImportError as exc:
        emit_stdout({"status": "error", "message": f"faster-whisper is not installed: {exc}"})
        return 2

    try:
        import websockets  # noqa: F401
    except ImportError as exc:
        emit_stdout({"status": "error", "message": f"websockets is not installed: {exc}"})
        return 2

    try:
        import numpy  # noqa: F401
    except ImportError as exc:
        emit_stdout({"status": "error", "message": f"numpy is not installed: {exc}"})
        return 2

    configure_python_logging()
    device, compute_type = resolve_device(args.device_mode)
    emit_stdout({
        "status": "starting",
        "message": f"Loading model '{args.model}' on {device} ({compute_type})…",
    })
    log(f"loading model={args.model} device={device} compute_type={compute_type}")

    try:
        model = load_model(args.model, device, compute_type)
        log("model loaded successfully")
    except Exception as exc:
        emit_stdout({"status": "error", "message": f"Failed to load model: {exc}"})
        return 1

    try:
        asyncio.run(serve(args.port, model, args.max_clients))
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        log_both(f"server error: {type(exc).__name__}: {exc}")
        formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).strip()
        for line in formatted.splitlines():
            log_both(f"trace: {line}")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
