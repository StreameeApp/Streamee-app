use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::path::BaseDirectory;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};
use tokio::time;
use tracing::{debug, error, info, warn};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

// Resettable process state — allows respawning after crash (replaces OnceLock)
static WEBTORRENT_PROCESS: Lazy<Mutex<Option<WebTorrentProcess>>> = Lazy::new(|| Mutex::new(None));
static WEBTORRENT_PORT: Lazy<Mutex<Option<u16>>> = Lazy::new(|| Mutex::new(None));
static LAST_PROGRESS: Lazy<std::sync::Mutex<Option<DownloadProgress>>> =
    Lazy::new(|| std::sync::Mutex::new(None));
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle<tauri::Wry>> = std::sync::OnceLock::new();
static PORT_WAITERS: Lazy<Mutex<Vec<oneshot::Sender<u16>>>> = Lazy::new(|| Mutex::new(Vec::new()));
static TORRENT_STARTING: AtomicBool = AtomicBool::new(false);
static STARTUP_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

// Request-response correlation: pending requests awaiting responses from Node.js
static PENDING_REQUESTS: Lazy<Mutex<HashMap<u64, oneshot::Sender<ServerMessage>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static REQUEST_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

struct WebTorrentProcess {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupStateEvent {
    pub session_id: u64,
    pub attempt: u32,
    pub phase: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_in_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TorrentHealth {
    pub session_id: u64,
    pub attempt: u32,
    pub phase: String,
    pub sidecar_running: bool,
    pub has_torrent: bool,
    pub metadata_ready: bool,
    pub port: Option<u16>,
    pub file_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct StartupSessionState {
    session_id: u64,
    attempt: u32,
    phase: String,
    last_error: Option<String>,
}

static STARTUP_SESSION: Lazy<std::sync::Mutex<StartupSessionState>> = Lazy::new(|| {
    std::sync::Mutex::new(StartupSessionState {
        session_id: 0,
        attempt: 0,
        phase: "idle".to_string(),
        last_error: None,
    })
});

#[allow(dead_code)]
struct TorrentState {
    name: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TorrentFile {
    pub name: String,
    pub size: u64,
    pub path: Option<String>,
    pub index: Option<usize>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DownloadProgress {
    pub status: String,
    pub downloaded: u64,
    pub total: u64,
    pub download_speed: u64,
    pub progress: f64,
    pub files: Vec<TorrentFile>,
    pub pieces: u32,
    pub downloaded_pieces: u32,
    pub peers: u32,
    pub connected_peers: u32,
    pub tracker_peers: u32,
    pub seeders: u32,
    pub leechers: u32,
    pub bitfield: Vec<u8>,
    pub metadata_ready: bool,
    pub file_count: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileProgress {
    pub file_index: usize,
    pub downloaded: u64,
    pub total: u64,
    pub progress: f64,
    pub ready: bool,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Clone)]
struct ServerMessage {
    #[serde(rename = "type")]
    msg_type: String,
    port: Option<u16>,
    status: Option<String>,
    downloaded: Option<u64>,
    received_delta: Option<u64>,
    total: Option<u64>,
    progress: Option<f64>,
    #[serde(alias = "download_speed")]
    speed: Option<f64>,
    files: Option<Vec<TorrentFile>>,
    url: Option<String>,
    message: Option<String>,
    name: Option<String>,
    pieces: Option<u32>,
    peers: Option<u32>,
    connected_peers: Option<u32>,
    tracker_peers: Option<u32>,
    seeders: Option<u32>,
    leechers: Option<u32>,
    file_index: Option<usize>,
    ready: Option<bool>,
    total_pieces: Option<usize>,
    downloaded_pieces: Option<usize>,
    bitfield: Option<Vec<u8>>,
    metadata_ready: Option<bool>,
    file_count: Option<usize>,
    #[serde(rename = "requestId")]
    request_id: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct SidecarLogMessage {
    level: String,
    #[serde(default = "default_webtorrent_source")]
    source: String,
    #[serde(default = "default_webtorrent_source")]
    subsystem: String,
    event: String,
    message: String,
    #[serde(default)]
    fields: serde_json::Value,
}

fn default_webtorrent_source() -> String {
    "webtorrent".to_string()
}

fn emit_sidecar_log(mut entry: SidecarLogMessage) -> bool {
    crate::logging::redact_json_value(&mut entry.fields);
    let fields_json = serde_json::to_string(&entry.fields).unwrap_or_else(|_| "{}".to_string());
    let is_error = entry.level.eq_ignore_ascii_case("error");
    match entry.level.trim().to_ascii_lowercase().as_str() {
        "debug" => debug!(
            target: "streamee_lib::torrent::sidecar",
            source = %entry.source,
            subsystem = %entry.subsystem,
            event = %entry.event,
            fields_json = %fields_json,
            "{}",
            crate::logging::redact_text(&entry.message)
        ),
        "info" => info!(
            target: "streamee_lib::torrent::sidecar",
            source = %entry.source,
            subsystem = %entry.subsystem,
            event = %entry.event,
            fields_json = %fields_json,
            "{}",
            crate::logging::redact_text(&entry.message)
        ),
        "warn" => warn!(
            target: "streamee_lib::torrent::sidecar",
            source = %entry.source,
            subsystem = %entry.subsystem,
            event = %entry.event,
            fields_json = %fields_json,
            "{}",
            crate::logging::redact_text(&entry.message)
        ),
        _ => error!(
            target: "streamee_lib::torrent::sidecar",
            source = %entry.source,
            subsystem = %entry.subsystem,
            event = %entry.event,
            fields_json = %fields_json,
            "{}",
            crate::logging::redact_text(&entry.message)
        ),
    }
    is_error
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TorrentReadyEvent {
    pub session_id: u64,
    pub files: Vec<TorrentFile>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TorrentProgressEvent {
    pub session_id: u64,
    pub status: String,
    pub downloaded: u64,
    pub received_delta: u64,
    pub total: u64,
    pub download_speed: u64,
    pub progress: f64,
    pub files: Vec<TorrentFile>,
    pub pieces: u32,
    pub downloaded_pieces: u32,
    pub peers: u32,
    pub connected_peers: u32,
    pub tracker_peers: u32,
    pub seeders: u32,
    pub leechers: u32,
    pub bitfield: Vec<u8>,
    pub metadata_ready: bool,
    pub file_count: usize,
}

fn get_server_path() -> Result<std::path::PathBuf, String> {
    if let Some(app) = get_app_handle() {
        if let Ok(path) = app
            .path()
            .resolve("webtorrent-server.cjs", BaseDirectory::Resource)
        {
            let path: PathBuf = path;
            if path.exists() {
                return Ok(normalize_windows_path(path));
            }
        }
    }

    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let server_dir = exe_path.parent().ok_or("Cannot get executable directory")?;
    Ok(server_dir.join("webtorrent-server.cjs"))
}

fn normalize_windows_path(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix("\\\\?\\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

fn get_node_exe_path() -> Option<PathBuf> {
    if let Some(app) = get_app_handle() {
        if let Ok(path) = app
            .path()
            .resolve("streameenode.exe", BaseDirectory::Resource)
        {
            if path.exists() {
                return Some(normalize_windows_path(path));
            }
        }
    }

    std::env::var("STREAMEE_NODE_EXE")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .or_else(|| {
            std::env::var("PATH").ok().and_then(|_| {
                let mut probe = std::process::Command::new("where");
                hide_console_std(&mut probe);
                probe.arg("node").output().ok().and_then(|output| {
                    if output.status.success() {
                        String::from_utf8(output.stdout)
                            .ok()
                            .and_then(|text| text.lines().next().map(str::trim).map(PathBuf::from))
                    } else {
                        None
                    }
                })
            })
        })
}

pub fn set_app_handle(app: tauri::AppHandle<tauri::Wry>) {
    let _ = APP_HANDLE.set(app);
}

#[allow(dead_code)]
fn get_app_handle() -> Option<tauri::AppHandle<tauri::Wry>> {
    APP_HANDLE.get().cloned()
}

fn begin_startup_session() -> u64 {
    let session_id = STARTUP_SESSION_COUNTER.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut session) = STARTUP_SESSION.lock() {
        session.session_id = session_id;
        session.attempt = 0;
        session.phase = "idle".to_string();
        session.last_error = None;
    }
    session_id
}

fn current_startup_session() -> StartupSessionState {
    STARTUP_SESSION
        .lock()
        .map(|session| session.clone())
        .unwrap_or_default()
}

pub fn emit_startup_state(
    session_id: u64,
    attempt: u32,
    phase: &str,
    message: impl Into<String>,
    retry_in_ms: Option<u64>,
    error_code: Option<&str>,
) {
    let message = message.into();
    match phase {
        "failed" => info!(
            target: "streamee_lib::torrent::startup",
            source = "backend",
            subsystem = "torrent.startup",
            event = "torrent.startup_state",
            session_id,
            attempt,
            phase,
            status = "Failed",
            retry_in_ms = ?retry_in_ms,
            error_kind = error_code.unwrap_or(""),
            "{message}"
        ),
        "metadata_ready" | "stream_ready" => info!(
            target: "streamee_lib::torrent::startup",
            source = "backend",
            subsystem = "torrent.startup",
            event = "torrent.startup_state",
            session_id,
            attempt,
            phase,
            status = "Successful",
            retry_in_ms = ?retry_in_ms,
            error_kind = error_code.unwrap_or(""),
            "{message}"
        ),
        _ => info!(
            target: "streamee_lib::torrent::startup",
            source = "backend",
            subsystem = "torrent.startup",
            event = "torrent.startup_state",
            session_id,
            attempt,
            phase,
            retry_in_ms = ?retry_in_ms,
            error_kind = error_code.unwrap_or(""),
            "{message}"
        ),
    }
    if let Ok(mut session) = STARTUP_SESSION.lock() {
        if session_id >= session.session_id {
            session.session_id = session_id;
            session.attempt = attempt;
            session.phase = phase.to_string();
            session.last_error = error_code.map(|value| value.to_string());
        }
    }

    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(
            "torrent://startup-state",
            StartupStateEvent {
                session_id,
                attempt,
                phase: phase.to_string(),
                message,
                retry_in_ms,
                error_code: error_code.map(|value| value.to_string()),
            },
        );
    }
}

async fn is_sidecar_running() -> bool {
    let proc_guard = WEBTORRENT_PROCESS.lock().await;
    let Some(process) = proc_guard.as_ref() else {
        return false;
    };

    let mut child_guard = process.child.lock().await;
    let Some(child) = child_guard.as_mut() else {
        return false;
    };

    matches!(child.try_wait(), Ok(None))
}

async fn shutdown_webtorrent_process() {
    let process = {
        let mut proc_guard = WEBTORRENT_PROCESS.lock().await;
        proc_guard.take()
    };

    if let Some(process) = process {
        {
            let mut stdin_guard = process.stdin.lock().await;
            *stdin_guard = None;
        }

        let mut child_guard = process.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            if let Err(err) = child.kill().await {
                debug!("Failed to kill WebTorrent child process cleanly: {}", err);
            }

            let _ = time::timeout(Duration::from_secs(2), child.wait()).await;
        }
    }

    *WEBTORRENT_PORT.lock().await = None;
    *LAST_PROGRESS.lock().unwrap() = None;
    TORRENT_STARTING.store(false, Ordering::SeqCst);

    {
        let mut waiters = PORT_WAITERS.lock().await;
        waiters.clear();
    }

    {
        let mut pending = PENDING_REQUESTS.lock().await;
        pending.clear();
    }
}

pub async fn start_server(listen_port: Option<u16>) -> Result<(), String> {
    let mut proc_guard = WEBTORRENT_PROCESS.lock().await;

    // Check if existing process is alive
    if let Some(proc) = proc_guard.as_ref() {
        let mut child_lock = proc.child.lock().await;
        if let Some(child) = child_lock.as_mut() {
            match child.try_wait() {
                Ok(None) => {
                    // Process still running
                    info!("WebTorrent server already running");
                    return Ok(());
                }
                Ok(Some(status)) => {
                    warn!("WebTorrent process had exited: {:?}, will respawn", status);
                    // Fall through to respawn
                }
                Err(e) => {
                    warn!("Error checking process status: {}, will respawn", e);
                    // Fall through to respawn
                }
            }
        }
    }

    // Clear stale state before respawning
    *proc_guard = None;
    *WEBTORRENT_PORT.lock().await = None;

    let server_path = get_server_path()?;
    info!("Starting WebTorrent server: {:?}", server_path);

    let node_exe = get_node_exe_path().ok_or_else(|| "Node runtime not found".to_string())?;
    let mut command = Command::new(&node_exe);
    hide_console_tokio(&mut command);
    command
        .arg(&server_path)
        .env(
            "STREAMEE_TORRENT_PORT",
            listen_port.map(|p| p.to_string()).unwrap_or_default(),
        )
        .env("STREAMEE_LOG_LEVEL", "debug")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(app) = get_app_handle() {
        if let Ok(node_modules) = app.path().resolve("node_modules", BaseDirectory::Resource) {
            if node_modules.exists() {
                let bundled_node_path = normalize_windows_path(node_modules)
                    .to_string_lossy()
                    .to_string();
                let existing_node_path = std::env::var("NODE_PATH").unwrap_or_default();
                let combined_node_path = if existing_node_path.is_empty() {
                    bundled_node_path
                } else {
                    format!("{};{}", bundled_node_path, existing_node_path)
                };
                command.env("NODE_PATH", combined_node_path);
            }
        }
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn Node process: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

    let process = WebTorrentProcess {
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
    };

    *proc_guard = Some(process);
    drop(proc_guard); // Release lock before spawning tasks

    // WebTorrent reserves stdout for its request/response protocol and emits
    // structured diagnostics on stderr.
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                let parsed = serde_json::from_str::<SidecarLogMessage>(&line);
                let (is_error, user_message) = match parsed {
                    Ok(entry) => {
                        let user_message = entry.message.clone();
                        (emit_sidecar_log(entry), user_message)
                    }
                    Err(parse_error) => {
                        warn!(
                            target: "streamee_lib::torrent::sidecar",
                            source = "webtorrent",
                            subsystem = "webtorrent",
                            event = "sidecar.unstructured_stderr",
                            error_kind = "invalid_json",
                            parse_error = %parse_error,
                            raw = %crate::logging::redact_text(&line),
                            "WebTorrent emitted an unstructured stderr line"
                        );
                        (false, String::new())
                    }
                };
                if is_error {
                    if let Some(app) = APP_HANDLE.get() {
                        let _ = app.emit("torrent://error", format!("[Node]: {user_message}"));
                    }
                }
            }
        }
    });

    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            match serde_json::from_str::<ServerMessage>(&line) {
                Ok(msg) => {
                    // Check if this response has a requestId — if so, complete the pending request
                    if let Some(req_id) = msg.request_id {
                        let mut pending = PENDING_REQUESTS.lock().await;
                        if let Some(tx) = pending.remove(&req_id) {
                            let _ = tx.send(msg.clone());
                            // Also process side effects (progress caching, events) below
                        }
                    }

                    match msg.msg_type.as_str() {
                        "port" => {
                            if let Some(port) = msg.port {
                                info!("WebTorrent server port: {}", port);
                                *WEBTORRENT_PORT.lock().await = Some(port);

                                // Complete all waiting futures
                                let mut guard = PORT_WAITERS.lock().await;
                                for tx in guard.drain(..) {
                                    let _ = tx.send(port);
                                }
                            }
                        }
                        "ready" => {
                            info!("Torrent ready, files: {:?}", msg.files);
                            let files = msg.files.unwrap_or_default();
                            let session = current_startup_session();
                            emit_startup_state(
                                session.session_id,
                                session.attempt.max(1),
                                "metadata_ready",
                                format!("Metadata ready with {} files", files.len()),
                                None,
                                None,
                            );
                            if let Some(app) = APP_HANDLE.get() {
                                let event = TorrentReadyEvent {
                                    session_id: session.session_id,
                                    files: files.clone(),
                                };
                                let _ = app.emit("torrent://ready", event);
                            }
                        }
                        "server_ready" => {
                            info!("WebTorrent HTTP server ready");
                        }
                        "progress" => {
                            let received_delta = msg.received_delta.unwrap_or(0);
                            let progress = DownloadProgress {
                                status: msg.status.unwrap_or_else(|| "downloading".to_string()),
                                downloaded: msg.downloaded.unwrap_or(0),
                                total: msg.total.unwrap_or(0),
                                download_speed: msg.speed.unwrap_or(0.0) as u64,
                                progress: msg.progress.unwrap_or(0.0),
                                files: msg.files.unwrap_or_default(),
                                pieces: msg.pieces.unwrap_or(0),
                                downloaded_pieces: msg.downloaded_pieces.unwrap_or(0) as u32,
                                peers: msg.peers.unwrap_or(0),
                                connected_peers: msg
                                    .connected_peers
                                    .unwrap_or_else(|| msg.peers.unwrap_or(0)),
                                tracker_peers: msg.tracker_peers.unwrap_or(0),
                                seeders: msg.seeders.unwrap_or(0),
                                leechers: msg.leechers.unwrap_or(0),
                                bitfield: msg.bitfield.unwrap_or_default(),
                                metadata_ready: msg.metadata_ready.unwrap_or(false),
                                file_count: msg.file_count.unwrap_or(0),
                            };
                            *LAST_PROGRESS.lock().unwrap() = Some(progress.clone());

                            if let Some(app) = APP_HANDLE.get() {
                                let session = current_startup_session();
                                let event = TorrentProgressEvent {
                                    session_id: session.session_id,
                                    status: progress.status.clone(),
                                    downloaded: progress.downloaded,
                                    received_delta,
                                    total: progress.total,
                                    download_speed: progress.download_speed,
                                    progress: progress.progress,
                                    files: progress.files.clone(),
                                    pieces: progress.pieces,
                                    downloaded_pieces: progress.downloaded_pieces,
                                    peers: progress.peers,
                                    connected_peers: progress.connected_peers,
                                    tracker_peers: progress.tracker_peers,
                                    seeders: progress.seeders,
                                    leechers: progress.leechers,
                                    bitfield: progress.bitfield.clone(),
                                    metadata_ready: progress.metadata_ready,
                                    file_count: progress.file_count,
                                };
                                let _ = app.emit("torrent://progress", event);
                            }
                        }
                        "started" => {
                            info!("Torrent started, files: {:?}", msg.files);
                            let progress = DownloadProgress {
                                status: "downloading".to_string(),
                                downloaded: 0,
                                total: 0,
                                download_speed: 0,
                                progress: 0.0,
                                files: msg.files.unwrap_or_default(),
                                pieces: 0,
                                downloaded_pieces: 0,
                                peers: 0,
                                connected_peers: 0,
                                tracker_peers: 0,
                                seeders: 0,
                                leechers: 0,
                                bitfield: vec![],
                                metadata_ready: false,
                                file_count: msg.file_count.unwrap_or(0),
                            };
                            *LAST_PROGRESS.lock().unwrap() = Some(progress);
                        }
                        "error" => {
                            error!("WebTorrent error: {:?}", msg.message);
                            if let Some(app) = APP_HANDLE.get() {
                                let _ =
                                    app.emit("torrent://error", msg.message.unwrap_or_default());
                            }
                        }
                        "stream_url" => {
                            info!("Stream URL response: {:?}", msg.url);
                        }
                        "whisper_stream_url" => {
                            debug!("Whisper stream URL response: {:?}", msg.url);
                        }
                        "files" => {
                            info!("Files response: {:?}", msg.files);
                        }
                        "file_progress" => {
                            debug!("File progress response received");
                        }
                        "pieces" => {
                            debug!("Pieces response received");
                        }
                        "status" => {
                            debug!("Torrent status: {:?}", msg.status);
                        }
                        "health" => {
                            debug!("Torrent health response: {:?}", msg.status);
                        }
                        "stopped" => {
                            debug!("Torrent stopped");
                        }
                        _ => {
                            warn!("Unknown message type: {}", msg.msg_type);
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to parse server message: {}", e);
                }
            }
        }
    });

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    Ok(())
}

async fn send_command(cmd: &serde_json::Value) -> Result<(), String> {
    let proc_guard = WEBTORRENT_PROCESS.lock().await;
    let process = proc_guard
        .as_ref()
        .ok_or("WebTorrent process not initialized")?;

    // Health check: verify Node process is still running
    {
        let mut child_guard = process.child.lock().await;
        if let Some(child) = child_guard.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    warn!("Node process died: {:?}", status);
                    return Err(format!("Node process died: {:?}", status));
                }
                _ => {}
            }
        }
    }

