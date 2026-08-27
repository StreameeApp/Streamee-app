use std::collections::VecDeque;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::SystemTime;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, HANDLE};

#[cfg(target_os = "windows")]
use crate::mpv_ipc::{connect_to_mpv_pipe, send_command, MpvCommand, MpvResponse};

const RIDER_GAIN_FILTER_NAME: &str = "rider-gain";
const RIDER_GAIN_FILTER_SPEC: &str = "@rider-gain:volume=volume=0dB";
const RIDER_STEREO_FILTER_NAME: &str = "rider-stereo";
const RIDER_STEREO_FILTER_SPEC: &str = "@rider-stereo:lavfi=[aformat=channel_layouts=stereo]";
const RIDER_EBUR128_FILTER_NAME: &str = "rider-ebur128";
const RIDER_EBUR128_FILTER_SPEC: &str = "@rider-ebur128:lavfi=[ebur128=metadata=1:peak=true]";
const RIDER_PEAK_FILTER_NAME: &str = "rider-peak";
const RIDER_PEAK_FILTER_SPEC: &str =
    "@rider-peak:lavfi=[astats=metadata=1:length=0.02:reset=1:measure_overall=Peak_level:measure_perchannel=none]";
const RIDER_LIMITER_FILTER_NAME: &str = "rider-limiter";
const RIDER_OUTPUT_EBUR128_FILTER_NAME: &str = "rider-output-ebur128";
const RIDER_OUTPUT_PEAK_FILTER_NAME: &str = "rider-output-peak";
const RIDER_OUTPUT_PEAK_FILTER_SPEC: &str =
    "@rider-output-peak:lavfi=[astats=metadata=1:length=0.02:reset=1:measure_overall=Peak_level:measure_perchannel=none]";

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiderResponseMode {
    TimeBased,
    DbPerSec,
}

