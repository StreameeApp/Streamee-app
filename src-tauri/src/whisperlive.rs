use std::ffi::OsStr;
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;

use crate::mpv_ipc::{get_player_info, get_selected_audio_ff_index, upsert_live_subtitle_file};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration};
use tracing::{debug, error, info, warn};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

const SERVER_SCRIPT_NAME: &str = "whisperlive_server.py";
const CLIENT_SCRIPT_NAME: &str = "whisperlive_client.py";
const DEFAULT_MODEL: &str = "small";
const CLIENT_TIMEOUT_MS: u64 = 60 * 60 * 1000;
const SERVER_READY_TIMEOUT_SECS: u64 = 120;
const PORT_BIND_RETRIES: u32 = 20;
const PORT_BIND_DELAY_MS: u64 = 500;
const LIVE_MPV_SUBTITLE_MAX_CUES: usize = 120;
const WHISPER_LOOKAHEAD_SECONDS: f64 = 10.0;

static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle<tauri::Wry>> = std::sync::OnceLock::new();

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct WhisperLiveState {
    pub server_process: Option<tokio::process::Child>,
    pub server_port: Option<u16>,
    pub server_pid: Option<u32>,
    pub client_pid: Option<u32>,
    pub server_model: Option<String>,
    pub server_device_mode: Option<String>,
}

impl Default for WhisperLiveState {
    fn default() -> Self {
        Self {
            server_process: None,
            server_port: None,
            server_pid: None,
            client_pid: None,
            server_model: None,
            server_device_mode: None,
        }
    }
}

pub type SharedWhisperLiveState = Arc<Mutex<WhisperLiveState>>;

// ---------------------------------------------------------------------------
// Serialisable event types
// ---------------------------------------------------------------------------

// Subset for the subtitle://progress event shape already expected by the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SubtitleProgressPayload {
    session_id: u64,
    phase: String,
    progress: f64,
    message: String,
    downloaded: Option<u64>,
    total: Option<u64>,
    title: Option<String>,
}

// The shape emitted as subtitle://segment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleSegmentPayload {
    pub session_id: u64,
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub completed: bool,
}

#[derive(Debug, Deserialize)]
struct WhisperSidecarLog {
    level: String,
    #[serde(default = "default_whisper_source")]
    source: String,
    #[serde(default = "default_whisper_source")]
    subsystem: String,
    event: String,
    message: String,
    #[serde(default)]
    session_id: Option<serde_json::Value>,
    #[serde(default)]
    fields: serde_json::Value,
}

fn default_whisper_source() -> String {
    "whisper".to_string()
}

fn emit_whisper_sidecar_line(line: &str, fallback_subsystem: &str) {
    let Ok(mut entry) = serde_json::from_str::<WhisperSidecarLog>(line) else {
        warn!(
            target: "streamee_lib::whisperlive::sidecar",
            source = "whisper",
            subsystem = %fallback_subsystem,
            event = "sidecar.unstructured_stderr",
            raw = %crate::logging::redact_text(line),
            "Whisper emitted an unstructured stderr line"
        );
        return;
    };
    if let Some(session_id) = entry.session_id.take() {
        if !entry.fields.is_object() {
            entry.fields = serde_json::json!({});
        }
        if let Some(fields) = entry.fields.as_object_mut() {
            fields.insert("session_id".to_string(), session_id);
        }
    }
    crate::logging::redact_json_value(&mut entry.fields);
    let fields_json = serde_json::to_string(&entry.fields).unwrap_or_else(|_| "{}".to_string());
    let message = crate::logging::redact_text(&entry.message);
    match entry.level.trim().to_ascii_lowercase().as_str() {
        "debug" => debug!(
            target: "streamee_lib::whisperlive::sidecar",
            source = %entry.source,
            subsystem = %entry.subsystem,
            event = %entry.event,
            fields_json = %fields_json,
            "{message}"
        ),
        "info" => info!(
            target: "streamee_lib::whisperlive::sidecar",
            source = %entry.source,
            subsystem = %entry.subsystem,
            event = %entry.event,
            fields_json = %fields_json,
            "{message}"
        ),
        "error" | "critical" => error!(
            target: "streamee_lib::whisperlive::sidecar",
            source = %entry.source,
            subsystem = %entry.subsystem,
            event = %entry.event,
            fields_json = %fields_json,
            "{message}"
        ),
        _ => warn!(
            target: "streamee_lib::whisperlive::sidecar",
            source = %entry.source,
            subsystem = %entry.subsystem,
            event = %entry.event,
            fields_json = %fields_json,
            "{message}"
        ),
    }
}

#[derive(Debug, Clone)]
struct LiveMpvCue {
    start: f64,
    end: f64,
    text: String,
}

#[derive(Debug, Default)]
struct LiveMpvSubtitleState {
    cues: Vec<LiveMpvCue>,
    dirty: bool,
}

// ---------------------------------------------------------------------------
// Runtime info (returned by test_whisperlive_runtime)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperLiveRuntimeInfo {
    pub python_available: bool,
    pub python_version: Option<String>,
    pub whisper_live_installed: bool,
    pub websocket_client_installed: bool,
    pub cuda_available: bool,
    pub ffmpeg_available: bool,
    pub deep_tested: bool,
    pub model_load_ok: bool,
    pub requested_mode: String,
    pub resolved_mode: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn cache_root() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("Streamee")
        .join("subtitles")
}

fn ensure_cache_dir() -> Result<std::path::PathBuf, String> {
    let dir = cache_root();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create cache dir: {}", e))?;
    Ok(dir)
}

pub fn set_app_handle(app: tauri::AppHandle<tauri::Wry>) {
    let _ = APP_HANDLE.set(app);
}

