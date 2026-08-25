#!/usr/bin/env python3
"""WhisperLive client for Streamee: streams audio from ffmpeg to WhisperLive and emits segments."""

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid
from typing import Optional

RETRYABLE_MEDIA_MARKER = "RETRYABLE_MEDIA_NOT_READY"
RETRYABLE_SESSION_MARKER = "RETRYABLE_SUBTITLE_SESSION_RESTART"
CHUNK_SIZE = 16384
SAMPLE_RATE = 16000
AUDIO_QUEUE_MAX_CHUNKS = 256
FLOAT32_BYTES_PER_SAMPLE = 4
LOCAL_SEND_AHEAD_LIMIT_SECS = 12.0
REMOTE_SEND_AHEAD_LIMIT_SECS = 8.0
LOCAL_CATCHUP_SEND_AHEAD_LIMIT_SECS = 28.0
REMOTE_CATCHUP_SEND_AHEAD_LIMIT_SECS = 16.0
POST_RETRY_CATCHUP_WINDOW_SECS = 20.0
MAX_SESSION_AUDIO_SECS = 240.0
MAX_SESSION_OVERRUN_SECS = 30.0
RECENT_VOICE_GAP_SECS = 5.0
SESSION_ID = "0"


def emit(payload: dict) -> None:
    print(json.dumps(payload), flush=True)


def emit_stderr_status(message: str) -> None:
    print(
        json.dumps({
            "level": "debug",
            "source": "whisper",
            "subsystem": "whisper.client",
            "event": "client.status",
            "message": message,
            "session_id": SESSION_ID,
            "fields": {},
        }),
        file=sys.stderr,
        flush=True,
    )


def fail_retryable(message: str, marker: str = RETRYABLE_MEDIA_MARKER) -> int:
    print(json.dumps({
        "level": "warn",
        "source": "whisper",
        "subsystem": "whisper.client",
        "event": "client.retryable_failure",
        "message": f"{marker}: {message}",
        "session_id": SESSION_ID,
        "fields": {"marker": marker},
    }), file=sys.stderr, flush=True)
    return 3


def is_retryable_ffmpeg_error(stderr: str) -> bool:
    lower = stderr.lower()
    retryable_fragments = [
        "invalid data found",
        "moov atom not found",
        "could not find codec parameters",
        "server returned 5",
        "server returned 429",
        "connection reset",
        "connection refused",
        "connection timed out",
        "error during demuxing",
        "i/o error",
    ]
    return any(fragment in lower for fragment in retryable_fragments)


def is_planned_session_rollover(error: Optional[str]) -> bool:
    return bool(error and RETRYABLE_SESSION_MARKER.lower() in error.lower())


def should_rollover(audio_sent_secs: float, last_voice_gap_at: float, now: Optional[float] = None) -> bool:
    current_time = time.time() if now is None else now
    recent_voice_gap = current_time - last_voice_gap_at <= RECENT_VOICE_GAP_SECS
    deadline_reached = audio_sent_secs >= MAX_SESSION_AUDIO_SECS + MAX_SESSION_OVERRUN_SECS
    return audio_sent_secs >= MAX_SESSION_AUDIO_SECS and (recent_voice_gap or deadline_reached)


def ffmpeg_command() -> Optional[str]:
    for candidate in ("ffmpeg", "ffmpeg.exe"):
        resolved = shutil.which(candidate)
        if resolved:
            return resolved

    try:
        import imageio_ffmpeg  # type: ignore
        resolved = imageio_ffmpeg.get_ffmpeg_exe()
        if resolved and os.path.exists(resolved):
            return resolved
    except Exception:
        pass

    return None


def is_probably_url(value: str) -> bool:
    lowered = value.lower()
    return lowered.startswith("http://") or lowered.startswith("https://")


def describe_input(input_value: str) -> str:
    if is_probably_url(input_value):
        return f"url={input_value}"

    try:
        stat = os.stat(input_value)
        return f"path={input_value} size={stat.st_size} mtime={stat.st_mtime:.3f}"
    except OSError as exc:
        return f"path={input_value} stat_error={exc}"


