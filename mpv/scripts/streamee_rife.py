"""RIFE frame generation using Streamee's optional managed runtime."""

import os
import json
import re
import shutil
import sys
import tempfile
from fractions import Fraction
from threading import Lock
from time import monotonic, time as wall_time

import vapoursynth as vs


core = vs.core
core.num_threads = max(2, min(16, (os.cpu_count() or 8)))

local_app_data = os.environ.get("LOCALAPPDATA", os.path.expanduser(r"~\AppData\Local"))
runtime_dir = os.environ.get(
    "STREAMEE_RIFE_RUNTIME",
    os.path.join(local_app_data, "Streamee", "rife-runtime", "v15.16"),
)
model_name = os.environ.get("STREAMEE_RIFE_MODEL", "4.6")
multiplier = max(2, min(3, int(os.environ.get("STREAMEE_RIFE_MULTIPLIER", "2"))))
gpu_streams = max(1, min(2, int(os.environ.get("STREAMEE_RIFE_GPU_STREAMS", "2"))))
processing_mode = os.environ.get("STREAMEE_RIFE_PROCESSING_MODE", "auto").strip().lower()
if processing_mode not in {"auto", "native", "1080", "720"}:
    processing_mode = "auto"
scale_setting = os.environ.get("STREAMEE_RIFE_SCALE", "auto").strip().lower()
valid_scale_settings = {"auto", "0.2", "0.25", "0.4", "0.5", "1.0"}
if scale_setting not in valid_scale_settings:
    scale_setting = "auto"

trt_plugin = os.path.join(runtime_dir, "vstrt.dll")
model_path = os.path.join(runtime_dir, "models", "rife", f"rife_v{model_name.replace('-', '_')}.onnx")

for required_path in (trt_plugin, model_path):
    if not os.path.isfile(required_path):
        raise RuntimeError(f"Streamee RIFE runtime file is missing: {required_path}")

if not hasattr(core, "trt"):
    core.std.LoadPlugin(trt_plugin)

if runtime_dir not in sys.path:
    sys.path.insert(0, runtime_dir)

import vsmlrt  # noqa: E402
from vsmlrt import Backend, RIFE  # noqa: E402


# Half-scale graph rewriting saves a derived ONNX model beside the source model.
# Keep both the source copy and derived graph in Streamee's writable cache rather
# than attempting to modify the runtime installed under Program Files.
model_cache_root = os.path.join(local_app_data, "Streamee", "rife-cache", "models")
cached_model_dir = os.path.join(model_cache_root, "rife")
cached_model_path = os.path.join(cached_model_dir, os.path.basename(model_path))
os.makedirs(cached_model_dir, exist_ok=True)
if not os.path.isfile(cached_model_path) or os.path.getsize(cached_model_path) != os.path.getsize(model_path):
    temporary_model_path = f"{cached_model_path}.{os.getpid()}.tmp"
    shutil.copy2(model_path, temporary_model_path)
    os.replace(temporary_model_path, cached_model_path)
vsmlrt.models_path = model_cache_root


def model_number(name: str) -> int:
    parts = re.split(r"[._-]", name)
    major = int(parts[0])
    minor = int(parts[1])
    number = major * (10 if len(parts[1]) == 1 else 100) + minor
    if "lite" in name:
        number = number * 10 + 1
    if number < 30:
        return 46
    return number