fn get_app_handle() -> Option<tauri::AppHandle<tauri::Wry>> {
    APP_HANDLE.get().cloned()
}

#[cfg(windows)]
fn hide_console_std(command: &mut std::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW.0);
}

#[cfg(not(windows))]
fn hide_console_std(_command: &mut std::process::Command) {}

#[cfg(windows)]
fn hide_console_tokio(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW.0);
}

#[cfg(not(windows))]
fn hide_console_tokio(_command: &mut Command) {}

fn terminate_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("taskkill");
        hide_console_std(&mut cmd);
        let status = cmd
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .status()
            .map_err(|e| format!("Failed to terminate process {}: {}", pid, e))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("taskkill failed for process {}", pid))
        }
    }

    #[cfg(not(windows))]
    {
        let status = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status()
            .map_err(|e| format!("Failed to terminate process {}: {}", pid, e))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("kill failed for process {}", pid))
        }
    }
}

async fn stop_client_process(state: &SharedWhisperLiveState) {
    let client_pid = {
        let mut guard = state.lock().await;
        guard.client_pid.take()
    };

    if let Some(pid) = client_pid {
        info!("Stopping WhisperLive client pid={}", pid);
        if let Err(err) = terminate_process_tree(pid) {
            info!("Failed to stop WhisperLive client pid={}: {}", pid, err);
        }
    }
}

fn ensure_script(name: &str, content: &str) -> Result<std::path::PathBuf, String> {
    let dir = ensure_cache_dir()?;
    let path = dir.join(name);

    let should_write = match fs::read_to_string(&path) {
        Ok(existing) => existing != content,
        Err(_) => true,
    };

    if should_write {
        fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", name, e))?;
    }

    Ok(path)
}

fn bundled_python_path() -> Option<PathBuf> {
    if let Some(app) = get_app_handle() {
        for rel in ["mpv/python.exe", "mpv/python3.exe"] {
            if let Ok(path) = app
                .path()
                .resolve(rel, tauri::path::BaseDirectory::Resource)
            {
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }

    for rel in ["mpv/python.exe", "mpv/python3.exe"] {
        let path = PathBuf::from(rel);
        if path.exists() {
            return Some(path);
        }
    }

    #[cfg(debug_assertions)]
    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        if let Some(workspace_dir) = Path::new(manifest_dir).parent() {
            for executable in ["python.exe", "python3.exe"] {
                let path = workspace_dir.join("mpv").join(executable);
                if path.exists() {
                    return Some(path);
                }
            }
        }
    }

    None
}

fn whisper_packages_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::env::temp_dir())
        .join("Streamee")
        .join("whisperlive")
        .join("site-packages")
}

fn bundled_python_pth_path() -> Option<PathBuf> {
    bundled_python_path().and_then(|python| python.parent().map(|dir| dir.join("python312._pth")))
}

fn ensure_bundled_python_paths() -> Result<PathBuf, String> {
    let site_packages = whisper_packages_dir();
    fs::create_dir_all(&site_packages)
        .map_err(|e| format!("Failed to create bundled Python site-packages dir: {}", e))?;

    let Some(pth_path) = bundled_python_pth_path() else {
        return Ok(site_packages);
    };

    let current = fs::read_to_string(&pth_path).unwrap_or_default();
    let mut lines = current
        .lines()
        .map(|line| line.trim_end().to_string())
        .collect::<Vec<_>>();
    let site_entry = "Lib\\site-packages".to_string();
    let import_site_entry = "import site".to_string();
    let mut changed = false;

    if !lines
        .iter()
        .any(|line| line.eq_ignore_ascii_case(&site_entry))
    {
        lines.push(site_entry);
        changed = true;
    }
    if !lines
        .iter()
        .any(|line| line.eq_ignore_ascii_case(&import_site_entry))
    {
        lines.push(import_site_entry);
        changed = true;
    }

    if changed {
        let joined = lines.join("\n") + "\n";
        fs::write(&pth_path, joined)
            .map_err(|e| format!("Failed to update bundled Python path file: {}", e))?;
    }

    let bundled_site_packages = pth_path
        .parent()
        .ok_or_else(|| "Bundled Python path has no parent folder".to_string())?
        .join("Lib")
        .join("site-packages");
    fs::create_dir_all(&bundled_site_packages)
        .map_err(|e| format!("Failed to create bundled Python package folder: {}", e))?;
    let bridge_path = bundled_site_packages.join("streamee-whisper.pth");
    let bridge_content = format!("{}\n", site_packages.display());
    if fs::read_to_string(&bridge_path).ok().as_deref() != Some(bridge_content.as_str()) {
        fs::write(&bridge_path, bridge_content)
            .map_err(|e| format!("Failed to update bundled Python package bridge: {}", e))?;
    }

    Ok(site_packages)
}

fn whisper_python_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(bundled) = bundled_python_path() {
        candidates.push(bundled);
    }

    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        candidates.extend(local_python_core_paths(&local_app_data.join("Python")));

        let base = local_app_data.join("Programs").join("Python");
        for version in [
            "Python314",
            "Python313",
            "Python312",
            "Python311",
            "Python310",
        ] {
            candidates.push(base.join(version).join("python.exe"));
            candidates.push(base.join(version).join("python3.exe"));
        }
    }

    candidates.push(PathBuf::from(
        r"C:\ProgramData\chocolatey\bin\python3.14.exe",
    ));
    candidates.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin\python.exe"));
    candidates.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin\python3.exe"));

    for root in [
        r"C:\Python314",
        r"C:\Python313",
        r"C:\Python312",
        r"C:\Python311",
        r"C:\Python310",
    ] {
        candidates.push(PathBuf::from(root).join("python.exe"));
        candidates.push(PathBuf::from(root).join("python3.exe"));
    }

    candidates
}