def main() -> int:
    parser = argparse.ArgumentParser(description="WhisperLive audio streaming client")
    parser.add_argument("--input", required=True, help="Video source URL or file path")
    parser.add_argument("--server", required=True, help="WhisperLive WebSocket URL (e.g. ws://127.0.0.1:9090)")
    parser.add_argument("--language", default=None, help="Language code (e.g. en, ja)")
    parser.add_argument("--model", default=os.environ.get("STREAMEE_WHISPER_MODEL", "small"))
    parser.add_argument("--title", default="")
    parser.add_argument("--start-seconds", type=float, default=0.0, help="Seek offset for transcription resume")
    parser.add_argument(
        "--audio-stream-index",
        type=int,
        default=None,
        help="FFmpeg stream index matching MPV's selected audio track",
    )
    parser.add_argument("--session-id", default="0", help="Streamee whisper session id for log correlation")
    args = parser.parse_args()

    start_seconds = max(0.0, args.start_seconds or 0.0)
    global SESSION_ID
    SESSION_ID = str(args.session_id or "0")
    is_local_input = not is_probably_url(args.input)
    send_ahead_limit_secs = LOCAL_SEND_AHEAD_LIMIT_SECS if is_local_input else REMOTE_SEND_AHEAD_LIMIT_SECS
    catchup_send_ahead_limit_secs = (
        LOCAL_CATCHUP_SEND_AHEAD_LIMIT_SECS if is_local_input else REMOTE_CATCHUP_SEND_AHEAD_LIMIT_SECS
    )
    catchup_mode = start_seconds > 0.0

    ffmpeg = ffmpeg_command()
    if not ffmpeg:
        emit({"type": "error", "message": "ffmpeg is not installed or not available on PATH"})
        return 1

    try:
        import websocket  # type: ignore
    except ImportError:
        try:
            import websocket_client as websocket  # type: ignore
        except ImportError:
            emit({"type": "error", "message": "websocket-client is not installed. Run: pip install websocket-client"})
            return 1

    emit({"type": "status", "phase": "connecting", "message": f"Connecting to WhisperLive server at {args.server}"})

    segment_queue: queue.Queue = queue.Queue()
    server_ready = threading.Event()
    segment_done = threading.Event()
    ws_error: list[str] = []
    segment_error: list[str] = []
    last_voice_gap_at = [0.0]
    uid = str(uuid.uuid4())

    def on_open(ws):
        config = {
            "uid": uid,
            "language": args.language,
            "task": "transcribe",
            "model": args.model,
            "use_vad": os.environ.get("STREAMEE_WHISPER_VAD", "0") == "1",
        }
        ws.send(json.dumps(config))

    def on_message(ws, message):
        try:
            data = json.loads(message)
        except Exception:
            return

        msg_type = data.get("message", "")
        if msg_type == "SERVER_READY":
            server_ready.set()
            emit({"type": "status", "phase": "transcribing", "message": f"session_id={SESSION_ID} WhisperLive server ready, streaming audio"})
            return

        if msg_type == "WAIT":
            segment_queue.put({"retryable": True, "message": "WhisperLive server is busy, retrying later"})
            return

        segments = data.get("segments")
        if segments:
            for seg in segments:
                text = (seg.get("text") or "").strip()
                if text:
                    segment_queue.put({
                        "type": "segment",
                        "start": seg.get("start", 0.0) + start_seconds,
                        "end": seg.get("end", 0.0) + start_seconds,
                        "text": text,
                        "completed": bool(seg.get("completed", False)),
                    })
        if data.get("voice_gap"):
            last_voice_gap_at[0] = time.time()
            segment_queue.put({"type": "voice_gap"})

    def on_error(ws, error):
        ws_error.append(str(error))

    def on_close(ws, close_status_code, close_msg):
        server_ready.set()
        segment_done.set()

    ws = websocket.WebSocketApp(
        args.server,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )

    ws_thread = threading.Thread(target=ws.run_forever, daemon=True)
    ws_thread.start()

    if not server_ready.wait(timeout=60):
        ws.close()
        if ws_error:
            emit({"type": "error", "message": f"WhisperLive server connection failed: {ws_error[0]}"})
        else:
            emit({"type": "error", "message": "Timed out waiting for WhisperLive server to be ready"})
        return 1

    if ws_error:
        emit({"type": "error", "message": f"WhisperLive server error: {ws_error[0]}"})
        return 1

    def drain_segments():
        while True:
            try:
                seg = segment_queue.get(timeout=0.25)
            except queue.Empty:
                if segment_done.is_set() and segment_queue.empty():
                    break
                continue

            if seg is None:
                break

            if seg.get("retryable"):
                segment_error.append(seg.get("message", "Server busy"))
                continue

            emit(seg)

    segment_thread = threading.Thread(target=drain_segments, daemon=True)
    segment_thread.start()

    ffmpeg_cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-fflags", "+discardcorrupt+genpts+igndts",
        "-err_detect", "ignore_err",
        "-rw_timeout", "15000000",
    ]

    if is_local_input:
        # Keep local decodes near real-time so the reader thread does not outrun
        # the websocket sender and build up a giant audio backlog.
        ffmpeg_cmd.append("-re")
    else:
        # Remote streams without cache retention forward Whisper's reads directly
        # upstream. Let ffmpeg retry transient proxy/CDN disconnects instead of
        # failing the whole subtitle session on one short range request.
        ffmpeg_cmd.extend([
            "-reconnect", "1",
            "-reconnect_streamed", "1",
            "-reconnect_at_eof", "1",
            "-reconnect_delay_max", "5",
        ])

    if start_seconds > 0.0:
        ffmpeg_cmd.extend(["-ss", f"{start_seconds:.3f}"])

    ffmpeg_cmd.extend(["-i", args.input])

    if args.audio_stream_index is not None and args.audio_stream_index >= 0:
        ffmpeg_cmd.extend(["-map", f"0:{args.audio_stream_index}"])

    ffmpeg_cmd.extend([
        "-vn",
        "-ac", "1",
        "-ar", str(SAMPLE_RATE),
        "-f", "f32le",
        "-",
    ])

    emit_stderr_status(
        "starting ffmpeg "
        f"input={describe_input(args.input)} "
        f"start_seconds={start_seconds:.3f} "
        f"audio_stream_index={args.audio_stream_index} "
        f"local_input={is_local_input} "
        f"send_ahead_limit={send_ahead_limit_secs:.1f}s "
        f"catchup_limit={catchup_send_ahead_limit_secs:.1f}s "
        f"catchup_mode={catchup_mode}"
    )

    try:
        proc = subprocess.Popen(
            ffmpeg_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except Exception as exc:
        ws.close()
        emit({"type": "error", "message": f"Failed to start ffmpeg: {exc}"})
        return 1

    ffmpeg_stderr_lines: list[str] = []

    def drain_stderr():
        for line in proc.stderr:
            decoded = line.decode("utf-8", errors="replace").strip()
            if decoded:
                ffmpeg_stderr_lines.append(decoded)
                print(f"[ffmpeg] {decoded}", file=sys.stderr, flush=True)

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    stream_error: Optional[str] = None
    bytes_sent = 0
    last_chunk_at = time.time()
    stream_stalled = False
    watchdog_stop = threading.Event()
    audio_queue: queue.Queue[Optional[bytes]] = queue.Queue(maxsize=AUDIO_QUEUE_MAX_CHUNKS)
    reader_done = threading.Event()
    sender_done = threading.Event()
    last_read_at = time.time()
    last_send_at = time.time()
    read_block_started_at: Optional[float] = None
    send_block_started_at: Optional[float] = None
    queue_full_started_at: Optional[float] = None
    reader_exit_reason = "running"
    sender_exit_reason = "running"
    last_pacing_log_at = 0.0

    def put_audio_chunk(chunk: Optional[bytes]) -> None:
        nonlocal queue_full_started_at
        while True:
            try:
                audio_queue.put(chunk, timeout=0.5)
                if queue_full_started_at is not None:
                    emit_stderr_status(
                        f"audio queue resumed after {time.time() - queue_full_started_at:.2f}s at start_seconds={start_seconds:.3f}"
                    )
                    queue_full_started_at = None
                return
            except queue.Full:
                if queue_full_started_at is None:
                    queue_full_started_at = time.time()
                    emit_stderr_status(
                        f"audio queue became full at start_seconds={start_seconds:.3f} bytes_sent={bytes_sent}"
                    )
                elif time.time() - queue_full_started_at > 2.0:
                    emit_stderr_status(
                        f"audio queue still full for {time.time() - queue_full_started_at:.2f}s at start_seconds={start_seconds:.3f}"
                    )
                if watchdog_stop.is_set() or sender_done.is_set() or proc.poll() is not None:
                    return

    def watch_for_stall() -> None:
        nonlocal stream_stalled
        while not watchdog_stop.is_set():
            if bytes_sent > 0 and time.time() - last_chunk_at > 12.0:
                stream_stalled = True
                now = time.time()
                read_age = now - last_read_at
                send_age = now - last_send_at
                read_block_age = now - read_block_started_at if read_block_started_at is not None else 0.0
                send_block_age = now - send_block_started_at if send_block_started_at is not None else 0.0
                emit_stderr_status(
                    "stream stalled "
                    f"for {now - last_chunk_at:.1f}s after {bytes_sent} bytes "
                    f"(start_seconds={start_seconds:.3f} queue_size={audio_queue.qsize()} "
                    f"read_age={read_age:.1f}s send_age={send_age:.1f}s "
                    f"read_block_age={read_block_age:.1f}s send_block_age={send_block_age:.1f}s)"
                )
                try:
                    proc.terminate()
                except Exception:
                    pass
                break
            time.sleep(1.0)

    watchdog_thread = threading.Thread(target=watch_for_stall, daemon=True)
    watchdog_thread.start()

    try:
        import numpy as np  # type: ignore
    except ImportError:
        np = None

    def read_audio() -> None:
        nonlocal stream_error, last_read_at, read_block_started_at, reader_exit_reason
        try:
            while True:
                read_block_started_at = time.time()
                chunk = proc.stdout.read(CHUNK_SIZE)
                read_duration = time.time() - read_block_started_at
                read_block_started_at = None
                last_read_at = time.time()

                if read_duration > 1.0:
                    emit_stderr_status(
                        f"ffmpeg read blocked for {read_duration:.2f}s at start_seconds={start_seconds:.3f}"
                    )

                if not chunk:
                    reader_exit_reason = "ffmpeg_stdout_eof"
                    emit_stderr_status(
                        f"ffmpeg stdout ended after {bytes_sent} bytes (start_seconds={start_seconds:.3f})"
                    )
                    break

                put_audio_chunk(chunk)
        except Exception as exc:
            reader_exit_reason = f"read_error:{exc}"
            stream_error = f"ffmpeg read failed: {exc}"
        finally:
            put_audio_chunk(None)
            emit_stderr_status(
                f"reader thread exiting reason={reader_exit_reason} queue_size={audio_queue.qsize()} bytes_sent={bytes_sent}"
            )
            reader_done.set()

    def send_audio() -> None:
        nonlocal stream_error, bytes_sent, last_chunk_at, last_send_at, send_block_started_at, sender_exit_reason, last_pacing_log_at
        stream_started_at = time.time()
        audio_sent_secs = 0.0
        catchup_mode_active = catchup_mode
        try:
            while True:
                try:
                    chunk = audio_queue.get(timeout=1.0)
                except queue.Empty:
                    if reader_done.is_set():
                        sender_exit_reason = "reader_done_queue_empty"
                        break
                    continue

                if chunk is None:
                    sender_exit_reason = "received_sentinel"
                    break

                chunk_audio_secs = len(chunk) / (SAMPLE_RATE * FLOAT32_BYTES_PER_SAMPLE)
                recent_voice_gap = time.time() - last_voice_gap_at[0] <= RECENT_VOICE_GAP_SECS
                if should_rollover(audio_sent_secs, last_voice_gap_at[0]):
                    sender_exit_reason = "session_rollover"
                    stream_error = (
                        f"{RETRYABLE_SESSION_MARKER}: "
                        f"planned session rollover after {audio_sent_secs:.1f}s "
                        f"(voice_gap={recent_voice_gap})"
                    )
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                    break

                current_send_ahead_limit_secs = send_ahead_limit_secs
                if catchup_mode_active:
                    current_send_ahead_limit_secs = catchup_send_ahead_limit_secs
                    buffered_ahead_secs = audio_sent_secs - (time.time() - stream_started_at)
                    if (
                        buffered_ahead_secs >= send_ahead_limit_secs - 0.5
                        or audio_sent_secs >= POST_RETRY_CATCHUP_WINDOW_SECS
                    ):
                        catchup_mode_active = False
                        emit_stderr_status(
                            f"catch-up mode completed at start_seconds={start_seconds:.3f} "
                            f"audio_sent={audio_sent_secs:.1f}s buffered_ahead={buffered_ahead_secs:.1f}s"
                        )

                target_elapsed = audio_sent_secs
                actual_elapsed = time.time() - stream_started_at
                ahead_by = target_elapsed - actual_elapsed
                if ahead_by > current_send_ahead_limit_secs:
                    sleep_for = ahead_by - current_send_ahead_limit_secs
                    if sleep_for > 0.01:
                        now = time.time()
                        if sleep_for >= 0.5 or now - last_pacing_log_at >= 5.0:
                            emit_stderr_status(
                                f"pacing websocket send by sleeping {sleep_for:.2f}s at start_seconds={start_seconds:.3f} "
                                f"(limit={current_send_ahead_limit_secs:.1f}s catchup={catchup_mode_active})"
                            )
                            last_pacing_log_at = now
                        time.sleep(sleep_for)

                send_block_started_at = time.time()
                if np is not None:
                    audio_array = np.frombuffer(chunk, dtype=np.float32)
                    ws.send(audio_array.tobytes(), websocket.ABNF.OPCODE_BINARY)
                else:
                    ws.send_binary(chunk)
                send_duration = time.time() - send_block_started_at
                send_block_started_at = None

                if send_duration > 1.0:
                    emit_stderr_status(
                        f"websocket send blocked for {send_duration:.2f}s at start_seconds={start_seconds:.3f}"
                    )

                bytes_sent += len(chunk)
                audio_sent_secs += chunk_audio_secs
                last_chunk_at = time.time()
                last_send_at = last_chunk_at
        except Exception as exc:
            sender_exit_reason = f"send_error:{exc}"
            stream_error = f"websocket send failed: {exc}"
            try:
                proc.terminate()
            except Exception:
                pass
        finally:
            send_block_started_at = None
            emit_stderr_status(
                f"sender thread exiting reason={sender_exit_reason} queue_size={audio_queue.qsize()} bytes_sent={bytes_sent}"
            )
            sender_done.set()

    reader_thread = threading.Thread(target=read_audio, daemon=True)
    sender_thread = threading.Thread(target=send_audio, daemon=True)
    reader_thread.start()
    sender_thread.start()

    while True:
        if stream_error:
            emit_stderr_status(f"stream loop breaking due to stream_error={stream_error}")
            break
        if reader_done.is_set() and sender_done.is_set():
            emit_stderr_status(
                f"stream loop noticed both threads done reader_reason={reader_exit_reason} sender_reason={sender_exit_reason}"
            )
            break
        if proc.poll() is not None and reader_done.is_set() and audio_queue.empty():
            emit_stderr_status(
                f"stream loop saw ffmpeg exit with empty queue reader_reason={reader_exit_reason} sender_reason={sender_exit_reason}"
            )
            break
        time.sleep(0.1)

    reader_thread.join(timeout=5)
    sender_thread.join(timeout=5)

    if bytes_sent > 0 and time.time() - last_chunk_at > 10.0:
        emit_stderr_status(
            f"stream stalled for {time.time() - last_chunk_at:.1f}s after {bytes_sent} bytes (start_seconds={start_seconds:.3f})"
        )

    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        emit_stderr_status("ffmpeg did not exit after terminate; killing process")
        proc.kill()
        proc.wait(timeout=5)
    watchdog_stop.set()
    watchdog_thread.join(timeout=3)
    stderr_thread.join(timeout=5)
    stderr_tail = " | ".join(ffmpeg_stderr_lines[-3:])
    suffix = f" stderr_tail={stderr_tail}" if stderr_tail else ""
    emit_stderr_status(
        f"ffmpeg exited code={proc.returncode} bytes_sent={bytes_sent} start_seconds={start_seconds:.3f}{suffix}"
    )

    if stream_error:
        lower_stream_error = stream_error.lower()
        is_session_rollover = is_planned_session_rollover(stream_error)
        is_retryable = (
            is_session_rollover
            or "connection is already closed" in lower_stream_error
            or "forcibly closed by the remote host" in lower_stream_error
            or "10054" in lower_stream_error
        )

        # For planned session rollovers, flush remaining audio before returning.
        if is_session_rollover:
            try:
                ws.send(b"END_OF_AUDIO", websocket.ABNF.OPCODE_BINARY)
                flush_deadline = time.time() + 5.0
                while time.time() < flush_deadline and ws_thread.is_alive():
                    time.sleep(0.2)
                segment_done.set()
                segment_thread.join(timeout=3)
            except Exception:
                pass

        if is_session_rollover:
            ws.close()
            emit({
                "type": "status",
                "phase": "complete",
                "reason": "session_rollover",
                "message": f"WhisperLive session rollover completed at start_seconds={start_seconds:.3f}",
            })
            return 0
        ws.close()
        if is_retryable:
            return fail_retryable(
                f"subtitle session restart requested at start_seconds={start_seconds:.3f}: {stream_error}",
                RETRYABLE_SESSION_MARKER,
            )
        emit({"type": "error", "message": f"Audio streaming error: {stream_error}"})
        return 1

    if stream_stalled:
        ws.close()
        return fail_retryable(
            f"audio stream stalled at start_seconds={start_seconds:.3f} after {bytes_sent} bytes"
        )

    if proc.returncode != 0:
        ws.close()
        stderr = "\n".join(ffmpeg_stderr_lines).strip()
        if is_retryable_ffmpeg_error(stderr):
            return fail_retryable(
                f"ffmpeg media read failed after {bytes_sent} bytes at start_seconds={start_seconds:.3f}"
            )
        if bytes_sent >= CHUNK_SIZE:
            emit({"type": "error", "message": f"ffmpeg stopped unexpectedly: {stderr or 'no stderr output'}"})
            return 1
        if stderr:
            emit({"type": "error", "message": f"ffmpeg failed: {stderr}"})
        else:
            emit({"type": "error", "message": "ffmpeg failed without output"})
        return 1

    try:
        ws.send(b"END_OF_AUDIO", websocket.ABNF.OPCODE_BINARY)
    except Exception:
        pass

    deadline = time.time() + 30.0
    while time.time() < deadline and ws_thread.is_alive():
        time.sleep(0.2)

    segment_done.set()
    segment_thread.join(timeout=3)

    if segment_error:
        ws.close()
        return fail_retryable(segment_error[0])

    ws.close()
    ws_thread.join(timeout=3)

    emit({"type": "status", "phase": "complete", "reason": "complete", "message": "WhisperLive transcription complete"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