class RifePlaybackGuard:
    """Shed interpolation work when the output queue misses playback deadlines."""

    def __init__(self, multiplier, gpu_streams, clock=monotonic, report=None):
        self.multiplier = multiplier
        self.gpu_streams = gpu_streams
        self.clock = clock
        self.report = report or (lambda message: None)
        self.lock = Lock()
        self.pending = {}
        self.last_activity = None
        self.speed = 1.0
        self.recovering = False
        self.retry_at = 0.0
        self.retry_delay = 2.0
        self.healthy_since = None
        self.trial = True
        self.trial_started = None
        self.trial_media = 0.0
        self.trial_is_recovery = False
        self.original_frames = 0
        self.generated_frames = 0
        self.fallback_frames = 0
        self.color_bypass = False

    def snapshot(self):
        with self.lock:
            return {
                "mode": "fallback" if self.recovering or self.color_bypass else "trial" if self.trial else "interpolating",
                "fallbackReason": "color-metadata" if self.color_bypass else "processing" if self.recovering else None,
                "speed": self.speed,
                "originalFrames": self.original_frames,
                "generatedFrames": self.generated_frames,
                "fallbackFrames": self.fallback_frames,
            }

    def set_speed(self, speed):
        speed = max(0.01, min(100.0, float(speed)))
        with self.lock:
            if abs(speed - self.speed) < 0.0001:
                return
            self.speed = speed
            self.recovering = False
            self.trial = True
            self.trial_started = None
            self.trial_media = 0.0
            self.trial_is_recovery = False
            self.healthy_since = None

    def _pipeline_overdue(self, now):
        if not self.pending:
            return False
        # A queue's playback budget is the sum of its actual frame durations.
        # Frame numbers cannot supply timestamps for variable-rate or reordered
        # requests. Allow a small processing margin for the warmed pipeline.
        budget = sum(item[2] for item in self.pending.values()) / self.speed
        return now - min(item[0] for item in self.pending.values()) > max(0.2, budget + 0.1)

    def _overloaded(self, now):
        if not self.recovering:
            self.report("RIFE overloaded; temporarily using source frames")
        self.recovering = True
        self.trial = False
        self.healthy_since = None
        self.retry_at = now + self.retry_delay
        self.retry_delay = min(15.0, self.retry_delay * 2)

    def request(self, n, duration, use_source=False):
        with self.lock:
            now = self.clock()
            if use_source:
                self.color_bypass = True
                self.pending[n] = (now, None, duration, False)
                self.last_activity = now
                return False
            if self.color_bypass:
                self.color_bypass = False
                self.recovering = False
                self.trial = True
                self.trial_started = None
                self.trial_media = 0.0
            # MPV stops requesting once its queue fills, including during pause,
            # slow playback, or network buffering. Only charge time while this
            # graph has work to do. Seeks rebuild the script and its guard.
            if self.last_activity is not None and not self.pending and self.trial_started is not None:
                self.trial_started += now - self.last_activity
            if not self.recovering and not self.trial and not self.color_bypass and self._pipeline_overdue(now):
                self._overloaded(now)

            generated = n % self.multiplier != 0
            use_rife = not self.recovering
            if self.recovering and generated and now >= self.retry_at:
                # Cold single-frame latency includes conversions and GPU wakeup;
                # it does not measure the capacity of a parallel RIFE pipeline.
                # Drain old work, then test the configured bounded queue.
                if not any(item[3] for item in self.pending.values()):
                    self.recovering = False
                    self.trial = True
                    self.trial_started = None
                    self.trial_media = 0.0
                    self.trial_is_recovery = True
                    use_rife = True
            self.pending[n] = (now, None, duration, generated and use_rife)
            self.last_activity = now
            return use_rife

    def complete(self, n):
        with self.lock:
            now = self.clock()
            if not self.recovering and not self.trial and not self.color_bypass and self._pipeline_overdue(now):
                self._overloaded(now)
            item = self.pending.pop(n, None)
            self.last_activity = now
            if item is None:
                return
            _, _, duration, generated = item
            if n % self.multiplier == 0:
                self.original_frames += 1
            elif generated:
                self.generated_frames += 1
            else:
                self.fallback_frames += 1
            if generated and not self.recovering and not self.color_bypass:
                # Ignore first-use initialization, then measure media produced
                # over at least half a second of active processing. Frames can
                # finish out of order; each generated slot counts once.
                if self.trial_started is None:
                    self.trial_started = now
                else:
                    self.trial_media += duration * self.multiplier / (self.multiplier - 1)
                    elapsed = now - self.trial_started
                    if elapsed >= 0.5 or self.trial_media >= 0.5 * self.speed:
                        if self.trial_media < elapsed * self.speed * 0.85:
                            self._overloaded(now)
                        else:
                            if self.trial:
                                self.healthy_since = now
                                if self.trial_is_recovery:
                                    self.report("RIFE recovered; resuming interpolation")
                            self.trial = False
                            self.trial_started = now
                            self.trial_media = 0.0
                if self.healthy_since is not None and now - self.healthy_since >= 5.0:
                    self.retry_delay = 2.0


class RifePlaybackBridge:
    """Exchange bounded playback telemetry with Streamee's MPV controller."""

    def __init__(self, directory=None, pid=None, clock=monotonic, wall_clock=wall_time):
        self.pid = pid or os.getpid()
        self.directory = directory or os.environ.get("STREAMEE_RIFE_STATE_DIR", tempfile.gettempdir())
        self.status_path = os.path.join(self.directory, f"streamee-rife-{self.pid}-status.json")
        self.control_path = os.path.join(self.directory, f"streamee-rife-{self.pid}-control.json")
        self.clock, self.wall_clock = clock, wall_clock
        self.last_read = self.last_write = None
        self.last_attempt = None
        self.last_counts = (0, 0)
        self.current_speed = 1.0
        self.lock = Lock()

    def speed(self):
        with self.lock:
            now = self.clock()
            if self.last_read is None or now - self.last_read >= 0.25:
                self.last_read = now
                try:
                    with open(self.control_path, encoding="utf-8") as source:
                        control = json.load(source)
                    speed = float(control["speed"])
                    age = self.wall_clock() - float(control["updatedAt"])
                    if control.get("pid") == self.pid and 0 <= age <= 5 and 0.01 <= speed <= 100:
                        self.current_speed = speed
                except (OSError, ValueError, KeyError, TypeError):
                    pass
            return self.current_speed

    def publish(self, guard):
        with self.lock:
            now = self.clock()
            if self.last_attempt is not None and now - self.last_attempt < 0.5:
                return
            self.last_attempt = now
            status = guard.snapshot()
            counts = (status["originalFrames"], status["generatedFrames"])
            elapsed = now - self.last_write if self.last_write is not None else 0
            status.update({
                "pid": self.pid, "updatedAt": self.wall_clock(),
                "sourceFps": (counts[0] - self.last_counts[0]) / elapsed if elapsed > 0 else 0,
                "generatedFps": (counts[1] - self.last_counts[1]) / elapsed if elapsed > 0 else 0,
            })
            temporary = self.status_path + ".tmp"
            try:
                with open(temporary, "w", encoding="utf-8") as output:
                    json.dump(status, output, allow_nan=False)
                os.replace(temporary, self.status_path)
                self.last_write, self.last_counts = now, counts
            except (OSError, ValueError):
                pass


