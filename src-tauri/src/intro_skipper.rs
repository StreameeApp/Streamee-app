use crate::introdb::IntroDbSegment;
use crate::mpv_ipc::MpvChapter;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::{info, warn};

#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

const MAX_ANALYSIS_SECONDS: f64 = 7.0 * 60.0;
const MIN_ANALYSIS_SECONDS: f64 = 60.0;
const SECONDARY_INTRO_OVERLAP_SECONDS: u64 = 60;
const MIN_OUTRO_ANALYSIS_SECONDS: f64 = 2.0 * 60.0;
const MAX_OUTRO_ANALYSIS_SECONDS: f64 = 12.0 * 60.0;
const MIN_OUTRO_MATCH_SECONDS: f64 = 10.0;
const MIN_CHAPTER_OUTRO_LEAD_SECONDS: f64 = 10.0;
const MIN_INTRO_SECONDS: f64 = 15.0;
const MIN_FUZZY_INTRO_SECONDS: f64 = 25.0;
const MIN_FEEDBACK_INTRO_SECONDS: f64 = 10.0;
const MIN_FEEDBACK_OUTRO_SECONDS: f64 = 5.0;
const MAX_INTRO_SECONDS: f64 = 2.0 * 60.0;
const SAMPLE_DURATION_SECONDS: f64 = 4096.0 / 11025.0 / 3.0;
const MAX_POINT_BIT_DIFFERENCES: u32 = 6;
const MAX_MATCH_GAP_POINTS: usize = 16;
const MIN_MATCH_DENSITY: f64 = 0.65;
const FUZZY_MAX_MEAN_BIT_DIFFERENCES: f64 = 12.0;
const FUZZY_CLOSE_POINT_BIT_DIFFERENCES: u32 = 14;
const FUZZY_MIN_CLOSE_POINT_DENSITY: f64 = 0.75;
const FUZZY_MIN_ALIGNED_CONTEXT_SECONDS: f64 = 60.0;
const FPCALC_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_MEMORY_FINGERPRINTS: usize = 24;
const MAX_PERSISTED_FINGERPRINTS: usize = 24;
const FINGERPRINT_CACHE_VERSION: u32 = 4;
const LOCAL_CACHE_NOT_READY: &str = "Intro Skipper local cache is not ready";
const LOCAL_AUDIO_CACHE_NOT_READY: &str = "Intro Skipper selected-audio cache is not ready";
const OUTRO_FINGERPRINT_CACHE_VERSION: u32 = 3;
const FINGERPRINT_CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const VISUAL_OUTRO_SAMPLE_FPS: f64 = 2.0;
const VISUAL_OUTRO_MIN_SECONDS: f64 = 10.0;
const VISUAL_OUTRO_MAX_GAP_SECONDS: f64 = 2.0;
const VISUAL_OUTRO_MIN_BLACK_PERCENT: f64 = 82.0;
const VISUAL_OUTRO_CONTENT_BLACK_CEILING: f64 = 99.8;
const VISUAL_OUTRO_MIN_DARK_DENSITY: f64 = 0.85;
const VISUAL_OUTRO_MIN_CONTENT_DENSITY: f64 = 0.20;
const VISUAL_OUTRO_AUTO_MIN_SECONDS: f64 = 20.0;
const VISUAL_OUTRO_AUTO_MIN_DARK_DENSITY: f64 = 0.90;
const VISUAL_OUTRO_AUTO_MIN_CONTENT_DENSITY: f64 = 0.50;
const VISUAL_OUTRO_AUTO_MIN_MEAN_BLACK_PERCENT: f64 = 90.0;
const VISUAL_OUTRO_AUTO_END_TOLERANCE_SECONDS: f64 = 2.0;

static FINGERPRINT_CACHE: Lazy<Mutex<HashMap<String, Arc<Vec<u32>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SEASON_CACHE_WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static VISUAL_OUTRO_DIAGNOSTICS: Lazy<Mutex<HashSet<String>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));