fn local_python_core_paths(root: &Path) -> Vec<PathBuf> {
    let mut install_dirs = fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.to_ascii_lowercase().starts_with("pythoncore-"))
                    .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    install_dirs.sort_by(|left, right| right.cmp(left));

    let mut candidates = Vec::new();
    for install_dir in install_dirs {
        candidates.push(install_dir.join("python.exe"));
        candidates.push(install_dir.join("python3.exe"));
    }
    candidates
}

fn python_probe_succeeds(program: &OsStr, args: &[&str]) -> bool {
    let mut probe = std::process::Command::new(program);
    hide_console_std(&mut probe);
    match probe
        .args(args)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
    {
        Ok(status) => {
            let success = status.success();
            debug!(
                target: "streamee_lib::whisper",
                source = "rust",
                subsystem = "whisper.python",
                event = "whisper.python_probe_completed",
                program = %program.to_string_lossy(),
                status = status.code().unwrap_or(-1),
                success,
                "Whisper Python probe completed"
            );
            success
        }
        Err(error) => {
            warn!(
                target: "streamee_lib::whisper",
                source = "rust",
                subsystem = "whisper.python",
                event = "whisper.python_probe_failed",
                program = %program.to_string_lossy(),
                error_kind = "process_start",
                error = %error,
                "Whisper Python probe could not start"
            );
            false
        }
    }
}

fn configure_whisper_python_env(cmd: &mut Command) {
    let site_packages = whisper_packages_dir();
    let mut paths = vec![site_packages.to_string_lossy().to_string()];

    if let Some(bundled) = bundled_python_path().and_then(|python| {
        python
            .parent()
            .map(|dir| dir.join("Lib").join("site-packages"))
    }) {
        paths.push(bundled.to_string_lossy().to_string());
    }

    if let Ok(existing) = std::env::var("PYTHONPATH") {
        if !existing.trim().is_empty() {
            paths.push(existing);
        }
    }

    let merged = paths
        .into_iter()
        .filter(|path| !path.trim().is_empty())
        .collect::<Vec<_>>()
        .join(";");

    if !merged.is_empty() {
        cmd.env("PYTHONPATH", merged);
    }
}

fn live_mpv_subtitle_path() -> Result<std::path::PathBuf, String> {
    Ok(ensure_cache_dir()?.join("streamee-live.srt"))
}

fn format_srt_timestamp(seconds: f64) -> String {
    let clamped = seconds.max(0.0);
    let total_ms = (clamped * 1000.0).round() as u64;
    let hours = total_ms / 3_600_000;
    let minutes = (total_ms % 3_600_000) / 60_000;
    let secs = (total_ms % 60_000) / 1000;
    let millis = total_ms % 1000;
    format!("{:02}:{:02}:{:02},{:03}", hours, minutes, secs, millis)
}

fn write_live_mpv_subtitle_file(path: &std::path::Path, cues: &[LiveMpvCue]) -> Result<(), String> {
    let mut body = String::new();
    for (idx, cue) in cues.iter().enumerate() {
        body.push_str(&(idx + 1).to_string());
        body.push('\n');
        body.push_str(&format!(
            "{} --> {}\n",
            format_srt_timestamp(cue.start),
            format_srt_timestamp(cue.end)
        ));
        body.push_str(&cue.text);
        body.push_str("\n\n");
    }

    fs::write(path, body).map_err(|e| format!("Failed to write live MPV subtitle file: {}", e))
}

fn push_live_mpv_cue(cues: &mut Vec<LiveMpvCue>, start: f64, end: f64, text: String) {
    if text.is_empty() || end <= start {
        return;
    }

    if let Some(last) = cues.last_mut() {
        if last.text == text && start <= last.end + 0.35 {
            last.end = last.end.max(end);
            return;
        }
    }

    cues.push(LiveMpvCue { start, end, text });
    if cues.len() > LIVE_MPV_SUBTITLE_MAX_CUES {
        let remove_count = cues.len() - LIVE_MPV_SUBTITLE_MAX_CUES;
        cues.drain(0..remove_count);
    }
}

async fn flush_live_mpv_subtitles(
    path: &std::path::Path,
    state: &Arc<Mutex<LiveMpvSubtitleState>>,
) -> Result<bool, String> {
    let cues = {
        let mut guard = state.lock().await;
        if !guard.dirty {
            return Ok(false);
        }
        guard.dirty = false;
        guard.cues.clone()
    };

    if let Err(error) = write_live_mpv_subtitle_file(path, &cues) {
        state.lock().await.dirty = true;
        return Err(error);
    }
    if let Err(error) = upsert_live_subtitle_file(&path.to_string_lossy()) {
        state.lock().await.dirty = true;
        return Err(error);
    }
    Ok(true)
}

async fn resolve_whisper_restart_start_seconds(fallback_start_seconds: Option<f64>) -> f64 {
    if let Ok(info) = get_player_info().await {
        if let Some(playback_time) = info.get("playback_time").and_then(|value| value.as_f64()) {
            return (playback_time + WHISPER_LOOKAHEAD_SECONDS).max(0.0);
        }
    }

    (fallback_start_seconds.unwrap_or(0.0) + WHISPER_LOOKAHEAD_SECONDS).max(0.0)
}

async fn resolve_selected_audio_ff_index(session_id: u64) -> Result<i32, String> {
    let mut last_error = None;
    for _ in 0..20 {
        match get_selected_audio_ff_index() {
            Ok(Some(index)) => return Ok(index),
            Ok(None) => last_error = Some("MPV has no selected audio track".to_string()),
            Err(error) => last_error = Some(error),
        }
        sleep(Duration::from_millis(250)).await;
    }

    Err(format!(
        "Could not resolve MPV selected audio stream for WhisperLive session={}: {}",
        session_id,
        last_error.unwrap_or_else(|| "unknown MPV audio-track error".to_string())
    ))
}