def guard_playback(source, interpolated, multiplier, gpu_streams):
    # Interleave divides each source frame's duration by the multiplier. Both
    # branches therefore have identical timestamps, including variable-rate
    # input. The fallback retains the original pixels and color properties.
    fallback = core.std.Interleave([source] * multiplier)
    guard = RifePlaybackGuard(
        multiplier,
        gpu_streams,
        report=lambda message: core.log_message(vs.MESSAGE_TYPE_INFORMATION, message),
    )
    bridge = globals().get("playback_bridge")
    if bridge:
        bridge.publish(guard)

    def choose(n, f):
        if bridge:
            guard.set_speed(bridge.speed())
        use_source = not color_conversion_supported(f.props)
        numerator = f.props.get("_DurationNum", 0)
        denominator = f.props.get("_DurationDen", 0)
        if numerator <= 0 or denominator <= 0:
            return fallback if use_source else interpolated
        return interpolated if guard.request(n, numerator / denominator, use_source=use_source) else fallback

    selected = core.std.FrameEval(
        fallback, eval=choose, prop_src=fallback, clip_src=[fallback, interpolated],
    )

    def completed(n, f):
        guard.complete(n)
        if bridge:
            bridge.publish(guard)
        return f

    return core.std.ModifyFrame(selected, clips=selected, selector=completed)


playback_bridge = RifePlaybackBridge() if os.environ.get("STREAMEE_RIFE_REALTIME") == "1" else None
clip = video_in.std.Trim(length=5_000_000)
source = clip
source_format = clip.format.id
source_width = clip.width
source_height = clip.height

processing_width = source_width
processing_height = source_height
external_processing_height = int(processing_mode) if processing_mode in {"1080", "720"} else 0
if external_processing_height and source_height > external_processing_height:
    processing_height = external_processing_height
    processing_width = max(2, round(source_width * processing_height / source_height / 2) * 2)
    clip = clip.resize.Spline36(width=processing_width, height=processing_height)

# RIFE 4.6 can estimate optical flow below full scale while retaining
# full-resolution input, original frames, and generated output. Newer models
# reject scale != 1. Treat cropped 4K cinema sources as 4K while leaving
# 1440p and 3440x1440 ultrawide sources at full motion-analysis scale.
if model_name == "4.6":
    is_4k_family = source_width >= 3500 or source_height >= 1800
    rife_scale = (
        Fraction(1, 2) if scale_setting == "auto" and processing_mode == "auto" and is_4k_family
        else Fraction(1, 1) if scale_setting == "auto"
        else Fraction(scale_setting)
    )
else:
    rife_scale = Fraction(1, 1)

# RIFE 4.6's merge graph requires dimensions aligned to 32 / scale. Preserve
# decimal settings as exact fractions so values such as 0.2 and 0.4 do not
# acquire binary floating-point denominators before vsmlrt validates them.
alignment_fraction = Fraction(32, 1) / rife_scale
if alignment_fraction.denominator != 1:
    raise ValueError(f"Unsupported RIFE scale alignment: {rife_scale}")
alignment = alignment_fraction.numerator


# Border padding preserves the full source image and is removed from the
# generated result. TensorRT specializes one engine for the exact padded input
# shape so fixed-resolution playback does not pay dynamic-shape overhead.
pad_right = (-processing_width) % alignment
pad_bottom = (-processing_height) % alignment
if pad_right or pad_bottom:
    clip = clip.std.AddBorders(right=pad_right, bottom=pad_bottom)

padded_width = processing_width + pad_right
padded_height = processing_height + pad_bottom

# Mark hard cuts before converting to the RGB half-float input expected by RIFE.
clip = clip.misc.SCDetect(threshold=0.12)