#[derive(Debug, Deserialize)]
struct FpcalcOutput {
    fingerprint: Vec<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IntroMatchMethod {
    Exact,
    Fuzzy,
}

impl IntroMatchMethod {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Fuzzy => "fuzzy",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct MatchedRange {
    start: f64,
    end: f64,
    reference_start: f64,
    reference_end: f64,
    method: IntroMatchMethod,
    exact_density: f64,
    mean_bit_difference: f64,
    close_point_density: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct VisualCreditCandidate {
    start_seconds: f64,
    end_seconds: f64,
    dark_density: f64,
    content_density: f64,
    mean_black_percent: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct VisualOutroDiagnostic {
    candidate: Option<VisualCreditCandidate>,
    sampled_frames: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CachedEpisodeFingerprint {
    episode: u32,
    source_identity: String,
    audio_identity: String,
    duration_seconds: f64,
    #[serde(default)]
    window_start_seconds: f64,
    #[serde(default = "default_intro_analysis_part")]
    analysis_part: u8,
    points: Vec<u32>,
}

const fn default_intro_analysis_part() -> u8 {
    1
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SeasonFingerprintCache {
    version: u32,
    episodes: Vec<CachedEpisodeFingerprint>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CachedEpisodeOutroFingerprint {
    episode: u32,
    source_identity: String,
    audio_identity: String,
    duration_seconds: f64,
    window_start_seconds: f64,
    points: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SeasonOutroFingerprintCache {
    version: u32,
    episodes: Vec<CachedEpisodeOutroFingerprint>,
}

impl Default for SeasonOutroFingerprintCache {
    fn default() -> Self {
        Self {
            version: OUTRO_FINGERPRINT_CACHE_VERSION,
            episodes: Vec::new(),
        }
    }
}

impl Default for SeasonFingerprintCache {
    fn default() -> Self {
        Self {
            version: FINGERPRINT_CACHE_VERSION,
            episodes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SegmentFeedbackCandidate {
    pub kind: String,
    pub start_sec: f64,
    pub end_sec: f64,
    pub source: String,
    pub reason: String,
    pub score: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct IntroSkipperDetectionResult {
    pub segment: Option<IntroDbSegment>,
    pub candidate: Option<SegmentFeedbackCandidate>,
    pub status: String,
    pub reference_episode: Option<u32>,
    pub reference_end_sec: Option<f64>,
    pub cached_episode_count: usize,
    pub buffered_seconds: f64,
    pub required_buffer_seconds: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct PlayerChapterSegments {
    pub intro: Option<IntroDbSegment>,
    pub recap: Option<IntroDbSegment>,
    pub outro: Option<IntroDbSegment>,
    pub candidate: Option<SegmentFeedbackCandidate>,
    pub chapter_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ChapterKind {
    Intro,
    Recap,
    Outro,
}

fn resolve_fpcalc_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("fpcalc.exe"));
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/fpcalc.exe"));

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "The packaged Intro Skipper fingerprint runtime is missing".to_string())
}

fn validate_media_source(source: &str) -> Result<(), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() || trimmed.len() > 8_192 {
        return Err("Invalid Intro Skipper media source".to_string());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let url = reqwest::Url::parse(trimmed)
            .map_err(|_| "Invalid Intro Skipper media stream URL".to_string())?;
        let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
        return (url.scheme() == "http" && loopback)
            .then_some(())
            .ok_or_else(|| "Intro Skipper only analyzes Streamee loopback streams".to_string());
    }
    if Path::new(trimmed).is_file() {
        return Ok(());
    }
    Err("Intro Skipper only analyzes local files and HTTP media streams".to_string())
}

fn validate_series_key(series_key: &str) -> Result<(), String> {
    let valid = !series_key.is_empty()
        && series_key.len() <= 128
        && series_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_'));
    valid
        .then_some(())
        .ok_or_else(|| "Invalid Intro Skipper series identity".to_string())
}

fn fingerprint_source_identity(source_identity: &str, current_url: &str) -> Result<String, String> {
    if source_identity.len() > 8_192 {
        return Err("Invalid Intro Skipper source identity".to_string());
    }
    let normalized = if source_identity.trim().is_empty() {
        current_url.trim()
    } else {
        source_identity.trim()
    }
    .replace('\\', "/")
    .to_ascii_lowercase();
    let mut digest = Sha1::new();
    digest.update(normalized.as_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn source_durations_compatible(current: f64, reference: f64) -> bool {
    if !current.is_finite() || !reference.is_finite() || current <= 0.0 || reference <= 0.0 {
        return false;
    }
    (current - reference).abs() <= (current.max(reference) * 0.15).max(180.0)
}

fn audio_identity_language(identity: &str) -> Option<&str> {
    let language = identity
        .split('|')
        .find_map(|component| component.strip_prefix("lang="))?
        .trim();
    (!language.is_empty() && !matches!(language, "und" | "unknown" | "mul" | "zxx"))
        .then_some(language)
}

fn audio_identities_compatible(current: &str, reference: &str) -> bool {
    current == reference
        || matches!(
            (
                audio_identity_language(current),
                audio_identity_language(reference)
            ),
            (Some(current_language), Some(reference_language))
                if current_language == reference_language
        )
}

fn fingerprint_has_enough_detail(points: &[u32]) -> bool {
    if points.len() < (MIN_INTRO_SECONDS / SAMPLE_DURATION_SECONDS) as usize {
        return false;
    }
    let unique = points.iter().copied().collect::<HashSet<_>>().len();
    unique >= 24 && unique as f64 / points.len() as f64 >= 0.01
}

fn fingerprint_covers_analysis_window(points: &[u32], analysis_seconds: u64) -> bool {
    let expected_points = analysis_seconds as f64 / SAMPLE_DURATION_SECONDS;
    points.len() as f64 >= expected_points * 0.9
}

async fn fingerprint_media(
    fpcalc_path: &Path,
    source: &str,
    analysis_seconds: u64,
) -> Result<Arc<Vec<u32>>, String> {
    let key = format!("{analysis_seconds}:{source}");
    if let Some(cached) = FINGERPRINT_CACHE.lock().get(&key).cloned() {
        return Ok(cached);
    }

    let output = timeout(
        FPCALC_TIMEOUT,
        run_fpcalc(fpcalc_path, source, analysis_seconds),
    )
    .await
    .map_err(|_| "Intro Skipper fingerprinting timed out".to_string())??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Intro Skipper fingerprinting failed: {}",
            stderr.trim().chars().take(300).collect::<String>()
        ));
    }

    let parsed = serde_json::from_slice::<FpcalcOutput>(&output.stdout)
        .map_err(|error| format!("Invalid Intro Skipper fingerprint output: {error}"))?;
    if !fingerprint_covers_analysis_window(&parsed.fingerprint, analysis_seconds) {
        return Err(LOCAL_CACHE_NOT_READY.to_string());
    }
    if !fingerprint_has_enough_detail(&parsed.fingerprint) {
        return Err("Intro Skipper fingerprint did not contain enough audio detail".to_string());
    }

    let fingerprint = Arc::new(parsed.fingerprint);
    let mut cache = FINGERPRINT_CACHE.lock();
    if cache.len() >= MAX_MEMORY_FINGERPRINTS {
        cache.clear();
    }
    cache.insert(key, fingerprint.clone());
    Ok(fingerprint)
}

async fn run_fpcalc(
    fpcalc_path: &Path,
    source: &str,
    analysis_seconds: u64,
) -> Result<std::process::Output, String> {
    let is_http_stream = source.starts_with("http://") || source.starts_with("https://");
    let mut command = Command::new(fpcalc_path);
    command.args([
        "-raw",
        "-json",
        "-algorithm",
        "2",
        "-length",
        &analysis_seconds.to_string(),
        if is_http_stream { "-" } else { source },
    ]);
    command
        .stdin(if is_http_stream {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW.0);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Intro Skipper fingerprinting: {error}"))?;
    if is_http_stream {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| {
                format!("Could not initialize Intro Skipper stream bridge: {error}")
            })?;
        let mut response = client
            .get(source)
            .header(reqwest::header::RANGE, "bytes=0-")
            .header("x-streamee-cache-only", "1")
            .send()
            .await
            .map_err(|error| format!("Could not open the current Streamee stream: {error}"))?;
        if response.status().as_u16() == 425 {
            return Err(LOCAL_CACHE_NOT_READY.to_string());
        }
        if !response.status().is_success() {
            return Err(format!(
                "Current Streamee stream returned HTTP {}",
                response.status().as_u16()
            ));
        }
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Could not open Intro Skipper fingerprint input".to_string())?;
        let feed_input =
            async move {
                while let Some(chunk) = response.chunk().await.map_err(|error| {
                    format!("Could not read the current Streamee stream: {error}")
                })? {
                    if let Err(error) = stdin.write_all(&chunk).await {
                        if error.kind() == std::io::ErrorKind::BrokenPipe {
                            break;
                        }
                        return Err(format!(
                            "Could not feed Intro Skipper fingerprinting: {error}"
                        ));
                    }
                }
                drop(stdin);
                Ok::<(), String>(())
            };
        let (feed_result, output_result) = tokio::join!(feed_input, child.wait_with_output());
        feed_result?;
        return output_result
            .map_err(|error| format!("Could not finish Intro Skipper fingerprinting: {error}"));
    }

    child
        .wait_with_output()
        .await
        .map_err(|error| format!("Could not finish Intro Skipper fingerprinting: {error}"))
}

fn outro_analysis_seconds(duration_seconds: f64) -> u64 {
    let duration_limit = (duration_seconds * 0.45).max(MIN_OUTRO_MATCH_SECONDS);
    (duration_seconds * 0.25)
        .clamp(MIN_OUTRO_ANALYSIS_SECONDS, MAX_OUTRO_ANALYSIS_SECONDS)
        .min(duration_limit)
        .round() as u64
}

fn intro_analysis_seconds(duration_seconds: f64) -> u64 {
    (duration_seconds * 0.25)
        .clamp(MIN_ANALYSIS_SECONDS, MAX_ANALYSIS_SECONDS)
        .round() as u64
}

fn intro_analysis_window(duration_seconds: f64, analysis_part: u8) -> Option<(f64, u64)> {
    let analysis_seconds = intro_analysis_seconds(duration_seconds);
    let window_start_seconds = match analysis_part {
        1 => 0,
        2 => analysis_seconds
            .saturating_sub(SECONDARY_INTRO_OVERLAP_SECONDS.min(analysis_seconds / 2)),
        _ => return None,
    };
    let available_seconds = duration_seconds.floor().max(0.0) as u64;
    let analysis_seconds =
        analysis_seconds.min(available_seconds.saturating_sub(window_start_seconds));
    (analysis_seconds >= MIN_INTRO_SECONDS.round() as u64)
        .then_some((window_start_seconds as f64, analysis_seconds))
}

fn cache_window_buffered_seconds(
    status: &crate::FingerprintCacheWindowStatus,
    required_buffer_seconds: f64,
) -> f64 {
    if status.required_bytes == 0 || status.covered_bytes >= status.required_bytes {
        return required_buffer_seconds;
    }
    required_buffer_seconds * status.covered_bytes as f64 / status.required_bytes as f64
}

fn opening_cache_buffered_seconds(
    status: Option<&crate::FingerprintCacheWindowStatus>,
    player_buffered_seconds: Option<f64>,
    required_buffer_seconds: f64,
) -> f64 {
    let byte_estimate = status
        .map(|status| cache_window_buffered_seconds(status, required_buffer_seconds))
        .unwrap_or(0.0);
    let timestamp_coverage = player_buffered_seconds
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .unwrap_or(0.0);
    byte_estimate
        .max(timestamp_coverage)
        .min(required_buffer_seconds)
}

fn audio_extraction_timeout(analysis_seconds: u64) -> Duration {
    Duration::from_secs((120 + analysis_seconds / 4).min(5 * 60))
}

fn cache_only_media_source(source: &str) -> Result<String, String> {
    if !(source.starts_with("http://") || source.starts_with("https://")) {
        return Ok(source.to_string());
    }
    let mut url = reqwest::Url::parse(source)
        .map_err(|error| format!("Invalid Intro Skipper stream URL: {error}"))?;
    url.query_pairs_mut()
        .append_pair("streamee-cache-only", "1");
    Ok(url.to_string())
}

fn parse_blackframe_percent(line: &str) -> Option<f64> {
    let value = line
        .split_once("pblack:")?
        .1
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()?;
    (value.is_finite() && (0.0..=100.0).contains(&value)).then_some(value)
}

fn parse_blackframe_sample(line: &str) -> Option<(usize, f64)> {
    let frame = line
        .split_once("frame:")?
        .1
        .split_whitespace()
        .next()?
        .parse::<usize>()
        .ok()?;
    Some((frame, parse_blackframe_percent(line)?))
}

fn collect_blackframe_percentages(stderr: &str) -> Vec<f64> {
    let mut percentages = Vec::new();
    for (frame, black_percent) in stderr.lines().filter_map(parse_blackframe_sample) {
        if frame >= percentages.len() {
            percentages.resize(frame + 1, 0.0);
        }
        percentages[frame] = black_percent;
    }
    percentages
}

fn find_visual_credit_candidate(
    black_percentages: &[f64],
    window_start_seconds: f64,
    duration_seconds: f64,
) -> Option<VisualCreditCandidate> {
    let max_gap_frames = (VISUAL_OUTRO_MAX_GAP_SECONDS * VISUAL_OUTRO_SAMPLE_FPS) as usize;
    let mut best = None;
    let mut run_start = None;
    let mut last_dark = 0usize;
    let mut dark_frames = 0usize;
    let mut content_frames = 0usize;
    let mut black_sum = 0.0;

    let consider_run = |start: usize,
                        end: usize,
                        dark_frames: usize,
                        content_frames: usize,
                        black_sum: f64,
                        best: &mut Option<VisualCreditCandidate>| {
        let total_frames = end.saturating_sub(start) + 1;
        if total_frames == 0 || dark_frames == 0 {
            return;
        }
        let span_seconds = total_frames as f64 / VISUAL_OUTRO_SAMPLE_FPS;
        let dark_density = dark_frames as f64 / total_frames as f64;
        let content_density = content_frames as f64 / dark_frames as f64;
        let start_seconds = window_start_seconds + start as f64 / VISUAL_OUTRO_SAMPLE_FPS;
        let end_seconds = (window_start_seconds + (end + 1) as f64 / VISUAL_OUTRO_SAMPLE_FPS)
            .min(duration_seconds);
        if span_seconds < VISUAL_OUTRO_MIN_SECONDS
            || dark_density < VISUAL_OUTRO_MIN_DARK_DENSITY
            || content_density < VISUAL_OUTRO_MIN_CONTENT_DENSITY
            || start_seconds < duration_seconds * 0.55
        {
            return;
        }
        let candidate = VisualCreditCandidate {
            start_seconds,
            end_seconds,
            dark_density,
            content_density,
            mean_black_percent: black_sum / dark_frames as f64,
        };
        if best.is_none_or(|existing| {
            let candidate_span = candidate.end_seconds - candidate.start_seconds;
            let existing_span = existing.end_seconds - existing.start_seconds;
            candidate_span > existing_span
                || ((candidate_span - existing_span).abs() < 0.5
                    && candidate.start_seconds < existing.start_seconds)
        }) {
            *best = Some(candidate);
        }
    };

    for (index, black_percent) in black_percentages.iter().copied().enumerate() {
        if black_percent >= VISUAL_OUTRO_MIN_BLACK_PERCENT {
            if run_start.is_none() {
                run_start = Some(index);
                dark_frames = 0;
                content_frames = 0;
                black_sum = 0.0;
            }
            last_dark = index;
            dark_frames += 1;
            content_frames += usize::from(black_percent < VISUAL_OUTRO_CONTENT_BLACK_CEILING);
            black_sum += black_percent;
        } else if let Some(start) = run_start {
            if index.saturating_sub(last_dark) > max_gap_frames {
                consider_run(
                    start,
                    last_dark,
                    dark_frames,
                    content_frames,
                    black_sum,
                    &mut best,
                );
                run_start = None;
                dark_frames = 0;
                content_frames = 0;
                black_sum = 0.0;
            }
        }
    }
    if let Some(start) = run_start {
        consider_run(
            start,
            last_dark,
            dark_frames,
            content_frames,
            black_sum,
            &mut best,
        );
    }
    best
}

fn visual_outro_fallback_segment(
    candidate: VisualCreditCandidate,
    duration_seconds: f64,
) -> Option<IntroDbSegment> {
    let span_seconds = candidate.end_seconds - candidate.start_seconds;
    (duration_seconds.is_finite()
        && duration_seconds > 0.0
        && span_seconds >= VISUAL_OUTRO_AUTO_MIN_SECONDS
        && candidate.dark_density >= VISUAL_OUTRO_AUTO_MIN_DARK_DENSITY
        && candidate.content_density >= VISUAL_OUTRO_AUTO_MIN_CONTENT_DENSITY
        && candidate.mean_black_percent >= VISUAL_OUTRO_AUTO_MIN_MEAN_BLACK_PERCENT
        && candidate.start_seconds >= duration_seconds * 0.55
        && candidate.end_seconds >= duration_seconds - VISUAL_OUTRO_AUTO_END_TOLERANCE_SECONDS)
        .then(|| {
            segment_from_range(
                candidate.start_seconds,
                duration_seconds,
                "intro-skipper-outro",
            )
        })
        .flatten()
}

async fn detect_visual_outro_diagnostic(
    app: &tauri::AppHandle,
    source: &str,
    window_start_seconds: f64,
    analysis_seconds: u64,
    duration_seconds: f64,
) -> Result<VisualOutroDiagnostic, String> {
    let mpv_path = crate::find_mpv(app)
        .ok_or_else(|| "MPV is required for visual outro diagnostics".to_string())?;
    let cache_only_source = cache_only_media_source(source)?;
    let mut command = Command::new(mpv_path);
    command
        .args([
            "--no-config",
            "--terminal=yes",
            "--msg-level=all=no,ffmpeg=trace",
            "--audio=no",
            "--audio-file-auto=no",
            "--sub=no",
            "--sub-auto=no",
            "--ytdl=no",
            "--untimed=yes",
            "--hwdec=no",
            "--vo=null",
            "--vf=lavfi=[fps=2,scale=320:-2,blackframe=amount=1:threshold=32]",
        ])
        .arg(format!("--start={window_start_seconds:.3}"))
        .arg(format!("--length={analysis_seconds}"))
        .arg(cache_only_source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW.0);

    let output = timeout(audio_extraction_timeout(analysis_seconds), command.output())
        .await
        .map_err(|_| "Visual outro diagnostic timed out".to_string())?
        .map_err(|error| format!("Could not start visual outro diagnostic: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "Visual outro diagnostic failed: status={}, stdout_bytes={}, stderr_bytes={}",
            output.status,
            output.stdout.len(),
            output.stderr.len()
        ));
    }
    let black_percentages = collect_blackframe_percentages(&format!("{stdout}\n{stderr}"));
    if black_percentages.is_empty() {
        return Err(format!(
            "Visual outro diagnostic produced no frame samples: stdout_bytes={}, stderr_bytes={}",
            output.stdout.len(),
            output.stderr.len()
        ));
    }
    Ok(VisualOutroDiagnostic {
        candidate: find_visual_credit_candidate(
            &black_percentages,
            window_start_seconds,
            duration_seconds,
        ),
        sampled_frames: black_percentages.len(),
    })
}

fn schedule_visual_outro_diagnostic(
    app: tauri::AppHandle,
    series_key: &str,
    season: u32,
    episode: u32,
    source: &str,
    window_start_seconds: f64,
    analysis_seconds: u64,
    duration_seconds: f64,
) {
    let mut digest = Sha1::new();
    digest.update(source.as_bytes());
    let diagnostic_key = format!("{series_key}:{season}:{episode}:{:x}", digest.finalize());
    {
        let mut diagnostics = VISUAL_OUTRO_DIAGNOSTICS.lock();
        if diagnostics.len() >= MAX_MEMORY_FINGERPRINTS {
            diagnostics.clear();
        }
        if !diagnostics.insert(diagnostic_key.clone()) {
            return;
        }
    }
    let source = source.to_string();
    info!(
        "[Segment Detection][Local][Outro][Visual] Diagnostic scheduled: window_start={:.1}s, analysis_window={:.1}s, season={}, episode={}",
        window_start_seconds, analysis_seconds, season, episode
    );
    tokio::spawn(async move {
        match detect_visual_outro_diagnostic(
            &app,
            &source,
            window_start_seconds,
            analysis_seconds,
            duration_seconds,
        )
        .await
        {
            Ok(VisualOutroDiagnostic {
                candidate: Some(candidate),
                sampled_frames,
            }) => info!(
                "[Segment Detection][Local][Outro][Visual] Diagnostic complete: status=candidate, start={:.3}, end={:.3}, span={:.1}s, dark_density={:.3}, content_density={:.3}, mean_black={:.1}, sampled_frames={}, season={}, episode={}",
                candidate.start_seconds,
                candidate.end_seconds,
                candidate.end_seconds - candidate.start_seconds,
                candidate.dark_density,
                candidate.content_density,
                candidate.mean_black_percent,
                sampled_frames,
                season,
                episode
            ),
            Ok(VisualOutroDiagnostic {
                candidate: None,
                sampled_frames,
            }) => info!(
                "[Segment Detection][Local][Outro][Visual] Diagnostic complete: status=no-candidate, sampled_frames={}, season={}, episode={}",
                sampled_frames, season, episode
            ),
            Err(error) => {
                VISUAL_OUTRO_DIAGNOSTICS.lock().remove(&diagnostic_key);
                warn!(
                    "[Segment Detection][Local][Outro][Visual] Diagnostic failed: season={}, episode={}, error={}",
                    season, episode, error
                );
            }
        }
    });
}

async fn extract_selected_audio(
    app: &tauri::AppHandle,
    source: &str,
    start_seconds: f64,
    analysis_seconds: u64,
    audio_track_id: i64,
) -> Result<PathBuf, String> {
    let mpv_path = crate::find_mpv(app)
        .ok_or_else(|| "MPV is required for Intro Skipper audio extraction".to_string())?;
    let output_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve Intro Skipper audio work folder: {error}"))?
        .join("intro-skipper")
        .join("audio-work");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("Could not create Intro Skipper audio work folder: {error}"))?;
    let mut digest = Sha1::new();
    digest.update(source.as_bytes());
    digest.update(start_seconds.to_le_bytes());
    let identity = format!("{:x}", digest.finalize());
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let output_path = output_dir.join(format!("{identity}-{nonce}.wav"));
    let cache_only_source = cache_only_media_source(source)?;

    let mut command = Command::new(mpv_path);
    command
        .args([
            "--no-config",
            "--terminal=yes",
            "--msg-level=all=warn",
            "--vid=no",
            "--audio-display=no",
            "--audio-file-auto=no",
            "--sub-auto=no",
            "--ytdl=no",
            "--untimed=yes",
            "--ao=pcm",
            "--ao-pcm-waveheader=yes",
            "--audio-format=s16",
            "--audio-samplerate=11025",
            "--audio-channels=mono",
        ])
        .arg(format!("--ao-pcm-file={}", output_path.to_string_lossy()))
        .arg(format!("--start={start_seconds:.3}"))
        .arg(format!("--length={analysis_seconds}"))
        .arg(format!("--aid={audio_track_id}"))
        .arg(cache_only_source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW.0);

    let output = match timeout(audio_extraction_timeout(analysis_seconds), command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            let _ = fs::remove_file(&output_path);
            return Err(format!(
                "Could not start Intro Skipper audio extraction: {error}"
            ));
        }
        Err(_) => {
            let _ = fs::remove_file(&output_path);
            return Err("Intro Skipper audio extraction timed out".to_string());
        }
    };
    if !output.status.success() {
        let _ = fs::remove_file(&output_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Intro Skipper audio extraction failed: {}",
            stderr.trim().chars().take(500).collect::<String>()
        ));
    }
    let output_size = fs::metadata(&output_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if output_size <= 44 {
        let _ = fs::remove_file(&output_path);
        return Err(LOCAL_AUDIO_CACHE_NOT_READY.to_string());
    }
    Ok(output_path)
}

fn candidate_shifts(lhs: &[u32], rhs: &[u32]) -> Vec<i32> {
    let mut rhs_positions = HashMap::<u32, Vec<usize>>::new();
    for (index, point) in rhs.iter().copied().enumerate() {
        let positions = rhs_positions.entry(point).or_default();
        if positions.len() < 8 {
            positions.push(index);
        }
    }

    let mut shift_counts = HashMap::<i32, usize>::new();
    for (lhs_index, point) in lhs.iter().copied().enumerate().step_by(2) {
        if let Some(positions) = rhs_positions.get(&point) {
            for rhs_index in positions {
                let shift = *rhs_index as i32 - lhs_index as i32;
                *shift_counts.entry(shift).or_default() += 1;
            }
        }
    }

    let mut shifts = shift_counts.into_iter().collect::<Vec<_>>();
    shifts.sort_unstable_by(|left, right| right.1.cmp(&left.1));
    shifts
        .into_iter()
        .filter(|(_, count)| *count >= 3)
        .take(32)
        .map(|(shift, _)| shift)
        .collect()
}

fn range_for_shift_with_limits(
    lhs: &[u32],
    rhs: &[u32],
    shift: i32,
    min_duration: f64,
    max_duration: f64,
) -> Option<MatchedRange> {
    let lhs_offset = (-shift).max(0) as usize;
    let rhs_offset = shift.max(0) as usize;
    let overlap = lhs
        .len()
        .saturating_sub(lhs_offset)
        .min(rhs.len().saturating_sub(rhs_offset));

    let mut best: Option<(usize, usize, usize)> = None;
    let mut group_start = None;
    let mut last_match = 0usize;
    let mut match_count = 0usize;

    let finish_group = |best: &mut Option<(usize, usize, usize)>,
                        start: Option<usize>,
                        end: usize,
                        matches: usize| {
        let Some(start) = start else { return };
        let span = end.saturating_sub(start) + 1;
        let duration = span as f64 * SAMPLE_DURATION_SECONDS;
        let density = matches as f64 / span as f64;
        if (min_duration..=max_duration).contains(&duration)
            && density >= MIN_MATCH_DENSITY
            && best.is_none_or(|current| span > current.1.saturating_sub(current.0) + 1)
        {
            *best = Some((start, end, matches));
        }
    };

    for relative_index in 0..overlap {
        let lhs_index = lhs_offset + relative_index;
        let rhs_index = rhs_offset + relative_index;
        let matches = (lhs[lhs_index] ^ rhs[rhs_index]).count_ones() <= MAX_POINT_BIT_DIFFERENCES;
        if !matches {
            continue;
        }

        if group_start.is_some() && relative_index.saturating_sub(last_match) > MAX_MATCH_GAP_POINTS
        {
            finish_group(&mut best, group_start, last_match, match_count);
            group_start = None;
            match_count = 0;
        }
        group_start.get_or_insert(relative_index);
        last_match = relative_index;
        match_count += 1;
    }
    finish_group(&mut best, group_start, last_match, match_count);

    best.map(|(start, end, matches)| {
        let span = end.saturating_sub(start) + 1;
        let (bit_sum, close_points) =
            (start..=end).fold((0u64, 0usize), |(bit_sum, close_points), relative_index| {
                let distance = (lhs[lhs_offset + relative_index]
                    ^ rhs[rhs_offset + relative_index])
                    .count_ones();
                (
                    bit_sum + u64::from(distance),
                    close_points + usize::from(distance <= FUZZY_CLOSE_POINT_BIT_DIFFERENCES),
                )
            });
        MatchedRange {
            start: (lhs_offset + start) as f64 * SAMPLE_DURATION_SECONDS,
            end: (lhs_offset + end + 1) as f64 * SAMPLE_DURATION_SECONDS,
            reference_start: (rhs_offset + start) as f64 * SAMPLE_DURATION_SECONDS,
            reference_end: (rhs_offset + end + 1) as f64 * SAMPLE_DURATION_SECONDS,
            method: IntroMatchMethod::Exact,
            exact_density: matches as f64 / span as f64,
            mean_bit_difference: bit_sum as f64 / span as f64,
            close_point_density: close_points as f64 / span as f64,
        }
    })
}

fn range_for_shift(lhs: &[u32], rhs: &[u32], shift: i32) -> Option<MatchedRange> {
    range_for_shift_with_limits(lhs, rhs, shift, MIN_INTRO_SECONDS, MAX_INTRO_SECONDS)
}

fn find_shared_intro(lhs: &[u32], rhs: &[u32]) -> Option<MatchedRange> {
    candidate_shifts(lhs, rhs)
        .into_iter()
        .filter_map(|shift| range_for_shift(lhs, rhs, shift))
        .max_by(|left, right| {
            (left.end - left.start)
                .partial_cmp(&(right.end - right.start))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .or_else(|| find_fuzzy_shared_intro(lhs, rhs))
}

fn fuzzy_window_is_eligible(bit_sum: u32, close_points: usize, points: usize) -> bool {
    points > 0
        && bit_sum as f64 / points as f64 <= FUZZY_MAX_MEAN_BIT_DIFFERENCES
        && close_points as f64 / points as f64 >= FUZZY_MIN_CLOSE_POINT_DENSITY
}

fn find_fuzzy_shared_intro(lhs: &[u32], rhs: &[u32]) -> Option<MatchedRange> {
    let min_points = (MIN_INTRO_SECONDS / SAMPLE_DURATION_SECONDS).ceil() as usize;
    let max_points = (MAX_INTRO_SECONDS / SAMPLE_DURATION_SECONDS).floor() as usize;
    let min_context_points =
        (FUZZY_MIN_ALIGNED_CONTEXT_SECONDS / SAMPLE_DURATION_SECONDS).ceil() as usize;
    if lhs.len() < min_points || rhs.len() < min_points {
        return None;
    }

    let min_shift = -(lhs.len().saturating_sub(min_points) as i32);
    let max_shift = rhs.len().saturating_sub(min_points) as i32;
    let mut best: Option<(i32, usize, u32, usize)> = None;

    for shift in min_shift..=max_shift {
        let lhs_offset = (-shift).max(0) as usize;
        let rhs_offset = shift.max(0) as usize;
        let overlap = lhs
            .len()
            .saturating_sub(lhs_offset)
            .min(rhs.len().saturating_sub(rhs_offset));
        if overlap < min_context_points.max(min_points) {
            continue;
        }

        let point_distance = |relative_index: usize| {
            (lhs[lhs_offset + relative_index] ^ rhs[rhs_offset + relative_index]).count_ones()
        };
        let mut bit_sum = 0u32;
        let mut close_points = 0usize;
        for relative_index in 0..min_points {
            let distance = point_distance(relative_index);
            bit_sum += distance;
            close_points += usize::from(distance <= FUZZY_CLOSE_POINT_BIT_DIFFERENCES);
        }

        for start in 0..=overlap - min_points {
            if start > 0 {
                let removed = point_distance(start - 1);
                bit_sum -= removed;
                close_points -= usize::from(removed <= FUZZY_CLOSE_POINT_BIT_DIFFERENCES);
                let added = point_distance(start + min_points - 1);
                bit_sum += added;
                close_points += usize::from(added <= FUZZY_CLOSE_POINT_BIT_DIFFERENCES);
            }
            if fuzzy_window_is_eligible(bit_sum, close_points, min_points)
                && best.is_none_or(|(_, _, best_sum, best_close_points)| {
                    bit_sum < best_sum || (bit_sum == best_sum && close_points > best_close_points)
                })
            {
                best = Some((shift, start, bit_sum, close_points));
            }
        }
    }

    let (shift, best_start, _, _) = best?;
    let lhs_offset = (-shift).max(0) as usize;
    let rhs_offset = shift.max(0) as usize;
    let overlap = lhs
        .len()
        .saturating_sub(lhs_offset)
        .min(rhs.len().saturating_sub(rhs_offset));
    let window_is_eligible = |window_start: usize| {
        let (bit_sum, close_points) = (window_start..window_start + min_points).fold(
            (0u32, 0usize),
            |(bit_sum, close_points), relative_index| {
                let distance = (lhs[lhs_offset + relative_index]
                    ^ rhs[rhs_offset + relative_index])
                    .count_ones();
                (
                    bit_sum + distance,
                    close_points + usize::from(distance <= FUZZY_CLOSE_POINT_BIT_DIFFERENCES),
                )
            },
        );
        fuzzy_window_is_eligible(bit_sum, close_points, min_points)
    };
    let mut first_window_start = best_start;
    while first_window_start > 0 && window_is_eligible(first_window_start - 1) {
        first_window_start -= 1;
    }
    let mut last_window_start = best_start;
    while last_window_start + min_points < overlap && window_is_eligible(last_window_start + 1) {
        last_window_start += 1;
    }
    let start = first_window_start;
    let end = last_window_start + min_points;
    if end - start > max_points {
        return None;
    }

    let points = end.saturating_sub(start);
    let (bit_sum, exact_points, close_points) = (start..end).fold(
        (0u64, 0usize, 0usize),
        |(bit_sum, exact_points, close_points), relative_index| {
            let distance =
                (lhs[lhs_offset + relative_index] ^ rhs[rhs_offset + relative_index]).count_ones();
            (
                bit_sum + u64::from(distance),
                exact_points + usize::from(distance <= MAX_POINT_BIT_DIFFERENCES),
                close_points + usize::from(distance <= FUZZY_CLOSE_POINT_BIT_DIFFERENCES),
            )
        },
    );

    Some(MatchedRange {
        start: (lhs_offset + start) as f64 * SAMPLE_DURATION_SECONDS,
        end: (lhs_offset + end) as f64 * SAMPLE_DURATION_SECONDS,
        reference_start: (rhs_offset + start) as f64 * SAMPLE_DURATION_SECONDS,
        reference_end: (rhs_offset + end) as f64 * SAMPLE_DURATION_SECONDS,
        method: IntroMatchMethod::Fuzzy,
        exact_density: exact_points as f64 / points as f64,
        mean_bit_difference: bit_sum as f64 / points as f64,
        close_point_density: close_points as f64 / points as f64,
    })
}

fn intro_match_is_eligible(range: &MatchedRange) -> bool {
    let minimum_duration = match range.method {
        IntroMatchMethod::Exact => MIN_INTRO_SECONDS,
        IntroMatchMethod::Fuzzy => MIN_FUZZY_INTRO_SECONDS,
    };
    range.end - range.start >= minimum_duration
}

fn find_shared_outro_with_minimum(
    lhs: &[u32],
    rhs: &[u32],
    minimum_duration: f64,
    max_duration: f64,
) -> Option<MatchedRange> {
    candidate_shifts(lhs, rhs)
        .into_iter()
        .filter_map(|shift| {
            range_for_shift_with_limits(lhs, rhs, shift, minimum_duration, max_duration)
        })
        .max_by(|left, right| {
            (left.end - left.start)
                .partial_cmp(&(right.end - right.start))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

#[cfg(test)]
fn find_shared_outro(lhs: &[u32], rhs: &[u32], max_duration: f64) -> Option<MatchedRange> {
    find_shared_outro_with_minimum(lhs, rhs, MIN_OUTRO_MATCH_SECONDS, max_duration)
}

fn cache_path(app: &tauri::AppHandle, series_key: &str, season: u32) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve Intro Skipper cache: {error}"))?
        .join("intro-skipper");
    let mut digest = Sha1::new();
    digest.update(series_key.as_bytes());
    let identity = format!("{:x}", digest.finalize());
    Ok(root.join(format!("{identity}-s{season}.json")))
}

fn outro_cache_path(
    app: &tauri::AppHandle,
    series_key: &str,
    season: u32,
) -> Result<PathBuf, String> {
    let path = cache_path(app, series_key, season)?;
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid Intro Skipper outro cache path".to_string())?;
    Ok(path.with_file_name(format!("{stem}-outro.json")))
}

fn load_season_cache(path: &Path) -> SeasonFingerprintCache {
    let Ok(bytes) = fs::read(path) else {
        return SeasonFingerprintCache::default();
    };
    match serde_json::from_slice::<SeasonFingerprintCache>(&bytes) {
        Ok(cache) if cache.version == FINGERPRINT_CACHE_VERSION => cache,
        Ok(_) => SeasonFingerprintCache::default(),
        Err(error) => {
            warn!("[Segment Detection][Local] Ignoring invalid fingerprint cache: {error}");
            SeasonFingerprintCache::default()
        }
    }
}

fn load_outro_cache(path: &Path) -> SeasonOutroFingerprintCache {
    let Ok(bytes) = fs::read(path) else {
        return SeasonOutroFingerprintCache::default();
    };
    match serde_json::from_slice::<SeasonOutroFingerprintCache>(&bytes) {
        Ok(cache) if cache.version == OUTRO_FINGERPRINT_CACHE_VERSION => cache,
        Ok(_) => SeasonOutroFingerprintCache::default(),
        Err(error) => {
            warn!("[Segment Detection][Local][Outro] Ignoring invalid fingerprint cache: {error}");
            SeasonOutroFingerprintCache::default()
        }
    }
}

fn enforce_fingerprint_cache_budget(root: &Path, max_bytes: u64) -> Result<(), String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Could not inspect Intro Skipper fingerprint cache: {error}"
            ));
        }
    };
    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!("Could not inspect Intro Skipper fingerprint cache entry: {error}")
        })?;
        let metadata = entry.metadata().map_err(|error| {
            format!("Could not inspect Intro Skipper fingerprint cache file: {error}")
        })?;
        if !metadata.is_file() {
            continue;
        }
        let size = metadata.len();
        total_bytes = total_bytes.saturating_add(size);
        files.push((
            metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            entry.file_name(),
            entry.path(),
            size,
        ));
    }
    if total_bytes <= max_bytes {
        return Ok(());
    }