fn python_command() -> Result<Command, String> {
    if let Err(error) = ensure_bundled_python_paths() {
        warn!("Could not prepare persistent WhisperLive package paths: {error}");
    }

    for path in whisper_python_paths() {
        if !path.exists() {
            continue;
        }
        if !python_probe_succeeds(path.as_os_str(), &[]) {
            warn!(
                "Skipping unusable WhisperLive Python candidate: {}",
                path.display()
            );
            continue;
        }
        info!("Using WhisperLive Python: {}", path.display());
        let mut cmd = Command::new(path);
        configure_whisper_python_env(&mut cmd);
        prepend_winget_paths(&mut cmd);
        return Ok(cmd);
    }

    for (program, args) in [("py", vec!["-3"]), ("python", vec![]), ("python3", vec![])] {
        if python_probe_succeeds(OsStr::new(program), &args) {
            info!("Using WhisperLive Python launcher: {program}");
            let mut cmd = Command::new(program);
            for arg in &args {
                cmd.arg(arg);
            }
            configure_whisper_python_env(&mut cmd);
            prepend_winget_paths(&mut cmd);
            return Ok(cmd);
        }
    }
    Err("Python executable not found. Install Python 3 to use WhisperLive.".to_string())
}

fn winget_link_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(local) = dirs::data_local_dir() {
        dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        dirs.push(PathBuf::from(program_files).join("WinGet").join("Links"));
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        dirs.push(
            PathBuf::from(program_files_x86)
                .join("WinGet")
                .join("Links"),
        );
    }
    dirs
}

fn prepend_winget_paths(cmd: &mut Command) {
    // Prepend winget link dirs AND the packages dir (for native DLLs like ctranslate2)
    // before the rest of PATH so Windows finds them without a separate env override.
    let mut paths: Vec<PathBuf> = winget_link_dirs();
    paths.push(whisper_packages_dir());

    if let Ok(existing) = std::env::var("PATH") {
        paths.push(PathBuf::from(existing));
    }

    let merged = paths
        .into_iter()
        .filter_map(|path| {
            let s = path.to_string_lossy().trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        })
        .collect::<Vec<_>>()
        .join(";");

    if !merged.is_empty() {
        cmd.env("PATH", merged);
    }
}

fn whisper_device_mode(app: &AppHandle) -> String {
    if let Ok(store) = app.store("settings.json") {
        if let Some(value) = store.get("whisperDeviceMode") {
            if let Some(mode) = value.as_str() {
                if matches!(mode, "cpu" | "cuda" | "auto") {
                    return mode.to_string();
                }
            }
        }
    }
    "auto".to_string()
}

fn whisper_model(app: &AppHandle) -> String {
    if let Ok(store) = app.store("settings.json") {
        if let Some(value) = store.get("whisperModel") {
            if let Some(model) = value.as_str() {
                if !model.trim().is_empty() {
                    return model.to_string();
                }
            }
        }
    }
    std::env::var("STREAMEE_WHISPER_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string())
}

fn find_free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .map(|l| l.local_addr().unwrap().port())
        .map_err(|e| format!("Failed to find a free port: {}", e))
}

async fn wait_for_port(port: u16) -> bool {
    for _ in 0..PORT_BIND_RETRIES {
        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            return true;
        }
        sleep(Duration::from_millis(PORT_BIND_DELAY_MS)).await;
    }
    false
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