impl Default for RiderResponseMode {
    fn default() -> Self {
        Self::TimeBased
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FastDetectorMode {
    MomentaryDelta,
    TruePeak,
}

impl Default for FastDetectorMode {
    fn default() -> Self {
        Self::TruePeak
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlowControlMode {
    Momentary,
    ShortTerm,
    Blended,
}

impl Default for SlowControlMode {
    fn default() -> Self {
        Self::Blended
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GateDetectorMode {
    Momentary,
    ShortTerm,
}

impl Default for GateDetectorMode {
    fn default() -> Self {
        Self::ShortTerm
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AdaptiveGateMode {
    Direct,
    Stable,
}

impl Default for AdaptiveGateMode {
    fn default() -> Self {
        Self::Direct
    }
}

fn default_attack_db_per_sec() -> f64 {
    20.0
}

fn default_release_db_per_sec() -> f64 {
    6.0
}

fn default_transient_threshold_lu() -> f64 {
    4.0
}

fn default_max_transient_cut_db() -> f64 {
    12.0
}

fn default_fast_threshold_lu() -> f64 {
    3.0
}

fn default_fast_max_cut_db() -> f64 {
    10.0
}

fn default_fast_attack_ms() -> f64 {
    80.0
}

fn default_fast_release_ms() -> f64 {
    350.0
}

fn default_fast_true_peak_threshold_db() -> f64 {
    -8.0
}

fn default_refresh_interval_ms() -> f64 {
    200.0
}

fn default_gate_observation_window_secs() -> f64 {
    60.0
}

fn default_adaptive_max_gain_limit_db() -> f64 {
    40.0
}

fn default_peak_ceiling_threshold_db() -> f64 {
    -1.0
}

fn default_limiter_limit_db() -> f64 {
    -1.0
}

fn default_limiter_attack_ms() -> f64 {
    5.0
}

fn default_limiter_release_ms() -> f64 {
    50.0
}

fn min_supported_limiter_limit_db() -> f64 {
    20.0 * 0.0625f64.log10()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizerConfig {
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub slow_enabled: bool,
    #[serde(default = "default_true")]
    pub fast_enabled: bool,
    #[serde(default = "default_true")]
    pub transient_enabled: bool,
    #[serde(default = "default_true")]
    pub peak_ceiling_enabled: bool,
    #[serde(default)]
    pub limiter_enabled: bool,
    pub target_lufs: f64,
    pub max_gain_db: f64,
    pub max_cut_db: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    #[serde(default)]
    pub slow_control_mode: SlowControlMode,
    #[serde(default)]
    pub response_mode: RiderResponseMode,
    #[serde(default = "default_attack_db_per_sec")]
    pub attack_db_per_sec: f64,
    #[serde(default = "default_release_db_per_sec")]
    pub release_db_per_sec: f64,
    #[serde(default = "default_transient_threshold_lu")]
    pub transient_threshold_lu: f64,
    #[serde(default = "default_max_transient_cut_db")]
    pub max_transient_cut_db: f64,
    #[serde(default = "default_fast_threshold_lu")]
    pub fast_threshold_lu: f64,
    #[serde(default = "default_fast_max_cut_db")]
    pub fast_max_cut_db: f64,
    #[serde(default = "default_fast_attack_ms")]
    pub fast_attack_ms: f64,
    #[serde(default = "default_fast_release_ms")]
    pub fast_release_ms: f64,
    #[serde(default)]
    pub fast_detector_mode: FastDetectorMode,
    #[serde(default = "default_fast_true_peak_threshold_db")]
    pub fast_true_peak_threshold_db: f64,
    #[serde(default = "default_peak_ceiling_threshold_db")]
    pub peak_ceiling_threshold_db: f64,
    #[serde(default = "default_limiter_limit_db")]
    pub limiter_limit_db: f64,
    #[serde(default = "default_limiter_attack_ms")]
    pub limiter_attack_ms: f64,
    #[serde(default = "default_limiter_release_ms")]
    pub limiter_release_ms: f64,
    #[serde(default)]
    pub adaptive_gate_enabled: bool,
    #[serde(default)]
    pub adaptive_gate_mode: AdaptiveGateMode,
    #[serde(default)]
    pub adaptive_max_gain_enabled: bool,
    #[serde(default = "default_adaptive_max_gain_limit_db")]
    pub adaptive_max_gain_limit_db: f64,
    #[serde(default)]
    pub subtitle_assist_enabled: bool,
    #[serde(default)]
    pub gate_detector_mode: GateDetectorMode,
    #[serde(default = "default_gate_observation_window_secs")]
    pub gate_observation_window_secs: f64,
    pub gate_threshold_lufs: f64,
    pub hold_ms: f64,
    #[serde(default = "default_refresh_interval_ms")]
    pub refresh_interval_ms: f64,
}

impl Default for NormalizerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            slow_enabled: true,
            fast_enabled: false,
            transient_enabled: false,
            peak_ceiling_enabled: false,
            limiter_enabled: true,
            target_lufs: -16.0,
            max_gain_db: 30.0,
            max_cut_db: -60.0,
            attack_ms: 200.0,
            release_ms: 1500.0,
            slow_control_mode: SlowControlMode::ShortTerm,
            response_mode: RiderResponseMode::DbPerSec,
            attack_db_per_sec: 6.0,
            release_db_per_sec: 6.0,
            transient_threshold_lu: default_transient_threshold_lu(),
            max_transient_cut_db: default_max_transient_cut_db(),
            fast_threshold_lu: default_fast_threshold_lu(),
            fast_max_cut_db: default_fast_max_cut_db(),
            fast_attack_ms: default_fast_attack_ms(),
            fast_release_ms: default_fast_release_ms(),
            fast_detector_mode: FastDetectorMode::TruePeak,
            fast_true_peak_threshold_db: default_fast_true_peak_threshold_db(),
            peak_ceiling_threshold_db: default_peak_ceiling_threshold_db(),
            limiter_limit_db: -5.0,
            limiter_attack_ms: 0.1,
            limiter_release_ms: 1000.0,
            adaptive_gate_enabled: false,
            adaptive_gate_mode: AdaptiveGateMode::Direct,
            adaptive_max_gain_enabled: false,
            adaptive_max_gain_limit_db: default_adaptive_max_gain_limit_db(),
            subtitle_assist_enabled: false,
            gate_detector_mode: GateDetectorMode::ShortTerm,
            gate_observation_window_secs: default_gate_observation_window_secs(),
            gate_threshold_lufs: -40.0,
            hold_ms: 100.0,
            refresh_interval_ms: default_refresh_interval_ms(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizerState {
    pub current_gain_db: f64,
    pub momentary_lufs: f64,
    pub short_term_lufs: f64,
    pub integrated_lufs: f64,
    pub true_peak_db: f64,
    pub true_peak_source: PeakTelemetrySource,
    pub limiter_input_peak_db: f64,
    pub limiter_input_peak_source: PeakTelemetrySource,
    pub output_peak_db: f64,
    pub output_peak_source: PeakTelemetrySource,
    pub limiter_reduction_db: f64,
    pub smoothed_lufs: f64,
    pub desired_gain_db: f64,
    pub slow_gain_db: f64,
    pub fast_gain_db: f64,
    pub transient_cut_db: f64,
    pub effective_max_gain_db: f64,
    pub adaptive_gain_extra_db: f64,
    pub adaptive_gain_state: String,
    pub gate_signal_lufs: f64,
    pub gate_threshold_lufs: f64,
    pub gate_normalization_offset_db: f64,
    pub gate_ambient_floor_lufs: f64,
    pub gate_foreground_lufs: f64,
    pub gate_open_threshold_lufs: f64,
    pub gate_close_threshold_lufs: f64,
    pub gate_observed_range_lu: f64,
    pub gate_observed_secs: f64,
    pub gate_observation_window_secs: f64,
    pub gate_confidence: f64,
    pub gate_detector_ready: bool,
    pub gate_model_state: String,
    pub gate_model_age_secs: f64,
    pub gate_phase: String,
    pub adaptive_gate_enabled: bool,
    pub adaptive_gate_mode: AdaptiveGateMode,
    pub subtitle_assist_enabled: bool,
    pub subtitle_assist_active: bool,
    pub gate_detector_mode: GateDetectorMode,
    pub gate_acquiring: bool,
    pub is_gated: bool,
    pub connected: bool,
    pub paused: bool,
    pub manual_mode: bool,
}

impl Default for NormalizerState {
    fn default() -> Self {
        Self {
            current_gain_db: 0.0,
            momentary_lufs: -70.0,
            short_term_lufs: -70.0,
            integrated_lufs: -70.0,
            true_peak_db: -70.0,
            true_peak_source: PeakTelemetrySource::Unknown,
            limiter_input_peak_db: -70.0,
            limiter_input_peak_source: PeakTelemetrySource::Unknown,
            output_peak_db: -70.0,
            output_peak_source: PeakTelemetrySource::Unknown,
            limiter_reduction_db: 0.0,
            smoothed_lufs: -70.0,
            desired_gain_db: 0.0,
            slow_gain_db: 0.0,
            fast_gain_db: 0.0,
            transient_cut_db: 0.0,
            effective_max_gain_db: 30.0,
            adaptive_gain_extra_db: 0.0,
            adaptive_gain_state: "disabled".to_string(),
            gate_signal_lufs: -70.0,
            gate_threshold_lufs: -40.0,
            gate_normalization_offset_db: 0.0,
            gate_ambient_floor_lufs: -70.0,
            gate_foreground_lufs: -70.0,
            gate_open_threshold_lufs: -40.0,
            gate_close_threshold_lufs: -40.0,
            gate_observed_range_lu: 0.0,
            gate_observed_secs: 0.0,
            gate_observation_window_secs: default_gate_observation_window_secs(),
            gate_confidence: 0.0,
            gate_detector_ready: false,
            gate_model_state: "fixed".to_string(),
            gate_model_age_secs: 0.0,
            gate_phase: "open".to_string(),
            adaptive_gate_enabled: false,
            adaptive_gate_mode: AdaptiveGateMode::Direct,
            subtitle_assist_enabled: false,
            subtitle_assist_active: false,
            gate_detector_mode: GateDetectorMode::ShortTerm,
            gate_acquiring: false,
            is_gated: false,
            connected: false,
            paused: false,
            manual_mode: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryPayload {
    pub timestamp_ms: f64,
    pub momentary_lufs: f64,
    pub short_term_lufs: f64,
    pub integrated_lufs: f64,
    pub true_peak_db: f64,
    pub true_peak_source: PeakTelemetrySource,
    pub limiter_input_peak_db: f64,
    pub limiter_input_peak_source: PeakTelemetrySource,
    pub output_peak_db: f64,
    pub output_peak_source: PeakTelemetrySource,
    pub limiter_reduction_db: f64,
    pub smoothed_lufs: f64,
    pub desired_gain_db: f64,
    pub slow_gain_db: f64,
    pub fast_gain_db: f64,
    pub transient_cut_db: f64,
    pub current_gain_db: f64,
    pub effective_max_gain_db: f64,
    pub adaptive_gain_extra_db: f64,
    pub adaptive_gain_state: String,
    pub gate_signal_lufs: f64,
    pub gate_threshold_lufs: f64,
    pub gate_normalization_offset_db: f64,
    pub gate_ambient_floor_lufs: f64,
    pub gate_foreground_lufs: f64,
    pub gate_open_threshold_lufs: f64,
    pub gate_close_threshold_lufs: f64,
    pub gate_observed_range_lu: f64,
    pub gate_observed_secs: f64,
    pub gate_observation_window_secs: f64,
    pub gate_confidence: f64,
    pub gate_detector_ready: bool,
    pub gate_model_state: String,
    pub gate_model_age_secs: f64,
    pub gate_phase: String,
    pub adaptive_gate_enabled: bool,
    pub adaptive_gate_mode: AdaptiveGateMode,
    pub subtitle_assist_enabled: bool,
    pub subtitle_assist_active: bool,
    pub gate_detector_mode: GateDetectorMode,
    pub gate_acquiring: bool,
    pub is_gated: bool,
    pub connected: bool,
    pub paused: bool,
    pub manual_mode: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventLogEntry {
    pub timestamp_ms: f64,
    pub event_type: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataProbeEntry {
    pub property: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioNormalizerDebugInfo {
    pub connected: bool,
    pub manual_mode: bool,
    pub filters: Option<serde_json::Value>,
    pub filename: Option<String>,
    pub probes: Vec<MetadataProbeEntry>,
    pub metadata_roots: Vec<MetadataProbeEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PeakTelemetrySource {
    TruePeak,
    SamplePeak,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Copy)]
struct PeakMeasurement {
    db: f64,
    source: PeakTelemetrySource,
}

impl PeakMeasurement {
    fn unknown() -> Self {
        Self {
            db: -70.0,
            source: PeakTelemetrySource::Unknown,
        }
    }
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

pub fn get_preset(name: &str) -> Option<NormalizerConfig> {
    let name = if name == "night" { "medium" } else { name };

    let preset_with_target = |target_lufs| NormalizerConfig {
        enabled: true,
        slow_enabled: true,
        fast_enabled: false,
        transient_enabled: false,
        peak_ceiling_enabled: false,
        limiter_enabled: true,
        target_lufs,
        max_gain_db: 30.0,
        max_cut_db: -60.0,
        attack_ms: 200.0,
        release_ms: 1500.0,
        slow_control_mode: SlowControlMode::Momentary,
        response_mode: RiderResponseMode::DbPerSec,
        attack_db_per_sec: 24.0,
        release_db_per_sec: 2.0,
        transient_threshold_lu: 4.0,
        max_transient_cut_db: 12.0,
        fast_threshold_lu: 3.0,
        fast_max_cut_db: 10.0,
        fast_attack_ms: 80.0,
        fast_release_ms: 350.0,
        fast_detector_mode: FastDetectorMode::TruePeak,
        fast_true_peak_threshold_db: -8.0,
        peak_ceiling_threshold_db: -1.0,
        limiter_limit_db: -1.0,
        limiter_attack_ms: 1.0,
        limiter_release_ms: 5.0,
        adaptive_gate_enabled: true,
        adaptive_gate_mode: AdaptiveGateMode::Stable,
        adaptive_max_gain_enabled: true,
        adaptive_max_gain_limit_db: 48.0,
        subtitle_assist_enabled: true,
        gate_detector_mode: GateDetectorMode::Momentary,
        gate_observation_window_secs: 30.0,
        gate_threshold_lufs: 0.0,
        hold_ms: 100.0,
        refresh_interval_ms: 50.0,
    };

    match name {
        "light" => Some(preset_with_target(-18.0)),
        "medium" => Some(preset_with_target(-16.0)),
        "strong" => Some(preset_with_target(-14.0)),
        "custom" => get_custom_preset(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

static NORMALIZER_RUNNING: AtomicBool = AtomicBool::new(false);
static NORMALIZER_THREAD: Lazy<Mutex<Option<JoinHandle<()>>>> = Lazy::new(|| Mutex::new(None));
static FILTERS_INSTALLED: AtomicBool = AtomicBool::new(false);
static RESET_REQUESTED: AtomicBool = AtomicBool::new(false);
static METADATA_PATH_LOGGED: AtomicBool = AtomicBool::new(false);
static METADATA_MISS_LOGGED: AtomicBool = AtomicBool::new(false);
static MANUAL_MODE: AtomicBool = AtomicBool::new(false);
static MANUAL_GAIN_DB: Lazy<Mutex<f64>> = Lazy::new(|| Mutex::new(0.0));

static CONFIG: Lazy<Mutex<NormalizerConfig>> =
    Lazy::new(|| Mutex::new(NormalizerConfig::default()));
static STATE: Lazy<Mutex<NormalizerState>> = Lazy::new(|| Mutex::new(NormalizerState::default()));
static PRESET_NAME: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new("medium".to_string()));
static CUSTOM_PRESET: Lazy<Mutex<Option<NormalizerConfig>>> = Lazy::new(|| Mutex::new(None));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub fn set_config(config: NormalizerConfig) {
    if let Ok(mut c) = CONFIG.lock() {
        *c = sanitize_config(config);
    }
}

fn sanitize_config(mut config: NormalizerConfig) -> NormalizerConfig {
    config.target_lufs = config.target_lufs.clamp(-60.0, 0.0);
    config.max_gain_db = config.max_gain_db.clamp(0.0, 40.0);
    config.max_cut_db = config.max_cut_db.clamp(-80.0, 0.0);
    config.attack_ms = config.attack_ms.clamp(1.0, 10_000.0);
    config.release_ms = config.release_ms.clamp(1.0, 10_000.0);
    config.attack_db_per_sec = config.attack_db_per_sec.clamp(0.0, 100.0);
    config.release_db_per_sec = config.release_db_per_sec.clamp(0.0, 100.0);
    config.transient_threshold_lu = config.transient_threshold_lu.clamp(0.0, 50.0);
    config.max_transient_cut_db = config.max_transient_cut_db.clamp(0.0, 80.0);
    config.fast_threshold_lu = config.fast_threshold_lu.clamp(0.0, 50.0);
    config.fast_max_cut_db = config.fast_max_cut_db.clamp(0.0, 80.0);
    config.fast_attack_ms = config.fast_attack_ms.clamp(1.0, 10_000.0);
    config.fast_release_ms = config.fast_release_ms.clamp(1.0, 10_000.0);
    config.fast_true_peak_threshold_db = config.fast_true_peak_threshold_db.clamp(-60.0, 0.0);
    config.peak_ceiling_threshold_db = config.peak_ceiling_threshold_db.clamp(-60.0, 0.0);
    config.adaptive_max_gain_limit_db = config.adaptive_max_gain_limit_db.clamp(0.0, 48.0);
    config.gate_observation_window_secs = config.gate_observation_window_secs.clamp(5.0, 300.0);
    config.gate_threshold_lufs = config.gate_threshold_lufs.clamp(-90.0, 0.0);
    config.hold_ms = config.hold_ms.clamp(0.0, 10_000.0);

    if config.max_cut_db > config.max_gain_db {
        warn!(
            "[Normalizer] Swapping invalid gain bounds: max_cut_db ({:.2}) > max_gain_db ({:.2})",
            config.max_cut_db, config.max_gain_db
        );
        std::mem::swap(&mut config.max_cut_db, &mut config.max_gain_db);
    }

    config.limiter_limit_db = config.limiter_limit_db.min(0.0);
    let min_limiter_db = min_supported_limiter_limit_db();
    if config.limiter_limit_db < min_limiter_db {
        warn!(
            "[Normalizer] Clamping limiter threshold from {:.2} dBTP to supported minimum {:.2} dBTP",
            config.limiter_limit_db,
            min_limiter_db
        );
        config.limiter_limit_db = min_limiter_db;
    }

    config.limiter_attack_ms = config.limiter_attack_ms.clamp(0.1, 10_000.0);
    config.limiter_release_ms = config.limiter_release_ms.clamp(1.0, 10_000.0);
    config.refresh_interval_ms = config.refresh_interval_ms.clamp(25.0, 5_000.0);
    config
}

fn protection_filters_are_usable(
    core_filters_added: bool,
    limiter_required: bool,
    limiter_added: bool,
) -> bool {
    core_filters_added && (!limiter_required || limiter_added)
}

pub fn get_config() -> NormalizerConfig {
    CONFIG.lock().map(|c| c.clone()).unwrap_or_default()
}

pub fn get_state() -> NormalizerState {
    STATE.lock().map(|s| s.clone()).unwrap_or_default()
}

pub fn get_preset_name() -> String {
    PRESET_NAME
        .lock()
        .map(|preset| preset.clone())
        .unwrap_or_else(|_| "medium".to_string())
}

pub fn set_preset_name(name: impl Into<String>) {
    if let Ok(mut preset) = PRESET_NAME.lock() {
        *preset = name.into();
    }
}

pub fn set_custom_preset(config: NormalizerConfig) {
    if let Ok(mut preset) = CUSTOM_PRESET.lock() {
        *preset = Some(config);
    }
}

pub fn get_custom_preset() -> Option<NormalizerConfig> {
    CUSTOM_PRESET.lock().ok().and_then(|preset| preset.clone())
}

pub fn apply_preset(name: &str) -> Result<(), String> {
    let canonical_name = if name == "night" { "medium" } else { name };
    let preset = get_preset(canonical_name).ok_or_else(|| format!("Unknown preset: {}", name))?;
    let was_enabled = get_config().enabled;
    let mut cfg = preset;
    cfg.enabled = was_enabled;
    set_config(cfg);
    set_preset_name(canonical_name);
    Ok(())
}

fn reset_shared_state(connected: bool) {
    let config = get_config();
    let manual_mode = MANUAL_MODE.load(Ordering::SeqCst);
    if let Ok(mut state) = STATE.lock() {
        *state = NormalizerState {
            effective_max_gain_db: config.max_gain_db,
            adaptive_gain_state: if manual_mode {
                "manual".to_string()
            } else if config.adaptive_max_gain_enabled {
                "waiting_for_long_term".to_string()
            } else {
                "disabled".to_string()
            },
            adaptive_gate_enabled: config.adaptive_gate_enabled,
            adaptive_gate_mode: config.adaptive_gate_mode,
            subtitle_assist_enabled: config.subtitle_assist_enabled,
            gate_detector_mode: config.gate_detector_mode,
            gate_observation_window_secs: config.gate_observation_window_secs,
            connected,
            manual_mode,
            ..NormalizerState::default()
        };
    }
}

pub fn request_reset() {
    RESET_REQUESTED.store(true, Ordering::SeqCst);
    if let Ok(mut manual_gain) = MANUAL_GAIN_DB.lock() {
        *manual_gain = 0.0;
    }
    let connected = get_state().connected;
    reset_shared_state(connected);
}

pub fn clear_state() {
    RESET_REQUESTED.store(false, Ordering::SeqCst);
    if let Ok(mut manual_gain) = MANUAL_GAIN_DB.lock() {
        *manual_gain = 0.0;
    }
    reset_shared_state(false);
}

pub fn set_manual_mode(enabled: bool) {
    MANUAL_MODE.store(enabled, Ordering::SeqCst);
    if let Ok(mut state) = STATE.lock() {
        state.manual_mode = enabled;
    }
}

pub fn is_manual_mode() -> bool {
    MANUAL_MODE.load(Ordering::SeqCst)
}

#[cfg(target_os = "windows")]
pub fn get_debug_info() -> Result<AudioNormalizerDebugInfo, String> {
    let pipe = connect_to_mpv_pipe().ok_or_else(|| "MPV not connected".to_string())?;

    let filters = mpv_get_property_json(pipe, "af");
    let filename = read_filename(pipe);
    let mut probes = Vec::new();
    let mut metadata_roots = Vec::new();

    for property in [
        "af-metadata".to_string(),
        format!("af-metadata/@{}", RIDER_EBUR128_FILTER_NAME),
        format!("af-metadata/{}", RIDER_EBUR128_FILTER_NAME),
        format!("af-metadata/@{}", RIDER_PEAK_FILTER_NAME),
        format!("af-metadata/{}", RIDER_PEAK_FILTER_NAME),
        "af-metadata/lavfi".to_string(),
        "af-metadata/lavfi.ebur128".to_string(),
    ] {
        metadata_roots.push(MetadataProbeEntry {
            value: mpv_get_property_json(pipe, &property).map(|value| value.to_string()),
            property,
        });
    }

    for property in [
        format!(
            "af-metadata/@{}/Momentary loudness",
            RIDER_EBUR128_FILTER_NAME
        ),
        format!(
            "af-metadata/@{}/Short term loudness",
            RIDER_EBUR128_FILTER_NAME
        ),
        format!(
            "af-metadata/@{}/Integrated loudness",
            RIDER_EBUR128_FILTER_NAME
        ),
        format!("af-metadata/@{}/True peak", RIDER_EBUR128_FILTER_NAME),
        format!(
            "af-metadata/{}/Momentary loudness",
            RIDER_EBUR128_FILTER_NAME
        ),
        format!(
            "af-metadata/{}/Short term loudness",
            RIDER_EBUR128_FILTER_NAME
        ),
        format!(
            "af-metadata/{}/Integrated loudness",
            RIDER_EBUR128_FILTER_NAME
        ),
        format!("af-metadata/{}/True peak", RIDER_EBUR128_FILTER_NAME),
        "af-metadata/lavfi.ebur128/Momentary loudness".to_string(),
        "af-metadata/lavfi.ebur128/Short term loudness".to_string(),
        "af-metadata/lavfi.ebur128/Integrated loudness".to_string(),
        "af-metadata/lavfi.ebur128/True peak".to_string(),
        format!(
            "af-metadata/@{}/lavfi.astats.Overall.Peak_level",
            RIDER_PEAK_FILTER_NAME
        ),
        format!(
            "af-metadata/{}/lavfi.astats.Overall.Peak_level",
            RIDER_PEAK_FILTER_NAME
        ),
    ] {
        probes.push(MetadataProbeEntry {
            value: mpv_get_property_string(pipe, &property),
            property,
        });
    }

    unsafe {
        let _ = CloseHandle(pipe);
    }

    Ok(AudioNormalizerDebugInfo {
        connected: true,
        manual_mode: is_manual_mode(),
        filters,
        filename,
        probes,
        metadata_roots,
    })
}

#[cfg(target_os = "windows")]
pub fn set_manual_gain(gain_db: f64) -> Result<(), String> {
    if let Ok(mut manual_gain) = MANUAL_GAIN_DB.lock() {
        *manual_gain = gain_db;
    }

    let pipe = connect_to_mpv_pipe().ok_or_else(|| "MPV not connected".to_string())?;

    let filters = mpv_get_property_json(pipe, "af")
        .map(|value| value.to_string())
        .unwrap_or_default();

    if !filters.contains(RIDER_GAIN_FILTER_NAME) {
        let added = mpv_command_success(
            pipe,
            vec![
                serde_json::json!("af"),
                serde_json::json!("add"),
                serde_json::json!(RIDER_GAIN_FILTER_SPEC),
            ],
        );

        if !added {
            unsafe {
                let _ = CloseHandle(pipe);
            }
            return Err("Failed to add rider gain filter".to_string());
        }
    }

    set_rider_gain(pipe, gain_db);

    if let Ok(mut state) = STATE.lock() {
        state.current_gain_db = gain_db;
        state.desired_gain_db = gain_db;
        state.slow_gain_db = 0.0;
        state.fast_gain_db = 0.0;
        state.transient_cut_db = 0.0;
        state.effective_max_gain_db = get_config().max_gain_db;
        state.adaptive_gain_extra_db = 0.0;
        state.adaptive_gain_state = "manual".to_string();
        state.connected = true;
        state.manual_mode = MANUAL_MODE.load(Ordering::SeqCst);
    }

    unsafe {
        let _ = CloseHandle(pipe);
    }

    Ok(())
}

fn get_manual_gain() -> f64 {
    MANUAL_GAIN_DB.lock().map(|gain| *gain).unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// MPV filter helpers (Windows)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn mpv_command_response(pipe: HANDLE, args: Vec<serde_json::Value>) -> Option<MpvResponse> {
    let cmd = MpvCommand {
        command: args,
        request_id: None,
    };
    let resp = send_command(pipe, &cmd)?;
    if resp.error.as_deref() == Some("success") {
        Some(resp)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn mpv_command_success(pipe: HANDLE, args: Vec<serde_json::Value>) -> bool {
    mpv_command_response(pipe, args).is_some()
}

#[cfg(target_os = "windows")]
fn mpv_command_logged(
    pipe: HANDLE,
    args: Vec<serde_json::Value>,
    label: &str,
) -> Option<MpvResponse> {
    let serialized_args = serde_json::Value::Array(args.clone()).to_string();
    match mpv_command_response(pipe, args) {
        Some(resp) => Some(resp),
        None => {
            warn!(
                "[Normalizer] MPV command failed ({}): {}",
                label, serialized_args
            );
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn mpv_get_property_string(pipe: HANDLE, name: &str) -> Option<String> {
    mpv_command_response(
        pipe,
        vec![
            serde_json::json!("get_property_string"),
            serde_json::json!(name),
        ],
    )
    .and_then(|resp| resp.data.and_then(|v| v.as_str().map(|s| s.to_string())))
}

#[cfg(target_os = "windows")]
fn mpv_get_property_json(pipe: HANDLE, name: &str) -> Option<serde_json::Value> {
    mpv_command_response(
        pipe,
        vec![serde_json::json!("get_property"), serde_json::json!(name)],
    )
    .and_then(|resp| resp.data)
}

#[cfg(target_os = "windows")]
fn db_to_linear(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

#[cfg(target_os = "windows")]
fn limiter_filter_specs(config: &NormalizerConfig) -> Vec<String> {
    let limit = db_to_linear(config.limiter_limit_db).clamp(0.0625, 1.0);
    let attack_ms = config.limiter_attack_ms.max(0.1);
    let release_ms = config.limiter_release_ms.max(1.0);

    vec![
        format!(
            "@{}:lavfi=[alimiter=limit={:.6}:attack={:.2}:release={:.2}:level=0:latency=1]",
            RIDER_LIMITER_FILTER_NAME, limit, attack_ms, release_ms
        ),
        format!(
            "@{}:lavfi=[alimiter=limit={:.6}:attack={:.2}:release={:.2}:level=false:latency=true]",
            RIDER_LIMITER_FILTER_NAME, limit, attack_ms, release_ms
        ),
        format!(
            "@{}:lavfi=[alimiter=limit={:.6}:attack={:.2}:release={:.2}:latency=1]",
            RIDER_LIMITER_FILTER_NAME, limit, attack_ms, release_ms
        ),
        format!(
            "@{}:lavfi=[alimiter=limit={:.6}:attack={:.2}:release={:.2}]",
            RIDER_LIMITER_FILTER_NAME, limit, attack_ms, release_ms
        ),
    ]
}

#[cfg(target_os = "windows")]
fn install_limiter_filter(pipe: HANDLE, config: &NormalizerConfig) -> bool {
    for spec in limiter_filter_specs(config) {
        info!("[Normalizer] Trying limiter spec: {}", spec);
        if mpv_command_logged(
            pipe,
            vec![
                serde_json::json!("af"),
                serde_json::json!("add"),
                serde_json::json!(spec),
            ],
            "add alimiter",
        )
        .is_some()
        {
            info!("[Normalizer] Limiter installed successfully");
            return true;
        }
    }

    warn!("[Normalizer] All limiter install attempts failed; continuing without limiter");
    false
}

#[cfg(target_os = "windows")]
fn install_filters(pipe: HANDLE) -> bool {
    let config = get_config();
    let stereo_added = mpv_command_logged(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("add"),
            serde_json::json!(RIDER_STEREO_FILTER_SPEC),
        ],
        "add stereo downmix",
    )
    .is_some();
    let ebur128_added = mpv_command_logged(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("add"),
            serde_json::json!(RIDER_EBUR128_FILTER_SPEC),
        ],
        "add ebur128",
    )
    .is_some();
    let peak_added = mpv_command_logged(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("add"),
            serde_json::json!(RIDER_PEAK_FILTER_SPEC),
        ],
        "add astats peak",
    )
    .is_some();
    let gain_added = mpv_command_logged(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("add"),
            serde_json::json!(RIDER_GAIN_FILTER_SPEC),
        ],
        "add rider gain",
    )
    .is_some();
    let limiter_added = if config.limiter_enabled {
        install_limiter_filter(pipe, &config)
    } else {
        true
    };
    // The input ebur128 pass drives gain control. A second post-limiter ebur128
    // pass only duplicated loudness analysis, so retain the cheaper peak probe
    // for protection telemetry without changing the processed audio.
    let output_ebur128_added = false;
    let output_peak_added = mpv_command_logged(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("add"),
            serde_json::json!(RIDER_OUTPUT_PEAK_FILTER_SPEC),
        ],
        "add output astats peak",
    )
    .is_some();

    // Keep the downmix before gain and limiting so a 5.1/7.1-to-2.0 sum cannot
    // create a new peak after the final protection stage.
    let core_filters_added = stereo_added && ebur128_added && peak_added && gain_added;
    let telemetry_filters_added = output_ebur128_added || output_peak_added;
    let protection_filters_added =
        protection_filters_are_usable(core_filters_added, config.limiter_enabled, limiter_added);
    let fully_installed = protection_filters_added && telemetry_filters_added;
    let usable = protection_filters_added;
    if fully_installed {
        info!("[Normalizer] Audio filters installed");
        if let Some(filters) = mpv_get_property_json(pipe, "af") {
            info!("[Normalizer] MPV af chain after install: {}", filters);
        }
        FILTERS_INSTALLED.store(true, Ordering::SeqCst);
        return true;
    } else if core_filters_added && telemetry_filters_added {
        warn!("[Normalizer] Core audio filters installed, but limiter is unavailable");
        if let Some(filters) = mpv_get_property_json(pipe, "af") {
            info!(
                "[Normalizer] MPV af chain after partial install: {}",
                filters
            );
        }
        FILTERS_INSTALLED.store(true, Ordering::SeqCst);
        return true;
    } else if core_filters_added && (!config.limiter_enabled || limiter_added) {
        warn!(
            "[Normalizer] Core audio filters installed, but post-limiter telemetry is unavailable"
        );
        if let Some(filters) = mpv_get_property_json(pipe, "af") {
            info!(
                "[Normalizer] MPV af chain after partial install: {}",
                filters
            );
        }
        FILTERS_INSTALLED.store(true, Ordering::SeqCst);
        return true;
    } else {
        warn!(
            "[Normalizer] Filter install status: ebur128={}, peak={}, gain={}, limiter={}, output_ebur128={}, output_peak={}",
            ebur128_added, peak_added, gain_added, limiter_added, output_ebur128_added, output_peak_added
        );
        let _ = mpv_command_success(
            pipe,
            vec![
                serde_json::json!("af"),
                serde_json::json!("remove"),
                serde_json::json!(format!("@{}", RIDER_GAIN_FILTER_NAME)),
            ],
        );
        let _ = mpv_command_success(
            pipe,
            vec![
                serde_json::json!("af"),
                serde_json::json!("remove"),
                serde_json::json!(format!("@{}", RIDER_PEAK_FILTER_NAME)),
            ],
        );
        let _ = mpv_command_success(
            pipe,
            vec![
                serde_json::json!("af"),
                serde_json::json!("remove"),
                serde_json::json!(format!("@{}", RIDER_LIMITER_FILTER_NAME)),
            ],
        );
        let _ = mpv_command_success(
            pipe,
            vec![
                serde_json::json!("af"),
                serde_json::json!("remove"),
                serde_json::json!(format!("@{}", RIDER_OUTPUT_PEAK_FILTER_NAME)),
            ],
        );
        let _ = mpv_command_success(
            pipe,
            vec![
                serde_json::json!("af"),
                serde_json::json!("remove"),
                serde_json::json!(format!("@{}", RIDER_OUTPUT_EBUR128_FILTER_NAME)),
            ],
        );
        let _ = mpv_command_success(
            pipe,
            vec![
                serde_json::json!("af"),
                serde_json::json!("remove"),
                serde_json::json!(format!("@{}", RIDER_STEREO_FILTER_NAME)),
            ],
        );
        let _ = mpv_command_success(
            pipe,
            vec![
                serde_json::json!("af"),
                serde_json::json!("remove"),
                serde_json::json!(format!("@{}", RIDER_EBUR128_FILTER_NAME)),
            ],
        );
        warn!("[Normalizer] Failed to install audio filters");
    }
    usable
}

#[cfg(target_os = "windows")]
fn remove_filters(pipe: HANDLE) {
    let _ = mpv_command_success(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("remove"),
            serde_json::json!(format!("@{}", RIDER_GAIN_FILTER_NAME)),
        ],
    );
    let _ = mpv_command_success(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("remove"),
            serde_json::json!(format!("@{}", RIDER_PEAK_FILTER_NAME)),
        ],
    );
    let _ = mpv_command_success(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("remove"),
            serde_json::json!(format!("@{}", RIDER_LIMITER_FILTER_NAME)),
        ],
    );
    let _ = mpv_command_success(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("remove"),
            serde_json::json!(format!("@{}", RIDER_OUTPUT_PEAK_FILTER_NAME)),
        ],
    );
    let _ = mpv_command_success(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("remove"),
            serde_json::json!(format!("@{}", RIDER_OUTPUT_EBUR128_FILTER_NAME)),
        ],
    );
    let _ = mpv_command_success(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("remove"),
            serde_json::json!(format!("@{}", RIDER_STEREO_FILTER_NAME)),
        ],
    );
    let _ = mpv_command_success(
        pipe,
        vec![
            serde_json::json!("af"),
            serde_json::json!("remove"),
            serde_json::json!(format!("@{}", RIDER_EBUR128_FILTER_NAME)),
        ],
    );
    FILTERS_INSTALLED.store(false, Ordering::SeqCst);
    info!("[Normalizer] Audio filters removed");
}

#[cfg(target_os = "windows")]
fn set_rider_gain(pipe: HANDLE, gain_db: f64) {
    let gain_str = format!("{:.2}dB", gain_db);
    let _ = mpv_command_success(
        pipe,
        vec![
            serde_json::json!("af-command"),
            serde_json::json!(RIDER_GAIN_FILTER_NAME),
            serde_json::json!("volume"),
            serde_json::json!(gain_str),
        ],
    );
}

#[cfg(target_os = "windows")]
fn read_metadata_value(pipe: HANDLE, key: &str) -> Option<f64> {
    let property_candidates = [
        format!("af-metadata/@{}/{}", RIDER_EBUR128_FILTER_NAME, key),
        format!("af-metadata/{}/{}", RIDER_EBUR128_FILTER_NAME, key),
        format!("af-metadata/lavfi.{}/{}", RIDER_EBUR128_FILTER_NAME, key),
        format!("af-metadata/lavfi.ebur128/{}", key),
    ];

    for property in property_candidates {
        if let Some(value) = mpv_get_property_string(pipe, &property) {
            if let Ok(parsed) = value.parse::<f64>() {
                if !METADATA_PATH_LOGGED.swap(true, Ordering::SeqCst) {
                    info!(
                        "[Normalizer] Metadata path resolved via {} ({} = {})",
                        property, key, parsed
                    );
                }
                METADATA_MISS_LOGGED.store(false, Ordering::SeqCst);
                return Some(parsed);
            }
        }
    }

    if !METADATA_MISS_LOGGED.swap(true, Ordering::SeqCst) {
        warn!("[Normalizer] ebur128 metadata not found on any known path");
    }
    None
}

#[cfg(target_os = "windows")]
fn normalize_metadata_key(key: &str) -> String {
    key.to_ascii_lowercase()
        .replace([' ', '-', '.', ':', '/', '_'], "")
}

#[cfg(target_os = "windows")]
fn parse_metadata_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(parsed) = trimmed.parse::<f64>() {
        return Some(parsed);
    }

    let numeric_prefix: String = trimmed
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || matches!(ch, '-' | '+' | '.'))
        .collect();

    if numeric_prefix.is_empty()
        || numeric_prefix == "-"
        || numeric_prefix == "+"
        || numeric_prefix == "."
    {
        return None;
    }

    numeric_prefix.parse::<f64>().ok()
}

#[cfg(target_os = "windows")]
fn linear_peak_to_dbfs(value: f64) -> f64 {
    if value <= 0.0 {
        -70.0
    } else {
        20.0 * value.log10()
    }
}

#[cfg(target_os = "windows")]
fn collect_numeric_metadata(prefix: &str, value: &Value, output: &mut Vec<(String, f64)>) {
    match value {
        Value::Number(number) => {
            if let Some(parsed) = number.as_f64() {
                output.push((prefix.to_string(), parsed));
            }
        }
        Value::String(text) => {
            if let Some(parsed) = parse_metadata_number(text) {
                output.push((prefix.to_string(), parsed));
            }
        }
        Value::Object(map) => {
            for (key, child) in map {
                let next_prefix = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{}/{}", prefix, key)
                };
                collect_numeric_metadata(&next_prefix, child, output);
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                let next_prefix = if prefix.is_empty() {
                    index.to_string()
                } else {
                    format!("{}/{}", prefix, index)
                };
                collect_numeric_metadata(&next_prefix, child, output);
            }
        }
        _ => {}
    }
}

#[cfg(target_os = "windows")]
fn read_astats_peak_metadata(pipe: HANDLE) -> Option<f64> {
    read_astats_peak_metadata_for_filter(pipe, RIDER_PEAK_FILTER_NAME)
}

#[cfg(target_os = "windows")]
fn read_astats_peak_metadata_for_filter(pipe: HANDLE, filter_name: &str) -> Option<f64> {
    let root_properties = [
        format!("af-metadata/@{}", filter_name),
        format!("af-metadata/{}", filter_name),
        "af-metadata".to_string(),
    ];
    let normalized_filter_name = normalize_metadata_key(filter_name);

    let mut numeric_entries = Vec::new();
    for property in root_properties {
        if let Some(value) = mpv_get_property_json(pipe, &property) {
            let mut property_entries = Vec::new();
            collect_numeric_metadata(&property, &value, &mut property_entries);
            if property == "af-metadata" {
                numeric_entries.extend(property_entries.into_iter().filter(|(path, _)| {
                    normalize_metadata_key(path).contains(&normalized_filter_name)
                }));
            } else {
                numeric_entries.extend(property_entries);
            }
        }
    }

    let mut peak_level = None;
    for (path, value) in numeric_entries {
        let normalized = normalize_metadata_key(&path);
        if normalized.contains("lavfiastatsoverallpeaklevel")
            || normalized.ends_with("overallpeaklevel")
            || normalized.ends_with("peaklevel")
        {
            if peak_level.map(|current| value > current).unwrap_or(true) {
                peak_level = Some(value);
            }
        }
    }

    if peak_level.is_none() {
        for property in [
            format!(
                "af-metadata/@{}/lavfi.astats.Overall.Peak_level",
                filter_name
            ),
            format!(
                "af-metadata/{}/lavfi.astats.Overall.Peak_level",
                filter_name
            ),
        ] {
            if let Some(value) = mpv_get_property_string(pipe, &property)
                .and_then(|text| parse_metadata_number(&text))
            {
                peak_level = Some(value);
                break;
            }
        }
    }

    peak_level
}

#[cfg(target_os = "windows")]
fn peak_source_priority(source: PeakTelemetrySource) -> u8 {
    match source {
        PeakTelemetrySource::TruePeak => 2,
        PeakTelemetrySource::SamplePeak => 1,
        PeakTelemetrySource::Unknown => 0,
    }
}

#[cfg(target_os = "windows")]
fn try_update_peak_measurement(
    current: Option<PeakMeasurement>,
    candidate: PeakMeasurement,
) -> Option<PeakMeasurement> {
    match current {
        None => Some(candidate),
        Some(existing) => {
            let current_priority = peak_source_priority(existing.source);
            let candidate_priority = peak_source_priority(candidate.source);
            if candidate_priority > current_priority
                || (candidate_priority == current_priority && candidate.db > existing.db)
            {
                Some(candidate)
            } else {
                Some(existing)
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn collect_filter_numeric_metadata(pipe: HANDLE, filter_name: &str) -> Vec<(String, f64)> {
    let root_properties = [
        format!("af-metadata/@{}", filter_name),
        format!("af-metadata/{}", filter_name),
        "af-metadata".to_string(),
    ];
    let normalized_filter_name = normalize_metadata_key(filter_name);
    let mut numeric_entries = Vec::new();

    for property in root_properties {
        if let Some(value) = mpv_get_property_json(pipe, &property) {
            let mut property_entries = Vec::new();
            collect_numeric_metadata(&property, &value, &mut property_entries);
            if property == "af-metadata" {
                numeric_entries.extend(property_entries.into_iter().filter(|(path, _)| {
                    normalize_metadata_key(path).contains(&normalized_filter_name)
                }));
            } else {
                numeric_entries.extend(property_entries);
            }
        }
    }

    numeric_entries
}

#[cfg(target_os = "windows")]
fn read_peak_measurement_from_ebur128(
    numeric_entries: &[(String, f64)],
) -> Option<PeakMeasurement> {
    let mut peak = None;

    for (path, value) in numeric_entries {
        let normalized = normalize_metadata_key(path);
        let source = if normalized.contains("truepeak")
            || normalized.contains("truepeaks")
            || normalized.contains("ftpk")
            || normalized.contains("tpk")
            || normalized.contains("lavfir128tp")
            || normalized.contains("lavfir128ftpk")
            || normalized.contains("lavfir128tpk")
            || normalized.contains("lavfir128truepeak")
        {
            PeakTelemetrySource::TruePeak
        } else if normalized.contains("samplepeak")
            || normalized.contains("spk")
            || normalized.contains("lavfir128spk")
        {
            PeakTelemetrySource::SamplePeak
        } else {
            continue;
        };

        let candidate = if normalized.contains("lavfir128") && *value >= 0.0 {
            linear_peak_to_dbfs(*value)
        } else {
            *value
        };

        peak = try_update_peak_measurement(
            peak,
            PeakMeasurement {
                db: candidate,
                source,
            },
        );
    }

    peak
}

#[cfg(target_os = "windows")]
fn read_ebur128_metadata_from_objects(pipe: HANDLE) -> Option<(f64, f64, f64, PeakMeasurement)> {
    let numeric_entries = collect_filter_numeric_metadata(pipe, RIDER_EBUR128_FILTER_NAME);

    if numeric_entries.is_empty() {
        return None;
    }

    let mut momentary = None;
    let mut short_term = None;
    let mut integrated = None;
    let mut true_peak = read_peak_measurement_from_ebur128(&numeric_entries);

    for (path, value) in numeric_entries {
        let normalized = normalize_metadata_key(&path);

        if momentary.is_none()
            && (normalized.contains("momentaryloudness")
                || normalized.ends_with("/m")
                || normalized.contains("lavfir128m"))
        {
            momentary = Some(value);
            continue;
        }

        if short_term.is_none()
            && (normalized.contains("shorttermloudness")
                || normalized.ends_with("/s")
                || normalized.contains("lavfir128s"))
        {
            short_term = Some(value);
            continue;
        }

        if integrated.is_none()
            && (normalized.contains("integratedloudness")
                || normalized.ends_with("/i")
                || normalized.contains("lavfir128i"))
        {
            integrated = Some(value);
            continue;
        }
    }

    if true_peak.is_none() {
        true_peak = read_astats_peak_metadata(pipe).map(|db| PeakMeasurement {
            db,
            source: PeakTelemetrySource::SamplePeak,
        });
    }

    let m = momentary?;
    Some((
        m,
        short_term.unwrap_or(m),
        integrated.unwrap_or(m),
        true_peak.unwrap_or_else(PeakMeasurement::unknown),
    ))
}

#[cfg(target_os = "windows")]
fn read_output_peak_metadata(pipe: HANDLE) -> PeakMeasurement {
    read_astats_peak_metadata_for_filter(pipe, RIDER_OUTPUT_PEAK_FILTER_NAME)
        .map(|db| PeakMeasurement {
            db,
            source: PeakTelemetrySource::SamplePeak,
        })
        .unwrap_or_else(PeakMeasurement::unknown)
}

#[cfg(target_os = "windows")]
fn read_ebur128_metadata(pipe: HANDLE) -> Option<(f64, f64, f64, PeakMeasurement)> {
    if let Some(values) = read_ebur128_metadata_from_objects(pipe) {
        METADATA_MISS_LOGGED.store(false, Ordering::SeqCst);
        return Some(values);
    }

    let momentary = read_metadata_value(pipe, "Momentary loudness");
    let short_term = read_metadata_value(pipe, "Short term loudness");
    let integrated = read_metadata_value(pipe, "Integrated loudness");
    let true_peak = read_metadata_value(pipe, "True peak").map(|db| PeakMeasurement {
        db,
        source: PeakTelemetrySource::TruePeak,
    });

    let m = momentary?;
    Some((
        m,
        short_term.unwrap_or(m),
        integrated.unwrap_or(m),
        true_peak.unwrap_or_else(PeakMeasurement::unknown),
    ))
}

#[cfg(target_os = "windows")]
fn read_filename(pipe: HANDLE) -> Option<String> {
    mpv_get_property_string(pipe, "filename")
}

fn subtitle_text_contains_dialogue(text: &str) -> bool {
    let mut bracket_depth = 0_u32;

    text.chars().any(|character| match character {
        '[' => {
            bracket_depth = bracket_depth.saturating_add(1);
            false
        }
        ']' => {
            bracket_depth = bracket_depth.saturating_sub(1);
            false
        }
        _ => bracket_depth == 0 && character.is_alphanumeric(),
    })
}

fn subtitle_event_should_assist(text: Option<&str>, bitmap_event_active: bool) -> bool {
    match text.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => subtitle_text_contains_dialogue(text),
        None => bitmap_event_active,
    }
}

#[cfg(target_os = "windows")]
fn visible_subtitle_should_assist(pipe: HANDLE) -> bool {
    [
        ("sub-visibility", "sub-text", "sub-start"),
        (
            "secondary-sub-visibility",
            "secondary-sub-text",
            "secondary-sub-start",
        ),
    ]
    .into_iter()
    .any(|(visibility_property, text_property, start_property)| {
        let visible = mpv_get_property_json(pipe, visibility_property)
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if !visible {
            return false;
        }

        let text = mpv_get_property_string(pipe, text_property);
        let bitmap_event_active = text.as_deref().is_none_or(|text| text.trim().is_empty())
            && mpv_get_property_json(pipe, start_property).is_some_and(|value| value.is_number());
        subtitle_event_should_assist(text.as_deref(), bitmap_event_active)
    })
}

// ---------------------------------------------------------------------------
// Rider algorithm
// ---------------------------------------------------------------------------

struct RiderContext {
    smoothed_lufs: f64,
    slow_gain_db: f64,
    fast_gain_db: f64,
    current_gain_db: f64,
    effective_max_gain_db: f64,
    adaptive_gain_state: String,
    last_filename: String,
    last_above_gate: Instant,
    gate_detector: GateDetector,
    subtitle_poll_elapsed_secs: f64,
    subtitle_dialogue_visible: bool,
    subtitle_assist_hold_secs: f64,
    stale_count: u32,
    settling_until: Option<Instant>,
}

impl RiderContext {
    fn new() -> Self {
        Self {
            smoothed_lufs: -70.0,
            slow_gain_db: 0.0,
            fast_gain_db: 0.0,
            current_gain_db: 0.0,
            effective_max_gain_db: NormalizerConfig::default().max_gain_db,
            adaptive_gain_state: "disabled".to_string(),
            last_filename: String::new(),
            last_above_gate: Instant::now(),
            gate_detector: GateDetector::new(),
            subtitle_poll_elapsed_secs: 0.1,
            subtitle_dialogue_visible: false,
            subtitle_assist_hold_secs: 0.0,
            stale_count: 0,
            settling_until: None,
        }
    }

    fn reset(&mut self) {
        self.smoothed_lufs = -70.0;
        self.slow_gain_db = 0.0;
        self.fast_gain_db = 0.0;
        self.current_gain_db = 0.0;
        self.effective_max_gain_db = NormalizerConfig::default().max_gain_db;
        self.adaptive_gain_state = "disabled".to_string();
        self.stale_count = 0;
        self.last_above_gate = Instant::now();
        self.gate_detector.reset();
        self.subtitle_poll_elapsed_secs = 0.1;
        self.subtitle_dialogue_visible = false;
        self.subtitle_assist_hold_secs = 0.0;
        self.settling_until = Some(Instant::now() + Duration::from_secs(1));
    }

    fn update_subtitle_assist(
        &mut self,
        enabled: bool,
        dialogue_visible: bool,
        dt_secs: f64,
    ) -> bool {
        const SUBTITLE_ASSIST_RELEASE_HOLD_SECS: f64 = 0.75;

        if !enabled {
            self.subtitle_assist_hold_secs = 0.0;
            return false;
        }

        if dialogue_visible {
            self.subtitle_assist_hold_secs = SUBTITLE_ASSIST_RELEASE_HOLD_SECS;
            return true;
        }

        self.subtitle_assist_hold_secs =
            (self.subtitle_assist_hold_secs - dt_secs.max(0.0)).max(0.0);
        self.subtitle_assist_hold_secs > 0.0
    }

    fn should_poll_subtitles(&mut self, enabled: bool, dt_secs: f64) -> bool {
        const SUBTITLE_POLL_INTERVAL_SECS: f64 = 0.1;

        if !enabled {
            self.subtitle_poll_elapsed_secs = SUBTITLE_POLL_INTERVAL_SECS;
            self.subtitle_dialogue_visible = false;
            return false;
        }

        self.subtitle_poll_elapsed_secs += dt_secs.max(0.0);
        if self.subtitle_poll_elapsed_secs < SUBTITLE_POLL_INTERVAL_SECS {
            return false;
        }

        self.subtitle_poll_elapsed_secs = 0.0;
        true
    }
}

fn apply_response_curve(
    current_gain_db: f64,
    desired_gain_db: f64,
    config: &NormalizerConfig,
    dt_secs: f64,
) -> f64 {
    let diff = desired_gain_db - current_gain_db;
    if config.response_mode == RiderResponseMode::DbPerSec {
        let rate_limit = if diff < 0.0 {
            config.attack_db_per_sec.max(0.0)
        } else {
            config.release_db_per_sec.max(0.0)
        };
        let max_step = rate_limit * dt_secs;
        return current_gain_db + diff.clamp(-max_step, max_step);
    }

    let rate = if diff < 0.0 {
        1.0 - (-dt_secs * 1000.0 / config.attack_ms).exp()
    } else {
        1.0 - (-dt_secs * 1000.0 / config.release_ms).exp()
    };

    current_gain_db + diff * rate
}

fn exponential_smoothing_alpha(dt_secs: f64, tau_secs: f64) -> f64 {
    1.0 - (-dt_secs.max(0.0) / tau_secs.max(f64::EPSILON)).exp()
}

fn apply_time_response(
    current_gain_db: f64,
    desired_gain_db: f64,
    attack_ms: f64,
    release_ms: f64,
    dt_secs: f64,
) -> f64 {
    let diff = desired_gain_db - current_gain_db;
    let attack_ms = attack_ms.max(1.0);
    let release_ms = release_ms.max(1.0);
    let rate = if diff < 0.0 {
        1.0 - (-dt_secs * 1000.0 / attack_ms).exp()
    } else {
        1.0 - (-dt_secs * 1000.0 / release_ms).exp()
    };
    current_gain_db + diff * rate
}

fn blend_control_signal(momentary: f64, short_term: f64, integrated: f64) -> f64 {
    let short_term = if short_term.is_finite() {
        short_term
    } else {
        momentary
    };

    let anchored_integrated = if integrated.is_finite() && integrated > -69.0 {
        integrated.clamp(short_term - 10.0, short_term + 10.0)
    } else {
        short_term
    };

    (short_term * 0.82) + (anchored_integrated * 0.18)
}

fn select_slow_control_signal(
    mode: &SlowControlMode,
    momentary: f64,
    short_term: f64,
    integrated: f64,
) -> f64 {
    match mode {
        SlowControlMode::Momentary => {
            if momentary.is_finite() {
                momentary
            } else if short_term.is_finite() {
                short_term
            } else {
                integrated
            }
        }
        SlowControlMode::ShortTerm => {
            if short_term.is_finite() {
                short_term
            } else if momentary.is_finite() {
                momentary
            } else {
                integrated
            }
        }
        SlowControlMode::Blended => blend_control_signal(momentary, short_term, integrated),
    }
}

#[derive(Debug, Clone)]
struct GateMeasurement {
    signal_lufs: f64,
    normalization_offset_db: f64,
    ambient_floor_lufs: f64,
    foreground_lufs: f64,
    open_threshold_lufs: f64,
    close_threshold_lufs: f64,
    observed_range_lu: f64,
    observed_secs: f64,
    confidence: f64,
    detector_ready: bool,
    model_state: String,
    model_age_secs: f64,
    phase: String,
    acquiring: bool,
    is_gated: bool,
    below_threshold: bool,
    subtitle_assist_active: bool,
}

#[derive(Debug, Clone, Copy)]
struct AdaptiveGateModel {
    ambient_floor_lufs: f64,
    foreground_lufs: f64,
    normalization_offset_db: f64,
    open_threshold_lufs: f64,
    close_threshold_lufs: f64,
    observed_range_lu: f64,
    confidence: f64,
    detector_ready: bool,
}

const ADAPTIVE_GATE_MIN_OBSERVATION_SECS: f64 = 3.0;
const ADAPTIVE_GATE_MIN_RANGE_LU: f64 = 9.0;
const ADAPTIVE_GATE_AMBIENT_MARGIN_LU: f64 = 4.0;
const ADAPTIVE_GATE_FOREGROUND_MARGIN_LU: f64 = 3.0;
const ADAPTIVE_GATE_HYSTERESIS_LU: f64 = 3.0;
const ADAPTIVE_GATE_OPEN_CONFIRM_SECS: f64 = 0.4;
const ADAPTIVE_GATE_MAX_SAMPLES: usize = 12_000;
const ADAPTIVE_GATE_AMBIENT_PERCENTILE: f64 = 0.2;
const ADAPTIVE_GATE_FOREGROUND_PERCENTILE: f64 = 0.8;
const ADAPTIVE_GATE_READY_CONFIDENCE: f64 = 0.65;
const ADAPTIVE_GATE_EXIT_CONFIDENCE: f64 = 0.55;
const ADAPTIVE_GATE_EXIT_RANGE_LU: f64 = 7.0;
const ADAPTIVE_GATE_ENTRY_CONFIRM_SECS: f64 = 2.0;
const ADAPTIVE_GATE_DEGRADED_GRACE_SECS: f64 = 10.0;
const ADAPTIVE_GATE_THRESHOLD_DOWN_TAU_SECS: f64 = 3.0;
const ADAPTIVE_GATE_THRESHOLD_UP_TAU_SECS: f64 = 12.0;

#[derive(Debug, Clone, Copy)]
struct TimedLoudnessSample {
    observed_at_secs: f64,
    loudness_lufs: f64,
    duration_secs: f64,
}

#[derive(Debug, Clone)]
struct GateDetector {
    ambient_floor_lufs: Option<f64>,
    foreground_lufs: Option<f64>,
    samples: VecDeque<TimedLoudnessSample>,
    elapsed_secs: f64,
    observed_secs: f64,
    distribution_stability: f64,
    trusted_model: Option<AdaptiveGateModel>,
    strong_candidate_secs: f64,
    degraded_secs: f64,
    model_age_secs: f64,
    model_state: String,
    gate_open: bool,
    above_open_secs: f64,
    below_close_secs: f64,
}

impl GateDetector {
    fn new() -> Self {
        Self {
            ambient_floor_lufs: None,
            foreground_lufs: None,
            samples: VecDeque::new(),
            elapsed_secs: 0.0,
            observed_secs: 0.0,
            distribution_stability: 0.0,
            trusted_model: None,
            strong_candidate_secs: 0.0,
            degraded_secs: 0.0,
            model_age_secs: 0.0,
            model_state: "learning".to_string(),
            gate_open: true,
            above_open_secs: 0.0,
            below_close_secs: 0.0,
        }
    }

    fn reset(&mut self) {
        *self = Self::new();
    }

    fn track_distribution(&mut self, sample_lufs: f64, dt_secs: f64, window_secs: f64) {
        let dt_secs = if dt_secs.is_finite() {
            dt_secs.clamp(0.0, 10.0)
        } else {
            0.0
        };
        let window_secs = window_secs.clamp(5.0, 300.0);
        self.elapsed_secs += dt_secs;
        let oldest_allowed = self.elapsed_secs - window_secs;

        while self
            .samples
            .front()
            .is_some_and(|sample| sample.observed_at_secs < oldest_allowed)
        {
            self.samples.pop_front();
        }

        if sample_lufs.is_finite() && sample_lufs > -69.0 {
            self.samples.push_back(TimedLoudnessSample {
                observed_at_secs: self.elapsed_secs,
                loudness_lufs: sample_lufs,
                duration_secs: dt_secs,
            });
        }

        while self.samples.len() > ADAPTIVE_GATE_MAX_SAMPLES {
            self.samples.pop_front();
        }

        self.observed_secs = self
            .samples
            .iter()
            .map(|sample| sample.duration_secs)
            .sum::<f64>()
            .min(window_secs);

        if self.samples.is_empty() {
            self.ambient_floor_lufs = None;
            self.foreground_lufs = None;
            self.distribution_stability = 0.0;
            return;
        }

        let mut distribution: Vec<f64> = self
            .samples
            .iter()
            .map(|sample| sample.loudness_lufs)
            .collect();
        distribution.sort_by(f64::total_cmp);

        self.ambient_floor_lufs = percentile(&distribution, ADAPTIVE_GATE_AMBIENT_PERCENTILE);
        self.foreground_lufs = percentile(&distribution, ADAPTIVE_GATE_FOREGROUND_PERCENTILE);

        let lower_spread = percentile(&distribution, 0.3)
            .zip(percentile(&distribution, 0.1))
            .map(|(upper, lower)| (upper - lower).max(0.0))
            .unwrap_or(12.0);
        let upper_spread = percentile(&distribution, 0.9)
            .zip(percentile(&distribution, 0.7))
            .map(|(upper, lower)| (upper - lower).max(0.0))
            .unwrap_or(12.0);
        self.distribution_stability =
            (1.0 - ((lower_spread + upper_spread) / 12.0)).clamp(0.0, 1.0);
    }

    fn adaptive_model(&self, config: &NormalizerConfig) -> Option<AdaptiveGateModel> {
        let ambient_floor_lufs = self.ambient_floor_lufs?;
        let foreground_lufs = self.foreground_lufs?;
        let observed_range_lu = (foreground_lufs - ambient_floor_lufs).max(0.0);
        let duration_score = (self.observed_secs / 6.0).clamp(0.0, 1.0);
        let separation_score = (observed_range_lu / 18.0).clamp(0.0, 1.0);
        let sample_score = (self.samples.len() as f64 / 12.0).clamp(0.0, 1.0);
        let confidence = (duration_score * 0.25)
            + (separation_score * 0.4)
            + (self.distribution_stability * 0.2)
            + (sample_score * 0.15);
        let normalization_offset_db = (config.target_lufs - foreground_lufs)
            .clamp(config.max_cut_db, configured_max_gain_limit(config));
        let configured_source_threshold = config.gate_threshold_lufs - normalization_offset_db;
        let ambient_threshold = ambient_floor_lufs + ADAPTIVE_GATE_AMBIENT_MARGIN_LU;
        let foreground_cap = foreground_lufs - ADAPTIVE_GATE_FOREGROUND_MARGIN_LU;
        let open_threshold_lufs = configured_source_threshold
            .max(ambient_threshold)
            .min(foreground_cap);

        Some(AdaptiveGateModel {
            ambient_floor_lufs,
            foreground_lufs,
            normalization_offset_db,
            open_threshold_lufs,
            close_threshold_lufs: open_threshold_lufs - ADAPTIVE_GATE_HYSTERESIS_LU,
            observed_range_lu,
            confidence,
            detector_ready: self.observed_secs >= ADAPTIVE_GATE_MIN_OBSERVATION_SECS
                && observed_range_lu >= ADAPTIVE_GATE_MIN_RANGE_LU
                && confidence >= ADAPTIVE_GATE_READY_CONFIDENCE,
        })
    }

    fn update_trusted_model(
        &mut self,
        candidate: Option<AdaptiveGateModel>,
        hard_silence: bool,
        dt_secs: f64,
    ) {
        let dt_secs = if dt_secs.is_finite() {
            dt_secs.clamp(0.0, 10.0)
        } else {
            0.0
        };

        if self.trusted_model.is_some() {
            self.model_age_secs += dt_secs;
        }

        if hard_silence {
            self.strong_candidate_secs = 0.0;
            self.degraded_secs = 0.0;
            self.model_state = if self.trusted_model.is_some() {
                "held"
            } else {
                "learning"
            }
            .to_string();
            return;
        }

        let strong_candidate = candidate.is_some_and(|model| model.detector_ready);
        let supports_trusted_model = candidate.is_some_and(|model| {
            self.observed_secs >= ADAPTIVE_GATE_MIN_OBSERVATION_SECS
                && model.observed_range_lu >= ADAPTIVE_GATE_EXIT_RANGE_LU
                && model.confidence >= ADAPTIVE_GATE_EXIT_CONFIDENCE
        });

        if strong_candidate {
            self.strong_candidate_secs += dt_secs;
            self.degraded_secs = 0.0;

            if self.strong_candidate_secs < ADAPTIVE_GATE_ENTRY_CONFIRM_SECS {
                self.model_state = if self.trusted_model.is_some() {
                    "held"
                } else {
                    "learning"
                }
                .to_string();
                return;
            }

            let candidate = candidate.expect("strong candidate must be available");
            if let Some(trusted) = self.trusted_model {
                let threshold_delta =
                    (candidate.open_threshold_lufs - trusted.open_threshold_lufs).abs();
                let open_threshold_lufs = smooth_adaptive_value(
                    trusted.open_threshold_lufs,
                    candidate.open_threshold_lufs,
                    dt_secs,
                );
                self.trusted_model = Some(AdaptiveGateModel {
                    ambient_floor_lufs: smooth_adaptive_value(
                        trusted.ambient_floor_lufs,
                        candidate.ambient_floor_lufs,
                        dt_secs,
                    ),
                    foreground_lufs: smooth_adaptive_value(
                        trusted.foreground_lufs,
                        candidate.foreground_lufs,
                        dt_secs,
                    ),
                    normalization_offset_db: smooth_adaptive_value(
                        trusted.normalization_offset_db,
                        candidate.normalization_offset_db,
                        dt_secs,
                    ),
                    open_threshold_lufs,
                    close_threshold_lufs: open_threshold_lufs - ADAPTIVE_GATE_HYSTERESIS_LU,
                    observed_range_lu: candidate.observed_range_lu,
                    confidence: candidate.confidence,
                    detector_ready: true,
                });
                self.model_state = if threshold_delta > 1.0 {
                    "adapting"
                } else {
                    "stable"
                }
                .to_string();
            } else {
                self.trusted_model = Some(AdaptiveGateModel {
                    detector_ready: true,
                    ..candidate
                });
                self.model_state = "stable".to_string();
            }
            self.model_age_secs = 0.0;
            return;
        }

        self.strong_candidate_secs = 0.0;
        if self.trusted_model.is_none() {
            self.degraded_secs = 0.0;
            self.model_state = "learning".to_string();
        } else if supports_trusted_model {
            self.degraded_secs = 0.0;
            self.model_state = "held".to_string();
        } else {
            self.degraded_secs += dt_secs;
            self.model_state = if self.degraded_secs >= ADAPTIVE_GATE_DEGRADED_GRACE_SECS {
                "degraded"
            } else {
                "held"
            }
            .to_string();
        }
    }

    fn phase(&self, below_threshold: bool, acquiring: bool) -> String {
        if acquiring {
            "learning"
        } else if self.gate_open {
            if below_threshold {
                "closing_hold"
            } else {
                "open"
            }
        } else if self.above_open_secs > 0.0 {
            "reopening"
        } else {
            "gated"
        }
        .to_string()
    }

    fn measure(
        &mut self,
        momentary: f64,
        short_term: f64,
        integrated: f64,
        config: &NormalizerConfig,
        dt_secs: f64,
    ) -> GateMeasurement {
        let observation_dt_secs = dt_secs;
        let dt_secs = dt_secs.clamp(0.025, 1.0);
        let gate_signal = match &config.gate_detector_mode {
            GateDetectorMode::Momentary => {
                if momentary.is_finite() {
                    momentary
                } else {
                    short_term
                }
            }
            GateDetectorMode::ShortTerm => {
                if short_term.is_finite() {
                    short_term
                } else {
                    momentary
                }
            }
        };
        let hard_silence = !gate_signal.is_finite() || gate_signal <= -69.0;

        if !config.adaptive_gate_enabled {
            self.ambient_floor_lufs = None;
            self.foreground_lufs = None;
            self.samples.clear();
            self.elapsed_secs = 0.0;
            self.observed_secs = 0.0;
            self.distribution_stability = 0.0;
            self.trusted_model = None;
            self.strong_candidate_secs = 0.0;
            self.degraded_secs = 0.0;
            self.model_age_secs = 0.0;
            self.model_state = "fixed".to_string();
            self.above_open_secs = 0.0;

            let below_threshold = hard_silence || gate_signal < config.gate_threshold_lufs;
            self.update_close_state(below_threshold, config.hold_ms / 1000.0, dt_secs);
            if !below_threshold {
                self.gate_open = true;
            }

            return GateMeasurement {
                signal_lufs: if hard_silence { -120.0 } else { gate_signal },
                normalization_offset_db: 0.0,
                ambient_floor_lufs: -70.0,
                foreground_lufs: -70.0,
                open_threshold_lufs: config.gate_threshold_lufs,
                close_threshold_lufs: config.gate_threshold_lufs,
                observed_range_lu: 0.0,
                observed_secs: 0.0,
                confidence: 0.0,
                detector_ready: false,
                model_state: self.model_state.clone(),
                model_age_secs: 0.0,
                phase: self.phase(below_threshold, false),
                acquiring: false,
                is_gated: !self.gate_open,
                below_threshold,
                subtitle_assist_active: false,
            };
        }

        self.track_distribution(
            gate_signal,
            observation_dt_secs,
            config.gate_observation_window_secs,
        );
        let candidate_model = self.adaptive_model(config);
        match config.adaptive_gate_mode {
            AdaptiveGateMode::Direct => {
                self.trusted_model = None;
                self.strong_candidate_secs = 0.0;
                self.degraded_secs = 0.0;
                self.model_age_secs = 0.0;
                self.model_state = if candidate_model.is_some_and(|model| model.detector_ready) {
                    "direct"
                } else {
                    "learning"
                }
                .to_string();
            }
            AdaptiveGateMode::Stable => {
                self.update_trusted_model(candidate_model, hard_silence, observation_dt_secs);
            }
        }
        let current_confidence = candidate_model.map(|model| model.confidence).unwrap_or(0.0);
        let current_range_lu = candidate_model
            .map(|model| model.observed_range_lu)
            .unwrap_or(0.0);
        let active_model = match config.adaptive_gate_mode {
            AdaptiveGateMode::Direct => candidate_model.filter(|model| model.detector_ready),
            AdaptiveGateMode::Stable => self.trusted_model,
        };
        let display_model = active_model.or(candidate_model);

        if hard_silence {
            self.update_close_state(true, config.hold_ms / 1000.0, dt_secs);
            let model = display_model.unwrap_or(AdaptiveGateModel {
                ambient_floor_lufs: -70.0,
                foreground_lufs: -70.0,
                normalization_offset_db: 0.0,
                open_threshold_lufs: config.gate_threshold_lufs,
                close_threshold_lufs: config.gate_threshold_lufs - ADAPTIVE_GATE_HYSTERESIS_LU,
                observed_range_lu: 0.0,
                confidence: 0.0,
                detector_ready: false,
            });
            return GateMeasurement {
                signal_lufs: -120.0,
                normalization_offset_db: model.normalization_offset_db,
                ambient_floor_lufs: model.ambient_floor_lufs,
                foreground_lufs: model.foreground_lufs,
                open_threshold_lufs: model.open_threshold_lufs,
                close_threshold_lufs: model.close_threshold_lufs,
                observed_range_lu: current_range_lu,
                observed_secs: self.observed_secs,
                confidence: current_confidence,
                detector_ready: active_model.is_some(),
                model_state: self.model_state.clone(),
                model_age_secs: self.model_age_secs,
                phase: self.phase(true, false),
                acquiring: false,
                is_gated: !self.gate_open,
                below_threshold: true,
                subtitle_assist_active: false,
            };
        }

        let integrated_available = integrated.is_finite() && integrated > -69.0;
        let fallback_offset = if integrated_available {
            (config.target_lufs - integrated)
                .clamp(config.max_cut_db, configured_max_gain_limit(config))
        } else {
            0.0
        };
        if active_model.is_none() {
            // Learning confidence is diagnostic only. Until the selected mode
            // has an active model, keep valid programme audio open so the gain
            // rider never depends on learner readiness.
            self.gate_open = true;
            self.above_open_secs = 0.0;
            self.below_close_secs = 0.0;
            let model = display_model.unwrap_or(AdaptiveGateModel {
                ambient_floor_lufs: -70.0,
                foreground_lufs: -70.0,
                normalization_offset_db: fallback_offset,
                open_threshold_lufs: config.gate_threshold_lufs - fallback_offset,
                close_threshold_lufs: config.gate_threshold_lufs - fallback_offset,
                observed_range_lu: current_range_lu,
                confidence: current_confidence,
                detector_ready: false,
            });

            return GateMeasurement {
                signal_lufs: gate_signal,
                normalization_offset_db: model.normalization_offset_db,
                ambient_floor_lufs: model.ambient_floor_lufs,
                foreground_lufs: model.foreground_lufs,
                open_threshold_lufs: model.open_threshold_lufs,
                close_threshold_lufs: model.close_threshold_lufs,
                observed_range_lu: current_range_lu,
                observed_secs: self.observed_secs,
                confidence: current_confidence,
                detector_ready: false,
                model_state: self.model_state.clone(),
                model_age_secs: 0.0,
                phase: self.phase(false, true),
                acquiring: true,
                is_gated: false,
                below_threshold: false,
                subtitle_assist_active: false,
            };
        }

        // Translate the configured normalized threshold back into this source's
        // loudness domain, then raise it enough to reject the learned ambience.
        // The foreground cap prevents the adaptive threshold from swallowing the
        // programme it is meant to preserve.
        let model = active_model.expect("active model must exist after learning guard");
        let open_threshold = model.open_threshold_lufs;
        let close_threshold = model.close_threshold_lufs;

        let below_threshold = if self.gate_open {
            gate_signal < close_threshold
        } else {
            gate_signal < open_threshold
        };

        if self.gate_open {
            self.above_open_secs = 0.0;
            self.update_close_state(below_threshold, config.hold_ms / 1000.0, dt_secs);
        } else {
            self.below_close_secs = 0.0;
            if gate_signal >= open_threshold {
                self.above_open_secs += dt_secs;
                if self.above_open_secs >= ADAPTIVE_GATE_OPEN_CONFIRM_SECS {
                    self.gate_open = true;
                    self.above_open_secs = 0.0;
                }
            } else {
                self.above_open_secs = 0.0;
            }
        }

        GateMeasurement {
            signal_lufs: gate_signal,
            normalization_offset_db: model.normalization_offset_db,
            ambient_floor_lufs: model.ambient_floor_lufs,
            foreground_lufs: model.foreground_lufs,
            open_threshold_lufs: model.open_threshold_lufs,
            close_threshold_lufs: model.close_threshold_lufs,
            observed_range_lu: current_range_lu,
            observed_secs: self.observed_secs,
            confidence: current_confidence,
            detector_ready: true,
            model_state: self.model_state.clone(),
            model_age_secs: self.model_age_secs,
            phase: self.phase(below_threshold, false),
            acquiring: false,
            is_gated: !self.gate_open,
            below_threshold,
            subtitle_assist_active: false,
        }
    }

    fn apply_subtitle_assist(&mut self, measurement: &mut GateMeasurement) {
        self.gate_open = true;
        self.above_open_secs = 0.0;
        self.below_close_secs = 0.0;
        measurement.phase = "subtitle".to_string();
        measurement.acquiring = false;
        measurement.is_gated = false;
        measurement.below_threshold = false;
        measurement.subtitle_assist_active = true;
    }

    fn update_close_state(&mut self, below: bool, hold_secs: f64, dt_secs: f64) {
        if below {
            self.below_close_secs += dt_secs;
            if self.below_close_secs >= hold_secs.max(0.0) {
                self.gate_open = false;
            }
        } else {
            self.below_close_secs = 0.0;
        }
    }
}

fn smooth_adaptive_value(current: f64, target: f64, dt_secs: f64) -> f64 {
    let tau_secs = if target < current {
        ADAPTIVE_GATE_THRESHOLD_DOWN_TAU_SECS
    } else {
        ADAPTIVE_GATE_THRESHOLD_UP_TAU_SECS
    };
    current + (exponential_smoothing_alpha(dt_secs, tau_secs) * (target - current))
}

fn percentile(sorted_values: &[f64], percentile: f64) -> Option<f64> {
    if sorted_values.is_empty() {
        return None;
    }

    let position = percentile.clamp(0.0, 1.0) * (sorted_values.len() - 1) as f64;
    let lower_index = position.floor() as usize;
    let upper_index = position.ceil() as usize;
    let fraction = position - lower_index as f64;
    Some(
        sorted_values[lower_index]
            + ((sorted_values[upper_index] - sorted_values[lower_index]) * fraction),
    )
}

const ADAPTIVE_MAX_GAIN_RISE_DB_PER_SEC: f64 = 2.0;
const ADAPTIVE_MAX_GAIN_FALL_DB_PER_SEC: f64 = 4.0;

fn configured_max_gain_limit(config: &NormalizerConfig) -> f64 {
    if config.adaptive_gate_enabled && config.adaptive_max_gain_enabled && config.limiter_enabled {
        config.adaptive_max_gain_limit_db.max(config.max_gain_db)
    } else {
        config.max_gain_db
    }
}

fn update_adaptive_max_gain(
    ctx: &mut RiderContext,
    integrated_lufs: f64,
    config: &NormalizerConfig,
    dt_secs: f64,
) -> f64 {
    let dt_secs = if dt_secs.is_finite() {
        dt_secs.clamp(0.0, 10.0)
    } else {
        0.0
    };
    let base_limit = config.max_gain_db;
    if !ctx.effective_max_gain_db.is_finite() || ctx.effective_max_gain_db < base_limit {
        ctx.effective_max_gain_db = base_limit;
    }

    let (target_limit, state, retreat_immediately) = if !config.adaptive_max_gain_enabled {
        (base_limit, "disabled", true)
    } else if !config.adaptive_gate_enabled {
        (base_limit, "adaptive_gate_required", true)
    } else if !config.limiter_enabled {
        (base_limit, "limiter_required", true)
    } else if !integrated_lufs.is_finite() || integrated_lufs <= -69.0 {
        (base_limit, "waiting_for_long_term", true)
    } else {
        let hard_limit = config.adaptive_max_gain_limit_db.max(base_limit);
        let source_offset_db = (config.target_lufs - integrated_lufs).max(0.0);
        let relative_limit = base_limit + source_offset_db;
        let target_limit = hard_limit.min(relative_limit);
        let state = if source_offset_db <= 0.05 {
            "manual_sufficient"
        } else if hard_limit <= relative_limit + 0.05 {
            "hard_ceiling"
        } else {
            "relative"
        };
        (target_limit, state, false)
    };

    if retreat_immediately && target_limit < ctx.effective_max_gain_db {
        ctx.effective_max_gain_db = target_limit;
    } else if target_limit > ctx.effective_max_gain_db {
        ctx.effective_max_gain_db = (ctx.effective_max_gain_db
            + (ADAPTIVE_MAX_GAIN_RISE_DB_PER_SEC * dt_secs))
            .min(target_limit);
    } else if target_limit < ctx.effective_max_gain_db {
        ctx.effective_max_gain_db = (ctx.effective_max_gain_db
            - (ADAPTIVE_MAX_GAIN_FALL_DB_PER_SEC * dt_secs))
            .max(target_limit);
    }

    ctx.effective_max_gain_db = ctx.effective_max_gain_db.clamp(
        base_limit,
        config.adaptive_max_gain_limit_db.max(base_limit),
    );
    ctx.adaptive_gain_state = state.to_string();
    ctx.effective_max_gain_db
}

fn compute_gain(
    ctx: &mut RiderContext,
    momentary: f64,
    short_term: f64,
    integrated: f64,
    true_peak: f64,
    gate: &GateMeasurement,
    config: &NormalizerConfig,
    dt_secs: f64,
) -> (f64, f64, f64, f64, f64, String) {
    if let Some(until) = ctx.settling_until {
        if Instant::now() < until {
            return (0.0, 0.0, 0.0, 0.0, 0.0, "settling".to_string());
        }
        ctx.settling_until = None;
    }

    let effective_max_gain_db = update_adaptive_max_gain(ctx, integrated, config, dt_secs);
    ctx.slow_gain_db = ctx
        .slow_gain_db
        .clamp(config.max_cut_db, effective_max_gain_db);
    ctx.current_gain_db = ctx
        .current_gain_db
        .clamp(config.max_cut_db, effective_max_gain_db);

    if gate.is_gated {
        return (
            ctx.current_gain_db,
            ctx.current_gain_db,
            ctx.slow_gain_db,
            ctx.fast_gain_db,
            0.0,
            "gated".to_string(),
        );
    }

    if gate.subtitle_assist_active && gate.signal_lufs <= -69.0 {
        return (
            ctx.current_gain_db,
            ctx.current_gain_db,
            ctx.slow_gain_db,
            ctx.fast_gain_db,
            0.0,
            "subtitle_wait".to_string(),
        );
    }

    let control_signal =
        select_slow_control_signal(&config.slow_control_mode, momentary, short_term, integrated);
    let smoothing_tau_secs = if control_signal < ctx.smoothed_lufs {
        0.55
    } else {
        1.25
    };
    let alpha = exponential_smoothing_alpha(dt_secs, smoothing_tau_secs);
    if ctx.smoothed_lufs <= -69.0 {
        ctx.smoothed_lufs = control_signal;
    } else {
        ctx.smoothed_lufs += alpha * (control_signal - ctx.smoothed_lufs);
    }

    let slow_desired_gain_db = if config.slow_enabled {
        let desired = (config.target_lufs - ctx.smoothed_lufs)
            .clamp(config.max_cut_db, effective_max_gain_db);
        ctx.slow_gain_db = apply_response_curve(ctx.slow_gain_db, desired, config, dt_secs)
            .clamp(config.max_cut_db, effective_max_gain_db);
        desired
    } else {
        ctx.slow_gain_db = 0.0;
        0.0
    };

    let fast_desired_gain_db = if config.fast_enabled {
        let desired = match config.fast_detector_mode {
            FastDetectorMode::MomentaryDelta => {
                let fast_excess = momentary - short_term;
                if fast_excess > config.fast_threshold_lu {
                    -((fast_excess - config.fast_threshold_lu).min(config.fast_max_cut_db.max(0.0)))
                } else {
                    0.0
                }
            }
            FastDetectorMode::TruePeak => {
                let peak_excess = true_peak - config.fast_true_peak_threshold_db;
                if peak_excess > 0.0 {
                    -(peak_excess.min(config.fast_max_cut_db.max(0.0)))
                } else {
                    0.0
                }
            }
        };
        ctx.fast_gain_db = apply_time_response(
            ctx.fast_gain_db,
            desired,
            config.fast_attack_ms,
            config.fast_release_ms,
            dt_secs,
        )
        .clamp(-config.fast_max_cut_db.max(0.0), 0.0);
        desired
    } else {
        ctx.fast_gain_db = 0.0;
        0.0
    };

    let previous_gain_db = ctx.current_gain_db;
    let mut desired_gain_db = (slow_desired_gain_db + fast_desired_gain_db)
        .clamp(config.max_cut_db, effective_max_gain_db);
    let mut applied_gain_db =
        (ctx.slow_gain_db + ctx.fast_gain_db).clamp(config.max_cut_db, effective_max_gain_db);
    let mut transient_cut_db = 0.0;
    let mut transient_limited = false;
    let fast_limited = config.fast_enabled && ctx.fast_gain_db < -0.1;
    let mut peak_limited = false;

    let transient_excess = momentary - short_term;
    if config.transient_enabled && transient_excess > config.transient_threshold_lu {
        let extra_cut = (transient_excess - config.transient_threshold_lu)
            .min(config.max_transient_cut_db.max(0.0));
        let transient_desired =
            (desired_gain_db - extra_cut).clamp(config.max_cut_db, effective_max_gain_db);
        let transient_applied = ((ctx.slow_gain_db + ctx.fast_gain_db) - extra_cut)
            .clamp(config.max_cut_db, effective_max_gain_db);
        if transient_applied < applied_gain_db {
            desired_gain_db = transient_desired;
            applied_gain_db = transient_applied;
            transient_cut_db = ((ctx.slow_gain_db + ctx.fast_gain_db) - transient_applied).max(0.0);
            transient_limited = true;
        }
    }

    if config.peak_ceiling_enabled {
        let peak_headroom = (config.peak_ceiling_threshold_db - true_peak)
            .clamp(config.max_cut_db, effective_max_gain_db);
        if peak_headroom < applied_gain_db {
            applied_gain_db = peak_headroom;
            peak_limited = true;
        }
        desired_gain_db = desired_gain_db.min(peak_headroom);
    }

    ctx.current_gain_db = applied_gain_db.clamp(config.max_cut_db, effective_max_gain_db);
    let applied_delta_db = ctx.current_gain_db - previous_gain_db;

    let reason = if peak_limited {
        "peak_limited"
    } else if fast_limited {
        "fast_cut"
    } else if transient_limited {
        "transient_cut"
    } else if gate.below_threshold {
        "hold_period"
    } else if applied_delta_db.abs() < 0.1 {
        "steady"
    } else if applied_delta_db < 0.0 {
        "cutting"
    } else {
        "boosting"
    };

    (
        ctx.current_gain_db,
        desired_gain_db,
        ctx.slow_gain_db,
        ctx.fast_gain_db,
        transient_cut_db,
        reason.to_string(),
    )
}

#[allow(dead_code)]
fn compute_gain_v1(
    ctx: &mut RiderContext,
    momentary: f64,
    _short_term: f64,
    _integrated: f64,
    true_peak: f64,
    config: &NormalizerConfig,
    dt_secs: f64,
) -> (f64, String) {
    // Check settling period (after file change)
    if let Some(until) = ctx.settling_until {
        if Instant::now() < until {
            return (0.0, "settling".to_string());
        }
        ctx.settling_until = None;
    }

    // Gate: if below threshold, hold gain steady
    if momentary < config.gate_threshold_lufs {
        let hold_dur = Duration::from_millis(config.hold_ms as u64);
        if ctx.last_above_gate.elapsed() > hold_dur {
            return (ctx.current_gain_db, "gated".to_string());
        }
        // Within hold period, continue normal processing
    } else {
        ctx.last_above_gate = Instant::now();
    }

    // Smooth the loudness reading (EMA)
    let alpha = (dt_secs / 0.4).min(1.0); // ~400ms time constant
    if ctx.smoothed_lufs <= -69.0 {
        ctx.smoothed_lufs = momentary;
    } else {
        ctx.smoothed_lufs += alpha * (momentary - ctx.smoothed_lufs);
    }

    // Desired gain
    let desired = config.target_lufs - ctx.smoothed_lufs;

    // Clamp
    let desired = desired.clamp(config.max_cut_db, config.max_gain_db);

    // Attack/release envelope
    let diff = desired - ctx.current_gain_db;
    if config.response_mode == RiderResponseMode::DbPerSec {
        let rate_limit = if diff < 0.0 {
            config.attack_db_per_sec.max(0.0)
        } else {
            config.release_db_per_sec.max(0.0)
        };
        let max_step = rate_limit * dt_secs;
        let step = diff.clamp(-max_step, max_step);
        ctx.current_gain_db += step;
    } else {
        let rate = if diff < 0.0 {
            // Cutting (too loud) — use attack (faster)
            1.0 - (-dt_secs * 1000.0 / config.attack_ms).exp()
        } else {
            // Boosting (too quiet) — use release (slower)
            1.0 - (-dt_secs * 1000.0 / config.release_ms).exp()
        };

        ctx.current_gain_db += diff * rate;
    }
    ctx.current_gain_db = ctx
        .current_gain_db
        .clamp(config.max_cut_db, config.max_gain_db);

    // Peak safety: if current peak + gain would exceed -1 dBFS, pull back
    let headroom = -1.0 - true_peak;
    if ctx.current_gain_db > headroom && headroom < config.max_gain_db {
        ctx.current_gain_db = headroom.max(0.0);
        return (ctx.current_gain_db, "peak_limited".to_string());
    }

    let reason = if momentary < config.gate_threshold_lufs {
        "hold_period"
    } else if (desired - ctx.current_gain_db).abs() < 0.1 {
        "steady"
    } else if diff < 0.0 {
        "cutting"
    } else {
        "boosting"
    };

    (ctx.current_gain_db, reason.to_string())
}

// ---------------------------------------------------------------------------
// Background thread
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub fn start_normalizer(app_handle: AppHandle) {
    let mut thread_slot = NORMALIZER_THREAD
        .lock()
        .expect("normalizer thread mutex poisoned");

    if NORMALIZER_RUNNING.load(Ordering::SeqCst) {
        info!("[Normalizer] Already running");
        return;
    }

    if let Some(previous_thread) = thread_slot.take() {
        let _ = previous_thread.join();
    }

    NORMALIZER_RUNNING.store(true, Ordering::SeqCst);
    info!("[Normalizer] Starting rider thread");

    let thread = std::thread::spawn(move || {
        let mut ctx = RiderContext::new();
        let mut pipe: Option<HANDLE> = None;
        let mut last_applied_gain = 0.0f64;
        let mut last_tick = Instant::now();
        let mut was_enabled = false;
        let mut was_connected = false;
        let mut last_gated_state = false;
        let mut stale_logged = false;
        let mut last_telemetry_emit = Instant::now() - Duration::from_millis(500);
        let mut last_telemetry_status: Option<(bool, bool, bool, bool, String)> = None;

        let emit_log = |app: &AppHandle, event_type: &str, message: &str| {
            let entry = EventLogEntry {
                timestamp_ms: current_timestamp_ms(),
                event_type: event_type.to_string(),
                message: message.to_string(),
            };
            let _ = app.emit("audio-normalizer://event-log", &entry);
        };

        emit_log(&app_handle, "start", "Normalizer thread started");

        while NORMALIZER_RUNNING.load(Ordering::SeqCst) {
            let config = get_config();
            let refresh_interval_ms = config.refresh_interval_ms.max(25.0).round() as u64;
            let refresh_interval = Duration::from_millis(refresh_interval_ms);
            std::thread::sleep(refresh_interval);
            let manual_mode = is_manual_mode();
            if !config.enabled {
                if was_enabled {
                    if let Some(h) = pipe {
                        set_rider_gain(h, 0.0);
                    }
                    if FILTERS_INSTALLED.load(Ordering::SeqCst) {
                        if let Some(h) = pipe {
                            remove_filters(h);
                        }
                    }
                    ctx.reset();
                    last_applied_gain = 0.0;
                    emit_log(&app_handle, "disabled", "Normalizer disabled");
                }

                if was_connected {
                    emit_log(&app_handle, "disconnected", "MPV pipe disconnected");
                }

                reset_shared_state(false);
                was_enabled = false;
                was_connected = false;
                last_gated_state = false;
                stale_logged = false;
                continue;
            }

            if !was_enabled {
                emit_log(&app_handle, "enabled", "Normalizer enabled");
            }
            was_enabled = true;

            if RESET_REQUESTED.swap(false, Ordering::SeqCst) {
                ctx.reset();
                last_applied_gain = 0.0;
                if let Some(h) = pipe {
                    set_rider_gain(h, 0.0);
                    if FILTERS_INSTALLED.load(Ordering::SeqCst) {
                        remove_filters(h);
                    }
                    if !install_filters(h) {
                        unsafe {
                            let _ = CloseHandle(h);
                        }
                        pipe = None;
                        was_connected = false;
                        reset_shared_state(false);
                        emit_log(
                            &app_handle,
                            "error",
                            "Failed to reinstall audio filters after reset",
                        );
                        continue;
                    }
                }
                reset_shared_state(pipe.is_some());
                emit_log(&app_handle, "reset", "Normalizer state reset");
            }

            let h = match pipe {
                Some(h) => h,
                None => match connect_to_mpv_pipe() {
                    Some(h) => {
                        pipe = Some(h);
                        ctx.reset();
                        last_applied_gain = 0.0;
                        last_tick = Instant::now();
                        if !was_connected {
                            emit_log(&app_handle, "connected", "Connected to MPV pipe");
                        }
                        was_connected = true;
                        h
                    }
                    None => {
                        if was_connected {
                            emit_log(&app_handle, "disconnected", "MPV pipe disconnected");
                        }
                        was_connected = false;
                        reset_shared_state(false);
                        std::thread::sleep(Duration::from_secs(2));
                        continue;
                    }
                },
            };

            if !FILTERS_INSTALLED.load(Ordering::SeqCst) {
                if !install_filters(h) {
                    unsafe {
                        let _ = CloseHandle(h);
                    }
                    pipe = None;
                    was_connected = false;
                    reset_shared_state(false);
                    emit_log(&app_handle, "error", "Failed to install audio filters");
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
                emit_log(&app_handle, "filters", "Audio filters installed");
                set_rider_gain(h, 0.0);
            }

            if let Some(filename) = read_filename(h) {
                if !filename.is_empty() && filename != ctx.last_filename {
                    if !ctx.last_filename.is_empty() {
                        info!("[Normalizer] File changed: {}", filename);
                        ctx.reset();
                        last_applied_gain = 0.0;
                        remove_filters(h);
                        if install_filters(h) {
                            set_rider_gain(h, 0.0);
                        } else {
                            unsafe {
                                let _ = CloseHandle(h);
                            }
                            pipe = None;
                            was_connected = false;
                            reset_shared_state(false);
                            emit_log(
                                &app_handle,
                                "error",
                                "Failed to reinstall filters after file change",
                            );
                            continue;
                        }
                        emit_log(
                            &app_handle,
                            "file_change",
                            &format!("File changed: {}", filename),
                        );
                    }
                    ctx.last_filename = filename;
                }
            }

            let paused = mpv_get_property_json(h, "pause")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let measurements = if paused {
                None
            } else {
                read_ebur128_metadata(h)
            };
            let dt = last_tick.elapsed().as_secs_f64();
            last_tick = Instant::now();
            let subtitle_dialogue_visible = if paused {
                false
            } else if ctx.should_poll_subtitles(config.subtitle_assist_enabled, dt) {
                ctx.subtitle_dialogue_visible = visible_subtitle_should_assist(h);
                ctx.subtitle_dialogue_visible
            } else {
                ctx.subtitle_dialogue_visible
            };
            let subtitle_assist_active = if paused {
                get_state().subtitle_assist_active
            } else {
                ctx.update_subtitle_assist(
                    config.subtitle_assist_enabled,
                    subtitle_dialogue_visible,
                    dt,
                )
            };

            let mut connected = true;
            let (
                momentary,
                short_term,
                integrated,
                true_peak,
                true_peak_source,
                limiter_input_peak_db,
                limiter_input_peak_source,
                output_peak_db,
                output_peak_source,
                limiter_reduction_db,
                desired_gain_db,
                slow_gain_db,
                fast_gain_db,
                transient_cut_db,
                mut gate,
                reason,
            ) = if paused {
                let state = get_state();
                (
                    state.momentary_lufs,
                    state.short_term_lufs,
                    state.integrated_lufs,
                    state.true_peak_db,
                    state.true_peak_source,
                    state.limiter_input_peak_db,
                    state.limiter_input_peak_source,
                    state.output_peak_db,
                    state.output_peak_source,
                    state.limiter_reduction_db,
                    state.desired_gain_db,
                    state.slow_gain_db,
                    state.fast_gain_db,
                    state.transient_cut_db,
                    GateMeasurement {
                        signal_lufs: state.gate_signal_lufs,
                        normalization_offset_db: state.gate_normalization_offset_db,
                        ambient_floor_lufs: state.gate_ambient_floor_lufs,
                        foreground_lufs: state.gate_foreground_lufs,
                        open_threshold_lufs: state.gate_open_threshold_lufs,
                        close_threshold_lufs: state.gate_close_threshold_lufs,
                        observed_range_lu: state.gate_observed_range_lu,
                        observed_secs: state.gate_observed_secs,
                        confidence: state.gate_confidence,
                        detector_ready: state.gate_detector_ready,
                        model_state: state.gate_model_state,
                        model_age_secs: state.gate_model_age_secs,
                        phase: state.gate_phase,
                        acquiring: state.gate_acquiring,
                        is_gated: state.is_gated,
                        below_threshold: false,
                        subtitle_assist_active: state.subtitle_assist_active,
                    },
                    "paused".to_string(),
                )
            } else {
                match measurements {
                    Some((m, s, i, control_peak)) => {
                        ctx.stale_count = 0;
                        stale_logged = false;
                        let mut gate = ctx.gate_detector.measure(m, s, i, &config, dt);
                        if subtitle_assist_active {
                            ctx.gate_detector.apply_subtitle_assist(&mut gate);
                        }
                        let (
                            gain,
                            desired_gain_db,
                            slow_gain_db,
                            fast_gain_db,
                            transient_cut_db,
                            reason,
                        ) = if manual_mode {
                            ctx.slow_gain_db = 0.0;
                            ctx.fast_gain_db = 0.0;
                            ctx.current_gain_db = get_manual_gain();
                            ctx.effective_max_gain_db = config.max_gain_db;
                            ctx.adaptive_gain_state = "manual".to_string();
                            (
                                ctx.current_gain_db,
                                ctx.current_gain_db,
                                0.0,
                                0.0,
                                0.0,
                                "manual_mode".to_string(),
                            )
                        } else {
                            compute_gain(&mut ctx, m, s, i, control_peak.db, &gate, &config, dt)
                        };

                        if !manual_mode && (gain - last_applied_gain).abs() > 0.1 {
                            set_rider_gain(h, gain);
                            last_applied_gain = gain;
                        }

                        let limiter_input_peak =
                            read_astats_peak_metadata(h).map(|db| PeakMeasurement {
                                db: db + gain,
                                source: PeakTelemetrySource::SamplePeak,
                            });
                        let output_peak = read_output_peak_metadata(h);
                        let output_sample_peak = output_peak;
                        let limiter_reduction_db = if config.limiter_enabled
                            && limiter_input_peak
                                .map(|peak| peak.db > config.limiter_limit_db)
                                .unwrap_or(false)
                            && output_sample_peak.source == PeakTelemetrySource::SamplePeak
                        {
                            let limiter_input_peak_db = limiter_input_peak
                                .map(|peak| peak.db)
                                .unwrap_or(config.limiter_limit_db);
                            (limiter_input_peak_db - output_sample_peak.db).max(0.0)
                        } else {
                            0.0
                        };
                        let limiter_input_peak =
                            limiter_input_peak.unwrap_or_else(PeakMeasurement::unknown);

                        (
                            m,
                            s,
                            i,
                            control_peak.db,
                            control_peak.source,
                            limiter_input_peak.db,
                            limiter_input_peak.source,
                            output_peak.db,
                            output_peak.source,
                            limiter_reduction_db,
                            desired_gain_db,
                            slow_gain_db,
                            fast_gain_db,
                            transient_cut_db,
                            gate,
                            reason,
                        )
                    }
                    None => {
                        if mpv_get_property_json(h, "pause").is_none() {
                            unsafe {
                                let _ = CloseHandle(h);
                            }
                            pipe = None;
                            FILTERS_INSTALLED.store(false, Ordering::SeqCst);
                            ctx.reset();
                            last_applied_gain = 0.0;
                            stale_logged = false;
                            connected = false;

                            if was_connected {
                                emit_log(&app_handle, "disconnected", "MPV pipe disconnected");
                            }
                            was_connected = false;

                            (
                                -70.0,
                                -70.0,
                                -70.0,
                                -70.0,
                                PeakTelemetrySource::Unknown,
                                -70.0,
                                PeakTelemetrySource::Unknown,
                                -70.0,
                                PeakTelemetrySource::Unknown,
                                0.0,
                                0.0,
                                0.0,
                                0.0,
                                0.0,
                                GateMeasurement {
                                    signal_lufs: -70.0,
                                    normalization_offset_db: 0.0,
                                    ambient_floor_lufs: -70.0,
                                    foreground_lufs: -70.0,
                                    open_threshold_lufs: config.gate_threshold_lufs,
                                    close_threshold_lufs: config.gate_threshold_lufs,
                                    observed_range_lu: 0.0,
                                    observed_secs: 0.0,
                                    confidence: 0.0,
                                    detector_ready: false,
                                    model_state: "disconnected".to_string(),
                                    model_age_secs: 0.0,
                                    phase: "disconnected".to_string(),
                                    acquiring: false,
                                    is_gated: false,
                                    below_threshold: false,
                                    subtitle_assist_active: false,
                                },
                                "disconnected".to_string(),
                            )
                        } else {
                            ctx.stale_count += 1;
                            if ctx.stale_count > 10 {
                                ctx.reset();
                                last_applied_gain = 0.0;
                                set_rider_gain(h, 0.0);
                                if !stale_logged {
                                    emit_log(
                                        &app_handle,
                                        "stale",
                                        "10+ stale readings, gain reset to 0",
                                    );
                                    stale_logged = true;
                                }
                                ctx.stale_count = 0;
                            }

                            let state = get_state();
                            (
                                state.momentary_lufs,
                                state.short_term_lufs,
                                state.integrated_lufs,
                                state.true_peak_db,
                                state.true_peak_source,
                                state.limiter_input_peak_db,
                                state.limiter_input_peak_source,
                                state.output_peak_db,
                                state.output_peak_source,
                                state.limiter_reduction_db,
                                state.desired_gain_db,
                                state.slow_gain_db,
                                state.fast_gain_db,
                                state.transient_cut_db,
                                GateMeasurement {
                                    signal_lufs: state.gate_signal_lufs,
                                    normalization_offset_db: state.gate_normalization_offset_db,
                                    ambient_floor_lufs: state.gate_ambient_floor_lufs,
                                    foreground_lufs: state.gate_foreground_lufs,
                                    open_threshold_lufs: state.gate_open_threshold_lufs,
                                    close_threshold_lufs: state.gate_close_threshold_lufs,
                                    observed_range_lu: state.gate_observed_range_lu,
                                    observed_secs: state.gate_observed_secs,
                                    confidence: state.gate_confidence,
                                    detector_ready: state.gate_detector_ready,
                                    model_state: state.gate_model_state,
                                    model_age_secs: state.gate_model_age_secs,
                                    phase: state.gate_phase,
                                    acquiring: state.gate_acquiring,
                                    is_gated: state.is_gated,
                                    below_threshold: false,
                                    subtitle_assist_active: state.subtitle_assist_active,
                                },
                                "no_data".to_string(),
                            )
                        }
                    }
                }
            };

            if subtitle_assist_active && !gate.subtitle_assist_active {
                ctx.gate_detector.apply_subtitle_assist(&mut gate);
            }

            let is_gated = gate.is_gated;

            if is_gated != last_gated_state {
                emit_log(
                    &app_handle,
                    if is_gated { "gate_on" } else { "gate_off" },
                    if is_gated {
                        "Silence gate engaged"
                    } else {
                        "Silence gate released"
                    },
                );
                last_gated_state = is_gated;
            }

            if let Ok(mut state) = STATE.lock() {
                state.current_gain_db = ctx.current_gain_db;
                state.momentary_lufs = momentary;
                state.short_term_lufs = short_term;
                state.integrated_lufs = integrated;
                state.true_peak_db = true_peak;
                state.true_peak_source = true_peak_source;
                state.limiter_input_peak_db = limiter_input_peak_db;
                state.limiter_input_peak_source = limiter_input_peak_source;
                state.output_peak_db = output_peak_db;
                state.output_peak_source = output_peak_source;
                state.limiter_reduction_db = limiter_reduction_db;
                state.smoothed_lufs = ctx.smoothed_lufs;
                state.desired_gain_db = desired_gain_db;
                state.slow_gain_db = slow_gain_db;
                state.fast_gain_db = fast_gain_db;
                state.transient_cut_db = transient_cut_db;
                state.effective_max_gain_db = ctx.effective_max_gain_db;
                state.adaptive_gain_extra_db =
                    (ctx.effective_max_gain_db - config.max_gain_db).max(0.0);
                state.adaptive_gain_state = ctx.adaptive_gain_state.clone();
                state.gate_signal_lufs = gate.signal_lufs;
                state.gate_threshold_lufs = config.gate_threshold_lufs;
                state.gate_normalization_offset_db = gate.normalization_offset_db;
                state.gate_ambient_floor_lufs = gate.ambient_floor_lufs;
                state.gate_foreground_lufs = gate.foreground_lufs;
                state.gate_open_threshold_lufs = gate.open_threshold_lufs;
                state.gate_close_threshold_lufs = gate.close_threshold_lufs;
                state.gate_observed_range_lu = gate.observed_range_lu;
                state.gate_observed_secs = gate.observed_secs;
                state.gate_observation_window_secs = config.gate_observation_window_secs;
                state.gate_confidence = gate.confidence;
                state.gate_detector_ready = gate.detector_ready;
                state.gate_model_state = gate.model_state.clone();
                state.gate_model_age_secs = gate.model_age_secs;
                state.gate_phase = gate.phase.clone();
                state.adaptive_gate_enabled = config.adaptive_gate_enabled;
                state.adaptive_gate_mode = config.adaptive_gate_mode;
                state.subtitle_assist_enabled = config.subtitle_assist_enabled;
                state.subtitle_assist_active = gate.subtitle_assist_active;
                state.gate_detector_mode = config.gate_detector_mode;
                state.gate_acquiring = gate.acquiring;
                state.is_gated = is_gated;
                state.connected = connected;
                state.paused = paused;
                state.manual_mode = manual_mode;
            }

            let telemetry_status = (connected, paused, manual_mode, is_gated, reason.clone());
            let telemetry_status_changed =
                last_telemetry_status.as_ref() != Some(&telemetry_status);
            let payload = TelemetryPayload {
                timestamp_ms: current_timestamp_ms(),
                momentary_lufs: momentary,
                short_term_lufs: short_term,
                integrated_lufs: integrated,
                true_peak_db: true_peak,
                true_peak_source,
                limiter_input_peak_db,
                limiter_input_peak_source,
                output_peak_db,
                output_peak_source,
                limiter_reduction_db,
                smoothed_lufs: ctx.smoothed_lufs,
                desired_gain_db,
                slow_gain_db,
                fast_gain_db,
                transient_cut_db,
                current_gain_db: ctx.current_gain_db,
                effective_max_gain_db: ctx.effective_max_gain_db,
                adaptive_gain_extra_db: (ctx.effective_max_gain_db - config.max_gain_db).max(0.0),
                adaptive_gain_state: ctx.adaptive_gain_state.clone(),
                gate_signal_lufs: gate.signal_lufs,
                gate_threshold_lufs: config.gate_threshold_lufs,
                gate_normalization_offset_db: gate.normalization_offset_db,
                gate_ambient_floor_lufs: gate.ambient_floor_lufs,
                gate_foreground_lufs: gate.foreground_lufs,
                gate_open_threshold_lufs: gate.open_threshold_lufs,
                gate_close_threshold_lufs: gate.close_threshold_lufs,
                gate_observed_range_lu: gate.observed_range_lu,
                gate_observed_secs: gate.observed_secs,
                gate_observation_window_secs: config.gate_observation_window_secs,
                gate_confidence: gate.confidence,
                gate_detector_ready: gate.detector_ready,
                gate_model_state: gate.model_state,
                gate_model_age_secs: gate.model_age_secs,
                gate_phase: gate.phase,
                adaptive_gate_enabled: config.adaptive_gate_enabled,
                adaptive_gate_mode: config.adaptive_gate_mode,
                subtitle_assist_enabled: config.subtitle_assist_enabled,
                subtitle_assist_active: gate.subtitle_assist_active,
                gate_detector_mode: config.gate_detector_mode,
                gate_acquiring: gate.acquiring,
                is_gated,
                connected,
                paused,
                manual_mode,
                reason,
            };
            if telemetry_status_changed || last_telemetry_emit.elapsed() >= refresh_interval {
                let _ = app_handle.emit("audio-normalizer://telemetry", &payload);
                last_telemetry_emit = Instant::now();
                last_telemetry_status = Some(telemetry_status);
            }
        }

        if let Some(h) = pipe {
            if FILTERS_INSTALLED.load(Ordering::SeqCst) {
                set_rider_gain(h, 0.0);
                remove_filters(h);
            }
            unsafe {
                let _ = CloseHandle(h);
            }
        }

        reset_shared_state(false);
        RESET_REQUESTED.store(false, Ordering::SeqCst);
        FILTERS_INSTALLED.store(false, Ordering::SeqCst);
        NORMALIZER_RUNNING.store(false, Ordering::SeqCst);

        info!("[Normalizer] Rider thread stopped");
    });

    *thread_slot = Some(thread);
}

pub fn stop_normalizer() {
    let thread = {
        let mut thread_slot = NORMALIZER_THREAD
            .lock()
            .expect("normalizer thread mutex poisoned");
        if NORMALIZER_RUNNING.swap(false, Ordering::SeqCst) {
            info!("[Normalizer] Stopping rider thread");
        }
        thread_slot.take()
    };

    if let Some(thread) = thread {
        let _ = thread.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_gate(signal_lufs: f64, foreground_lufs: f64) -> GateMeasurement {
        GateMeasurement {
            signal_lufs,
            normalization_offset_db: 0.0,
            ambient_floor_lufs: foreground_lufs - 12.0,
            foreground_lufs,
            open_threshold_lufs: foreground_lufs - 4.0,
            close_threshold_lufs: foreground_lufs - 7.0,
            observed_range_lu: 12.0,
            observed_secs: 10.0,
            confidence: 0.85,
            detector_ready: true,
            model_state: "direct".to_string(),
            model_age_secs: 0.0,
            phase: "open".to_string(),
            acquiring: false,
            is_gated: false,
            below_threshold: false,
            subtitle_assist_active: false,
        }
    }

    #[test]
    fn sanitize_config_enforces_safe_audio_and_timing_bounds() {
        let config = sanitize_config(NormalizerConfig {
            target_lufs: 20.0,
            max_gain_db: 100.0,
            max_cut_db: -200.0,
            attack_ms: 0.0,
            release_ms: 20_000.0,
            gate_observation_window_secs: 1.0,
            gate_threshold_lufs: -200.0,
            hold_ms: -1.0,
            refresh_interval_ms: 1.0,
            limiter_limit_db: 100.0,
            limiter_attack_ms: 0.0,
            limiter_release_ms: 0.0,
            adaptive_max_gain_limit_db: 100.0,
            ..NormalizerConfig::default()
        });

        assert_eq!(config.target_lufs, 0.0);
        assert_eq!(config.max_gain_db, 40.0);
        assert_eq!(config.max_cut_db, -80.0);
        assert_eq!(config.attack_ms, 1.0);
        assert_eq!(config.release_ms, 10_000.0);
        assert_eq!(config.gate_observation_window_secs, 5.0);
        assert_eq!(config.gate_threshold_lufs, -90.0);
        assert_eq!(config.hold_ms, 0.0);
        assert_eq!(config.refresh_interval_ms, 25.0);
        assert_eq!(config.limiter_limit_db, 0.0);
        assert_eq!(config.limiter_attack_ms, 0.1);
        assert_eq!(config.limiter_release_ms, 1.0);
        assert_eq!(config.adaptive_max_gain_limit_db, 48.0);

        let minimum_limiter = sanitize_config(NormalizerConfig {
            limiter_limit_db: -100.0,
            ..NormalizerConfig::default()
        });
        assert_eq!(
            minimum_limiter.limiter_limit_db,
            min_supported_limiter_limit_db()
        );
    }

    #[test]
    fn requested_limiter_is_required_for_normalizer_processing() {
        assert!(protection_filters_are_usable(true, false, false));
        assert!(protection_filters_are_usable(true, true, true));
        assert!(!protection_filters_are_usable(true, true, false));
        assert!(!protection_filters_are_usable(false, true, true));
    }

    #[test]
    fn adaptive_max_gain_uses_target_relative_integrated_loudness() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            adaptive_max_gain_enabled: true,
            adaptive_max_gain_limit_db: 40.0,
            limiter_enabled: true,
            limiter_limit_db: -5.0,
            target_lufs: -16.0,
            max_gain_db: 30.0,
            ..NormalizerConfig::default()
        };
        let mut ctx = RiderContext::new();

        for _ in 0..4 {
            update_adaptive_max_gain(&mut ctx, -24.0, &config, 1.0);
        }

        assert_eq!(ctx.effective_max_gain_db, 38.0);
        assert_eq!(ctx.adaptive_gain_state, "relative");
    }

    #[test]
    fn adaptive_max_gain_requires_valid_long_term_loudness_and_limiter() {
        let mut config = NormalizerConfig {
            adaptive_gate_enabled: true,
            adaptive_max_gain_enabled: true,
            limiter_enabled: true,
            max_gain_db: 30.0,
            ..NormalizerConfig::default()
        };
        let mut ctx = RiderContext::new();

        update_adaptive_max_gain(&mut ctx, -70.0, &config, 10.0);
        assert_eq!(ctx.effective_max_gain_db, 30.0);
        assert_eq!(ctx.adaptive_gain_state, "waiting_for_long_term");

        config.limiter_enabled = false;
        update_adaptive_max_gain(&mut ctx, -24.0, &config, 10.0);
        assert_eq!(ctx.effective_max_gain_db, 30.0);
        assert_eq!(ctx.adaptive_gain_state, "limiter_required");
    }

    #[test]
    fn adaptive_max_gain_is_independent_from_direct_or_stable_gate_learning() {
        for adaptive_gate_mode in [AdaptiveGateMode::Direct, AdaptiveGateMode::Stable] {
            let config = NormalizerConfig {
                adaptive_gate_enabled: true,
                adaptive_gate_mode,
                adaptive_max_gain_enabled: true,
                adaptive_max_gain_limit_db: 40.0,
                limiter_enabled: true,
                target_lufs: -16.0,
                max_gain_db: 30.0,
                ..NormalizerConfig::default()
            };
            let mut ctx = RiderContext::new();

            update_adaptive_max_gain(&mut ctx, -24.0, &config, 10.0);

            assert_eq!(ctx.effective_max_gain_db, 38.0);
            assert_eq!(ctx.adaptive_gain_state, "relative");
        }
    }

    #[test]
    fn adaptive_max_gain_respects_hard_ceiling_and_stays_relative_while_gated() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            adaptive_max_gain_enabled: true,
            adaptive_max_gain_limit_db: 40.0,
            limiter_enabled: true,
            limiter_limit_db: -5.0,
            target_lufs: -16.0,
            max_gain_db: 30.0,
            ..NormalizerConfig::default()
        };
        let open_gate = ready_gate(-55.0, -55.0);
        let mut closed_gate = open_gate.clone();
        closed_gate.signal_lufs = -70.0;
        closed_gate.is_gated = true;
        closed_gate.below_threshold = true;
        closed_gate.phase = "gated".to_string();
        let mut ctx = RiderContext::new();
        ctx.settling_until = None;

        update_adaptive_max_gain(&mut ctx, -40.0, &config, 10.0);
        ctx.slow_gain_db = ctx.effective_max_gain_db;
        ctx.current_gain_db = ctx.effective_max_gain_db;
        assert_eq!(ctx.current_gain_db, 40.0);
        assert_eq!(ctx.adaptive_gain_state, "hard_ceiling");

        compute_gain(
            &mut ctx,
            -70.0,
            -70.0,
            -40.0,
            -20.0,
            &closed_gate,
            &config,
            1.0,
        );
        assert_eq!(ctx.current_gain_db, 40.0);
        assert_eq!(ctx.adaptive_gain_state, "hard_ceiling");
    }

    #[test]
    fn built_in_presets_match_saved_custom_tuning_except_target_loudness() {
        let mut low = get_preset("light").expect("low preset should exist");
        let medium = get_preset("medium").expect("medium preset should exist");
        let mut high = get_preset("strong").expect("high preset should exist");

        assert!(medium.enabled);
        assert!(medium.slow_enabled);
        assert!(!medium.fast_enabled);
        assert!(!medium.transient_enabled);
        assert!(!medium.peak_ceiling_enabled);
        assert!(medium.limiter_enabled);
        assert_eq!(low.target_lufs, -18.0);
        assert_eq!(medium.target_lufs, -16.0);
        assert_eq!(high.target_lufs, -14.0);
        assert_eq!(medium.slow_control_mode, SlowControlMode::Momentary);
        assert_eq!(medium.response_mode, RiderResponseMode::DbPerSec);
        assert_eq!(medium.attack_db_per_sec, 24.0);
        assert_eq!(medium.release_db_per_sec, 2.0);
        assert_eq!(medium.fast_true_peak_threshold_db, -8.0);
        assert_eq!(medium.limiter_attack_ms, 1.0);
        assert_eq!(medium.limiter_release_ms, 5.0);
        assert!(medium.adaptive_gate_enabled);
        assert_eq!(medium.adaptive_gate_mode, AdaptiveGateMode::Stable);
        assert!(medium.adaptive_max_gain_enabled);
        assert_eq!(medium.adaptive_max_gain_limit_db, 48.0);
        assert!(medium.subtitle_assist_enabled);
        assert_eq!(medium.gate_detector_mode, GateDetectorMode::Momentary);
        assert_eq!(medium.gate_observation_window_secs, 30.0);
        assert_eq!(medium.gate_threshold_lufs, 0.0);
        assert_eq!(medium.refresh_interval_ms, 50.0);

        low.target_lufs = medium.target_lufs;
        high.target_lufs = medium.target_lufs;
        assert_eq!(
            serde_json::to_value(low).expect("low preset should serialize"),
            serde_json::to_value(&medium).expect("medium preset should serialize")
        );
        assert_eq!(
            serde_json::to_value(high).expect("high preset should serialize"),
            serde_json::to_value(medium).expect("medium preset should serialize")
        );
    }

    #[test]
    fn silence_gate_detector_is_independent_from_the_rider_detector() {
        let base = NormalizerConfig {
            adaptive_gate_enabled: false,
            slow_control_mode: SlowControlMode::Blended,
            gate_threshold_lufs: -40.0,
            hold_ms: 0.0,
            ..NormalizerConfig::default()
        };
        let momentary_config = NormalizerConfig {
            gate_detector_mode: GateDetectorMode::Momentary,
            ..base.clone()
        };
        let short_term_config = NormalizerConfig {
            gate_detector_mode: GateDetectorMode::ShortTerm,
            ..base
        };

        let mut momentary_detector = GateDetector::new();
        let momentary_gate =
            momentary_detector.measure(-50.0, -30.0, -30.0, &momentary_config, 0.2);
        let mut short_term_detector = GateDetector::new();
        let short_term_gate =
            short_term_detector.measure(-50.0, -30.0, -30.0, &short_term_config, 0.2);

        assert!(momentary_gate.is_gated);
        assert_eq!(momentary_gate.signal_lufs, -50.0);
        assert!(!short_term_gate.is_gated);
        assert_eq!(short_term_gate.signal_lufs, -30.0);
        assert_eq!(momentary_config.slow_control_mode, SlowControlMode::Blended);
        assert_eq!(
            short_term_config.slow_control_mode,
            SlowControlMode::Blended
        );
    }

    #[test]
    fn saved_config_without_new_gate_fields_uses_compatible_defaults() {
        let mut saved = serde_json::to_value(NormalizerConfig::default())
            .expect("default config should serialize");
        let saved = saved
            .as_object_mut()
            .expect("config should serialize as an object");
        saved.remove("adaptive_gate_mode");
        saved.remove("adaptive_max_gain_enabled");
        saved.remove("adaptive_max_gain_limit_db");
        saved.remove("subtitle_assist_enabled");
        saved.remove("gate_detector_mode");
        saved.remove("gate_observation_window_secs");

        let restored: NormalizerConfig =
            serde_json::from_value(serde_json::Value::Object(saved.clone()))
                .expect("legacy config should deserialize");

        assert_eq!(restored.adaptive_gate_mode, AdaptiveGateMode::Direct);
        assert!(!restored.adaptive_max_gain_enabled);
        assert_eq!(restored.adaptive_max_gain_limit_db, 40.0);
        assert!(!restored.subtitle_assist_enabled);
        assert_eq!(restored.gate_detector_mode, GateDetectorMode::ShortTerm);
        assert_eq!(restored.gate_observation_window_secs, 60.0);
    }

    #[test]
    fn adaptive_gate_reacts_the_same_to_loud_and_quiet_mastering() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            target_lufs: -16.0,
            gate_threshold_lufs: -34.0,
            hold_ms: 100.0,
            ..NormalizerConfig::default()
        };
        let mut loud = GateDetector::new();
        let mut quiet = GateDetector::new();

        for _ in 0..20 {
            let loud_gate = loud.measure(-16.0, -16.0, -16.0, &config, 0.2);
            let quiet_gate = quiet.measure(-28.0, -28.0, -28.0, &config, 0.2);
            assert_eq!(loud_gate.is_gated, quiet_gate.is_gated);
        }

        let mut loud_gate = loud.measure(-30.0, -30.0, -16.0, &config, 0.2);
        let mut quiet_gate = quiet.measure(-42.0, -42.0, -28.0, &config, 0.2);
        for _ in 0..30 {
            loud_gate = loud.measure(-30.0, -30.0, -16.0, &config, 0.2);
            quiet_gate = quiet.measure(-42.0, -42.0, -28.0, &config, 0.2);
            assert_eq!(loud_gate.is_gated, quiet_gate.is_gated);
        }
        assert!(
            loud_gate.is_gated,
            "loud-source ambience should close the gate"
        );
        assert!(
            quiet_gate.is_gated,
            "quiet-source ambience should close the gate"
        );

        for _ in 0..3 {
            loud_gate = loud.measure(-16.0, -16.0, -16.0, &config, 0.2);
            quiet_gate = quiet.measure(-28.0, -28.0, -28.0, &config, 0.2);
            assert_eq!(loud_gate.is_gated, quiet_gate.is_gated);
        }
        assert!(
            !loud_gate.is_gated,
            "loud foreground should reopen the gate"
        );
        assert!(
            !quiet_gate.is_gated,
            "quiet foreground should reopen the gate"
        );
        assert!(
            (quiet_gate.normalization_offset_db - loud_gate.normalization_offset_db - 12.0).abs()
                < 0.5
        );
    }

    #[test]
    fn adaptive_gate_keeps_fixed_mode_and_silence_floor_safe() {
        let fixed = NormalizerConfig {
            adaptive_gate_enabled: false,
            gate_threshold_lufs: -40.0,
            hold_ms: 0.0,
            ..NormalizerConfig::default()
        };
        let mut detector = GateDetector::new();
        let fixed_gate = detector.measure(-43.0, -43.0, -30.0, &fixed, 0.2);
        assert_eq!(fixed_gate.signal_lufs, -43.0);
        assert!(fixed_gate.is_gated);

        let adaptive = NormalizerConfig {
            adaptive_gate_enabled: true,
            hold_ms: 0.0,
            ..NormalizerConfig::default()
        };
        detector.reset();
        let silence = detector.measure(-70.0, -70.0, -30.0, &adaptive, 0.2);
        assert_eq!(silence.signal_lufs, -120.0);
        assert!(silence.is_gated);

        detector.reset();
        let acquiring = detector.measure(-50.0, -50.0, -70.0, &adaptive, 0.2);
        assert_eq!(acquiring.signal_lufs, -50.0);
        assert!(acquiring.acquiring);
        assert!(!acquiring.is_gated);
    }

    #[test]
    fn adaptive_gate_keeps_steady_foreground_open_without_a_learned_floor() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            target_lufs: -16.0,
            gate_threshold_lufs: -34.0,
            ..NormalizerConfig::default()
        };
        let mut detector = GateDetector::new();
        let mut measurement = detector.measure(-18.0, -18.0, -18.0, &config, 0.2);

        for _ in 0..300 {
            measurement = detector.measure(-18.0, -18.0, -18.0, &config, 0.2);
        }

        assert!(!measurement.is_gated);
        assert!(measurement.acquiring);
    }

    #[test]
    fn adaptive_gate_percentiles_ignore_isolated_peak_outliers() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            target_lufs: -16.0,
            gate_threshold_lufs: -34.0,
            ..NormalizerConfig::default()
        };
        let mut detector = GateDetector::new();

        for index in 0..80 {
            let loudness = if index % 2 == 0 { -48.0 } else { -24.0 };
            detector.measure(loudness, loudness, -30.0, &config, 0.1);
        }
        let before = detector
            .adaptive_model(&config)
            .expect("distribution should be available");
        detector.measure(0.0, 0.0, -30.0, &config, 0.1);
        let after = detector
            .adaptive_model(&config)
            .expect("distribution should remain available");

        assert!(before.detector_ready);
        assert!(after.detector_ready);
        assert!((after.ambient_floor_lufs - before.ambient_floor_lufs).abs() < 0.1);
        assert!((after.foreground_lufs - before.foreground_lufs).abs() < 0.1);
    }

    #[test]
    fn adaptive_gate_requires_a_non_overlapping_threshold_band() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            ..NormalizerConfig::default()
        };
        let mut detector = GateDetector::new();
        let mut measurement = detector.measure(-42.0, -42.0, -36.0, &config, 0.1);

        for index in 0..100 {
            let loudness = if index % 2 == 0 { -42.0 } else { -34.0 };
            measurement = detector.measure(loudness, loudness, -36.0, &config, 0.1);
        }
        let model = detector
            .adaptive_model(&config)
            .expect("distribution should be available");

        assert!(model.confidence >= ADAPTIVE_GATE_READY_CONFIDENCE);
        assert!(model.observed_range_lu < ADAPTIVE_GATE_MIN_RANGE_LU);
        assert!(!model.detector_ready);
        assert!(!measurement.is_gated);
        assert!(measurement.acquiring);
    }

    #[test]
    fn adaptive_gate_learning_never_blocks_valid_single_level_audio() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            gate_threshold_lufs: -25.0,
            hold_ms: 0.0,
            ..NormalizerConfig::default()
        };
        let mut detector = GateDetector::new();
        let mut measurement = detector.measure(-50.0, -50.0, -30.0, &config, 0.2);

        for _ in 0..100 {
            measurement = detector.measure(-50.0, -50.0, -30.0, &config, 0.2);
        }

        assert!(!measurement.detector_ready);
        assert!(measurement.acquiring);
        assert!(!measurement.is_gated);
        assert_eq!(measurement.signal_lufs, -50.0);
    }

    #[test]
    fn adaptive_gate_learning_uses_only_its_selected_detector() {
        let momentary_config = NormalizerConfig {
            adaptive_gate_enabled: true,
            gate_detector_mode: GateDetectorMode::Momentary,
            ..NormalizerConfig::default()
        };
        let short_term_config = NormalizerConfig {
            gate_detector_mode: GateDetectorMode::ShortTerm,
            ..momentary_config.clone()
        };
        let mut momentary_detector = GateDetector::new();
        let mut short_term_detector = GateDetector::new();

        for index in 0..100 {
            let momentary = if index % 2 == 0 { -55.0 } else { -25.0 };
            momentary_detector.measure(momentary, -35.0, -35.0, &momentary_config, 0.1);
            short_term_detector.measure(momentary, -35.0, -35.0, &short_term_config, 0.1);
        }

        let momentary_model = momentary_detector
            .adaptive_model(&momentary_config)
            .expect("momentary distribution should be available");
        let short_term_model = short_term_detector
            .adaptive_model(&short_term_config)
            .expect("short-term distribution should be available");

        assert!(momentary_model.detector_ready);
        assert!(momentary_model.observed_range_lu > 20.0);
        assert!(!short_term_model.detector_ready);
        assert_eq!(short_term_model.observed_range_lu, 0.0);
    }

    #[test]
    fn subtitle_assist_excludes_sdh_brackets_without_discarding_dialogue() {
        assert!(!subtitle_text_contains_dialogue("[DOOR SLAMS]"));
        assert!(!subtitle_text_contains_dialogue("[MUSIC]\n[WIND BLOWING]"));
        assert!(subtitle_text_contains_dialogue("[whispering] Don't go."));
        assert!(subtitle_text_contains_dialogue(
            "JOHN: [quietly] Stay here."
        ));
    }

    #[test]
    fn subtitle_assist_accepts_active_bitmap_events_without_ocr() {
        assert!(subtitle_event_should_assist(Some(""), true));
        assert!(subtitle_event_should_assist(None, true));
        assert!(!subtitle_event_should_assist(Some(""), false));
        assert!(!subtitle_event_should_assist(Some("[MUSIC]"), true));
        assert!(subtitle_event_should_assist(Some("Hello."), false));
    }

    #[test]
    fn subtitle_assist_release_hold_bridges_short_caption_gaps() {
        let mut ctx = RiderContext::new();

        assert!(ctx.update_subtitle_assist(true, true, 0.1));
        assert!(ctx.update_subtitle_assist(true, false, 0.5));
        assert!(!ctx.update_subtitle_assist(true, false, 0.3));
        assert!(!ctx.update_subtitle_assist(false, true, 0.1));
    }

    #[test]
    fn subtitle_assist_forces_the_gate_open_in_direct_and_stable_modes() {
        for adaptive_gate_mode in [AdaptiveGateMode::Direct, AdaptiveGateMode::Stable] {
            let config = NormalizerConfig {
                adaptive_gate_enabled: true,
                adaptive_gate_mode,
                hold_ms: 0.0,
                ..NormalizerConfig::default()
            };
            let mut detector = GateDetector::new();
            let mut gate = detector.measure(-70.0, -70.0, -70.0, &config, 0.1);
            assert!(gate.is_gated);

            detector.apply_subtitle_assist(&mut gate);

            assert!(!gate.is_gated);
            assert!(gate.subtitle_assist_active);
            assert_eq!(gate.phase, "subtitle");
        }
    }

    #[test]
    fn subtitle_assist_does_not_boost_a_silent_leading_caption() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            hold_ms: 0.0,
            ..NormalizerConfig::default()
        };
        let mut ctx = RiderContext::new();
        ctx.settling_until = None;
        ctx.current_gain_db = 4.0;
        let mut gate = ctx.gate_detector.measure(-70.0, -70.0, -70.0, &config, 0.1);
        ctx.gate_detector.apply_subtitle_assist(&mut gate);

        let (gain, desired, _, _, _, reason) =
            compute_gain(&mut ctx, -70.0, -70.0, -70.0, -70.0, &gate, &config, 0.1);

        assert_eq!(gain, 4.0);
        assert_eq!(desired, 4.0);
        assert_eq!(reason, "subtitle_wait");
    }