    files.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    for (_, _, path, size) in files {
        if total_bytes <= max_bytes {
            break;
        }
        fs::remove_file(&path).map_err(|error| {
            format!(
                "Could not evict old Intro Skipper fingerprint cache {}: {error}",
                path.display()
            )
        })?;
        total_bytes = total_bytes.saturating_sub(size);
        info!(
            "[Segment Detection][Local] Evicted oldest fingerprint cache: file={}, size_bytes={}, remaining_bytes={}, limit_bytes={}",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown"),
            size,
            total_bytes,
            max_bytes
        );
    }
    Ok(())
}

fn store_episode_fingerprint(
    path: &Path,
    cache: &mut SeasonFingerprintCache,
    episode: u32,
    source_identity: &str,
    audio_identity: &str,
    duration_seconds: f64,
    window_start_seconds: f64,
    analysis_part: u8,
    points: &[u32],
) -> Result<(), String> {
    cache.episodes.retain(|entry| {
        entry.episode != episode
            || entry.source_identity != source_identity
            || entry.audio_identity != audio_identity
            || entry.analysis_part != analysis_part
    });
    cache.episodes.push(CachedEpisodeFingerprint {
        episode,
        source_identity: source_identity.to_string(),
        audio_identity: audio_identity.to_string(),
        duration_seconds,
        window_start_seconds,
        analysis_part,
        points: points.to_vec(),
    });
    cache.episodes.sort_by_key(|entry| {
        (
            entry.audio_identity != audio_identity,
            entry.source_identity != source_identity,
            entry.episode.abs_diff(episode),
        )
    });
    if cache.episodes.len() > MAX_PERSISTED_FINGERPRINTS {
        cache.episodes.truncate(MAX_PERSISTED_FINGERPRINTS);
    }
    cache.episodes.sort_by_key(|entry| entry.episode);

    let parent = path
        .parent()
        .ok_or_else(|| "Invalid Intro Skipper cache path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Intro Skipper cache: {error}"))?;
    let bytes = serde_json::to_vec(cache)
        .map_err(|error| format!("Could not encode Intro Skipper cache: {error}"))?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, bytes)
        .map_err(|error| format!("Could not stage Intro Skipper cache: {error}"))?;
    replace_file_atomically(&temporary_path, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary_path);
    })?;
    enforce_fingerprint_cache_budget(parent, FINGERPRINT_CACHE_MAX_BYTES)
}