pub async fn ensure_server_running(
    app: &AppHandle,
    state: &SharedWhisperLiveState,
) -> Result<u16, String> {
    let mut guard = state.lock().await;
    let device_mode = whisper_device_mode(app);
    let model = whisper_model(app);

    // Reuse a healthy server only when it has the currently selected runtime configuration.
    let existing_port = guard.server_port;
    let existing_model = guard.server_model.clone();
    let existing_device_mode = guard.server_device_mode.clone();
    let config_matches = existing_model.as_deref() == Some(model.as_str())
        && existing_device_mode.as_deref() == Some(device_mode.as_str());
    if let (Some(ref mut child), Some(port)) = (&mut guard.server_process, existing_port) {
        match child.try_wait() {
            Ok(None) if config_matches => {
                return Ok(port);
            }
            Ok(None) => {
                info!(
                    "Restarting WhisperLive server to apply model/device change: {} / {} -> {} / {}",
                    existing_model.as_deref().unwrap_or("unknown"),
                    existing_device_mode.as_deref().unwrap_or("unknown"),
                    model,
                    device_mode
                );
                let _ = child.kill().await;
                guard.server_process = None;
                guard.server_port = None;
                guard.server_pid = None;
                guard.client_pid = None;
                guard.server_model = None;
                guard.server_device_mode = None;
            }
            _ => {
                // Process exited; clear state and restart
                guard.server_process = None;
                guard.server_port = None;
                guard.server_pid = None;
                guard.client_pid = None;
                guard.server_model = None;
                guard.server_device_mode = None;
            }
        }
    }

    let server_script = ensure_script(SERVER_SCRIPT_NAME, include_str!("whisperlive_server.py"))?;
    let port = find_free_port()?;
    let startup_started_at = Instant::now();
    info!(
        "Starting WhisperLive server on port {} (model={}, device={})",
        port, model, device_mode
    );

    let mut cmd = python_command()?;
    hide_console_tokio(&mut cmd);
    cmd.arg(&server_script)
        .arg("--port")
        .arg(port.to_string())
        .arg("--model")
        .arg(&model)
        .arg("--device-mode")
        .arg(&device_mode)
        .env("STREAMEE_WHISPER_DEVICE", &device_mode)
        .env("STREAMEE_WHISPER_MODEL", &model)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start WhisperLive server: {}", e))?;
    let child_pid = child.id();

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture WhisperLive server stdout")?;

    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture WhisperLive server stderr")?;

    // Drain server stderr in the background so the pipe never blocks.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim().to_string();
            if !trimmed.is_empty() {
                emit_whisper_sidecar_line(&trimmed, "whisper.server");
            }
        }
    });

    // Read stdout lines until we get the "ready" or "error" signal
    let ready_result = timeout(Duration::from_secs(SERVER_READY_TIMEOUT_SECS), async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            info!("WhisperLive server: {}", trimmed);
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let status = val.get("status").and_then(|s| s.as_str()).unwrap_or("");
                if status == "ready" {
                    return Ok(());
                }
                if status == "error" {
                    let msg = val
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown server error");
                    return Err(format!("WhisperLive server failed to start: {}", msg));
                }
            }
        }
        Err("WhisperLive server stdout closed before emitting ready".to_string())
    })
    .await;

    match ready_result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = child.kill().await;
            return Err(e);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!(
                "Timed out waiting for WhisperLive server to start ({}s)",
                SERVER_READY_TIMEOUT_SECS
            ));
        }
    }

    // Wait for the TCP port to actually be bound
    if !wait_for_port(port).await {
        let _ = child.kill().await;
        return Err(format!(
            "WhisperLive server did not bind to port {} in time",
            port
        ));
    }

    info!(
        target: "streamee_lib::whisperlive",
        source = "backend",
        subsystem = "whisper.server",
        event = "whisper.server.start_completed",
        status = "Successful",
        duration_ms = startup_started_at.elapsed().as_millis() as u64,
        port,
        model = %model,
        device_mode = %device_mode,
        "WhisperLive server started successfully"
    );
    guard.server_process = Some(child);
    guard.server_port = Some(port);
    guard.server_pid = child_pid;
    guard.server_model = Some(model);
    guard.server_device_mode = Some(device_mode);

    if let Some(server_pid) = child_pid {
        let state_for_monitor = state.clone();
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_millis(500)).await;

                let mut guard = state_for_monitor.lock().await;
                if guard.server_pid != Some(server_pid) {
                    break;
                }

                let Some(child) = guard.server_process.as_mut() else {
                    break;
                };

                match child.try_wait() {
                    Ok(Some(status)) => {
                        info!(
                            "WhisperLive server process pid={} exited unexpectedly with status={:?}",
                            server_pid,
                            status
                        );
                        guard.server_process = None;
                        guard.server_port = None;
                        guard.server_pid = None;
                        guard.client_pid = None;
                        guard.server_model = None;
                        guard.server_device_mode = None;
                        break;
                    }
                    Ok(None) => {}
                    Err(err) => {
                        info!(
                            "WhisperLive server process pid={} could not be polled: {}",
                            server_pid, err
                        );
                        break;
                    }
                }
            }
        });
    }

    Ok(port)
}

pub async fn stop_server(state: &SharedWhisperLiveState) {
    stop_client_process(state).await;
    let mut guard = state.lock().await;
    if let Some(mut child) = guard.server_process.take() {
        info!("Stopping WhisperLive server");
        let _ = child.kill().await;
        let _ = timeout(Duration::from_secs(2), async {
            loop {
                match child.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) => sleep(Duration::from_millis(50)).await,
                }
            }
        })
        .await;
    }
    guard.server_port = None;
    guard.server_pid = None;
    guard.client_pid = None;
    guard.server_model = None;
    guard.server_device_mode = None;
}

pub async fn stop_client(state: &SharedWhisperLiveState) {
    stop_client_process(state).await;
}

// ---------------------------------------------------------------------------
// Client runner
// ---------------------------------------------------------------------------

const RETRYABLE_MARKER: &str = "RETRYABLE_MEDIA_NOT_READY";
const RETRYABLE_SESSION_MARKER: &str = "RETRYABLE_SUBTITLE_SESSION_RESTART";