    #[test]
    fn adaptive_gate_direct_mode_expires_with_the_rolling_window() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            adaptive_gate_mode: AdaptiveGateMode::Direct,
            gate_observation_window_secs: 10.0,
            ..NormalizerConfig::default()
        };
        let mut detector = GateDetector::new();

        for index in 0..100 {
            let loudness = if index % 2 == 0 { -50.0 } else { -28.0 };
            detector.measure(loudness, loudness, -36.0, &config, 0.1);
        }

        let mut silence = detector.measure(-70.0, -70.0, -36.0, &config, 1.0);
        for _ in 0..10 {
            silence = detector.measure(-70.0, -70.0, -36.0, &config, 1.0);
        }

        assert!(detector.samples.is_empty());
        assert!(!silence.detector_ready);
        assert_eq!(silence.model_state, "learning");
        assert_eq!(silence.model_age_secs, 0.0);
    }

    #[test]
    fn adaptive_gate_holds_its_trusted_model_after_the_window_expires_in_silence() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            adaptive_gate_mode: AdaptiveGateMode::Stable,
            gate_observation_window_secs: 10.0,
            ..NormalizerConfig::default()
        };
        let mut detector = GateDetector::new();

        for index in 0..100 {
            let loudness = if index % 2 == 0 { -50.0 } else { -28.0 };
            detector.measure(loudness, loudness, -36.0, &config, 0.1);
        }
        assert!(detector
            .adaptive_model(&config)
            .is_some_and(|model| model.detector_ready));

        let mut silence = detector.measure(-70.0, -70.0, -36.0, &config, 1.0);
        for _ in 0..10 {
            silence = detector.measure(-70.0, -70.0, -36.0, &config, 1.0);
        }

        assert!(detector.samples.is_empty());
        assert!(detector.adaptive_model(&config).is_none());
        assert_eq!(silence.observed_secs, 0.0);
        assert_eq!(silence.confidence, 0.0);
        assert!(silence.detector_ready);
        assert_eq!(silence.model_state, "held");
        assert!(silence.model_age_secs > 0.0);
    }

    #[test]
    fn adaptive_gate_degrades_only_after_a_sustained_low_quality_window() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            adaptive_gate_mode: AdaptiveGateMode::Stable,
            gate_observation_window_secs: 5.0,
            ..NormalizerConfig::default()
        };
        let mut detector = GateDetector::new();
        let mut measurement = detector.measure(-50.0, -50.0, -36.0, &config, 0.1);

        for index in 0..100 {
            let loudness = if index % 2 == 0 { -50.0 } else { -28.0 };
            measurement = detector.measure(loudness, loudness, -36.0, &config, 0.1);
        }
        assert!(measurement.detector_ready);
        assert!(matches!(
            measurement.model_state.as_str(),
            "stable" | "adapting"
        ));

        for _ in 0..90 {
            measurement = detector.measure(-28.0, -28.0, -28.0, &config, 0.1);
        }
        assert_eq!(measurement.model_state, "held");
        assert!(measurement.detector_ready);

        for _ in 0..110 {
            measurement = detector.measure(-28.0, -28.0, -28.0, &config, 0.1);
        }
        assert_eq!(measurement.model_state, "degraded");
        assert!(measurement.detector_ready);
    }

    #[test]
    fn adaptive_thresholds_move_down_faster_than_up() {
        let downward = smooth_adaptive_value(-30.0, -40.0, 1.0);
        let upward = smooth_adaptive_value(-40.0, -30.0, 1.0);

        assert!((-30.0 - downward).abs() > (upward - -40.0).abs());
    }

    #[test]
    fn exponential_smoothing_is_refresh_rate_independent() {
        let mut coarse = 0.0;
        for _ in 0..5 {
            coarse += exponential_smoothing_alpha(0.2, 0.55) * (1.0 - coarse);
        }

        let mut fine = 0.0;
        for _ in 0..40 {
            fine += exponential_smoothing_alpha(0.025, 0.55) * (1.0 - fine);
        }

        assert!((coarse - fine).abs() < 1e-12);
    }

    #[test]
    fn gain_telemetry_separates_requested_and_applied_gain() {
        let config = NormalizerConfig {
            target_lufs: -10.0,
            adaptive_gate_enabled: false,
            gate_threshold_lufs: -40.0,
            ..NormalizerConfig::default()
        };
        let mut ctx = RiderContext::new();
        ctx.settling_until = None;
        let gate = ctx.gate_detector.measure(-30.0, -30.0, -30.0, &config, 0.2);

        let (applied, desired, _, _, _, reason) =
            compute_gain(&mut ctx, -30.0, -30.0, -30.0, -20.0, &gate, &config, 0.2);

        assert!((desired - 20.0).abs() < 1e-9);
        assert!((applied - 1.2).abs() < 1e-9);
        assert_eq!(reason, "boosting");
    }

    #[test]
    fn adaptive_gate_reports_high_confidence_for_stable_separated_levels() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            ..NormalizerConfig::default()
        };
        let mut detector = GateDetector::new();

        for index in 0..100 {
            let loudness = if index % 2 == 0 { -50.0 } else { -28.0 };
            detector.measure(loudness, loudness, -36.0, &config, 0.1);
        }
        let model = detector
            .adaptive_model(&config)
            .expect("distribution should be available");

        assert!(model.detector_ready);
        assert!(model.confidence > 0.9);
        assert!(
            model.open_threshold_lufs >= model.ambient_floor_lufs + ADAPTIVE_GATE_AMBIENT_MARGIN_LU
        );
        assert!(
            model.open_threshold_lufs <= model.foreground_lufs - ADAPTIVE_GATE_FOREGROUND_MARGIN_LU
        );
    }

    #[test]
    fn adaptive_gate_accepts_a_stable_nine_lu_separation() {
        let config = NormalizerConfig {
            adaptive_gate_enabled: true,
            ..NormalizerConfig::default()
        };
        let mut detector = GateDetector::new();

        for index in 0..100 {
            let loudness = if index % 2 == 0 { -50.0 } else { -41.0 };
            detector.measure(loudness, loudness, -45.0, &config, 0.1);
        }

        let model = detector
            .adaptive_model(&config)
            .expect("distribution should be available");

        assert!((model.observed_range_lu - ADAPTIVE_GATE_MIN_RANGE_LU).abs() < 0.1);
        assert!(model.confidence >= ADAPTIVE_GATE_READY_CONFIDENCE);
        assert!(model.detector_ready);
    }
}

fn current_timestamp_ms() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}