    let mut stdin_guard = process.stdin.lock().await;
    let stdin = stdin_guard.as_mut().ok_or("stdin not available")?;

    match stdin.write_all(format!("{}\n", cmd).as_bytes()).await {
        Ok(_) => {
            stdin.flush().await.map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e)
            if e.to_string().contains("pipe is being closed")
                || e.to_string().contains("Broken pipe") =>
        {
            warn!("Node stdin pipe closed, marking process as dead");
            *stdin_guard = None;
            // Clear process state so it can be respawned
            drop(stdin_guard);
            drop(proc_guard);
            *WEBTORRENT_PROCESS.lock().await = None;
            *WEBTORRENT_PORT.lock().await = None;
            Err("Node process not responding".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Send a command and wait for the correlated response via requestId
async fn send_command_and_wait(
    cmd: &serde_json::Value,
    timeout_ms: u64,
) -> Result<ServerMessage, String> {
    let req_id = REQUEST_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let action = cmd
        .get("action")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let started = std::time::Instant::now();

    let mut cmd = cmd.clone();
    if let Some(obj) = cmd.as_object_mut() {
        obj.insert("requestId".to_string(), serde_json::json!(req_id));
    }

    let (tx, rx) = oneshot::channel();
    PENDING_REQUESTS.lock().await.insert(req_id, tx);

    if let Err(e) = send_command(&cmd).await {
        PENDING_REQUESTS.lock().await.remove(&req_id);
        warn!(
            target: "streamee_lib::torrent::protocol",
            source = "backend",
            subsystem = "webtorrent.protocol",
            event = "webtorrent.request_send_failed",
            request_id = req_id,
            action = %action,
            duration_ms = started.elapsed().as_millis() as u64,
            status = "Failed",
            error_kind = "sidecar_write",
            error = %e,
            "Could not send request to WebTorrent sidecar"
        );
        return Err(e);
    }

    match time::timeout(Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(msg)) => {
            debug!(
                target: "streamee_lib::torrent::protocol",
                source = "backend",
                subsystem = "webtorrent.protocol",
                event = "webtorrent.request_completed",
                request_id = req_id,
                action = %action,
                status = "Successful",
                response_type = %msg.msg_type,
                duration_ms = started.elapsed().as_millis() as u64,
                "WebTorrent sidecar request completed"
            );
            Ok(msg)
        }
        Ok(Err(_)) => {
            PENDING_REQUESTS.lock().await.remove(&req_id);
            warn!(
                target: "streamee_lib::torrent::protocol",
                source = "backend",
                subsystem = "webtorrent.protocol",
                event = "webtorrent.response_channel_closed",
                request_id = req_id,
                action = %action,
                duration_ms = started.elapsed().as_millis() as u64,
                status = "Failed",
                error_kind = "channel_closed",
                "WebTorrent response channel closed"
            );
            Err("Response channel closed".to_string())
        }
        Err(_) => {
            PENDING_REQUESTS.lock().await.remove(&req_id);
            warn!(
                target: "streamee_lib::torrent::protocol",
                source = "backend",
                subsystem = "webtorrent.protocol",
                event = "webtorrent.request_timed_out",
                request_id = req_id,
                action = %action,
                duration_ms = started.elapsed().as_millis() as u64,
                timeout_ms,
                status = "Failed",
                error_kind = "timeout",
                "WebTorrent sidecar request timed out"
            );
            Err(format!("Timeout waiting for response ({}ms)", timeout_ms))
        }
    }
}

pub async fn reset_torrent_session() -> Result<(), String> {
    send_command_and_wait(
        &serde_json::json!({ "action": "reset_torrent_session" }),
        3_000,
    )
    .await?;
    *LAST_PROGRESS.lock().unwrap() = None;
    Ok(())
}

pub async fn get_health() -> Result<TorrentHealth, String> {
    let session = current_startup_session();
    let sidecar_running = is_sidecar_running().await;
    let port = *WEBTORRENT_PORT.lock().await;

    let msg = send_command_and_wait(&serde_json::json!({ "action": "health" }), 2_000).await?;
    let has_torrent = msg.status.as_deref() != Some("idle");
    let metadata_ready = msg.metadata_ready.unwrap_or(false);
    let file_count = msg.file_count.unwrap_or(0);

    Ok(TorrentHealth {
        session_id: session.session_id,
        attempt: session.attempt,
        phase: session.phase,
        sidecar_running,
        has_torrent,
        metadata_ready,
        port: msg.port.or(port),
        file_count,
        last_error: session.last_error,
    })
}

async fn wait_for_metadata_ready(
    session_id: u64,
    attempt: u32,
    timeout: Duration,
) -> Result<DownloadProgress, String> {
    let started = time::Instant::now();
    let poll_interval = Duration::from_millis(500);

    while started.elapsed() < timeout {
        let session = current_startup_session();
        if session.session_id != session_id {
            return Err("Startup session replaced".to_string());
        }

        let health = get_health().await?;
        if !health.sidecar_running {
            return Err("WebTorrent sidecar stopped during startup".to_string());
        }

        if health.metadata_ready && health.file_count > 0 {
            emit_startup_state(
                session_id,
                attempt,
                "metadata_ready",
                format!("Metadata ready with {} files", health.file_count),
                None,
                None,
            );

            if let Some(progress) = get_progress().await? {
                if progress.metadata_ready || !progress.files.is_empty() {
                    return Ok(progress);
                }
            }
        }

        time::sleep(poll_interval).await;
    }

    Err("Timed out waiting for metadata".to_string())
}

pub async fn start_download(
    magnet_uri: String,
    listen_port: Option<u16>,
    expected_size: Option<u64>,
    persistent_cache: Option<(PathBuf, u64)>,
) -> Result<DownloadProgress, String> {
    if TORRENT_STARTING.swap(true, Ordering::SeqCst) {
        info!("Torrent start already in progress, returning existing state");
        return get_progress().await.map(|p| {
            p.unwrap_or(DownloadProgress {
                status: "starting".to_string(),
                downloaded: 0,
                total: 0,
                download_speed: 0,
                progress: 0.0,
                files: vec![],
                pieces: 0,
                downloaded_pieces: 0,
                peers: 0,
                connected_peers: 0,
                tracker_peers: 0,
                seeders: 0,
                leechers: 0,
                bitfield: vec![],
                metadata_ready: false,
                file_count: 0,
            })
        });
    }

    let result =
        start_download_internal(magnet_uri, listen_port, expected_size, persistent_cache).await;

    TORRENT_STARTING.store(false, Ordering::SeqCst);

    result
}

async fn start_download_internal(
    magnet_uri: String,
    listen_port: Option<u16>,
    expected_size: Option<u64>,
    persistent_cache: Option<(PathBuf, u64)>,
) -> Result<DownloadProgress, String> {
    let session_id = begin_startup_session();
    let retry_backoffs_ms = [0_u64, 1_500, 4_000];

    for (index, retry_in_ms) in retry_backoffs_ms.iter().enumerate() {
        let attempt = (index + 1) as u32;

        if *retry_in_ms > 0 {
            emit_startup_state(
                session_id,
                attempt,
                "waiting_for_metadata",
                format!(
                    "Retrying torrent startup ({}/{})",
                    attempt,
                    retry_backoffs_ms.len()
                ),
                Some(*retry_in_ms),
                Some("retrying_startup"),
            );
            time::sleep(Duration::from_millis(*retry_in_ms)).await;
        }

        emit_startup_state(
            session_id,
            attempt,
            "starting_sidecar",
            "Starting torrent sidecar",
            None,
            None,
        );
        start_server(listen_port).await?;
        ensure_port().await?;

        if attempt > 1 {
            let _ = reset_torrent_session().await;
        }

        emit_startup_state(
            session_id,
            attempt,
            "waiting_for_metadata",
            "Requesting torrent metadata",
            None,
            None,
        );

        let persistent_cache_root = persistent_cache
            .as_ref()
            .map(|(root, _)| root.to_string_lossy().to_string());
        let persistent_cache_limit_bytes = persistent_cache.as_ref().map(|(_, limit)| *limit);
        let start_response = send_command_and_wait(
            &serde_json::json!({
                "action": "start",
                "magnet": magnet_uri,
                "expectedSize": expected_size,
                "persistentCacheEnabled": persistent_cache.is_some(),
                "persistentCacheRoot": persistent_cache_root,
                "persistentCacheLimitBytes": persistent_cache_limit_bytes,
            }),
            5_000,
        )
        .await;

        match start_response {
            Ok(_) => {}
            Err(err) => {
                warn!(
                    "Failed to send start command on attempt {}: {}",
                    attempt, err
                );
                if attempt == retry_backoffs_ms.len() as u32 {
                    emit_startup_state(
                        session_id,
                        attempt,
                        "failed",
                        "Torrent start command failed",
                        None,
                        Some("start_command_failed"),
                    );
                    return Err(err);
                }
                continue;
            }
        }

        match wait_for_metadata_ready(session_id, attempt, Duration::from_secs(20)).await {
            Ok(progress) => return Ok(progress),
            Err(err) => {
                warn!("Metadata wait failed on attempt {}: {}", attempt, err);
                if attempt == retry_backoffs_ms.len() as u32 {
                    emit_startup_state(
                        session_id,
                        attempt,
                        "failed",
                        "Torrent metadata did not become ready",
                        None,
                        Some("metadata_timeout"),
                    );
                    return Err(err);
                }
            }
        }
    }

    Err("Torrent startup failed".to_string())
}

pub async fn get_progress() -> Result<Option<DownloadProgress>, String> {
    debug!("get_progress called");

    match send_command_and_wait(&serde_json::json!({ "action": "get_progress" }), 2000).await {
        Ok(msg) => {
            let progress = DownloadProgress {
                status: msg.status.unwrap_or_else(|| "downloading".to_string()),
                downloaded: msg.downloaded.unwrap_or(0),
                total: msg.total.unwrap_or(0),
                download_speed: msg.speed.unwrap_or(0.0) as u64,
                progress: msg.progress.unwrap_or(0.0),
                files: msg.files.unwrap_or_default(),
                pieces: msg.pieces.unwrap_or(0),
                downloaded_pieces: msg.downloaded_pieces.unwrap_or(0) as u32,
                peers: msg.peers.unwrap_or(0),
                connected_peers: msg
                    .connected_peers
                    .unwrap_or_else(|| msg.peers.unwrap_or(0)),
                tracker_peers: msg.tracker_peers.unwrap_or(0),
                seeders: msg.seeders.unwrap_or(0),
                leechers: msg.leechers.unwrap_or(0),
                bitfield: msg.bitfield.unwrap_or_default(),
                metadata_ready: msg.metadata_ready.unwrap_or(false),
                file_count: msg.file_count.unwrap_or(0),
            };
            debug!("get_progress returning: {:?}", progress);
            Ok(Some(progress))
        }
        Err(e) => {
            // Fallback to cached progress
            debug!(
                "get_progress send_command_and_wait failed: {}, using cached",
                e
            );
            let result = LAST_PROGRESS.lock().ok().and_then(|g| g.clone());
            Ok(result)
        }
    }
}

pub async fn get_file_progress(file_index: usize) -> Result<FileProgress, String> {
    info!("get_file_progress called for index: {}", file_index);

    let msg = send_command_and_wait(
        &serde_json::json!({ "action": "get_file_progress", "fileIndex": file_index }),
        2000,
    )
    .await?;

    if msg.msg_type == "file_progress" {
        Ok(FileProgress {
            file_index: msg.file_index.unwrap_or(file_index),
            downloaded: msg.downloaded.unwrap_or(0),
            total: msg.total.unwrap_or(0),
            progress: msg.progress.unwrap_or(0.0),
            ready: msg.ready.unwrap_or(false),
        })
    } else {
        Err(format!("Unexpected response type: {}", msg.msg_type))
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PieceInfo {
    pub total_pieces: usize,
    pub downloaded_pieces: usize,
    pub piece_size: usize,
    pub bitfield: Vec<u8>,
}

pub async fn get_pieces() -> Result<PieceInfo, String> {
    let msg = send_command_and_wait(&serde_json::json!({ "action": "get_pieces" }), 2000).await?;

    if msg.msg_type == "pieces" {
        Ok(PieceInfo {
            total_pieces: msg.total_pieces.unwrap_or(0),
            downloaded_pieces: msg.downloaded_pieces.unwrap_or(0),
            piece_size: 0,
            bitfield: msg.bitfield.unwrap_or_default(),
        })
    } else {
        Err(format!("Unexpected response type: {}", msg.msg_type))
    }
}

pub async fn stop_download() -> Result<(), String> {
    let _ = send_command_and_wait(&serde_json::json!({ "action": "stop" }), 3_000).await;
    shutdown_webtorrent_process().await;
    emit_startup_state(0, 0, "idle", "Torrent stopped", None, None);
    Ok(())
}

pub async fn pause_download() -> Result<(), String> {
    send_command(&serde_json::json!({ "action": "pause" })).await?;
    Ok(())
}

pub async fn resume_download() -> Result<(), String> {
    send_command(&serde_json::json!({ "action": "resume" })).await?;
    Ok(())
}

pub async fn get_stream_url(file_index: usize) -> Result<String, String> {
    send_command(&serde_json::json!({
        "action": "get_stream_url",
        "fileIndex": file_index
    }))
    .await?;

    let port = ensure_port().await?;

    Ok(format!("http://127.0.0.1:{}/stream/{}", port, file_index))
}

pub async fn get_whisper_stream_url(file_index: usize) -> Result<String, String> {
    send_command(&serde_json::json!({
        "action": "get_whisper_stream_url",
        "fileIndex": file_index
    }))
    .await?;

    let port = ensure_port().await?;

    Ok(format!("http://127.0.0.1:{}/whisper/{}", port, file_index))
}

pub async fn prepare_stream(
    file_index: usize,
    _readiness_timeout: Duration,
    cache_whole_file_enabled: bool,
) -> Result<(u64, String, u64, u64), String> {
    let session = current_startup_session();
    if session.session_id == 0 {
        return Err("No active torrent startup session".to_string());
    }

    emit_startup_state(
        session.session_id,
        session.attempt.max(1),
        "selecting_file",
        format!("Selecting file {}", file_index),
        None,
        None,
    );

    let health = get_health().await?;
    if !health.sidecar_running {
        emit_startup_state(
            session.session_id,
            session.attempt.max(1),
            "failed",
            "Torrent sidecar is not running",
            None,
            Some("sidecar_unavailable"),
        );
        return Err("Torrent sidecar is not running".to_string());
    }

    if !health.metadata_ready {
        emit_startup_state(
            session.session_id,
            session.attempt.max(1),
            "failed",
            "Torrent metadata is not ready",
            None,
            Some("metadata_not_ready"),
        );
        return Err("Torrent metadata is not ready".to_string());
    }

    let progress = get_file_progress(file_index).await?;
    if progress.total == 0 {
        emit_startup_state(
            session.session_id,
            session.attempt.max(1),
            "failed",
            format!("File {} is not available in torrent metadata", file_index),
            None,
            Some("file_not_found"),
        );
        return Err(format!(
            "File {} is not available in torrent metadata",
            file_index
        ));
    }

    send_command_and_wait(
        &serde_json::json!({
            "action": "configure_full_cache",
            "fileIndex": file_index,
            "enabled": cache_whole_file_enabled,
        }),
        2_000,
    )
    .await?;

    emit_startup_state(
        session.session_id,
        session.attempt.max(1),
        "stream_ready",
        format!("Stream ready for file {}", file_index),
        None,
        None,
    );

    let url = get_stream_url(file_index).await?;
    Ok((session.session_id, url, progress.downloaded, progress.total))
}

pub async fn ensure_port() -> Result<u16, String> {
    if let Some(port) = *WEBTORRENT_PORT.lock().await {
        return Ok(port);
    }

    let (tx, rx) = oneshot::channel();

    {
        let mut guard = PORT_WAITERS.lock().await;
        guard.push(tx);
    }

    send_command(&serde_json::json!({ "action": "get_port" })).await?;

    match time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(port)) => {
            info!("Got port from Node: {}", port);
            Ok(port)
        }
        Ok(Err(_)) => Err("Port channel closed".to_string()),
        Err(_) => Err("Timeout waiting for port".to_string()),
    }
}

pub async fn get_file_path_from_state(filename: &str) -> Result<Option<(String, PathBuf)>, String> {
    let progress = get_progress()
        .await?
        .or_else(|| LAST_PROGRESS.lock().ok().and_then(|g| g.clone()));

    if let Some(progress) = progress {
        for file in &progress.files {
            if file.name == filename {
                if let Some(path) = &file.path {
                    return Ok(Some((file.name.clone(), PathBuf::from(path))));
                }
            }
        }

        for file in &progress.files {
            if let Some(path) = &file.path {
                return Ok(Some((file.name.clone(), PathBuf::from(path))));
            }
        }
    }

    Ok(None)
}