fn store_episode_outro_fingerprint(
    path: &Path,
    cache: &mut SeasonOutroFingerprintCache,
    episode: u32,
    source_identity: &str,
    audio_identity: &str,
    duration_seconds: f64,
    window_start_seconds: f64,
    points: &[u32],
) -> Result<(), String> {
    cache.episodes.retain(|entry| {
        entry.episode != episode
            || entry.source_identity != source_identity
            || entry.audio_identity != audio_identity
    });
    cache.episodes.push(CachedEpisodeOutroFingerprint {
        episode,
        source_identity: source_identity.to_string(),
        audio_identity: audio_identity.to_string(),
        duration_seconds,
        window_start_seconds,
        points: points.to_vec(),
    });
    cache.episodes.sort_by_key(|entry| {
        (
            entry.audio_identity != audio_identity,
            entry.source_identity != source_identity,
            entry.episode.abs_diff(episode),
        )
    });
    if cache.episodes.len() > MAX_PERSISTED_FINGERPRINTS {
        cache.episodes.truncate(MAX_PERSISTED_FINGERPRINTS);
    }
    cache.episodes.sort_by_key(|entry| entry.episode);

    let parent = path
        .parent()
        .ok_or_else(|| "Invalid Intro Skipper outro cache path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create Intro Skipper outro cache: {error}"))?;
    let bytes = serde_json::to_vec(cache)
        .map_err(|error| format!("Could not encode Intro Skipper outro cache: {error}"))?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, bytes)
        .map_err(|error| format!("Could not stage Intro Skipper outro cache: {error}"))?;
    replace_file_atomically(&temporary_path, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary_path);
    })?;
    enforce_fingerprint_cache_budget(parent, FINGERPRINT_CACHE_MAX_BYTES)
}