pub async fn run_client(
    app: AppHandle,
    state: SharedWhisperLiveState,
    source_url: String,
    title: Option<String>,
    language: Option<String>,
    session_id: u64,
    start_seconds: Option<f64>,
) -> Result<(), String> {
    let port = ensure_server_running(&app, &state).await?;

    let client_script = ensure_script(CLIENT_SCRIPT_NAME, include_str!("whisperlive_client.py"))?;
    let model = whisper_model(&app);
    let device_mode = whisper_device_mode(&app);
    let server_url = format!("ws://127.0.0.1:{}", port);

    info!(
        "Starting WhisperLive client session={} for '{}' → {} (start={:.2}s)",
        session_id,
        title.as_deref().unwrap_or(&source_url),
        server_url,
        start_seconds.unwrap_or(0.0)
    );

    let _ = app.emit(
        "subtitle://progress",
        SubtitleProgressPayload {
            session_id,
            phase: "starting".to_string(),
            progress: 0.0,
            message: "Starting WhisperLive transcription".to_string(),
            downloaded: None,
            total: None,
            title: title.clone(),
        },
    );

    let mut current_start_seconds = start_seconds;
    let mut client_restart_count = 0usize;
    let live_mpv_path = live_mpv_subtitle_path()?;
    fs::write(&live_mpv_path, "")
        .map_err(|e| format!("Failed to initialize live MPV subtitle file: {}", e))?;
    let live_mpv_state = Arc::new(Mutex::new(LiveMpvSubtitleState::default()));
    if let Err(error) = upsert_live_subtitle_file(&live_mpv_path.to_string_lossy()) {
        info!(
            "Could not initialize the live MPV subtitle track: {}",
            error
        );
    }

    loop {
        let selected_audio_ff_index = resolve_selected_audio_ff_index(session_id).await?;
        let mut cmd = python_command()?;
        hide_console_tokio(&mut cmd);
        cmd.arg(&client_script)
            .arg("--input")
            .arg(&source_url)
            .arg("--server")
            .arg(&server_url)
            .arg("--model")
            .arg(&model)
            .env("STREAMEE_WHISPER_DEVICE", &device_mode)
            .env("STREAMEE_WHISPER_MODEL", &model)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(ref lang) = language {
            cmd.arg("--language").arg(lang);
        }
        if let Some(start) = current_start_seconds {
            if start.is_finite() && start > 0.0 {
                cmd.arg("--start-seconds").arg(format!("{:.3}", start));
            }
        }
        info!(
            "WhisperLive session={} using MPV selected FFmpeg audio stream index={}",
            session_id, selected_audio_ff_index
        );
        cmd.arg("--audio-stream-index")
            .arg(selected_audio_ff_index.to_string());
        cmd.arg("--session-id").arg(session_id.to_string());

        stop_client_process(&state).await;

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start WhisperLive client: {}", e))?;
        let child_pid = child.id();

        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to capture WhisperLive client stdout")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Failed to capture WhisperLive client stderr")?;
        {
            let mut guard = state.lock().await;
            guard.client_pid = child_pid;
        }

        let stderr_lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let stdout_error_lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let completion_reason = Arc::new(Mutex::new(None::<String>));
        // Drain stderr
        let stderr_lines_clone = stderr_lines.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    emit_whisper_sidecar_line(&trimmed, "whisper.client");
                    stderr_lines_clone.lock().await.push(trimmed);
                }
            }
        });

        // Read and dispatch stdout events
        let app_clone = app.clone();
        let title_clone = title.clone();
        let live_mpv_path_clone = live_mpv_path.clone();
        let live_mpv_state_clone = live_mpv_state.clone();
        let stdout_error_lines_clone = stdout_error_lines.clone();
        let completion_reason_clone = completion_reason.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let val = match serde_json::from_str::<serde_json::Value>(trimmed) {
                    Ok(v) => v,
                    Err(_) => {
                        info!("WhisperLive client stdout (non-JSON): {}", trimmed);
                        continue;
                    }
                };

                let event_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match event_type {
                    "status" => {
                        let phase = val
                            .get("phase")
                            .and_then(|p| p.as_str())
                            .unwrap_or("pending");
                        let message = val.get("message").and_then(|m| m.as_str()).unwrap_or("");
                        let progress = match phase {
                            "connecting" => 0.1,
                            "transcribing" => 0.2,
                            "complete" => 1.0,
                            _ => 0.0,
                        };
                        let _ = app_clone.emit(
                            "subtitle://progress",
                            SubtitleProgressPayload {
                                session_id,
                                phase: phase.to_string(),
                                progress,
                                message: message.to_string(),
                                downloaded: None,
                                total: None,
                                title: title_clone.clone(),
                            },
                        );
                        if phase == "complete" {
                            let reason = val.get("reason").and_then(|r| r.as_str());
                            if reason != Some("session_rollover") {
                                if let Err(err) = flush_live_mpv_subtitles(
                                    &live_mpv_path_clone,
                                    &live_mpv_state_clone,
                                )
                                .await
                                {
                                    info!(
                                        "Failed to flush live MPV subtitles at completion: {}",
                                        err
                                    );
                                }
                            }
                            if let Some(reason) = reason {
                                *completion_reason_clone.lock().await = Some(reason.to_string());
                            }
                        }
                    }
                    "segment" => {
                        let seg = SubtitleSegmentPayload {
                            session_id,
                            start: val.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0),
                            end: val.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0),
                            text: val
                                .get("text")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string(),
                            completed: val
                                .get("completed")
                                .and_then(|c| c.as_bool())
                                .unwrap_or(false),
                        };
                        if !seg.text.is_empty() {
                            info!(
                                "WhisperLive segment: [{:.2}->{:.2}] {}",
                                seg.start, seg.end, seg.text
                            );
                            let _ = app_clone.emit("subtitle://segment", &seg);

                            let mut live_state = live_mpv_state_clone.lock().await;
                            push_live_mpv_cue(
                                &mut live_state.cues,
                                seg.start,
                                seg.end,
                                seg.text.clone(),
                            );
                            live_state.dirty = true;
                        }
                    }
                    "voice_gap" => {
                        match flush_live_mpv_subtitles(&live_mpv_path_clone, &live_mpv_state_clone)
                            .await
                        {
                            Ok(true) => info!(
                                "Live MPV subtitles updated during voice gap: {}",
                                live_mpv_path_clone.display()
                            ),
                            Ok(false) => {}
                            Err(err) => {
                                info!(
                                    "Failed to update live MPV subtitles during voice gap: {}",
                                    err
                                )
                            }
                        }
                    }
                    "error" => {
                        let msg = val
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown error");
                        info!("WhisperLive client error event: {}", msg);
                        stdout_error_lines_clone.lock().await.push(msg.to_string());
                    }
                    _ => {
                        info!("WhisperLive client stdout: {}", trimmed);
                    }
                }
            }
        });

        let wait_result = timeout(Duration::from_millis(CLIENT_TIMEOUT_MS), child.wait()).await;

        let status = match wait_result {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                return Err(format!("Failed waiting for WhisperLive client: {}", e));
            }
            Err(_) => {
                let _ = child.kill().await;
                return Err("Timed out waiting for WhisperLive transcription".to_string());
            }
        };

        stdout_task.await.ok();
        stderr_task.await.ok();

        if let Some(pid) = child_pid {
            let mut guard = state.lock().await;
            if guard.client_pid == Some(pid) {
                guard.client_pid = None;
            }
        }

        if status.success() {
            let reason = completion_reason.lock().await.clone();
            if reason.as_deref() == Some("session_rollover") {
                client_restart_count += 1;
                current_start_seconds =
                    Some(resolve_whisper_restart_start_seconds(current_start_seconds).await);
                info!(
                    "WhisperLive session rollover completed; restarting client session={} attempt={} start={:.3}",
                    session_id,
                    client_restart_count,
                    current_start_seconds.unwrap_or(0.0)
                );
                continue;
            }

            info!("WhisperLive client finished successfully");
            return Ok(());
        }

        if !status.success() {
            let stderr = stderr_lines.lock().await.join("\n").trim().to_string();
            let stdout_errors = stdout_error_lines
                .lock()
                .await
                .join("\n")
                .trim()
                .to_string();
            let combined = if !stderr.is_empty() && !stdout_errors.is_empty() {
                format!("{}\n{}", stderr, stdout_errors)
            } else if !stderr.is_empty() {
                stderr.clone()
            } else {
                stdout_errors.clone()
            };

            // Check for retryable errors surfaced by the Python client.
            if status.code() == Some(3)
                || combined.contains(RETRYABLE_MARKER)
                || combined.contains(RETRYABLE_SESSION_MARKER)
            {
                let marker = if combined.contains(RETRYABLE_SESSION_MARKER) {
                    RETRYABLE_SESSION_MARKER
                } else {
                    RETRYABLE_MARKER
                };
                return Err(format!("{}: {}", marker, combined));
            }

            // Treat server connection failures as retryable session restarts so the
            // frontend will retry instead of giving up permanently.
            let combined_lower = combined.to_lowercase();
            if combined_lower.contains("connection")
                || combined_lower.contains("server error")
                || combined_lower.contains("timed out")
            {
                return Err(format!("{}: {}", RETRYABLE_SESSION_MARKER, combined));
            }

            let message = if !combined.is_empty() {
                combined
            } else {
                "WhisperLive client failed without output".to_string()
            };
            return Err(message);
        }
    }
}