matrix_names = {
    int(vs.MATRIX_BT709): "709",
    int(vs.MATRIX_FCC): "fcc",
    int(vs.MATRIX_BT470_BG): "470bg",
    int(vs.MATRIX_ST170_M): "170m",
    int(vs.MATRIX_ST240_M): "240m",
    int(vs.MATRIX_BT2020_NCL): "2020ncl",
    int(vs.MATRIX_BT2020_CL): "2020cl",
    int(vs.MATRIX_CHROMATICITY_DERIVED_NCL): "chromancl",
    int(vs.MATRIX_CHROMATICITY_DERIVED_CL): "chromacl",
    int(vs.MATRIX_ICTCP): "ictcp",
}


def range_name(range_id: int) -> str:
    return "limited" if range_id == int(vs.RANGE_LIMITED) else "full"


def frame_color_properties(props):
    # MPV's bridge uses _ColorSpace; native VapourSynth sources use _Matrix.
    matrix_id = next(
        (int(props[key]) for key in ("_Matrix", "_ColorSpace")
         if key in props and int(props[key]) in matrix_names),
        int(vs.MATRIX_BT709),
    )
    if props.get("_Range") in (0, 1):
        range_id = 1 - int(props["_Range"])
    else:
        range_id = int(props.get("_ColorRange", int(vs.RANGE_LIMITED)))
    if range_id not in (int(vs.RANGE_FULL), int(vs.RANGE_LIMITED)):
        range_id = int(vs.RANGE_LIMITED)
    return matrix_id, range_id


def color_conversion_supported(props):
    matrix_id, _ = frame_color_properties(props)
    transfer = int(props.get("_Transfer", 2))
    primaries = int(props.get("_Primaries", 2))
    if matrix_id == 10:
        return transfer in (14, 15)
    if matrix_id in (12, 13):
        known_primaries = primaries in (1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 22)
        return known_primaries and (matrix_id == 12 or transfer in (1, 4, 5, 6, 7, 8, 13, 14, 15, 16, 18))
    if matrix_id == 14:
        return primaries == 9 and transfer in (16, 18)
    return True


rgb_conversions = {
    (matrix_id, range_id): clip.resize.Bicubic(
        format=vs.RGBH,
        matrix_in_s=matrix_name,
        range_in_s=range_name(range_id),
    )
    for matrix_id, matrix_name in matrix_names.items()
    for range_id in (int(vs.RANGE_FULL), int(vs.RANGE_LIMITED))
}
default_rgb = rgb_conversions[(int(vs.MATRIX_BT709), int(vs.RANGE_LIMITED))]


def select_rgb_conversion(n: int, f: vs.VideoFrame) -> vs.VideoNode:
    del n
    matrix_id, range_id = frame_color_properties(f.props)
    return rgb_conversions.get((matrix_id, range_id), default_rgb)


rgb = core.std.FrameEval(default_rgb, eval=select_rgb_conversion, prop_src=clip)

backend = Backend.TRT(
    device_id=0,
    num_streams=gpu_streams,
    static_shape=True,
    opt_shapes=[padded_width, padded_height],
)
backend.force_fp16 = True
backend.tf32 = True
backend.output_format = 1
backend.use_cuda_graph = True
backend.workspace = None

smooth = RIFE(
    rgb,
    multi=multiplier,
    scale=rife_scale,
    model=model_number(model_name),
    backend=backend,
    ensemble=False,
    video_player=True,
    _implementation=1,
)
def converted_output(matrix_name: str, range_name: str) -> vs.VideoNode:
    return smooth.resize.Point(
        format=source_format,
        matrix_s=matrix_name,
        range_s=range_name,
    )


converted = {
    (matrix_id, range_id): converted_output(
        matrix_name,
        "limited" if range_id == int(vs.RANGE_LIMITED) else "full",
    )
    for matrix_id, matrix_name in matrix_names.items()
    for range_id in (int(vs.RANGE_FULL), int(vs.RANGE_LIMITED))
}
default_output = converted[(int(vs.MATRIX_BT709), int(vs.RANGE_LIMITED))]
property_clip = core.std.Interleave([clip] * multiplier)


def select_color_conversion(n: int, f: vs.VideoFrame) -> vs.VideoNode:
    del n
    matrix_id, range_id = frame_color_properties(f.props)
    return converted.get((matrix_id, range_id), default_output)


smooth = core.std.FrameEval(
    default_output,
    eval=select_color_conversion,
    prop_src=property_clip,
)

if pad_right or pad_bottom:
    smooth = smooth.std.CropRel(right=pad_right, bottom=pad_bottom)

if processing_width != source_width or processing_height != source_height:
    smooth = smooth.resize.Spline36(width=source_width, height=source_height)

guard_playback(source, smooth, multiplier, gpu_streams).set_output()