#[cfg(target_os = "windows")]
fn replace_file_atomically(temporary_path: &Path, path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary_wide = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(temporary_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| format!("Could not commit Intro Skipper cache: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn replace_file_atomically(temporary_path: &Path, path: &Path) -> Result<(), String> {
    fs::rename(temporary_path, path)
        .map_err(|error| format!("Could not commit Intro Skipper cache: {error}"))
}

fn normalize_chapter_title(title: &str) -> String {
    title
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn chapter_kind(title: &str) -> Option<ChapterKind> {
    let title = normalize_chapter_title(title);
    if title == "recap" || title.starts_with("recap ") || title.contains("previously") {
        return Some(ChapterKind::Recap);
    }
    if matches!(title.as_str(), "intro" | "introduction" | "opening" | "op")
        || title.starts_with("intro ")
        || title.starts_with("opening ")
    {
        return Some(ChapterKind::Intro);
    }
    if matches!(
        title.as_str(),
        "credits" | "outro" | "ending" | "end credits" | "closing credits" | "ed"
    ) || title.ends_with(" credits")
    {
        return Some(ChapterKind::Outro);
    }
    None
}

fn segment_from_range(start: f64, end: f64, source: &str) -> Option<IntroDbSegment> {
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start {
        return None;
    }
    let start_ms = (start * 1_000.0).round() as u64;
    let end_ms = (end * 1_000.0).round() as u64;
    Some(IntroDbSegment {
        start_ms,
        end_ms,
        start_sec: start_ms as f64 / 1_000.0,
        end_sec: end_ms as f64 / 1_000.0,
        confidence: None,
        submission_count: None,
        source: source.to_string(),
    })
}

fn feedback_candidate_from_range(
    kind: &str,
    start: f64,
    end: f64,
    source: &str,
    reason: &str,
    score: Option<f64>,
) -> Option<SegmentFeedbackCandidate> {
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start {
        return None;
    }
    Some(SegmentFeedbackCandidate {
        kind: kind.to_string(),
        start_sec: (start * 1_000.0).round() / 1_000.0,
        end_sec: (end * 1_000.0).round() / 1_000.0,
        source: source.to_string(),
        reason: reason.to_string(),
        score: score.map(|value| value.clamp(0.0, 1.0)),
    })
}

fn detect_chapter_segments(chapters: &[MpvChapter], duration: f64) -> PlayerChapterSegments {
    let mut result = PlayerChapterSegments {
        chapter_count: chapters.len(),
        ..PlayerChapterSegments::default()
    };
    if !duration.is_finite() || duration <= 0.0 {
        return result;
    }

    for (index, chapter) in chapters.iter().enumerate() {
        let Some(kind) = chapter_kind(&chapter.title) else {
            continue;
        };
        let end = chapters
            .get(index + 1)
            .map(|next| next.time)
            .unwrap_or(duration)
            .min(duration);
        let Some(segment) = segment_from_range(chapter.time, end, "chapter") else {
            continue;
        };
        match kind {
            ChapterKind::Intro
                if result.intro.is_none()
                    && segment.start_sec <= (duration * 0.4).min(20.0 * 60.0) =>
            {
                result.intro = Some(segment)
            }
            ChapterKind::Recap
                if result.recap.is_none()
                    && segment.start_sec <= (duration * 0.4).min(20.0 * 60.0) =>
            {
                result.recap = Some(segment)
            }
            ChapterKind::Outro
                if result.outro.is_none()
                    && segment.start_sec >= duration * 0.5
                    && duration - segment.start_sec >= MIN_CHAPTER_OUTRO_LEAD_SECONDS =>
            {
                result.outro = Some(segment)
            }
            _ => {}
        }
    }

    if result.outro.is_none() {
        if let Some(last) = chapters.last() {
            let remaining = duration - last.time;
            let kind = chapter_kind(&last.title);
            let unlabeled_candidate = kind.is_none() && remaining >= MIN_CHAPTER_OUTRO_LEAD_SECONDS;
            let short_labeled_candidate =
                kind == Some(ChapterKind::Outro) && remaining >= MIN_FEEDBACK_OUTRO_SECONDS;
            if last.time >= duration * 0.55
                && remaining <= MAX_OUTRO_ANALYSIS_SECONDS
                && (unlabeled_candidate || short_labeled_candidate)
            {
                result.candidate = feedback_candidate_from_range(
                    "outro",
                    last.time,
                    duration,
                    "chapter",
                    if unlabeled_candidate {
                        "unlabeled-final-chapter"
                    } else {
                        "short-labeled-outro-chapter"
                    },
                    short_labeled_candidate.then_some(remaining / MIN_CHAPTER_OUTRO_LEAD_SECONDS),
                );
            }
        }
    }
    result
}

#[tauri::command]
pub async fn detect_player_chapter_segments(
    duration_seconds: f64,
) -> Result<PlayerChapterSegments, String> {
    info!("[Segment Detection][Local] Chapter scan started");
    let chapters = crate::mpv_ipc::get_player_chapters()?;
    let result = detect_chapter_segments(&chapters, duration_seconds);
    info!(
        "[Segment Detection][Local] Chapter scan complete: chapters={}, intro={}, recap={}, outro={}, feedback_candidate={}",
        result.chapter_count,
        result.intro.is_some(),
        result.recap.is_some(),
        result.outro.is_some(),
        result
            .candidate
            .as_ref()
            .map(|candidate| candidate.reason.as_str())
            .unwrap_or("none")
    );
    Ok(result)
}

#[tauri::command]
pub async fn detect_intro_skipper_segment(
    app: tauri::AppHandle,
    series_key: String,
    source_identity: String,
    season: u32,
    episode: u32,
    current_url: String,
    duration_seconds: f64,
    analysis_part: u8,
) -> Result<IntroSkipperDetectionResult, String> {
    info!(
        "[Segment Detection][Local] Rolling fingerprint command received: season={}, episode={}, part={}",
        season, episode, analysis_part
    );
    validate_series_key(&series_key)?;
    validate_media_source(&current_url)?;
    if season == 0 || episode == 0 || !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Err("Invalid Intro Skipper episode identity".to_string());
    }
    let source_identity = fingerprint_source_identity(&source_identity, &current_url)?;
    let selected_audio = match crate::mpv_ipc::get_selected_audio_track() {
        Ok(track) => track,
        Err(error) => {
            warn!(
                "[Segment Detection][Local] Rolling fingerprint preflight failed: season={}, episode={}, error={}",
                season, episode, error
            );
            return Err(error);
        }
    };
    let audio_track_id = selected_audio.id;
    info!(
        "[Segment Detection][Local] Rolling fingerprint requested: season={}, episode={}, selected_audio_track_id={}",
        season, episode, audio_track_id
    );

    let (window_start_seconds, analysis_seconds) =
        intro_analysis_window(duration_seconds, analysis_part)
            .ok_or_else(|| "Invalid Intro Skipper analysis part".to_string())?;
    let required_buffer_seconds = window_start_seconds + analysis_seconds as f64;
    let cache_window = crate::pin_intro_cache_for_stream_url(
        &current_url,
        required_buffer_seconds,
        duration_seconds,
    )?;
    let pinned_opening_bytes = cache_window
        .as_ref()
        .map(|status| status.pinned_bytes)
        .unwrap_or(0);
    let is_local_file =
        !(current_url.starts_with("http://") || current_url.starts_with("https://"));
    let buffered_seconds = if is_local_file {
        required_buffer_seconds
    } else {
        let player_buffered_seconds =
            match crate::mpv_ipc::get_player_cached_window_end_seconds(window_start_seconds) {
                Ok(seconds) => Some(seconds),
                Err(error) if cache_window.is_none() => return Err(error),
                Err(_) => None,
            };
        opening_cache_buffered_seconds(
            cache_window.as_ref(),
            player_buffered_seconds,
            required_buffer_seconds,
        )
    };
    if buffered_seconds + 0.5 < required_buffer_seconds {
        info!(
            "[Segment Detection][Local] Rolling fingerprint waiting for opening cache: buffered={:.1}s, required={:.1}s, pinned_opening_bytes={}, season={}, episode={}",
            buffered_seconds,
            required_buffer_seconds,
            pinned_opening_bytes,
            season,
            episode
        );
        return Ok(IntroSkipperDetectionResult {
            segment: None,
            candidate: None,
            status: "waiting-for-buffer".to_string(),
            reference_episode: None,
            reference_end_sec: None,
            cached_episode_count: 0,
            buffered_seconds,
            required_buffer_seconds,
        });
    }

    let path = cache_path(&app, &series_key, season)?;
    let cache = load_season_cache(&path);
    let mut references = cache
        .episodes
        .iter()
        .filter(|entry| {
            entry.episode != episode
                && audio_identities_compatible(&selected_audio.identity, &entry.audio_identity)
                && entry.analysis_part == analysis_part
                && (entry.source_identity == source_identity
                    || source_durations_compatible(duration_seconds, entry.duration_seconds))
        })
        .cloned()
        .collect::<Vec<_>>();
    references.sort_by_key(|entry| {
        (
            entry.source_identity != source_identity,
            entry.episode.abs_diff(episode),
        )
    });
    info!(
        "[Segment Detection][Local] Rolling fingerprint attached to local cache: buffered={:.1}s, window_start={:.1}s, analysis_window={:.1}s, part={}, season={}, episode={}, cached_references={}",
        buffered_seconds,
        window_start_seconds,
        analysis_seconds,
        analysis_part,
        season,
        episode,
        references.len()
    );

    let fpcalc_path = resolve_fpcalc_path(&app)?;
    info!(
        "[Segment Detection][Local] Selected-audio extraction started: window_start={:.1}s, analysis_window={:.1}s, part={}, season={}, episode={}, audio_track_id={}",
        window_start_seconds, analysis_seconds, analysis_part, season, episode, audio_track_id
    );
    let extracted_path = match extract_selected_audio(
        &app,
        &current_url,
        window_start_seconds,
        analysis_seconds,
        audio_track_id,
    )
    .await
    {
        Ok(path) => path,
        Err(error) if error == LOCAL_AUDIO_CACHE_NOT_READY => {
            return Ok(IntroSkipperDetectionResult {
                segment: None,
                candidate: None,
                status: "waiting-for-local-cache".to_string(),
                reference_episode: None,
                reference_end_sec: None,
                cached_episode_count: cache.episodes.len(),
                buffered_seconds,
                required_buffer_seconds,
            });
        }
        Err(error) => return Err(error),
    };
    let fingerprint_result = fingerprint_media(
        &fpcalc_path,
        &extracted_path.to_string_lossy(),
        analysis_seconds,
    )
    .await;
    let _ = fs::remove_file(&extracted_path);
    let current = match fingerprint_result {
        Ok(fingerprint) => fingerprint,
        Err(error) if error == LOCAL_CACHE_NOT_READY => {
            info!(
                "[Segment Detection][Local] Rolling fingerprint waiting for local cache: season={}, episode={}, cached_episodes={}",
                season,
                episode,
                cache.episodes.len()
            );
            return Ok(IntroSkipperDetectionResult {
                segment: None,
                candidate: None,
                status: "waiting-for-local-cache".to_string(),
                reference_episode: None,
                reference_end_sec: None,
                cached_episode_count: cache.episodes.len(),
                buffered_seconds,
                required_buffer_seconds,
            });
        }
        Err(error) => {
            warn!(
                "[Segment Detection][Local] Rolling fingerprint failed: season={}, episode={}, error={}",
                season, episode, error
            );
            return Err(error);
        }
    };
    if crate::mpv_ipc::get_selected_audio_track()? != selected_audio {
        return Err(
            "Intro Skipper discarded because the selected MPV audio changed during fingerprinting"
                .to_string(),
        );
    }

    let (matched, feedback_candidate, cached_episode_count, reference_count) = {
        let _write_guard = SEASON_CACHE_WRITE_LOCK.lock();
        let mut latest_cache = load_season_cache(&path);
        let mut latest_references = latest_cache
            .episodes
            .iter()
            .filter(|entry| {
                entry.episode != episode
                    && audio_identities_compatible(&selected_audio.identity, &entry.audio_identity)
                    && entry.analysis_part == analysis_part
                    && (entry.source_identity == source_identity
                        || source_durations_compatible(duration_seconds, entry.duration_seconds))
            })
            .cloned()
            .collect::<Vec<_>>();
        latest_references.sort_by_key(|entry| {
            (
                entry.source_identity != source_identity,
                entry.episode.abs_diff(episode),
            )
        });
        let evaluated = latest_references
            .iter()
            .filter_map(|reference| {
                let range = find_shared_intro(&current, &reference.points)?;
                let match_duration_seconds = range.end - range.start;
                let minimum_duration_seconds = match range.method {
                    IntroMatchMethod::Exact => MIN_INTRO_SECONDS,
                    IntroMatchMethod::Fuzzy => MIN_FUZZY_INTRO_SECONDS,
                };
                let accepted = intro_match_is_eligible(&range);
                info!(
                    event = "segment_detection.local.intro_candidate_evaluated",
                    subsystem = "segment_detection.local",
                    status = if accepted { "accepted" } else { "rejected" },
                    season,
                    episode,
                    analysis_part,
                    reference_episode = reference.episode,
                    reference_audio_exact = reference.audio_identity == selected_audio.identity,
                    reference_source_exact = reference.source_identity == source_identity,
                    match_method = range.method.as_str(),
                    match_duration_seconds,
                    minimum_duration_seconds,
                    exact_density = range.exact_density,
                    mean_bit_difference = range.mean_bit_difference,
                    close_point_density = range.close_point_density,
                    current_start_seconds = window_start_seconds + range.start,
                    reference_start_seconds =
                        reference.window_start_seconds + range.reference_start,
                    "[Segment Detection][Local] Intro fingerprint candidate evaluated"
                );
                Some((
                    reference.source_identity == source_identity,
                    reference.episode,
                    reference.window_start_seconds,
                    range,
                    accepted,
                ))
            })
            .collect::<Vec<_>>();
        let matched = evaluated
            .iter()
            .copied()
            .filter(|entry| entry.4)
            .max_by(|left, right| {
                left.0.cmp(&right.0).then_with(|| {
                    (left.3.end - left.3.start)
                        .partial_cmp(&(right.3.end - right.3.start))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            })
            .map(|entry| (entry.0, entry.1, entry.2, entry.3));
        let feedback_candidate = evaluated
            .iter()
            .copied()
            .filter(|entry| !entry.4 && entry.3.end - entry.3.start >= MIN_FEEDBACK_INTRO_SECONDS)
            .max_by(|left, right| {
                (left.3.end - left.3.start)
                    .partial_cmp(&(right.3.end - right.3.start))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .and_then(|entry| {
                let minimum = match entry.3.method {
                    IntroMatchMethod::Exact => MIN_INTRO_SECONDS,
                    IntroMatchMethod::Fuzzy => MIN_FUZZY_INTRO_SECONDS,
                };
                feedback_candidate_from_range(
                    "intro",
                    window_start_seconds + entry.3.start,
                    window_start_seconds + entry.3.end,
                    "intro-skipper",
                    match entry.3.method {
                        IntroMatchMethod::Exact => "short-exact-fingerprint-match",
                        IntroMatchMethod::Fuzzy => "short-fuzzy-fingerprint-match",
                    },
                    Some((entry.3.end - entry.3.start) / minimum),
                )
            });
        if let Err(error) = store_episode_fingerprint(
            &path,
            &mut latest_cache,
            episode,
            &source_identity,
            &selected_audio.identity,
            duration_seconds,
            window_start_seconds,
            analysis_part,
            &current,
        ) {
            warn!("[Segment Detection][Local] Fingerprint cache write failed: {error}");
        }
        (
            matched,
            feedback_candidate,
            latest_cache.episodes.len(),
            latest_references.len(),
        )
    };
    let Some((_, reference_episode, reference_window_start, range)) = matched else {
        let status = if reference_count == 0 {
            "learned"
        } else {
            "no-match"
        };
        info!(
            "[Segment Detection][Local] Rolling fingerprint complete: status={}, cached_episodes={}",
            status,
            cached_episode_count
        );
        return Ok(IntroSkipperDetectionResult {
            segment: None,
            candidate: feedback_candidate,
            status: status.to_string(),
            reference_episode: None,
            reference_end_sec: None,
            cached_episode_count,
            buffered_seconds,
            required_buffer_seconds,
        });
    };

    let absolute_start = window_start_seconds + range.start;
    let absolute_end = window_start_seconds + range.end;
    let absolute_reference_end = reference_window_start + range.reference_end;
    let segment = segment_from_range(absolute_start, absolute_end, "intro-skipper");
    info!(
        event = "segment_detection.local.intro_detected",
        subsystem = "segment_detection.local",
        status = "detected",
        season,
        episode,
        analysis_part,
        reference_episode,
        match_method = range.method.as_str(),
        match_duration_seconds = range.end - range.start,
        exact_density = range.exact_density,
        mean_bit_difference = range.mean_bit_difference,
        close_point_density = range.close_point_density,
        start_seconds = absolute_start,
        end_seconds = absolute_end,
        reference_start_seconds = reference_window_start + range.reference_start,
        reference_end_seconds = absolute_reference_end,
        cached_episode_count,
        "[Segment Detection][Local] Rolling fingerprint complete: status=detected"
    );
    Ok(IntroSkipperDetectionResult {
        segment,
        candidate: None,
        status: "detected".to_string(),
        reference_episode: Some(reference_episode),
        reference_end_sec: Some(absolute_reference_end),
        cached_episode_count,
        buffered_seconds,
        required_buffer_seconds,
    })
}

#[tauri::command]
pub async fn detect_intro_skipper_outro_segment(
    app: tauri::AppHandle,
    series_key: String,
    source_identity: String,
    season: u32,
    episode: u32,
    current_url: String,
    duration_seconds: f64,
) -> Result<IntroSkipperDetectionResult, String> {
    info!(
        "[Segment Detection][Local][Outro] Fingerprint command received: season={}, episode={}",
        season, episode
    );
    validate_series_key(&series_key)?;
    validate_media_source(&current_url)?;
    if season == 0 || episode == 0 || !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return Err("Invalid Intro Skipper outro episode identity".to_string());
    }
    let source_identity = fingerprint_source_identity(&source_identity, &current_url)?;
    let selected_audio = match crate::mpv_ipc::get_selected_audio_track() {
        Ok(track) => track,
        Err(error) => {
            warn!(
                "[Segment Detection][Local][Outro] Fingerprint preflight failed: season={}, episode={}, error={}",
                season, episode, error
            );
            return Err(error);
        }
    };
    let audio_track_id = selected_audio.id;
    info!(
        "[Segment Detection][Local][Outro] Fingerprint requested: season={}, episode={}, selected_audio_track_id={}",
        season, episode, audio_track_id
    );

    let analysis_seconds = outro_analysis_seconds(duration_seconds);
    let required_buffer_seconds = analysis_seconds as f64;
    let cache_window = crate::pin_outro_cache_for_stream_url(
        &current_url,
        required_buffer_seconds,
        duration_seconds,
    )?;
    let pinned_tail_bytes = cache_window
        .as_ref()
        .map(|status| status.pinned_bytes)
        .unwrap_or(0);
    let is_local_file =
        !(current_url.starts_with("http://") || current_url.starts_with("https://"));
    let buffered_seconds = if is_local_file {
        required_buffer_seconds
    } else if let Some(status) = cache_window.as_ref() {
        cache_window_buffered_seconds(status, required_buffer_seconds)
    } else {
        crate::mpv_ipc::get_player_cached_tail_seconds(duration_seconds)?
    };
    if buffered_seconds + 0.5 < required_buffer_seconds {
        info!(
            "[Segment Detection][Local][Outro] Waiting for tail cache: buffered={:.1}s, required={:.1}s, pinned_tail_bytes={}, season={}, episode={}",
            buffered_seconds,
            required_buffer_seconds,
            pinned_tail_bytes,
            season,
            episode
        );
        return Ok(IntroSkipperDetectionResult {
            segment: None,
            candidate: None,
            status: "waiting-for-tail-cache".to_string(),
            reference_episode: None,
            reference_end_sec: None,
            cached_episode_count: 0,
            buffered_seconds,
            required_buffer_seconds,
        });
    }

    let window_start_seconds = (duration_seconds - required_buffer_seconds).max(0.0);
    let fpcalc_path = resolve_fpcalc_path(&app)?;
    info!(
        "[Segment Detection][Local][Outro] Tail extraction started: window_start={:.1}s, analysis_window={:.1}s, season={}, episode={}",
        window_start_seconds,
        required_buffer_seconds,
        season,
        episode
    );
    let extracted_path = match extract_selected_audio(
        &app,
        &current_url,
        window_start_seconds,
        analysis_seconds,
        audio_track_id,
    )
    .await
    {
        Ok(path) => path,
        Err(error) if error == LOCAL_AUDIO_CACHE_NOT_READY => {
            return Ok(IntroSkipperDetectionResult {
                segment: None,
                candidate: None,
                status: "waiting-for-tail-cache".to_string(),
                reference_episode: None,
                reference_end_sec: None,
                cached_episode_count: 0,
                buffered_seconds,
                required_buffer_seconds,
            });
        }
        Err(error) => return Err(error),
    };
    let fingerprint_result = fingerprint_media(
        &fpcalc_path,
        &extracted_path.to_string_lossy(),
        analysis_seconds,
    )
    .await;
    let _ = fs::remove_file(&extracted_path);
    let current = match fingerprint_result {
        Ok(fingerprint) => fingerprint,
        Err(error) if error == LOCAL_CACHE_NOT_READY => {
            return Ok(IntroSkipperDetectionResult {
                segment: None,
                candidate: None,
                status: "waiting-for-tail-cache".to_string(),
                reference_episode: None,
                reference_end_sec: None,
                cached_episode_count: 0,
                buffered_seconds,
                required_buffer_seconds,
            });
        }
        Err(error) => return Err(error),
    };
    if crate::mpv_ipc::get_selected_audio_track()? != selected_audio {
        return Err(
            "Intro Skipper discarded the outro because the selected audio changed during fingerprinting"
                .to_string(),
        );
    }
    let path = outro_cache_path(&app, &series_key, season)?;
    let (matched, feedback_candidate, cached_episode_count, reference_count) = {
        let _write_guard = SEASON_CACHE_WRITE_LOCK.lock();
        let mut latest_cache = load_outro_cache(&path);
        let mut latest_references = latest_cache
            .episodes
            .iter()
            .filter(|entry| {
                entry.episode != episode
                    && audio_identities_compatible(&selected_audio.identity, &entry.audio_identity)
                    && (entry.source_identity == source_identity
                        || source_durations_compatible(duration_seconds, entry.duration_seconds))
            })
            .cloned()
            .collect::<Vec<_>>();
        latest_references.sort_by_key(|entry| {
            (
                entry.source_identity != source_identity,
                entry.episode.abs_diff(episode),
            )
        });
        let evaluated = latest_references
            .iter()
            .filter_map(|reference| {
                let range = find_shared_outro_with_minimum(
                    &current,
                    &reference.points,
                    MIN_FEEDBACK_OUTRO_SECONDS,
                    required_buffer_seconds,
                )?;
                let absolute_start = window_start_seconds + range.start;
                let reference_absolute_start =
                    reference.window_start_seconds + range.reference_start;
                let accepted = range.end - range.start >= MIN_OUTRO_MATCH_SECONDS
                    && absolute_start >= duration_seconds * 0.55
                    && absolute_start < duration_seconds - 5.0
                    && reference_absolute_start >= reference.duration_seconds * 0.55
                    && reference_absolute_start < reference.duration_seconds - 5.0;
                Some((
                    reference.source_identity == source_identity,
                    reference.episode,
                    reference.duration_seconds,
                    reference.window_start_seconds,
                    range,
                    accepted,
                ))
            })
            .collect::<Vec<_>>();
        let matched = evaluated
            .iter()
            .copied()
            .filter(|entry| entry.5)
            .max_by(|left, right| {
                left.0.cmp(&right.0).then_with(|| {
                    (left.4.end - left.4.start)
                        .partial_cmp(&(right.4.end - right.4.start))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            })
            .map(|entry| (entry.0, entry.1, entry.2, entry.3, entry.4));
        let feedback_candidate = evaluated
            .iter()
            .copied()
            .filter(|entry| {
                let absolute_start = window_start_seconds + entry.4.start;
                !entry.5
                    && absolute_start >= duration_seconds * 0.55
                    && absolute_start < duration_seconds - MIN_FEEDBACK_OUTRO_SECONDS
            })
            .max_by(|left, right| {
                (left.4.end - left.4.start)
                    .partial_cmp(&(right.4.end - right.4.start))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .and_then(|entry| {
                let matched_seconds = entry.4.end - entry.4.start;
                feedback_candidate_from_range(
                    "outro",
                    window_start_seconds + entry.4.start,
                    duration_seconds,
                    "intro-skipper-outro",
                    if matched_seconds < MIN_OUTRO_MATCH_SECONDS {
                        "short-outro-fingerprint-match"
                    } else {
                        "reference-placement-mismatch"
                    },
                    Some(matched_seconds / MIN_OUTRO_MATCH_SECONDS),
                )
            });
        if let Err(error) = store_episode_outro_fingerprint(
            &path,
            &mut latest_cache,
            episode,
            &source_identity,
            &selected_audio.identity,
            duration_seconds,
            window_start_seconds,
            &current,
        ) {
            warn!("[Segment Detection][Local][Outro] Fingerprint cache write failed: {error}");
        }
        (
            matched,
            feedback_candidate,
            latest_cache.episodes.len(),
            latest_references.len(),
        )
    };
    let Some((_, reference_episode, reference_duration, reference_window_start, range)) = matched
    else {
        let mut feedback_candidate = feedback_candidate;
        let status = if reference_count == 0 {
            "learned"
        } else {
            "no-match"
        };
        info!(
            "[Segment Detection][Local][Outro] Audio complete: status={}, cached_episodes={}",
            status, cached_episode_count
        );
        info!(
            "[Segment Detection][Local][Outro][Visual] Fallback analysis started: window_start={:.1}s, analysis_window={:.1}s, season={}, episode={}",
            window_start_seconds, analysis_seconds, season, episode
        );
        match detect_visual_outro_diagnostic(
            &app,
            &current_url,
            window_start_seconds,
            analysis_seconds,
            duration_seconds,
        )
        .await
        {
            Ok(VisualOutroDiagnostic {
                candidate: Some(candidate),
                sampled_frames,
            }) => {
                if let Some(segment) = visual_outro_fallback_segment(candidate, duration_seconds) {
                    info!(
                        "[Segment Detection][Local][Outro][Visual] Fallback complete: status=detected, start={:.3}, end={:.3}, span={:.1}s, dark_density={:.3}, content_density={:.3}, mean_black={:.1}, sampled_frames={}, season={}, episode={}",
                        candidate.start_seconds,
                        duration_seconds,
                        candidate.end_seconds - candidate.start_seconds,
                        candidate.dark_density,
                        candidate.content_density,
                        candidate.mean_black_percent,
                        sampled_frames,
                        season,
                        episode
                    );
                    return Ok(IntroSkipperDetectionResult {
                        segment: Some(segment),
                        candidate: None,
                        status: "detected".to_string(),
                        reference_episode: None,
                        reference_end_sec: None,
                        cached_episode_count,
                        buffered_seconds,
                        required_buffer_seconds,
                    });
                }
                info!(
                    "[Segment Detection][Local][Outro][Visual] Fallback complete: status=rejected, start={:.3}, end={:.3}, span={:.1}s, dark_density={:.3}, content_density={:.3}, mean_black={:.1}, sampled_frames={}, season={}, episode={}",
                    candidate.start_seconds,
                    candidate.end_seconds,
                    candidate.end_seconds - candidate.start_seconds,
                    candidate.dark_density,
                    candidate.content_density,
                    candidate.mean_black_percent,
                    sampled_frames,
                    season,
                    episode
                );
                let span_score = (candidate.end_seconds - candidate.start_seconds)
                    / VISUAL_OUTRO_AUTO_MIN_SECONDS;
                let visual_score = span_score
                    .min(candidate.dark_density / VISUAL_OUTRO_AUTO_MIN_DARK_DENSITY)
                    .min(candidate.content_density / VISUAL_OUTRO_AUTO_MIN_CONTENT_DENSITY)
                    .min(candidate.mean_black_percent / VISUAL_OUTRO_AUTO_MIN_MEAN_BLACK_PERCENT);
                let visual_candidate = (candidate.start_seconds >= duration_seconds * 0.55
                    && candidate.end_seconds >= duration_seconds - 120.0)
                    .then(|| {
                        feedback_candidate_from_range(
                            "outro",
                            candidate.start_seconds,
                            duration_seconds,
                            "intro-skipper-outro",
                            "visual-credit-near-match",
                            Some(visual_score),
                        )
                    })
                    .flatten();
                if visual_candidate.as_ref().and_then(|value| value.score)
                    > feedback_candidate.as_ref().and_then(|value| value.score)
                {
                    feedback_candidate = visual_candidate;
                }
            }
            Ok(VisualOutroDiagnostic {
                candidate: None,
                sampled_frames,
            }) => info!(
                "[Segment Detection][Local][Outro][Visual] Fallback complete: status=no-candidate, sampled_frames={}, season={}, episode={}",
                sampled_frames, season, episode
            ),
            Err(error) => warn!(
                "[Segment Detection][Local][Outro][Visual] Fallback failed: season={}, episode={}, error={}",
                season, episode, error
            ),
        }
        info!(
            "[Segment Detection][Local][Outro] Complete: status={}, cached_episodes={}",
            status, cached_episode_count
        );
        return Ok(IntroSkipperDetectionResult {
            segment: None,
            candidate: feedback_candidate,
            status: status.to_string(),
            reference_episode: None,
            reference_end_sec: None,
            cached_episode_count,
            buffered_seconds,
            required_buffer_seconds,
        });
    };

    let absolute_start = window_start_seconds + range.start;
    let reference_absolute_start = reference_window_start + range.reference_start;
    let segment = segment_from_range(absolute_start, duration_seconds, "intro-skipper-outro");
    schedule_visual_outro_diagnostic(
        app.clone(),
        &series_key,
        season,
        episode,
        &current_url,
        window_start_seconds,
        analysis_seconds,
        duration_seconds,
    );
    info!(
        "[Segment Detection][Local][Outro] Complete: status=detected, reference_episode={}, start={:.3}, end={:.3}, reference_start={:.3}, matched_seconds={:.1}, cached_episodes={}",
        reference_episode,
        absolute_start,
        duration_seconds,
        reference_absolute_start,
        range.end - range.start,
        cached_episode_count
    );
    Ok(IntroSkipperDetectionResult {
        segment,
        candidate: None,
        status: "detected".to_string(),
        reference_episode: Some(reference_episode),
        reference_end_sec: Some(reference_duration),
        cached_episode_count,
        buffered_seconds,
        required_buffer_seconds,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varied_points(length: usize, seed: u32) -> Vec<u32> {
        (0..length)
            .scan(seed, |state, index| {
                *state = state
                    .wrapping_mul(1_664_525)
                    .wrapping_add(1_013_904_223 ^ index as u32);
                Some(*state)
            })
            .collect()
    }

    #[test]
    fn finds_shifted_shared_audio_region() {
        let shared = varied_points(360, 42);
        let mut lhs = varied_points(200, 10);
        lhs.extend_from_slice(&shared);
        lhs.extend(varied_points(400, 11));
        let mut rhs = varied_points(430, 20);
        rhs.extend_from_slice(&shared);
        rhs.extend(varied_points(170, 21));

        let matched = find_shared_intro(&lhs, &rhs).expect("shared intro should be found");
        assert!((matched.start - 200.0 * SAMPLE_DURATION_SECONDS).abs() < 0.01);
        assert!((matched.end - 560.0 * SAMPLE_DURATION_SECONDS).abs() < 0.01);
        assert!((matched.reference_start - 430.0 * SAMPLE_DURATION_SECONDS).abs() < 0.01);
        assert!((matched.reference_end - 790.0 * SAMPLE_DURATION_SECONDS).abs() < 0.01);
    }

    #[test]
    fn finds_fuzzy_shifted_audio_without_exact_fingerprint_points() {
        let shared = varied_points(400, 52);
        let fuzzy_shared = shared
            .iter()
            .map(|point| point ^ 0x0000_07ff)
            .collect::<Vec<_>>();
        let mut lhs = varied_points(300, 60);
        lhs.extend_from_slice(&shared);
        lhs.extend(varied_points(500, 61));
        let mut rhs = varied_points(520, 70);
        rhs.extend_from_slice(&fuzzy_shared);
        rhs.extend(varied_points(280, 71));

        assert!(candidate_shifts(&lhs, &rhs).is_empty());
        let matched = find_shared_intro(&lhs, &rhs).expect("fuzzy intro should be found");
        assert_eq!(matched.method, IntroMatchMethod::Fuzzy);
        assert!(intro_match_is_eligible(&matched));
        let expected_start = 300.0 * SAMPLE_DURATION_SECONDS;
        let expected_end = 700.0 * SAMPLE_DURATION_SECONDS;
        let expected_reference_start = 520.0 * SAMPLE_DURATION_SECONDS;
        let expected_reference_end = 920.0 * SAMPLE_DURATION_SECONDS;
        assert!(matched.start <= expected_start);
        assert!(expected_start - matched.start <= 5.0);
        assert!(matched.end >= expected_end);
        assert!(matched.end - expected_end <= 3.0);
        assert!(matched.reference_start <= expected_reference_start);
        assert!(expected_reference_start - matched.reference_start <= 5.0);
        assert!(matched.reference_end >= expected_reference_end);
        assert!(matched.reference_end - expected_reference_end <= 3.0);
        assert!(matched.end - matched.start >= MIN_INTRO_SECONDS);
        assert!(matched.end - matched.start <= MAX_INTRO_SECONDS);
    }

    #[test]
    fn rejects_short_single_reference_fuzzy_intro_candidate() {
        let shared = varied_points(135, 82);
        let fuzzy_shared = shared
            .iter()
            .map(|point| point ^ 0x0000_07ff)
            .collect::<Vec<_>>();
        let mut lhs = varied_points(1_500, 90);
        lhs.extend_from_slice(&shared);
        lhs.extend(varied_points(1_500, 91));
        let mut rhs = varied_points(1_000, 92);
        rhs.extend_from_slice(&fuzzy_shared);
        rhs.extend(varied_points(2_000, 93));

        assert!(candidate_shifts(&lhs, &rhs).is_empty());
        let matched =
            find_shared_intro(&lhs, &rhs).expect("borderline fuzzy match should be measured");
        assert_eq!(matched.method, IntroMatchMethod::Fuzzy);
        assert!(matched.end - matched.start >= MIN_INTRO_SECONDS);
        assert!(matched.end - matched.start < MIN_FUZZY_INTRO_SECONDS);
        assert!(!intro_match_is_eligible(&matched));
    }

    #[test]
    fn outro_analysis_window_scales_without_changing_intro_limits() {
        assert_eq!(intro_analysis_seconds(20.0 * 60.0), 300);
        assert_eq!(intro_analysis_seconds(60.0 * 60.0), 420);
        assert_eq!(intro_analysis_window(60.0 * 60.0, 1), Some((0.0, 420)));
        assert_eq!(intro_analysis_window(60.0 * 60.0, 2), Some((360.0, 420)));
        assert_eq!(intro_analysis_window(20.0 * 60.0, 2), Some((240.0, 300)));
        assert_eq!(intro_analysis_window(60.0 * 60.0, 3), None);
        assert_eq!(outro_analysis_seconds(8.0 * 60.0), 120);
        assert_eq!(outro_analysis_seconds(22.0 * 60.0), 330);
        assert_eq!(outro_analysis_seconds(60.0 * 60.0), 720);
        assert_eq!(audio_extraction_timeout(120), Duration::from_secs(150));
        assert_eq!(audio_extraction_timeout(720), Duration::from_secs(300));

        let shared = varied_points(1_600, 77);
        let mut lhs = varied_points(120, 31);
        lhs.extend_from_slice(&shared);
        let mut rhs = varied_points(240, 32);
        rhs.extend_from_slice(&shared);
        assert!(find_shared_intro(&lhs, &rhs).is_none());
        let outro = find_shared_outro(&lhs, &rhs, 720.0).expect("long outro should match");
        assert!(outro.end - outro.start > MAX_INTRO_SECONDS);
    }

    #[test]
    fn parses_blackframe_diagnostic_samples() {
        assert_eq!(
            parse_blackframe_percent(
                "[Parsed_blackframe_2] frame:12 pblack:97 pts:6000 t:0.500000 type:P"
            ),
            Some(97.0)
        );
        assert_eq!(parse_blackframe_percent("pblack:99.5 frame:20"), Some(99.5));
        assert_eq!(parse_blackframe_percent("pblack:invalid"), None);
        assert_eq!(parse_blackframe_percent("unrelated diagnostic"), None);
        assert_eq!(
            parse_blackframe_sample("[ffmpeg] frame:12 pblack:97 pts:6000"),
            Some((12, 97.0))
        );
        assert_eq!(
            collect_blackframe_percentages(
                "[ffmpeg] frame:0 pblack:80 pts:0\n[ffmpeg] frame:2 pblack:90 pts:2"
            ),
            vec![80.0, 0.0, 90.0]
        );
    }

    #[test]
    fn finds_sustained_black_background_with_visible_content() {
        let mut samples = vec![35.0; 30];
        samples.extend((0..80).map(|index| if index % 2 == 0 { 98.0 } else { 100.0 }));
        samples.splice(65..68, [40.0, 40.0, 40.0]);

        let candidate = find_visual_credit_candidate(&samples, 900.0, 1_200.0)
            .expect("sustained black-background sequence should be reported");
        assert!((candidate.start_seconds - 915.0).abs() < 0.01);
        assert!(candidate.end_seconds - candidate.start_seconds >= 39.0);
        assert!(candidate.dark_density >= VISUAL_OUTRO_MIN_DARK_DENSITY);
        assert!(candidate.content_density >= VISUAL_OUTRO_MIN_CONTENT_DENSITY);
    }

    #[test]
    fn rejects_pure_black_and_short_fades() {
        assert!(find_visual_credit_candidate(&vec![100.0; 120], 900.0, 1_200.0).is_none());

        let mut short_fade = vec![25.0; 20];
        short_fade.extend((0..16).map(|index| if index % 2 == 0 { 97.0 } else { 100.0 }));
        assert!(find_visual_credit_candidate(&short_fade, 900.0, 1_200.0).is_none());
    }

    #[test]
    fn promotes_only_high_confidence_visual_outros_reaching_eof() {
        let candidate = VisualCreditCandidate {
            start_seconds: 1_080.0,
            end_seconds: 1_200.0,
            dark_density: 0.99,
            content_density: 0.95,
            mean_black_percent: 94.5,
        };
        let segment = visual_outro_fallback_segment(candidate, 1_200.0)
            .expect("strong EOF visual candidate should be promoted");
        assert_eq!(segment.source, "intro-skipper-outro");
        assert_eq!(segment.start_sec, 1_080.0);
        assert_eq!(segment.end_sec, 1_200.0);

        assert!(visual_outro_fallback_segment(
            VisualCreditCandidate {
                end_seconds: 1_197.5,
                ..candidate
            },
            1_200.0,
        )
        .is_none());
        assert!(visual_outro_fallback_segment(
            VisualCreditCandidate {
                mean_black_percent: 89.9,
                ..candidate
            },
            1_200.0,
        )
        .is_none());
    }

    #[test]
    fn sparse_cache_coverage_controls_fingerprint_readiness() {
        let partial = crate::FingerprintCacheWindowStatus {
            covered_bytes: 25,
            required_bytes: 100,
            pinned_bytes: 200,
        };
        assert_eq!(cache_window_buffered_seconds(&partial, 420.0), 105.0);

        let ready = crate::FingerprintCacheWindowStatus {
            covered_bytes: 100,
            required_bytes: 100,
            pinned_bytes: 200,
        };
        assert_eq!(cache_window_buffered_seconds(&ready, 420.0), 420.0);

        assert_eq!(
            opening_cache_buffered_seconds(Some(&partial), Some(300.0), 420.0),
            300.0
        );
        assert_eq!(
            opening_cache_buffered_seconds(Some(&partial), Some(500.0), 420.0),
            420.0
        );
        assert_eq!(
            opening_cache_buffered_seconds(Some(&partial), None, 420.0),
            105.0
        );
        assert_eq!(
            opening_cache_buffered_seconds(Some(&partial), Some(839.0), 780.0),
            780.0
        );
    }

    #[test]
    fn audio_identity_allows_same_language_across_release_encodes() {
        let release_a = "lang=eng|title=english|codec=aac|channels=2|external=false";
        let release_b = "lang=eng|title=english 5.1|codec=eac3|channels=6|external=false";
        let different_language = "lang=jpn|title=japanese|codec=aac|channels=2|external=false";
        let unknown_language = "lang=und|title=main|codec=aac|channels=2|external=false";

        assert!(audio_identities_compatible(release_a, release_a));
        assert!(audio_identities_compatible(release_a, release_b));
        assert!(!audio_identities_compatible(release_a, different_language));
        assert!(!audio_identities_compatible(
            unknown_language,
            "lang=und|title=main 5.1|codec=eac3|channels=6|external=false"
        ));
    }

    #[test]
    fn persisted_cache_keeps_source_and_audio_variants_without_cross_language_matching() {
        assert!(source_durations_compatible(2_700.0, 2_880.0));
        assert!(!source_durations_compatible(1_200.0, 2_700.0));

        let root = std::env::temp_dir().join(format!(
            "streamee-intro-cache-variants-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = root.join("season.json");
        let mut cache = SeasonFingerprintCache::default();
        store_episode_fingerprint(
            &path,
            &mut cache,
            1,
            "source-a",
            "english",
            2_700.0,
            0.0,
            1,
            &[1, 2],
        )
        .unwrap();
        store_episode_fingerprint(
            &path,
            &mut cache,
            1,
            "source-b",
            "english",
            2_710.0,
            0.0,
            1,
            &[3, 4],
        )
        .unwrap();
        store_episode_fingerprint(
            &path,
            &mut cache,
            1,
            "source-b",
            "japanese",
            2_710.0,
            0.0,
            1,
            &[5, 6],
        )
        .unwrap();
        store_episode_fingerprint(
            &path,
            &mut cache,
            1,
            "source-b",
            "english",
            2_710.0,
            360.0,
            2,
            &[7, 8],
        )
        .unwrap();

        assert_eq!(cache.episodes.len(), 4);
        assert_eq!(
            cache
                .episodes
                .iter()
                .filter(|entry| entry.audio_identity == "english")
                .count(),
            3
        );
        assert_eq!(
            cache
                .episodes
                .iter()
                .filter(|entry| entry.audio_identity == "japanese")
                .count(),
            1
        );
        assert_eq!(
            cache
                .episodes
                .iter()
                .filter(|entry| entry.analysis_part == 2)
                .count(),
            1
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn fingerprint_cache_budget_evicts_oldest_direct_files_only() {
        let root = std::env::temp_dir().join(format!(
            "streamee-intro-cache-budget-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let tail_work = root.join("tail-work");
        fs::create_dir_all(&tail_work).unwrap();
        let file_size = 800 * 1024;
        for name in ["a.json", "b.json", "c.json"] {
            fs::write(root.join(name), vec![1u8; file_size]).unwrap();
            std::thread::sleep(Duration::from_millis(5));
        }
        fs::write(tail_work.join("transient.wav"), vec![2u8; 3 * 1024 * 1024]).unwrap();

        enforce_fingerprint_cache_budget(&root, FINGERPRINT_CACHE_MAX_BYTES).unwrap();

        assert!(!root.join("a.json").exists());
        assert!(root.join("b.json").exists());
        assert!(root.join("c.json").exists());
        assert!(tail_work.join("transient.wav").exists());
        let remaining_bytes = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.metadata().ok())
            .filter(|metadata| metadata.is_file())
            .map(|metadata| metadata.len())
            .sum::<u64>();
        assert!(remaining_bytes <= FINGERPRINT_CACHE_MAX_BYTES);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cache_only_tail_url_preserves_existing_query() {
        let url =
            cache_only_media_source("http://127.0.0.1:1234/addon/1?filename=Episode%2001.mkv")
                .expect("cache-only URL");
        let parsed = reqwest::Url::parse(&url).expect("parse cache-only URL");
        let query = parsed.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(
            query.get("filename").map(|value| value.as_ref()),
            Some("Episode 01.mkv")
        );
        assert_eq!(
            query.get("streamee-cache-only").map(|value| value.as_ref()),
            Some("1")
        );
    }

    #[test]
    fn recognizes_named_intro_recap_and_credits_chapters() {
        let chapters = vec![
            MpvChapter {
                title: "Previously On".to_string(),
                time: 0.0,
            },
            MpvChapter {
                title: "Opening".to_string(),
                time: 75.0,
            },
            MpvChapter {
                title: "Episode".to_string(),
                time: 135.0,
            },
            MpvChapter {
                title: "End Credits".to_string(),
                time: 2_300.0,
            },
        ];
        let segments = detect_chapter_segments(&chapters, 2_400.0);
        assert_eq!(segments.recap.expect("recap").end_sec, 75.0);
        assert_eq!(segments.intro.expect("intro").end_sec, 135.0);
        assert_eq!(segments.outro.expect("outro").end_sec, 2_400.0);
    }

    #[test]
    fn credits_chapter_must_start_at_least_ten_seconds_before_eof() {
        for title in ["Credits", "Outro"] {
            let accepted = detect_chapter_segments(
                &[MpvChapter {
                    title: title.to_string(),
                    time: 590.0,
                }],
                600.0,
            );
            assert_eq!(accepted.outro.expect("outro at threshold").start_sec, 590.0);

            let rejected = detect_chapter_segments(
                &[MpvChapter {
                    title: title.to_string(),
                    time: 595.0,
                }],
                600.0,
            );
            assert!(rejected.outro.is_none());
            let candidate = rejected.candidate.expect("short labeled candidate");
            assert_eq!(candidate.kind, "outro");
            assert_eq!(candidate.reason, "short-labeled-outro-chapter");
        }
    }

    #[test]
    fn offers_unlabeled_final_chapter_as_feedback_candidate() {
        let segments = detect_chapter_segments(
            &[
                MpvChapter {
                    title: "Chapter 1".to_string(),
                    time: 0.0,
                },
                MpvChapter {
                    title: "Chapter 8".to_string(),
                    time: 1_120.0,
                },
            ],
            1_200.0,
        );
        assert!(segments.outro.is_none());
        let candidate = segments
            .candidate
            .expect("unlabeled final chapter candidate");
        assert_eq!(candidate.start_sec, 1_120.0);
        assert_eq!(candidate.end_sec, 1_200.0);
        assert_eq!(candidate.reason, "unlabeled-final-chapter");
    }

    #[test]
    fn does_not_offer_tiny_or_early_generic_chapters() {
        let tiny = detect_chapter_segments(
            &[MpvChapter {
                title: "Chapter 12".to_string(),
                time: 1_196.0,
            }],
            1_200.0,
        );
        assert!(tiny.candidate.is_none());

        let early = detect_chapter_segments(
            &[MpvChapter {
                title: "Chapter 2".to_string(),
                time: 300.0,
            }],
            1_200.0,
        );
        assert!(early.candidate.is_none());
    }

    #[test]
    fn rejects_generic_and_implausibly_late_chapters() {
        let chapters = vec![
            MpvChapter {
                title: "Chapter 1".to_string(),
                time: 0.0,
            },
            MpvChapter {
                title: "Opening".to_string(),
                time: 1_800.0,
            },
            MpvChapter {
                title: "Chapter 3".to_string(),
                time: 1_900.0,
            },
        ];
        let segments = detect_chapter_segments(&chapters, 2_400.0);
        assert!(segments.intro.is_none());
        assert!(segments.recap.is_none());
        assert!(segments.outro.is_none());
    }

    #[test]
    fn rejects_low_detail_fingerprints() {
        assert!(!fingerprint_has_enough_detail(&vec![7; 500]));
        assert!(fingerprint_has_enough_detail(&varied_points(500, 9)));
    }

    #[test]
    fn rejects_truncated_analysis_windows() {
        let expected_points = (300.0 / SAMPLE_DURATION_SECONDS) as usize;
        assert!(!fingerprint_covers_analysis_window(
            &varied_points(expected_points / 2, 12),
            300,
        ));
        assert!(fingerprint_covers_analysis_window(
            &varied_points(expected_points, 13),
            300,
        ));
    }

    #[test]
    fn labels_fingerprint_segments_separately_from_chapters() {
        let fingerprint = segment_from_range(30.0, 90.0, "intro-skipper")
            .expect("fingerprint segment should be valid");
        let chapter = segment_from_range(30.0, 90.0, "chapter").expect("chapter should be valid");
        assert_eq!(fingerprint.source, "intro-skipper");
        assert_eq!(chapter.source, "chapter");
    }

    #[test]
    fn media_source_validation_allows_only_local_files_and_loopback_streams() {
        assert!(validate_media_source("http://127.0.0.1:1234/stream/1").is_ok());
        assert!(validate_media_source("http://localhost:1234/stream/1").is_ok());
        assert!(validate_media_source("https://example.com/video.mkv").is_err());
        assert!(validate_media_source("http://192.168.1.10/video.mkv").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn packaged_fpcalc_accepts_loopback_audio_through_stdin_bridge() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        const SAMPLE_RATE: u32 = 11_025;
        const SECONDS: u32 = 8;
        let mut pcm = Vec::with_capacity((SAMPLE_RATE * SECONDS * 2) as usize);
        for index in 0..SAMPLE_RATE * SECONDS {
            let phase = index as f64 / SAMPLE_RATE as f64;
            let frequency = 220.0 + (index / SAMPLE_RATE) as f64 * 37.0;
            let sample = (12_000.0 * (std::f64::consts::TAU * frequency * phase).sin()) as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        let mut wav = Vec::with_capacity(44 + pcm.len());
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
        wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        wav.extend_from_slice(&pcm);

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback test server");
        let address = listener.local_addr().expect("read loopback address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept fpcalc bridge request");
            let mut request = [0u8; 2_048];
            let request_len = stream.read(&mut request).expect("read bridge request");
            let request_text =
                String::from_utf8_lossy(&request[..request_len]).to_ascii_lowercase();
            assert!(
                request_text.contains("\r\nrange: bytes=0-\r\n"),
                "fingerprint bridge must request the cached opening range"
            );
            assert!(
                request_text.contains("\r\nx-streamee-cache-only: 1\r\n"),
                "fingerprint bridge must prohibit upstream cache fills"
            );
            write!(
                stream,
                "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/wav\r\nContent-Range: bytes 0-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                wav.len() - 1,
                wav.len(),
                wav.len(),
            )
            .expect("write bridge headers");
            stream.write_all(&wav).expect("write bridge audio");
        });

        let fpcalc_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/fpcalc.exe");
        let runtime = tokio::runtime::Runtime::new().expect("create bridge test runtime");
        let output = runtime
            .block_on(run_fpcalc(
                &fpcalc_path,
                &format!("http://{address}/audio.wav"),
                SECONDS as u64,
            ))
            .expect("run packaged fpcalc bridge");
        server.join().expect("join bridge test server");
        assert!(
            output.status.success(),
            "fpcalc stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let parsed = serde_json::from_slice::<FpcalcOutput>(&output.stdout)
            .expect("parse fpcalc bridge output");
        assert!(!parsed.fingerprint.is_empty());
    }
}