// ---------------------------------------------------------------------------
// install_whisperlive
// ---------------------------------------------------------------------------

async fn run_pip(
    target: &Path,
    extra_args: &[&str],
    packages: &[&str],
    pip_index_url: &Option<String>,
) -> Result<String, String> {
    let mut cmd = python_command()?;
    hide_console_tokio(&mut cmd);
    ensure_bundled_python_paths()?;

    let mut args: Vec<String> = vec![
        "-m".into(),
        "pip".into(),
        "install".into(),
        "--upgrade".into(),
        "--target".into(),
        target.to_string_lossy().to_string(),
    ];
    if let Some(ref url) = pip_index_url {
        if !url.trim().is_empty() {
            args.push("-i".into());
            args.push(url.trim().to_string());
        }
    }
    args.extend(extra_args.iter().map(|value| (*value).to_string()));
    args.extend(packages.iter().map(|value| (*value).to_string()));
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to launch pip: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

async fn ensure_pip_available() -> Result<(), String> {
    let site_packages = ensure_bundled_python_paths()?;

    let mut cmd = python_command()?;
    hide_console_tokio(&mut cmd);
    cmd.args(["-m", "pip", "--version"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to check pip availability: {}", e))?;

    if output.status.success() {
        return Ok(());
    }

    let get_pip = bundled_python_path()
        .and_then(|python| python.parent().map(|dir| dir.join("get-pip.py")))
        .filter(|path| path.exists())
        .ok_or_else(|| "Bundled get-pip.py was not found".to_string())?;

    let mut bootstrap = python_command()?;
    hide_console_tokio(&mut bootstrap);
    bootstrap
        .arg(get_pip)
        .arg("--no-warn-script-location")
        .arg("--prefix")
        .arg(
            bundled_python_path()
                .and_then(|python| python.parent().map(|dir| dir.to_path_buf()))
                .unwrap_or(
                    site_packages
                        .parent()
                        .unwrap_or(&site_packages)
                        .to_path_buf(),
                ),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = bootstrap
        .output()
        .await
        .map_err(|e| format!("Failed to bootstrap pip: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

pub async fn install_whisperlive(pip_index_url: Option<String>) -> Result<String, String> {
    info!("Installing WhisperLive dependencies");

    // Streamee's server is a custom script built directly on faster-whisper + websockets.
    // No whisper-live package needed — avoids torch, PyAudio, av, fastapi and other
    // heavyweight / Windows-unfriendly dependencies entirely.
    if python_command().is_err() {
        return Err("Python executable not found. The bundled runtime or a system Python install is required.".to_string());
    }

    ensure_pip_available().await?;

    let deps = [
        "faster-whisper==1.2.1",
        "ctranslate2==4.8.1",
        "websockets==16.1.1",
        "numpy==2.5.1",
        "websocket-client==1.9.0",
        "imageio-ffmpeg==0.6.0",
    ];
    let site_packages = ensure_bundled_python_paths()?;
    let package_root = site_packages
        .parent()
        .ok_or_else(|| "WhisperLive package folder has no parent".to_string())?;
    let staging = package_root.join("site-packages.installing");
    let backup = package_root.join("site-packages.previous");
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|e| format!("Failed to clear previous WhisperLive staging folder: {e}"))?;
    }
    fs::create_dir_all(&staging)
        .map_err(|e| format!("Failed to create WhisperLive staging folder: {e}"))?;

    let out = match run_pip(&staging, &[], &deps, &pip_index_url).await {
        Ok(output) => output,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("Failed to install dependencies: {error}"));
        }
    };

    if backup.exists() {
        fs::remove_dir_all(&backup)
            .map_err(|e| format!("Failed to clear previous WhisperLive backup: {e}"))?;
    }
    if site_packages.exists() {
        fs::rename(&site_packages, &backup)
            .map_err(|e| format!("Failed to preserve current WhisperLive installation: {e}"))?;
    }
    if let Err(error) = fs::rename(&staging, &site_packages) {
        if backup.exists() {
            let _ = fs::rename(&backup, &site_packages);
        }
        return Err(format!(
            "Failed to activate new WhisperLive installation: {error}"
        ));
    }
    if backup.exists() {
        if let Err(error) = fs::remove_dir_all(&backup) {
            warn!("Could not remove previous WhisperLive installation: {error}");
        }
    }

    info!("WhisperLive installation completed");
    let result = if out.is_empty() {
        "faster-whisper, websockets, numpy, websocket-client, and imageio-ffmpeg installed successfully".to_string()
    } else {
        out
    };

    Ok(result)
}

// ---------------------------------------------------------------------------
// test_whisperlive_runtime
// ---------------------------------------------------------------------------

pub async fn test_whisperlive_runtime(
    app: AppHandle,
    deep: bool,
) -> Result<WhisperLiveRuntimeInfo, String> {
    let mut cmd = python_command()?;
    hide_console_tokio(&mut cmd);
    let requested_mode = whisper_device_mode(&app);
    let requested_model = whisper_model(&app);

    let probe = r#"
import json, os, platform, shutil

requested = os.environ.get("STREAMEE_WHISPER_DEVICE", "auto")
model_name = os.environ.get("STREAMEE_WHISPER_MODEL", "small")
deep_tested = os.environ.get("STREAMEE_WHISPER_DEEP_TEST", "0") == "1"
python_version = platform.python_version()
faster_whisper_ok = False
websockets_ok = False
numpy_ok = False
websocket_client_ok = False
cuda_available = False
ffmpeg_available = False
model_load_ok = False
model_error = ""

try:
    import faster_whisper  # noqa: F401
    faster_whisper_ok = True
except Exception:
    pass

try:
    import websockets  # noqa: F401
    websockets_ok = True
except Exception:
    pass

try:
    import numpy  # noqa: F401
    numpy_ok = True
except Exception:
    pass

try:
    import websocket  # noqa: F401
    websocket_client_ok = True
except Exception:
    pass

try:
    import imageio_ffmpeg
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    ffmpeg_available = bool(ffmpeg_exe and os.path.exists(ffmpeg_exe))
except Exception:
    ffmpeg_available = shutil.which("ffmpeg") is not None or shutil.which("ffmpeg.exe") is not None

try:
    import ctranslate2
    if hasattr(ctranslate2, "get_cuda_device_count"):
        cuda_available = int(ctranslate2.get_cuda_device_count()) > 0
except Exception:
    pass

if requested == "cuda":
    resolved = "cuda" if cuda_available else "cpu"
elif requested == "cpu":
    resolved = "cpu"
else:
    resolved = "cuda" if cuda_available else "cpu"

missing = [p for p, ok in [
    ("faster-whisper", faster_whisper_ok),
    ("websockets", websockets_ok),
    ("numpy", numpy_ok),
    ("websocket-client", websocket_client_ok),
    ("imageio-ffmpeg", ffmpeg_available),
] if not ok]

if not missing and deep_tested:
    try:
        import numpy as np
        from faster_whisper import WhisperModel
        compute_type = "float16" if resolved == "cuda" else "int8"
        model = WhisperModel(model_name, device=resolved, compute_type=compute_type)
        segments, _ = model.transcribe(
            np.zeros(8000, dtype=np.float32),
            language="en",
            beam_size=1,
            vad_filter=False,
        )
        list(segments)
        model_load_ok = True
    except Exception as exc:
        model_error = f"{type(exc).__name__}: {exc}"

if missing:
    message = f"Missing packages: {', '.join(missing)}. Click 'Install WhisperLive' to install them."
elif deep_tested and not model_load_ok:
    message = f"Selected model '{model_name}' failed its inference test: {model_error}"
elif deep_tested:
    message = f"Selected model '{model_name}' loaded and completed a test inference on {resolved.upper()}"
elif requested == "cuda" and not cuda_available:
    message = "CUDA was requested but is not available, transcription will fall back to CPU"
elif resolved == "cuda":
    message = "CUDA is available — transcription will use GPU acceleration"
else:
    message = "All dependencies ready. Transcription will run on CPU."

print(json.dumps({
    "python_available": True,
    "python_version": python_version,
    "whisper_live_installed": faster_whisper_ok and websockets_ok and numpy_ok and ffmpeg_available,
    "websocket_client_installed": websocket_client_ok,
    "cuda_available": cuda_available,
    "ffmpeg_available": ffmpeg_available,
    "deep_tested": deep_tested,
    "model_load_ok": model_load_ok,
    "requested_mode": requested,
    "resolved_mode": resolved,
    "message": message,
}))
"#;

    cmd.arg("-c")
        .arg(probe)
        .env("STREAMEE_WHISPER_DEVICE", &requested_mode)
        .env("STREAMEE_WHISPER_MODEL", &requested_model)
        .env("STREAMEE_WHISPER_DEEP_TEST", if deep { "1" } else { "0" })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run WhisperLive runtime test: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "WhisperLive runtime test failed without output".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    serde_json::from_str::<WhisperLiveRuntimeInfo>(&stdout)
        .map_err(|e| format!("Failed to parse runtime test output: {}", e))
}
