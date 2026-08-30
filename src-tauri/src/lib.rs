mod addons;
mod api_keys;
mod audio_normalizer;
mod credential_vault;
mod discord_presence;
mod intro_skipper;
mod introdb;
mod logging;
mod mpv_ipc;
mod remote_server;
mod rife_runtime;
mod torrent;
mod whisperlive;
#[cfg(target_os = "windows")]
mod windows_hdr;
mod windows_volume;

use intro_skipper::{
    detect_intro_skipper_outro_segment, detect_intro_skipper_segment,
    detect_player_chapter_segments,
};
use introdb::fetch_introdb_segments;
use mpv_ipc::{
    ack_smart_next_request, fetch_player_tracks, get_pending_smart_next_request, get_player_info,
    get_playlist_info, load_file_replace_with_title, load_subtitle_file, playlist_add,
    playlist_next, playlist_prev, seek_absolute_time, set_detected_segments,
    set_media_title as set_mpv_media_title, set_player_track as set_mpv_player_track,
    set_smart_next_available, show_player_message, start_player_observing, stop_player_observing,
    PlayerDetectedSegment,
};
use sha1::{Digest, Sha1};
use tauri_plugin_store::StoreExt;
use whisperlive::SharedWhisperLiveState;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{debug, error, info, warn};

#[cfg(target_os = "windows")]
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_ALT, MOD_NOREPEAT, VK_F6};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

#[cfg(target_os = "windows")]
const WEBVIEW_RECOVERY_RESTART_ENV: &str = "STREAMEE_WEBVIEW_RECOVERY_RESTARTED";
#[cfg(target_os = "windows")]
const WEBVIEW_RECOVERY_STABILIZATION_SECONDS: u64 = 30;
#[cfg(target_os = "windows")]
static WEBVIEW_RECOVERY_RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "windows")]
const EMERGENCY_SCRAM_HOTKEY_ID: i32 = 0x5354;
const MPV_STRUCTURED_LOGGING_ENABLED: bool = true;

#[cfg(target_os = "windows")]
fn emergency_scram_command(process_id: u32) -> String {
    format!(
        "taskkill /F /T /IM node.exe >nul 2>&1 & \
         taskkill /F /T /IM streameenode.exe >nul 2>&1 & \
         taskkill /F /PID {process_id} >nul 2>&1"
    )
}

#[cfg(target_os = "windows")]
fn trigger_emergency_scram() -> ! {
    let script = emergency_scram_command(std::process::id());
    let mut command = std::process::Command::new("cmd.exe");
    command.args(["/D", "/S", "/C", &script]);
    hide_console_std(&mut command);
    let _ = command.spawn();

    std::process::exit(137);
}

#[cfg(target_os = "windows")]
fn install_emergency_scram_hotkey() {
    let _ = std::thread::Builder::new()
        .name("streamee-emergency-scram".to_string())
        .spawn(|| {
            let modifiers = MOD_ALT | MOD_NOREPEAT;
            if let Err(error) = unsafe {
                RegisterHotKey(None, EMERGENCY_SCRAM_HOTKEY_ID, modifiers, VK_F6.0 as u32)
            } {
                warn!(
                    event = "app.scram_hotkey_registration_failed",
                    source = "backend",
                    subsystem = "app.safety",
                    error_kind = %error.code(),
                    "Could not register emergency Alt+F6 shortcut: {error}"
                );
                return;
            }

            info!(
                event = "app.scram_hotkey_registered",
                source = "backend",
                subsystem = "app.safety",
                shortcut = "Alt+F6",
                "Emergency SCRAM shortcut registered"
            );

            let mut message = MSG::default();
            loop {
                let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
                if result.0 <= 0 {
                    break;
                }
                if message.message == WM_HOTKEY
                    && message.wParam.0 == EMERGENCY_SCRAM_HOTKEY_ID as usize
                {
                    trigger_emergency_scram();
                }
            }
        });
}

#[cfg(all(test, target_os = "windows"))]
mod emergency_scram_tests {
    use super::emergency_scram_command;

    #[test]
    fn scram_targets_all_node_sidecars_and_only_the_current_main_process() {
        let command = emergency_scram_command(4242);
        assert!(command.contains("taskkill /F /T /IM node.exe"));
        assert!(command.contains("taskkill /F /T /IM streameenode.exe"));
        assert!(command.contains("taskkill /F /PID 4242"));
        assert!(!command.contains("/IM streamee.exe"));
    }
}

#[cfg(target_os = "windows")]
fn webview_process_failure_kind_name(kind: i32) -> &'static str {
    match kind {
        0 => "browser-process-exited",
        1 => "render-process-exited",
        2 => "render-process-unresponsive",
        3 => "frame-render-process-exited",
        4 => "utility-process-exited",
        5 => "sandbox-helper-process-exited",
        6 => "gpu-process-exited",
        7 => "ppapi-plugin-process-exited",
        8 => "ppapi-broker-process-exited",
        9 => "unknown-process-exited",
        _ => "unknown",
    }
}

#[cfg(target_os = "windows")]
fn webview_process_failure_reason_name(reason: i32) -> &'static str {
    match reason {
        0 => "unexpected",
        1 => "unresponsive",
        2 => "terminated",
        3 => "crashed",
        4 => "launch-failed",
        5 => "out-of-memory",
        6 => "profile-deleted",
        _ => "unknown",
    }
}

#[cfg(target_os = "windows")]
fn install_webview_process_recovery(window: &tauri::WebviewWindow) {
    let label = window.label().to_string();
    let app_handle = window.app_handle().clone();
    if std::env::var_os(WEBVIEW_RECOVERY_RESTART_ENV).is_some() {
        info!(
            "WebView2 recovery restart guard active for {WEBVIEW_RECOVERY_STABILIZATION_SECONDS}s"
        );
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(
                WEBVIEW_RECOVERY_STABILIZATION_SECONDS,
            ));
            std::env::remove_var(WEBVIEW_RECOVERY_RESTART_ENV);
            info!("WebView2 recovery restart guard cleared after stable startup");
        });
    }
    let registration = window.with_webview(move |platform_webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
            ICoreWebView2ProcessFailedEventArgs2,
        };
        use webview2_com::ProcessFailedEventHandler;
        use windows::core::{Interface, PWSTR};
        use windows::Win32::System::Com::CoTaskMemFree;

        let controller = platform_webview.controller();
        let core_webview = match unsafe { controller.CoreWebView2() } {
            Ok(webview) => webview,
            Err(error) => {
                warn!("Failed to access WebView2 core for process recovery: {error}");
                return;
            }
        };

        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else {
                warn!("WebView2 process failure reported without event details");
                return Ok(());
            };

            let mut kind = Default::default();
            if let Err(error) = unsafe { args.ProcessFailedKind(&mut kind) } {
                warn!("Failed to read WebView2 process failure kind: {error}");
                return Ok(());
            }

            match args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                Ok(details) => {
                    let mut reason = Default::default();
                    let reason = unsafe { details.Reason(&mut reason) }
                        .ok()
                        .map(|()| reason.0);

                    let mut exit_code = 0;
                    let exit_code = unsafe { details.ExitCode(&mut exit_code) }
                        .ok()
                        .map(|()| exit_code);

                    let mut raw_description = PWSTR::null();
                    let description = if unsafe {
                        details.ProcessDescription(&mut raw_description)
                    }
                    .is_ok()
                        && !raw_description.is_null()
                    {
                        unsafe { raw_description.to_string() }
                            .unwrap_or_else(|_| "invalid-utf16".to_string())
                    } else {
                        "unavailable".to_string()
                    };
                    if !raw_description.is_null() {
                        unsafe { CoTaskMemFree(Some(raw_description.as_ptr().cast())) };
                    }

                    let reason = reason
                        .map(|value| {
                            format!(
                                "{}({value})",
                                webview_process_failure_reason_name(value)
                            )
                        })
                        .unwrap_or_else(|| "unavailable".to_string());
                    let exit_code = exit_code
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "unavailable".to_string());

                    warn!(
                        "WebView2 process failure detected; kind={}({}), reason={}, exit_code={}, process_description={:?}",
                        webview_process_failure_kind_name(kind.0),
                        kind.0,
                        reason,
                        exit_code,
                        description
                    );
                }
                Err(error) => warn!(
                    "WebView2 process failure detected; kind={}({}), diagnostics_unavailable={error}",
                    webview_process_failure_kind_name(kind.0),
                    kind.0
                ),
            }
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                if std::env::var_os(WEBVIEW_RECOVERY_RESTART_ENV).is_none()
                    && WEBVIEW_RECOVERY_RESTART_REQUESTED
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                {
                    warn!(
                        "WebView2 browser process exited; restarting Streamee once after cleanup"
                    );
                    std::env::set_var(WEBVIEW_RECOVERY_RESTART_ENV, "1");
                    let app_handle = app_handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        app_handle.request_restart();
                    });
                } else {
                    warn!(
                        "WebView2 browser process exited after automatic recovery was already attempted; restart suppressed to avoid a loop"
                    );
                }
            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
            {
                if let Some(sender) = sender {
                    match unsafe { sender.Reload() } {
                        Ok(()) => info!("Reloading WebView2 after renderer failure"),
                        Err(error) => {
                            warn!("Failed to reload WebView2 after renderer failure: {error}")
                        }
                    }
                }
            }

            Ok(())
        }));

        let mut token = 0;
        if let Err(error) = unsafe { core_webview.add_ProcessFailed(&handler, &mut token) } {
            warn!("Failed to register WebView2 process recovery handler: {error}");
        } else {
            info!("WebView2 process recovery handler registered");
        }
    });

    if let Err(error) = registration {
        warn!("Failed to configure WebView2 process recovery for window {label}: {error}");
    }
}

#[cfg(target_os = "windows")]
fn hide_console_std(command: &mut std::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW.0);
}

#[cfg(not(target_os = "windows"))]
fn hide_console_std(_command: &mut std::process::Command) {}

const DEFAULT_SVP_EXECUTABLE_PATH: &str = r"C:\Program Files (x86)\SVP 4\SVPManager.exe";
const REMOTE_METADATA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);
const TORRENT_METADATA_MAX_BYTES: usize = 20 * 1024 * 1024;
const TORRENT_METADATA_MAX_REDIRECTS: usize = 10;

static REMOTE_METADATA_HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(reqwest::Client::new);
#[cfg(target_os = "windows")]
static AUTO_HDR_TARGET: Lazy<Mutex<Option<windows_hdr::HdrTarget>>> =
    Lazy::new(|| Mutex::new(None));
#[cfg(target_os = "windows")]
static SKIP_AUTO_HDR_ON_NEXT_LAUNCH: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static SKIP_HDR_RESTORE_ON_NEXT_MPV_EXIT: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize)]
struct KinoCheckMovieResponse {
    trailer: Option<KinoCheckTrailer>,
}

#[derive(Debug, Serialize, Deserialize)]
struct KinoCheckTrailer {
    id: Option<String>,
    youtube_video_id: Option<String>,
    title: Option<String>,
    url: Option<String>,
    language: Option<String>,
    categories: Option<Vec<String>>,
    published: Option<String>,
}

#[allow(dead_code)]
static MPV_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct AppState {
    #[allow(dead_code)]
    session_initialized: AtomicBool,
    torrent_app_handle: std::sync::Mutex<Option<tauri::AppHandle>>,
}

#[derive(Debug, Deserialize)]
struct RendererLogEntry {
    timestamp: u64,
    level: String,
    subsystem: String,
    event: String,
    message: String,
    fields: serde_json::Value,
}

fn normalize_log_identifier(value: &str, fallback: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .take(80)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if normalized.is_empty() {
        fallback.to_string()
    } else {
        normalized
    }
}

#[tauri::command]
fn write_renderer_log_batch(entries: Vec<RendererLogEntry>) -> Result<(), String> {
    const MAX_BATCH_SIZE: usize = 101;
    const MAX_MESSAGE_BYTES: usize = 16 * 1024;
    const MAX_FIELDS_BYTES: usize = 64 * 1024;

    if entries.len() > MAX_BATCH_SIZE {
        return Err(format!(
            "Renderer log batch contains {} entries; maximum is {MAX_BATCH_SIZE}",
            entries.len()
        ));
    }

    for mut entry in entries {
        if entry.message.len() > MAX_MESSAGE_BYTES {
            entry.message.truncate(MAX_MESSAGE_BYTES);
        }
        let mut fields = entry.fields;
        logging::redact_json_value(&mut fields);
        let fields_json = serde_json::to_string(&fields)
            .map_err(|error| format!("Could not serialize renderer log fields: {error}"))?;
        if fields_json.len() > MAX_FIELDS_BYTES {
            return Err(format!(
                "Renderer log fields exceed {MAX_FIELDS_BYTES} bytes for event {}",
                entry.event
            ));
        }
        let subsystem = normalize_log_identifier(&entry.subsystem, "renderer");
        let event_name = normalize_log_identifier(&entry.event, "console.message");
        let message = logging::redact_text(&entry.message);
        match entry.level.trim().to_ascii_lowercase().as_str() {
            "debug" => debug!(
                target: "streamee_lib::renderer",
                source = "renderer",
                subsystem = %subsystem,
                event = %event_name,
                renderer_timestamp = entry.timestamp,
                fields_json = %fields_json,
                "{message}"
            ),
            "info" => info!(
                target: "streamee_lib::renderer",
                source = "renderer",
                subsystem = %subsystem,
                event = %event_name,
                renderer_timestamp = entry.timestamp,
                fields_json = %fields_json,
                "{message}"
            ),
            "warn" => warn!(
                target: "streamee_lib::renderer",
                source = "renderer",
                subsystem = %subsystem,
                event = %event_name,
                renderer_timestamp = entry.timestamp,
                fields_json = %fields_json,
                "{message}"
            ),
            "error" => error!(
                target: "streamee_lib::renderer",
                source = "renderer",
                subsystem = %subsystem,
                event = %event_name,
                renderer_timestamp = entry.timestamp,
                fields_json = %fields_json,
                "{message}"
            ),
            other => return Err(format!("Unsupported renderer log level: {other}")),
        }
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TorrentStats {
    pub status: String,
    pub downloaded: u64,
    pub total: u64,
    pub download_speed: u64,
    pub upload_speed: u64,
    pub uploaded: u64,
    pub progress: f64,
    pub pieces: Pieces,
    pub peers: Peers,
    pub peer_list: Vec<PeerInfo>,
    pub trackers: Vec<TrackerInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Pieces {
    pub ready: u32,
    pub total: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Peers {
    pub total: u32,
    pub seeders: u32,
    pub leechers: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PeerInfo {
    pub ip: String,
    pub protocol: String,
    pub download_speed: u64,
    pub upload_speed: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TrackerInfo {
    pub url: String,
    pub status: String,
    pub peers: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TorrentFile {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TorrentPortTestResult {
    pub port: u16,
    pub dht_enabled: bool,
    pub tcp_bind_ok: bool,
    pub udp_bind_ok: bool,
    pub tcp_error: Option<String>,
    pub udp_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StreamLaunchResult {
    pub session_id: u64,
    pub pid: u32,
    pub file_url: String,
    pub ready_bytes: u64,
    pub total_bytes: u64,
    pub playlist_file_urls: Vec<String>,
    pub playlist_files: Vec<StreamPlaylistItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamPlaylistItem {
    pub url: String,
    pub name: String,
    pub size: u64,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MpvPrelaunchResult {
    pub pid: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreparedStreamResult {
    pub session_id: u64,
    pub file_url: String,
    pub ready_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreparedQbittorrentStreamResult {
    pub file_url: String,
    pub file_name: String,
    pub ready_bytes: u64,
    pub total_bytes: u64,
    pub playlist_file_urls: Vec<String>,
    pub playlist_files: Vec<StreamPlaylistItem>,
    pub torrent_hash: String,
    pub downloaded_bytes: u64,
}

fn media_file_base_name(name: &str) -> String {
    let normalized = name.replace('\\', "/");
    normalized
        .rsplit('/')
        .next()
        .filter(|base| !base.trim().is_empty())
        .unwrap_or(name)
        .to_string()
}

fn stream_playlist_item(
    url: String,
    name: String,
    size: u64,
    preferred_season: Option<u32>,
) -> StreamPlaylistItem {
    let parsed = parse_episode_number_with_context(&name, preferred_season);
    StreamPlaylistItem {
        url,
        name: media_file_base_name(&name),
        size,
        season: parsed.map(|(season, _)| season),
        episode: parsed.map(|(_, episode)| episode),
    }
}

#[derive(Debug, Deserialize, Clone)]
struct QbittorrentTorrentInfo {
    hash: String,
    name: String,
    save_path: String,
    seq_dl: bool,
    f_l_piece_prio: bool,
    #[serde(default)]
    downloaded: u64,
    #[serde(default)]
    progress: f64,
}

#[derive(Debug, Deserialize, Clone)]
struct QbittorrentFileInfo {
    #[serde(default)]
    index: usize,
    name: String,
    progress: f64,
    size: u64,
    piece_range: Option<[usize; 2]>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Track {
    pub id: i32,
    #[serde(rename = "type")]
    pub type_: String,
    pub title: String,
    pub lang: String,
    pub codec: String,
    pub selected: bool,
    pub hearing_impaired: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub status: String,
    pub downloaded: u64,
    pub total: u64,
    pub download_speed: u64,
    pub progress: f64,
    pub files: Vec<torrent::TorrentFile>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalVideoFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VideoUpscaler {
    RtxVsr,
    SSimSuperRes,
    Fsr,
}

impl VideoUpscaler {
    fn from_setting(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()) {
            Some(ref v) if v == "ssim-superres" || v == "ssimsuperres" || v == "ssim" => {
                Self::SSimSuperRes
            }
            Some(ref v) if v == "fsr" => Self::Fsr,
            _ => Self::RtxVsr,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::RtxVsr => "RTX VSR",
            Self::SSimSuperRes => "SSimSuperRes",
            Self::Fsr => "FSR",
        }
    }

    fn sharpen_default(self) -> &'static str {
        match self {
            Self::RtxVsr => "auto",
            Self::SSimSuperRes | Self::Fsr => "off",
        }
    }
}

fn normalize_mpv_language(value: Option<&str>) -> &'static str {
    match value.map(|v| v.trim().to_ascii_lowercase()) {
        Some(ref v) if v == "ms" || v == "may" || v == "msa" || v == "malay" => "ms,may,msa,malay",
        Some(ref v) if v == "id" || v == "ind" || v == "indonesian" => "id,ind,indonesian",
        Some(ref v) if v == "zh" || v == "chi" || v == "zho" || v == "chinese" => {
            "zh,chi,zho,chinese"
        }
        Some(ref v) if v == "ja" || v == "jpn" || v == "japanese" => "ja,jpn,japanese",
        Some(ref v) if v == "ko" || v == "kor" || v == "korean" => "ko,kor,korean",
        Some(ref v) if v == "es" || v == "spa" || v == "spanish" => "es,spa,spanish",
        Some(ref v) if v == "fr" || v == "fre" || v == "fra" || v == "french" => {
            "fr,fre,fra,french"
        }
        Some(ref v) if v == "de" || v == "ger" || v == "deu" || v == "german" => {
            "de,ger,deu,german"
        }
        Some(ref v) if v == "pt" || v == "por" || v == "portuguese" => "pt,por,portuguese",
        Some(ref v) if v == "it" || v == "ita" || v == "italian" => "it,ita,italian",
        Some(ref v) if v == "th" || v == "tha" || v == "thai" => "th,tha,thai",
        Some(ref v) if v == "vi" || v == "vie" || v == "vietnamese" => "vi,vie,vietnamese",
        _ => "en,eng,english",
    }
}

fn get_torrent_listen_port(state: &tauri::State<'_, AppState>) -> Option<u16> {
    if let Ok(handle_lock) = state.torrent_app_handle.lock() {
        if let Some(app_handle) = handle_lock.as_ref() {
            if let Ok(store) = app_handle.store("settings.json") {
                if let Some(value) = store.get("torrentPort") {
                    if let Some(port) = value.as_str().and_then(|s| s.parse::<u16>().ok()) {
                        return Some(port);
                    }
                    if let Some(port) = value.as_u64().and_then(|p| u16::try_from(p).ok()) {
                        return Some(port);
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
async fn start_torrent(
    state: tauri::State<'_, AppState>,
    magnet_uri: String,
    _files: Vec<TorrentFile>,
    expected_size: Option<u64>,
) -> Result<String, String> {
    let torrent_name = magnet_uri
        .split("&dn=")
        .nth(1)
        .map(|s| s.split('&').next().unwrap_or(&s))
        .unwrap_or("Unknown");
    info!("Starting torrent download: {}", torrent_name);

    let listen_port = get_torrent_listen_port(&state);
    let persistent_cache = state
        .torrent_app_handle
        .lock()
        .ok()
        .and_then(|handle| handle.as_ref().cloned())
        .and_then(|app| persistent_webtorrent_cache_settings(&app));
    let result =
        torrent::start_download(magnet_uri, listen_port, expected_size, persistent_cache).await?;

    info!("Torrent started, files: {}", result.files.len());
    Ok(format!("Torrent started with {} files", result.files.len()))
}

#[tauri::command]
async fn get_torrent_stats() -> Result<Option<TorrentStats>, String> {
    match torrent::get_progress().await {
        Ok(Some(progress)) => {
            let status = match progress.status.as_str() {
                "getting_metadata" => "getting_metadata".to_string(),
                "downloading" => "downloading".to_string(),
                "seeding" => "seeding".to_string(),
                "paused" => "paused".to_string(),
                _ => "downloading".to_string(),
            };

            let pieces = Pieces {
                ready: progress.downloaded_pieces,
                total: progress.pieces,
            };

            Ok(Some(TorrentStats {
                status,
                downloaded: progress.downloaded,
                total: progress.total,
                download_speed: progress.download_speed,
                upload_speed: 0,
                uploaded: 0,
                progress: progress.progress,
                pieces,
                peers: Peers {
                    total: 0,
                    seeders: 0,
                    leechers: 0,
                },
                peer_list: vec![],
                trackers: vec![],
            }))
        }
        Ok(None) => Ok(None),
        Err(e) => {
            warn!("Failed to get torrent stats: {}", e);
            Ok(None)
        }
    }
}

#[tauri::command]
async fn get_torrent_files() -> Result<Vec<torrent::TorrentFile>, String> {
    match torrent::get_progress().await {
        Ok(Some(progress)) => Ok(progress.files),
        Ok(None) => Ok(vec![]),
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn get_file_progress(file_index: usize) -> Result<torrent::FileProgress, String> {
    torrent::get_file_progress(file_index).await
}

#[tauri::command]
async fn get_pieces() -> Result<torrent::PieceInfo, String> {
    torrent::get_pieces().await
}

#[tauri::command]
async fn get_stream_url(file_index: usize) -> Result<String, String> {
    info!("Getting stream URL for file index: {}", file_index);
    torrent::get_stream_url(file_index).await
}

#[tauri::command]
async fn get_torrent_health() -> Result<torrent::TorrentHealth, String> {
    torrent::get_health().await
}

#[tauri::command]
async fn test_torrent_port(port: u16) -> Result<TorrentPortTestResult, String> {
    if !(1024..=65535).contains(&port) {
        return Err("Torrent port must be between 1024 and 65535".to_string());
    }

    let bind_addr = format!("0.0.0.0:{port}");

    let tcp_result = TcpListener::bind(&bind_addr);
    let (tcp_bind_ok, tcp_error) = match tcp_result {
        Ok(listener) => {
            drop(listener);
            (true, None)
        }
        Err(err) => (false, Some(err.to_string())),
    };

    let udp_result = UdpSocket::bind(&bind_addr);
    let (udp_bind_ok, udp_error) = match udp_result {
        Ok(socket) => {
            drop(socket);
            (true, None)
        }
        Err(err) => (false, Some(err.to_string())),
    };

    Ok(TorrentPortTestResult {
        port,
        dht_enabled: true,
        tcp_bind_ok,
        udp_bind_ok,
        tcp_error,
        udp_error,
    })
}

#[tauri::command]
async fn prepare_and_open_stream(
    app: tauri::AppHandle,
    file_index: usize,
    display_title: Option<String>,
    position_x: Option<i32>,
    position_y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    start_position: Option<f64>,
    upscaler: Option<String>,
    seek_preview_enabled: Option<bool>,
    force_stereo_enabled: Option<bool>,
    rtx_hdr_enabled: Option<bool>,
    hdr_contrast_boost_enabled: Option<bool>,
    cache_whole_file_enabled: Option<bool>,
    preferred_subtitle_language: Option<String>,
    preferred_audio_language: Option<String>,
    prefer_sdh_subtitles: Option<bool>,
) -> Result<StreamLaunchResult, String> {
    info!(
        "Preparing verified stream launch for file index: {}",
        file_index
    );
    let cache_whole_file_enabled = cache_whole_file_enabled.unwrap_or(false);
    let (session_id, file_url, ready_bytes, total_bytes) = torrent::prepare_stream(
        file_index,
        std::time::Duration::from_secs(30),
        cache_whole_file_enabled,
    )
    .await?;
    let startup_attempt = torrent::get_health()
        .await
        .map(|health| health.attempt.max(1))
        .unwrap_or(1);

    torrent::emit_startup_state(
        session_id,
        startup_attempt,
        "launching_mpv",
        format!("Launching MPV for file {}", file_index),
        None,
        None,
    );

    let mut last_error = None;
    for attempt in 0..2 {
        #[cfg(target_os = "windows")]
        match launch_stream_with_mpv(
            &app,
            file_url.clone(),
            display_title.clone(),
            position_x,
            position_y,
            width,
            height,
            start_position,
            upscaler.clone(),
            seek_preview_enabled.unwrap_or(false),
            force_stereo_enabled.unwrap_or(true),
            rtx_hdr_enabled.unwrap_or(false),
            hdr_contrast_boost_enabled.unwrap_or(false),
            cache_whole_file_enabled,
            preferred_subtitle_language.clone(),
            preferred_audio_language.clone(),
            prefer_sdh_subtitles.unwrap_or(false),
        )
        .await
        {
            Ok(pid) => {
                torrent::emit_startup_state(
                    session_id,
                    torrent::get_health()
                        .await
                        .map(|health| health.attempt.max(1))
                        .unwrap_or(1),
                    "mpv_started",
                    format!("MPV started for file {}", file_index),
                    None,
                    None,
                );
                return Ok(StreamLaunchResult {
                    session_id,
                    pid,
                    file_url,
                    ready_bytes,
                    total_bytes,
                    playlist_file_urls: vec![],
                    playlist_files: vec![],
                });
            }
            Err(err) => {
                last_error = Some(err);
                if attempt == 0 {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = (
                display_title,
                position_x,
                position_y,
                width,
                height,
                start_position,
                attempt,
            );
            return Err("prepare_and_open_stream is only implemented on Windows".to_string());
        }
    }

    torrent::emit_startup_state(
        session_id,
        startup_attempt,
        "failed",
        "MPV launch failed after retries",
        None,
        Some("mpv_launch_failed"),
    );
    Err(last_error.unwrap_or_else(|| "Failed to launch MPV".to_string()))
}

#[tauri::command]
async fn prelaunch_mpv(
    app: tauri::AppHandle,
    display_title: Option<String>,
    position_x: Option<i32>,
    position_y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    upscaler: Option<String>,
    seek_preview_enabled: Option<bool>,
    force_stereo_enabled: Option<bool>,
    rtx_hdr_enabled: Option<bool>,
    hdr_contrast_boost_enabled: Option<bool>,
    cache_whole_file_enabled: Option<bool>,
    preferred_subtitle_language: Option<String>,
    preferred_audio_language: Option<String>,
    prefer_sdh_subtitles: Option<bool>,
) -> Result<MpvPrelaunchResult, String> {
    #[cfg(target_os = "windows")]
    {
        let cache_whole_file_enabled = cache_whole_file_enabled.unwrap_or(false);
        let pid = launch_idle_mpv(
            &app,
            display_title,
            position_x,
            position_y,
            width,
            height,
            upscaler,
            seek_preview_enabled.unwrap_or(false),
            force_stereo_enabled.unwrap_or(true),
            rtx_hdr_enabled.unwrap_or(false),
            hdr_contrast_boost_enabled.unwrap_or(false),
            cache_whole_file_enabled,
            preferred_subtitle_language,
            preferred_audio_language,
            prefer_sdh_subtitles.unwrap_or(false),
        )
        .await?;
        Ok(MpvPrelaunchResult { pid })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (
            app,
            display_title,
            position_x,
            position_y,
            width,
            height,
            upscaler,
            seek_preview_enabled,
            force_stereo_enabled,
            rtx_hdr_enabled,
            hdr_contrast_boost_enabled,
            cache_whole_file_enabled,
            preferred_subtitle_language,
            preferred_audio_language,
            prefer_sdh_subtitles,
        );
        Err("prelaunch_mpv is only implemented on Windows".to_string())
    }
}

#[tauri::command]
async fn prepare_and_load_stream(
    file_index: usize,
    pid: u32,
    display_title: Option<String>,
    start_position: Option<f64>,
    cache_whole_file_enabled: Option<bool>,
) -> Result<StreamLaunchResult, String> {
    info!(
        "Preparing verified stream load for file index {} into MPV PID {}",
        file_index, pid
    );
    let (session_id, file_url, ready_bytes, total_bytes) = torrent::prepare_stream(
        file_index,
        std::time::Duration::from_secs(30),
        cache_whole_file_enabled.unwrap_or(false),
    )
    .await?;
    let startup_attempt = torrent::get_health()
        .await
        .map(|health| health.attempt.max(1))
        .unwrap_or(1);

    torrent::emit_startup_state(
        session_id,
        startup_attempt,
        "loading_mpv_stream",
        format!("Loading stream in MPV for file {}", file_index),
        None,
        None,
    );

    load_file_replace_with_title(&file_url, display_title.as_deref(), start_position)?;

    torrent::emit_startup_state(
        session_id,
        torrent::get_health()
            .await
            .map(|health| health.attempt.max(1))
            .unwrap_or(1),
        "mpv_started",
        format!("MPV loaded stream for file {}", file_index),
        None,
        None,
    );

    Ok(StreamLaunchResult {
        session_id,
        pid,
        file_url,
        ready_bytes,
        total_bytes,
        playlist_file_urls: vec![],
        playlist_files: vec![],
    })
}

#[tauri::command]
async fn prepare_stream_url(file_index: usize) -> Result<PreparedStreamResult, String> {
    info!(
        "Preparing verified stream URL for file index: {}",
        file_index
    );
    let (session_id, file_url, ready_bytes, total_bytes) =
        torrent::prepare_stream(file_index, std::time::Duration::from_secs(30), false).await?;

    Ok(PreparedStreamResult {
        session_id,
        file_url,
        ready_bytes,
        total_bytes,
    })
}

fn extract_info_hash(magnet_uri: &str, info_hash: Option<&str>) -> Result<String, String> {
    if let Some(hash) = info_hash {
        let normalized = hash.trim().to_lowercase();
        if !normalized.is_empty() {
            return Ok(normalized);
        }
    }

    let marker = "xt=urn:btih:";
    let Some(start) = magnet_uri.find(marker) else {
        return Err("Could not determine torrent info hash".to_string());
    };
    let start_index = start + marker.len();
    let hash = magnet_uri[start_index..]
        .split('&')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();

    if hash.is_empty() {
        Err("Could not determine torrent info hash".to_string())
    } else {
        Ok(hash)
    }
}

fn parse_bencode_string_length(bytes: &[u8], cursor: &mut usize) -> Result<usize, String> {
    let start = *cursor;
    while *cursor < bytes.len() && bytes[*cursor].is_ascii_digit() {
        *cursor += 1;
    }

    if *cursor == start || *cursor >= bytes.len() || bytes[*cursor] != b':' {
        return Err("Invalid bencoded string length".to_string());
    }

    let length = std::str::from_utf8(&bytes[start..*cursor])
        .map_err(|_| "Invalid bencoded string length".to_string())?
        .parse::<usize>()
        .map_err(|_| "Invalid bencoded string length".to_string())?;

    *cursor += 1;
    Ok(length)
}

fn skip_bencode_value(bytes: &[u8], cursor: &mut usize) -> Result<(), String> {
    if *cursor >= bytes.len() {
        return Err("Unexpected end of torrent metadata".to_string());
    }

    match bytes[*cursor] {
        b'i' => {
            *cursor += 1;
            let start = *cursor;
            while *cursor < bytes.len() && bytes[*cursor] != b'e' {
                *cursor += 1;
            }
            if *cursor >= bytes.len() || *cursor == start {
                return Err("Invalid bencoded integer".to_string());
            }
            *cursor += 1;
            Ok(())
        }
        b'l' => {
            *cursor += 1;
            while *cursor < bytes.len() && bytes[*cursor] != b'e' {
                skip_bencode_value(bytes, cursor)?;
            }
            if *cursor >= bytes.len() {
                return Err("Invalid bencoded list".to_string());
            }
            *cursor += 1;
            Ok(())
        }
        b'd' => {
            *cursor += 1;
            while *cursor < bytes.len() && bytes[*cursor] != b'e' {
                let key_len = parse_bencode_string_length(bytes, cursor)?;
                if *cursor + key_len > bytes.len() {
                    return Err("Invalid bencoded dictionary key".to_string());
                }
                *cursor += key_len;
                skip_bencode_value(bytes, cursor)?;
            }
            if *cursor >= bytes.len() {
                return Err("Invalid bencoded dictionary".to_string());
            }
            *cursor += 1;
            Ok(())
        }
        b'0'..=b'9' => {
            let length = parse_bencode_string_length(bytes, cursor)?;
            if *cursor + length > bytes.len() {
                return Err("Invalid bencoded string".to_string());
            }
            *cursor += length;
            Ok(())
        }
        _ => Err("Unknown bencoded value".to_string()),
    }
}

fn extract_torrent_info_section(bytes: &[u8]) -> Result<&[u8], String> {
    if bytes.first() != Some(&b'd') {
        return Err("Torrent file root is not a dictionary".to_string());
    }

    let mut cursor = 1;
    while cursor < bytes.len() && bytes[cursor] != b'e' {
        let key_len = parse_bencode_string_length(bytes, &mut cursor)?;
        if cursor + key_len > bytes.len() {
            return Err("Invalid torrent dictionary key".to_string());
        }

        let key = &bytes[cursor..cursor + key_len];
        cursor += key_len;

        let value_start = cursor;
        skip_bencode_value(bytes, &mut cursor)?;

        if key == b"info" {
            return Ok(&bytes[value_start..cursor]);
        }
    }

    Err("Torrent metadata does not contain an info dictionary".to_string())
}

fn sha1_hex(bytes: &[u8]) -> String {
    let digest = Sha1::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn redact_sensitive_url(url: &str) -> String {
    logging::redact_text(url)
}

fn redact_mpv_arg(arg: &str) -> String {
    let lower = arg.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        redact_sensitive_url(arg)
    } else {
        arg.to_string()
    }
}

fn is_forbidden_torrent_source_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [first, second, third, fourth] = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || first == 0
                || (first == 100 && (64..=127).contains(&second))
                || (first == 192 && second == 0 && third == 0 && fourth != 9 && fourth != 10)
                || (first == 192 && second == 88 && third == 99)
                || (first == 198 && (second == 18 || second == 19))
                || first >= 240
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4() {
                return is_forbidden_torrent_source_ip(IpAddr::V4(mapped));
            }
            let segments = ip.segments();
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] == 0x0100
                    && segments[1] == 0
                    && segments[2] == 0
                    && segments[3] == 0)
        }
    }
}

fn torrent_source_matches_allowed_origin(url: &reqwest::Url, allowed_origins: &[String]) -> bool {
    let source_origin = url.origin().ascii_serialization();
    allowed_origins.iter().any(|allowed| {
        reqwest::Url::parse(allowed)
            .map(|url| url.origin().ascii_serialization() == source_origin)
            .unwrap_or(false)
    })
}

async fn validate_torrent_source_url(
    url: &reqwest::Url,
    allowed_local_origins: Option<&[String]>,
) -> Result<Vec<SocketAddr>, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Torrent source must use HTTP or HTTPS".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Torrent source URL has no host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Torrent source URL has no usable port".to_string())?;
    let host = host.to_string();
    let addresses: Vec<SocketAddr> = tokio::task::spawn_blocking(move || {
        (host.as_str(), port)
            .to_socket_addrs()
            .map(|resolved| resolved.collect::<Vec<_>>())
    })
    .await
    .map_err(|_| "Torrent source DNS lookup failed".to_string())?
    .map_err(|_| "Torrent source host could not be resolved".to_string())?;
    let has_forbidden_address = addresses
        .iter()
        .any(|address| is_forbidden_torrent_source_ip(address.ip()));
    let local_origin_allowed = allowed_local_origins
        .map(|origins| torrent_source_matches_allowed_origin(url, origins))
        .unwrap_or(true);
    if addresses.is_empty() || (has_forbidden_address && !local_origin_allowed) {
        return Err("Torrent source resolves to a local or non-public address".to_string());
    }
    Ok(addresses)
}

async fn read_limited_response_body(response: &mut reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .map(|length| length > TORRENT_METADATA_MAX_BYTES as u64)
        .unwrap_or(false)
    {
        return Err(format!(
            "Torrent metadata exceeds the {} MiB limit",
            TORRENT_METADATA_MAX_BYTES / (1024 * 1024)
        ));
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Failed to read torrent file: {}", error.without_url()))?
    {
        if bytes.len().saturating_add(chunk.len()) > TORRENT_METADATA_MAX_BYTES {
            return Err(format!(
                "Torrent metadata exceeds the {} MiB limit",
                TORRENT_METADATA_MAX_BYTES / (1024 * 1024)
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

enum TorrentFetchOutcome {
    Response(reqwest::Response, String),
    Magnet(String),
}

async fn fetch_torrent_response(
    source_url: &str,
    timeout: std::time::Duration,
    allowed_local_origins: Option<&[String]>,
) -> Result<TorrentFetchOutcome, String> {
    let mut current_url =
        reqwest::Url::parse(source_url).map_err(|_| "Torrent source URL is invalid".to_string())?;

    for redirect_count in 0..=TORRENT_METADATA_MAX_REDIRECTS {
        let addresses = validate_torrent_source_url(&current_url, allowed_local_origins).await?;
        let host = current_url
            .host_str()
            .ok_or_else(|| "Torrent source URL has no host".to_string())?;
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|e| format!("Failed to create torrent metadata client: {}", e))?;
        let response = client
            .get(current_url.clone())
            .header(reqwest::header::USER_AGENT, "Streamee/1.0")
            .send()
            .await
            .map_err(|error| format!("Failed to download torrent file: {}", error.without_url()))?;

        if !response.status().is_redirection() {
            let final_url = current_url.to_string();
            return Ok(TorrentFetchOutcome::Response(response, final_url));
        }
        if redirect_count == TORRENT_METADATA_MAX_REDIRECTS {
            return Err("Torrent metadata redirect limit exceeded".to_string());
        }

        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| "Torrent metadata redirect has no valid location".to_string())?;
        if location.starts_with("magnet:?") {
            return Ok(TorrentFetchOutcome::Magnet(location.to_string()));
        }
        current_url = current_url
            .join(location)
            .map_err(|_| "Torrent metadata redirect URL is invalid".to_string())?;
    }

    Err("Torrent metadata redirect limit exceeded".to_string())
}

async fn fetch_torrent_info_hash(
    source_url: &str,
    allowed_local_origins: Option<&[String]>,
) -> Result<String, String> {
    let (mut response, final_url) = match fetch_torrent_response(
        source_url,
        std::time::Duration::from_secs(20),
        allowed_local_origins,
    )
    .await?
    {
        TorrentFetchOutcome::Response(response, final_url) => (response, final_url),
        TorrentFetchOutcome::Magnet(magnet) => return extract_info_hash(&magnet, None),
    };
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("<missing>")
        .to_string();
    let redacted_source_url = redact_sensitive_url(source_url);
    let redacted_final_url = redact_sensitive_url(&final_url);
    info!(
        "Torrent metadata fetch: source={}, final_url={}, status={}, content_type={}",
        redacted_source_url, redacted_final_url, status, content_type
    );
    if !status.is_success() {
        return Err(format!("Failed to download torrent file: HTTP {}", status));
    }

    let bytes = read_limited_response_body(&mut response).await?;
    info!("Torrent metadata payload: bytes={}", bytes.len());
    let info_section = extract_torrent_info_section(&bytes).map_err(|err| {
        warn!(
            "Torrent metadata parse failed: source={}, final_url={}, content_type={}, bytes={}, error={}",
            redacted_source_url,
            redacted_final_url,
            content_type,
            bytes.len(),
            err
        );
        err
    })?;
    Ok(sha1_hex(info_section))
}

async fn resolve_info_hash(source_uri: &str, info_hash: Option<&str>) -> Result<String, String> {
    match extract_info_hash(source_uri, info_hash) {
        Ok(hash) => Ok(hash),
        Err(_) if source_uri.starts_with("http://") || source_uri.starts_with("https://") => {
            fetch_torrent_info_hash(source_uri, None).await
        }
        Err(err) => Err(err),
    }
}

fn get_qbittorrent_webui_base_url() -> String {
    let port = std::env::var("APPDATA")
        .ok()
        .map(PathBuf::from)
        .map(|dir| dir.join("qBittorrent").join("qBittorrent.ini"))
        .and_then(|ini_path| fs::read_to_string(ini_path).ok())
        .and_then(|content| {
            content
                .lines()
                .find_map(|line| line.strip_prefix("WebUI\\Port="))
                .and_then(|value| value.trim().parse::<u16>().ok())
        })
        .unwrap_or(8080);

    format!("http://127.0.0.1:{port}")
}

async fn qbittorrent_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create qBittorrent client: {}", e))
}

async fn wait_for_qbittorrent_webui(
    client: &reqwest::Client,
    base_url: &str,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let started = std::time::Instant::now();

    while started.elapsed() < timeout {
        match client
            .get(format!("{base_url}/api/v2/app/version"))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(_) | Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
    }

    Err("qBittorrent WebUI is not reachable on localhost. Enable the WebUI and disable localhost auth for Streamee autoplay.".to_string())
}

async fn find_qbittorrent_torrent(
    client: &reqwest::Client,
    base_url: &str,
    info_hash: &str,
) -> Result<Option<QbittorrentTorrentInfo>, String> {
    let response = client
        .get(format!("{base_url}/api/v2/torrents/info"))
        .query(&[("hashes", info_hash)])
        .send()
        .await
        .map_err(|e| format!("Failed to query qBittorrent torrents: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "qBittorrent torrent query failed with status {}",
            response.status()
        ));
    }

    let torrents = response
        .json::<Vec<QbittorrentTorrentInfo>>()
        .await
        .map_err(|e| format!("Failed to decode qBittorrent torrent response: {}", e))?;

    Ok(torrents.into_iter().next())
}

fn spawn_qbittorrent_transfer_monitor(app: AppHandle, info_hash: String, initial_downloaded: u64) {
    let monitor_started = QBITTORRENT_TRANSFER_MONITORS
        .lock()
        .map(|mut monitors| monitors.insert(info_hash.clone()))
        .unwrap_or(false);
    if !monitor_started {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let base_url = get_qbittorrent_webui_base_url();
        let client = match qbittorrent_client().await {
            Ok(client) => client,
            Err(err) => {
                warn!("qBittorrent statistics monitor could not start: {}", err);
                if let Ok(mut monitors) = QBITTORRENT_TRANSFER_MONITORS.lock() {
                    monitors.remove(&info_hash);
                }
                return;
            }
        };
        let started_at = std::time::Instant::now();
        let mut last_downloaded = initial_downloaded;

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            match find_qbittorrent_torrent(&client, &base_url, &info_hash).await {
                Ok(Some(torrent)) => {
                    let delta = torrent.downloaded.saturating_sub(last_downloaded);
                    emit_statistics_transfer(&app, "qbittorrent", delta, None, None);
                    last_downloaded = torrent.downloaded;
                    if torrent.progress >= 1.0 {
                        break;
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    debug!("qBittorrent statistics monitor query failed: {}", err);
                }
            }
            if started_at.elapsed() >= std::time::Duration::from_secs(6 * 60 * 60) {
                break;
            }
        }

        if let Ok(mut monitors) = QBITTORRENT_TRANSFER_MONITORS.lock() {
            monitors.remove(&info_hash);
        }
    });
}

async fn add_qbittorrent_torrent(
    client: &reqwest::Client,
    base_url: &str,
    source_url: &str,
) -> Result<(), String> {
    let response = client
        .post(format!("{base_url}/api/v2/torrents/add"))
        .form(&[
            ("urls", source_url),
            ("sequentialDownload", "true"),
            ("firstLastPiecePrio", "true"),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to add torrent to qBittorrent: {}", e))?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "qBittorrent add torrent failed with status {}",
            response.status()
        ))
    }
}

async fn get_qbittorrent_files(
    client: &reqwest::Client,
    base_url: &str,
    info_hash: &str,
) -> Result<Vec<QbittorrentFileInfo>, String> {
    let response = client
        .get(format!("{base_url}/api/v2/torrents/files"))
        .query(&[("hash", info_hash)])
        .send()
        .await
        .map_err(|e| format!("Failed to query qBittorrent files: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "qBittorrent files query failed with status {}",
            response.status()
        ));
    }

    response
        .json::<Vec<QbittorrentFileInfo>>()
        .await
        .map_err(|e| format!("Failed to decode qBittorrent files response: {}", e))
}

async fn set_qbittorrent_file_priority(
    client: &reqwest::Client,
    base_url: &str,
    info_hash: &str,
    file_ids: &str,
    priority: u8,
) -> Result<(), String> {
    if file_ids.is_empty() {
        return Ok(());
    }
    let priority_value = priority.to_string();
    let response = client
        .post(format!("{base_url}/api/v2/torrents/filePrio"))
        .form(&[
            ("hash", info_hash),
            ("id", file_ids),
            ("priority", priority_value.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Failed to set qBittorrent file priority: {error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "qBittorrent file priority failed with status {}",
            response.status()
        ))
    }
}

async fn set_qbittorrent_torrent_paused(
    client: &reqwest::Client,
    base_url: &str,
    info_hash: &str,
    paused: bool,
) -> Result<(), String> {
    let action = if paused { "pause" } else { "resume" };
    let response = client
        .post(format!("{base_url}/api/v2/torrents/{action}"))
        .form(&[("hashes", info_hash)])
        .send()
        .await
        .map_err(|error| format!("Failed to {action} qBittorrent torrent: {error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "qBittorrent {action} failed with status {}",
            response.status()
        ))
    }
}

async fn restore_qbittorrent_playback_downloads(
    client: &reqwest::Client,
    base_url: &str,
    info_hash: &str,
    files: &[QbittorrentFileInfo],
) -> Result<(), String> {
    let all_ids = files
        .iter()
        .map(|file| file.index.to_string())
        .collect::<Vec<_>>()
        .join("|");
    set_qbittorrent_file_priority(client, base_url, info_hash, &all_ids, 1).await?;
    set_qbittorrent_torrent_paused(client, base_url, info_hash, false).await
}

async fn get_qbittorrent_piece_states(
    client: &reqwest::Client,
    base_url: &str,
    info_hash: &str,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(format!("{base_url}/api/v2/torrents/pieceStates"))
        .query(&[("hash", info_hash)])
        .send()
        .await
        .map_err(|e| format!("Failed to query qBittorrent piece states: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "qBittorrent piece state query failed with status {}",
            response.status()
        ));
    }

    response
        .json::<Vec<u8>>()
        .await
        .map_err(|e| format!("Failed to decode qBittorrent piece states: {}", e))
}

async fn toggle_qbittorrent_flag(
    client: &reqwest::Client,
    base_url: &str,
    endpoint: &str,
    info_hash: &str,
) -> Result<(), String> {
    let response = client
        .post(format!("{base_url}{endpoint}"))
        .form(&[("hashes", info_hash)])
        .send()
        .await
        .map_err(|e| format!("Failed to update qBittorrent torrent settings: {}", e))?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "qBittorrent update failed with status {}",
            response.status()
        ))
    }
}

async fn ensure_qbittorrent_torrent(
    client: &reqwest::Client,
    base_url: &str,
    source_uri: &str,
    resolved_hash: &str,
) -> Result<QbittorrentTorrentInfo, String> {
    let webui_available =
        wait_for_qbittorrent_webui(client, base_url, std::time::Duration::from_secs(2))
            .await
            .is_ok();

    let existing_torrent = if webui_available {
        find_qbittorrent_torrent(client, base_url, resolved_hash).await?
    } else {
        None
    };

    if existing_torrent.is_none() {
        if webui_available {
            if let Err(err) = add_qbittorrent_torrent(client, base_url, source_uri).await {
                warn!(
                    "Failed to add torrent through qBittorrent WebUI, falling back to shell handoff: {}",
                    err
                );
                spawn_magnet_open(source_uri)?;
                wait_for_qbittorrent_webui(client, base_url, std::time::Duration::from_secs(30))
                    .await?;
            }
        } else {
            spawn_magnet_open(source_uri)?;
            wait_for_qbittorrent_webui(client, base_url, std::time::Duration::from_secs(30))
                .await?;
        }
    }

    let started = std::time::Instant::now();
    let torrent = if let Some(torrent) = existing_torrent {
        torrent
    } else {
        loop {
            if started.elapsed() > std::time::Duration::from_secs(180) {
                return Err("Timed out waiting for qBittorrent to accept the torrent".to_string());
            }

            if let Some(torrent) = find_qbittorrent_torrent(client, base_url, resolved_hash).await?
            {
                break torrent;
            }

            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    };

    if !torrent.seq_dl {
        let _ = toggle_qbittorrent_flag(
            client,
            base_url,
            "/api/v2/torrents/toggleSequentialDownload",
            &torrent.hash,
        )
        .await;
    }
    if !torrent.f_l_piece_prio {
        let _ = toggle_qbittorrent_flag(
            client,
            base_url,
            "/api/v2/torrents/toggleFirstLastPiecePrio",
            &torrent.hash,
        )
        .await;
    }

    Ok(torrent)
}

fn is_video_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".mp4")
        || lower.ends_with(".mkv")
        || lower.ends_with(".avi")
        || lower.ends_with(".mov")
        || lower.ends_with(".webm")
        || lower.ends_with(".m4v")
        || lower.ends_with(".wmv")
        || lower.ends_with(".flv")
}

fn local_video_file_from_path(path: &Path) -> Result<Option<LocalVideoFile>, String> {
    if !path.is_file() {
        return Ok(None);
    }

    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return Ok(None);
    };

    if !is_video_file(name) {
        return Ok(None);
    }

    let metadata =
        fs::metadata(path).map_err(|err| format!("Failed to read {}: {}", path.display(), err))?;

    Ok(Some(LocalVideoFile {
        name: name.to_string(),
        path: path.to_string_lossy().to_string(),
        size: metadata.len(),
    }))
}

fn collect_local_video_files(
    folder: &Path,
    output: &mut Vec<LocalVideoFile>,
) -> Result<(), String> {
    let entries = fs::read_dir(folder)
        .map_err(|err| format!("Failed to read {}: {}", folder.display(), err))?;

    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("Failed to inspect {}: {}", path.display(), err))?;

        if file_type.is_dir() {
            collect_local_video_files(&path, output)?;
        } else if file_type.is_file() {
            if let Some(file) = local_video_file_from_path(&path)? {
                output.push(file);
            }
        }
    }

    Ok(())
}

fn compare_qbittorrent_episode_files(
    a: &QbittorrentFileInfo,
    b: &QbittorrentFileInfo,
    preferred_season: Option<u32>,
) -> std::cmp::Ordering {
    match (
        parse_episode_number_with_context(&a.name, preferred_season),
        parse_episode_number_with_context(&b.name, preferred_season),
    ) {
        (Some((a_season, a_episode)), Some((b_season, b_episode))) => a_season
            .cmp(&b_season)
            .then_with(|| a_episode.cmp(&b_episode))
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            }),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a
            .name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase()),
    }
}

fn saved_source_matches_requested_episode(
    source_filename: &str,
    preferred_season: Option<u32>,
    preferred_episode: Option<u32>,
    picker_label: &str,
) -> bool {
    let (Some(season), Some(episode)) = (preferred_season, preferred_episode) else {
        return true;
    };

    match parse_episode_number_with_context(source_filename, preferred_season) {
        Some((parsed_season, parsed_episode))
            if parsed_season == season && parsed_episode == episode =>
        {
            true
        }
        Some((parsed_season, parsed_episode)) => {
            info!(
                "[{} picker] ignoring saved source filename {:?}: parsed S{:02}E{:02} does not match requested S{:02}E{:02}",
                picker_label, source_filename, parsed_season, parsed_episode, season, episode
            );
            false
        }
        None => {
            info!(
                "[{} picker] ignoring saved source filename {:?}: could not verify it matches requested S{:02}E{:02}",
                picker_label, source_filename, season, episode
            );
            false
        }
    }
}

fn pick_qbittorrent_video_file(
    files: &[QbittorrentFileInfo],
    preferred_season: Option<u32>,
    preferred_episode: Option<u32>,
    preferred_source_filename: Option<&str>,
) -> Option<QbittorrentFileInfo> {
    let mut video_files: Vec<QbittorrentFileInfo> = files
        .iter()
        .filter(|file| is_video_file(&file.name))
        .cloned()
        .collect();

    if video_files.is_empty() {
        info!(
            "[qBit picker] no video files available for preferred target S{:?}E{:?}",
            preferred_season, preferred_episode
        );
        return None;
    }

    video_files.sort_by(|a, b| compare_qbittorrent_episode_files(a, b, preferred_season));
    let candidate_summaries: Vec<String> = video_files
        .iter()
        .map(|file| {
            let parsed = parse_episode_number_with_context(&file.name, preferred_season)
                .map(|(season, episode)| format!("S{season:02}E{episode:02}"))
                .unwrap_or_else(|| "unknown".to_string());
            format!("{} [{}]", file.name, parsed)
        })
        .collect();
    info!(
        "[qBit picker] preferred target S{:?}E{:?}, source={:?}; candidates: {}",
        preferred_season,
        preferred_episode,
        preferred_source_filename,
        candidate_summaries.join(" | ")
    );

    if let Some(source_filename) = preferred_source_filename.filter(|source_filename| {
        saved_source_matches_requested_episode(
            source_filename,
            preferred_season,
            preferred_episode,
            "qBit",
        )
    }) {
        let normalized_source = source_filename.replace('\\', "/").to_ascii_lowercase();
        let source_base = normalized_source
            .rsplit('/')
            .next()
            .unwrap_or(&normalized_source);
        if let Some(file) = video_files.iter().find(|file| {
            let name = file.name.replace('\\', "/").to_ascii_lowercase();
            let base = name.rsplit('/').next().unwrap_or(&name);
            name == normalized_source || base == source_base
        }) {
            info!(
                "[qBit picker] matched saved source filename {:?} -> {}",
                source_filename, file.name
            );
            return Some(file.clone());
        }
    }

    if let (Some(season), Some(episode)) = (preferred_season, preferred_episode) {
        if let Some(file) = video_files.iter().find(|file| {
            parse_episode_number_with_context(&file.name, preferred_season)
                .map(|(parsed_season, parsed_episode)| {
                    parsed_season == season && parsed_episode == episode
                })
                .unwrap_or(false)
        }) {
            info!(
                "[qBit picker] matched parsed target S{:02}E{:02} -> {}",
                season, episode, file.name
            );
            return Some(file.clone());
        }

        // Single-episode: find the exact S##E## match
        let patterns = [
            format!("s{season:02}e{episode:02}"),
            format!("s{season}e{episode}"),
            format!("{season}x{episode:02}"),
            format!("{season}x{episode}"),
        ];
        if let Some(file) = video_files.iter().find(|file| {
            let name = file.name.to_ascii_lowercase();
            patterns.iter().any(|p| name.contains(p))
        }) {
            info!(
                "[qBit picker] matched fallback pattern target S{:02}E{:02} -> {}",
                season, episode, file.name
            );
            return Some(file.clone());
        }

        let ordinal_index = episode.saturating_sub(1) as usize;
        if ordinal_index < video_files.len() {
            let file = video_files[ordinal_index].clone();
            info!(
                "[qBit picker] matched ordinal fallback target S{:02}E{:02} -> {}",
                season, episode, file.name
            );
            return Some(file);
        }
    } else if let Some(season) = preferred_season {
        // Season pack: return the first episode of that season (sorted = E01 first)
        let season_patterns = [
            format!("s{season:02}e"),
            format!("s{season}e"),
            format!("{season}x"),
        ];
        if let Some(file) = video_files.iter().find(|file| {
            let name = file.name.to_ascii_lowercase();
            season_patterns.iter().any(|p| name.contains(p))
        }) {
            info!(
                "[qBit picker] matched season-only target S{:02} -> {}",
                season, file.name
            );
            return Some(file.clone());
        }
    }

    // No season/episode preference (complete series or single file): return first sorted video file
    let fallback = video_files.into_iter().next();
    if let Some(file) = &fallback {
        info!(
            "[qBit picker] falling back to first sorted file -> {}",
            file.name
        );
    }
    fallback
}

static SMART_NEXT_WARMUP_GENERATION: AtomicU64 = AtomicU64::new(1);
static QBITTORRENT_TRANSFER_MONITORS: Lazy<Mutex<HashSet<String>>> =
    Lazy::new(|| Mutex::new(HashSet::new()));
// First-use GPU filters such as RIFE can pause MPV's local stream reads while
// TensorRT compiles an engine. Keep the proxy connection alive through that
// one-time stall instead of treating local back-pressure as a source failure.
const STREAM_CACHE_CLIENT_WRITE_TIMEOUT_SECONDS: u64 = 120;
const SINGLE_FILE_CACHE_BLOCK_BYTES: u64 = 1024 * 1024;
const SINGLE_FILE_CACHE_WRITE_BYTES: usize = 256 * 1024;
// Advertise a broad local snapshot so MPV rarely reconnects, but stream it in
// small chunks so superseded hover requests do not pre-read the whole range.
const SINGLE_FILE_CACHE_ONLY_READ_BYTES: usize = 64 * 1024 * 1024;
const SINGLE_FILE_CACHE_ROLLING_BLOCKS: usize = 256;
const SINGLE_FILE_CACHE_BASE_OPENING_PIN_BYTES: u64 = 256 * 1024 * 1024;
const SINGLE_FILE_CACHE_INTRO_OPENING_PIN_BYTES: u64 = 1536 * 1024 * 1024;
const SINGLE_FILE_CACHE_FINGERPRINT_HEADROOM_BYTES: u64 = 64 * 1024 * 1024;
const SINGLE_FILE_CACHE_READ_AHEAD_BYTES: u64 = 64 * 1024 * 1024;
// Keep the downloaded-byte window aligned with MPV's normal back-cache while
// leaving a hard 256 MiB rolling budget outside the explicitly pinned opening
// and tail ranges.
const SINGLE_FILE_CACHE_PRODUCER_BACK_BUFFER_BYTES: u64 = 256 * 1024 * 1024;
const SINGLE_FILE_CACHE_MAX_PRODUCERS: usize = 2;
const SINGLE_FILE_CACHE_FAILURE_COOLDOWN_MS: u64 = 1_000;
const PERSISTENT_STREAM_CACHE_VERSION: u32 = 1;
const PERSISTENT_STREAM_CACHE_DEFAULT_LIMIT_GB: u64 = 50;
const PERSISTENT_STREAM_CACHE_MIN_LIMIT_GB: u64 = 1;
const PERSISTENT_STREAM_CACHE_MAX_LIMIT_GB: u64 = 2_000;
const PERSISTENT_STREAM_CACHE_PRUNE_INTERVAL_BYTES: u64 = 64 * 1024 * 1024;
const SMART_NEXT_WARMUP_MAX_BYTES: u64 = 1024 * 1024 * 1024;

fn smart_next_warmup_target_bytes(total_bytes: u64) -> u64 {
    if total_bytes == 0 {
        return 0;
    }
    total_bytes
        .saturating_add(9)
        .checked_div(10)
        .unwrap_or(0)
        .clamp(1, SMART_NEXT_WARMUP_MAX_BYTES)
}

static ACTIVE_PERSISTENT_STREAM_CACHES: Lazy<Mutex<HashMap<PathBuf, Weak<SingleFileRangeCache>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PERSISTENT_STREAM_CACHE_PRUNE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Clone)]
struct PersistentStreamCacheSettings {
    root: PathBuf,
    limit_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistentStreamCacheManifest {
    version: u32,
    cache_key: String,
    provider: String,
    total_size: u64,
    resident_bytes: u64,
    last_access_ms: u64,
    covered_ranges: Vec<(u64, u64)>,
    resident_blocks: Vec<u64>,
}

struct PersistentSingleFileCache {
    root: PathBuf,
    entry_dir: PathBuf,
    manifest_path: PathBuf,
    cache_key: String,
    provider: String,
    limit_bytes: u64,
    bytes_since_prune: AtomicU64,
}

struct SingleFileActiveProducer {
    id: u64,
    cursor: u64,
    demand_end: u64,
    last_access: u64,
    cancel: Arc<AtomicBool>,
}

struct SingleFileCacheState {
    covered_ranges: Vec<(u64, u64)>,
    block_access: HashMap<u64, u64>,
    block_readers: HashMap<u64, usize>,
    active_producers: Vec<SingleFileActiveProducer>,
    sequence: u64,
    next_fetch_id: u64,
    recent_failure: Option<SingleFileFetchFailure>,
    full_cache_priority_start: Option<u64>,
    full_cache_generation: u64,
}

struct SingleFileFetchFailure {
    start: u64,
    end: u64,
    occurred_at: std::time::Instant,
    message: String,
}

struct SingleFileRangeCache {
    path: PathBuf,
    file: Arc<fs::File>,
    total_size: u64,
    retain_whole_file: bool,
    fill_whole_file: AtomicBool,
    pinned_opening_bytes: AtomicU64,
    pinned_tail_start: AtomicU64,
    producer_limit_bytes: AtomicU64,
    persistent: Option<PersistentSingleFileCache>,
    state: Mutex<SingleFileCacheState>,
    changed: Condvar,
}

struct SingleFileCacheReadReservation<'a> {
    cache: &'a SingleFileRangeCache,
    start: u64,
    end: u64,
    blocks: Vec<u64>,
}

impl SingleFileCacheReadReservation<'_> {
    fn len(&self) -> usize {
        self.end.saturating_sub(self.start).saturating_add(1) as usize
    }
}

impl Drop for SingleFileCacheReadReservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.cache.state.lock() {
            for block in &self.blocks {
                if let Some(readers) = state.block_readers.get_mut(block) {
                    *readers = readers.saturating_sub(1);
                    if *readers == 0 {
                        state.block_readers.remove(block);
                    }
                }
            }
            self.cache.changed.notify_all();
        }
    }
}

enum SingleFileCachePlan {
    Cached,
    Wait,
    StartProducer(SingleFileProducerPermit),
}

struct SingleFileProducerPermit {
    cache: Arc<SingleFileRangeCache>,
    id: u64,
    start: u64,
    upstream_end: u64,
    cancel: Arc<AtomicBool>,
    full_cache_generation: Option<u64>,
}

impl SingleFileProducerPermit {
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    fn next_read_len(&self, cursor: u64, maximum: usize) -> Result<Option<usize>, String> {
        let mut state = self.cache.state.lock().map_err(|error| error.to_string())?;
        loop {
            let Some(fetch) = state
                .active_producers
                .iter()
                .find(|fetch| fetch.id == self.id)
            else {
                return Ok(None);
            };
            if fetch.cancel.load(Ordering::Acquire) {
                return Ok(None);
            }
            if cursor <= fetch.demand_end {
                return Ok(Some(maximum.min(
                    fetch.demand_end.saturating_sub(cursor).saturating_add(1) as usize,
                )));
            }
            state = self
                .cache
                .changed
                .wait(state)
                .map_err(|error| error.to_string())?;
        }
    }

    fn update_cursor(&self, cursor: u64) {
        if let Ok(mut state) = self.cache.state.lock() {
            if let Some(fetch) = state
                .active_producers
                .iter_mut()
                .find(|fetch| fetch.id == self.id)
            {
                fetch.cursor = cursor;
            }
            self.cache.changed.notify_all();
        }
    }

    fn record_failure(&self, message: String) {
        if let Ok(mut state) = self.cache.state.lock() {
            let cursor = state
                .active_producers
                .iter()
                .find(|fetch| fetch.id == self.id)
                .map(|fetch| fetch.cursor)
                .unwrap_or(self.start);
            state.recent_failure = Some(SingleFileFetchFailure {
                start: cursor,
                end: cursor
                    .saturating_add(SINGLE_FILE_CACHE_READ_AHEAD_BYTES)
                    .saturating_sub(1)
                    .min(self.upstream_end),
                occurred_at: std::time::Instant::now(),
                message,
            });
            self.cache.changed.notify_all();
        }
    }
}

impl Drop for SingleFileProducerPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.cache.state.lock() {
            state
                .active_producers
                .retain(|producer| producer.id != self.id);
            self.cache.changed.notify_all();
        }
    }
}

fn merge_single_file_cache_range(ranges: &mut Vec<(u64, u64)>, added: (u64, u64)) {
    if added.0 > added.1 {
        return;
    }
    ranges.push(added);
    ranges.sort_by_key(|range| range.0);
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for range in ranges.drain(..) {
        if let Some(last) = merged.last_mut() {
            if range.0 <= last.1.saturating_add(1) {
                last.1 = last.1.max(range.1);
                continue;
            }
        }
        merged.push(range);
    }
    *ranges = merged;
}

fn remove_single_file_cache_range(ranges: &mut Vec<(u64, u64)>, removed: (u64, u64)) {
    let mut remaining = Vec::with_capacity(ranges.len().saturating_add(1));
    for (start, end) in ranges.drain(..) {
        if end < removed.0 || start > removed.1 {
            remaining.push((start, end));
            continue;
        }
        if start < removed.0 {
            remaining.push((start, removed.0.saturating_sub(1)));
        }
        if end > removed.1 {
            remaining.push((removed.1.saturating_add(1), end));
        }
    }
    *ranges = remaining;
}

fn single_file_cache_covered_end(ranges: &[(u64, u64)], position: u64) -> Option<u64> {
    ranges
        .iter()
        .find(|(start, end)| position >= *start && position <= *end)
        .map(|(_, end)| *end)
}

fn single_file_cache_covered_opening_bytes(ranges: &[(u64, u64)], total_size: u64) -> u64 {
    single_file_cache_covered_end(ranges, 0)
        .map(|end| end.saturating_add(1).min(total_size))
        .unwrap_or(0)
}

fn single_file_cache_covered_tail_bytes(ranges: &[(u64, u64)], total_size: u64) -> u64 {
    ranges
        .iter()
        .rev()
        .find(|(_, end)| end.saturating_add(1) >= total_size)
        .map(|(start, _)| total_size.saturating_sub(*start))
        .unwrap_or(0)
}

fn single_file_cache_first_uncovered(ranges: &[(u64, u64)], start: u64, end: u64) -> Option<u64> {
    if start > end {
        return None;
    }
    let mut cursor = start;
    for (covered_start, covered_end) in ranges {
        if *covered_end < cursor {
            continue;
        }
        if *covered_start > cursor {
            return Some(cursor);
        }
        cursor = cursor.max(covered_end.saturating_add(1));
        if cursor > end {
            return None;
        }
    }
    Some(cursor)
}

fn single_file_cache_uncovered_end(ranges: &[(u64, u64)], start: u64, end: u64) -> Option<u64> {
    if start > end {
        return None;
    }
    for (covered_start, covered_end) in ranges {
        if *covered_end < start {
            continue;
        }
        if *covered_start <= start {
            return None;
        }
        return Some(end.min(covered_start.saturating_sub(1)));
    }
    Some(end)
}

fn single_file_cache_range_overlaps_producer_back_buffer(
    range: (u64, u64),
    producer_cursor: u64,
) -> bool {
    if producer_cursor == 0 {
        return false;
    }
    let back_buffer = (
        producer_cursor.saturating_sub(SINGLE_FILE_CACHE_PRODUCER_BACK_BUFFER_BYTES),
        producer_cursor.saturating_sub(1),
    );
    range.0 <= back_buffer.1 && back_buffer.0 <= range.1
}

fn single_file_cache_pinned_block_count(
    total_size: u64,
    pinned_opening_bytes: u64,
    pinned_tail_start: u64,
) -> usize {
    let block_count = |bytes: u64| {
        bytes.saturating_add(SINGLE_FILE_CACHE_BLOCK_BYTES.saturating_sub(1))
            / SINGLE_FILE_CACHE_BLOCK_BYTES
    };
    let total_blocks = block_count(total_size);
    let opening_blocks = block_count(pinned_opening_bytes.min(total_size));
    let tail_first_block =
        (pinned_tail_start.min(total_size) / SINGLE_FILE_CACHE_BLOCK_BYTES).min(total_blocks);
    let tail_blocks = total_blocks.saturating_sub(tail_first_block);
    let overlap = opening_blocks
        .saturating_sub(tail_first_block)
        .min(tail_blocks);
    opening_blocks
        .saturating_add(tail_blocks)
        .saturating_sub(overlap) as usize
}

fn should_log_single_file_cache_request(sequence: u64) -> bool {
    sequence <= 4 || sequence.is_multiple_of(100)
}

#[cfg(target_os = "windows")]
fn mark_single_file_cache_sparse(file: &fs::File) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::IO::DeviceIoControl;

    const FSCTL_SET_SPARSE: u32 = 590_020;
    let mut returned = 0u32;
    unsafe {
        DeviceIoControl(
            HANDLE(file.as_raw_handle()),
            FSCTL_SET_SPARSE,
            None,
            0,
            None,
            0,
            Some(&mut returned),
            None,
        )
    }
    .map_err(|error| format!("Failed to mark streaming cache sparse: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn mark_single_file_cache_sparse(_file: &fs::File) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn punch_single_file_cache_hole(
    file: &fs::File,
    start: u64,
    end_exclusive: u64,
) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::IO::DeviceIoControl;

    #[repr(C)]
    struct FileZeroDataInformation {
        file_offset: i64,
        beyond_final_zero: i64,
    }

    if start >= end_exclusive {
        return Ok(());
    }
    const FSCTL_SET_ZERO_DATA: u32 = 622_792;
    let input = FileZeroDataInformation {
        file_offset: start as i64,
        beyond_final_zero: end_exclusive as i64,
    };
    let mut returned = 0u32;
    unsafe {
        DeviceIoControl(
            HANDLE(file.as_raw_handle()),
            FSCTL_SET_ZERO_DATA,
            Some((&input as *const FileZeroDataInformation).cast()),
            std::mem::size_of::<FileZeroDataInformation>() as u32,
            None,
            0,
            Some(&mut returned),
            None,
        )
    }
    .map_err(|error| format!("Failed to release sparse streaming cache range: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn punch_single_file_cache_hole(
    _file: &fs::File,
    _start: u64,
    _end_exclusive: u64,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn write_single_file_cache_at(
    file: &fs::File,
    mut offset: u64,
    mut data: &[u8],
) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;

    while !data.is_empty() {
        let written = file.seek_write(data, offset)?;
        if written == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "failed to write streaming cache block",
            ));
        }
        offset = offset.saturating_add(written as u64);
        data = &data[written..];
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn write_single_file_cache_at(
    file: &fs::File,
    mut offset: u64,
    mut data: &[u8],
) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;

    while !data.is_empty() {
        let written = file.write_at(data, offset)?;
        if written == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "failed to write streaming cache block",
            ));
        }
        offset = offset.saturating_add(written as u64);
        data = &data[written..];
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn read_single_file_cache_at(
    file: &fs::File,
    mut offset: u64,
    mut data: &mut [u8],
) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;

    while !data.is_empty() {
        let read = file.seek_read(data, offset)?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "streaming cache block ended early",
            ));
        }
        offset = offset.saturating_add(read as u64);
        data = &mut data[read..];
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn read_single_file_cache_at(
    file: &fs::File,
    mut offset: u64,
    mut data: &mut [u8],
) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;

    while !data.is_empty() {
        let read = file.read_at(data, offset)?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "streaming cache block ended early",
            ));
        }
        offset = offset.saturating_add(read as u64);
        data = &mut data[read..];
    }
    Ok(())
}

fn stream_cache_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn persistent_stream_cache_root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_cache_dir()
        .ok()
        .map(|root| root.join("persistent-stream-cache-v1"))
}

fn persistent_stream_cache_settings(app: &AppHandle) -> Option<PersistentStreamCacheSettings> {
    if !get_bool_setting(app, "streamCachePersistentEnabled") {
        return None;
    }
    let limit_gb = get_store_setting(app, "streamCachePersistentLimitGb")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(PERSISTENT_STREAM_CACHE_DEFAULT_LIMIT_GB)
        .clamp(
            PERSISTENT_STREAM_CACHE_MIN_LIMIT_GB,
            PERSISTENT_STREAM_CACHE_MAX_LIMIT_GB,
        );
    let root = persistent_stream_cache_root(app)?;
    Some(PersistentStreamCacheSettings {
        root,
        limit_bytes: limit_gb.saturating_mul(1024 * 1024 * 1024),
    })
}

fn cleanup_persistent_stream_cache_on_startup(app: &AppHandle) {
    let Some(root) = persistent_stream_cache_root(app) else {
        return;
    };
    if let Some(settings) = persistent_stream_cache_settings(app) {
        prune_persistent_stream_cache(&settings.root, settings.limit_bytes);
    } else if root.exists() {
        match fs::remove_dir_all(&root) {
            Ok(()) => info!(
                "Cleared persistent stream cache because persistence is disabled: {}",
                root.display()
            ),
            Err(error) => warn!(
                "Failed to clear disabled persistent stream cache {}: {error}",
                root.display()
            ),
        }
    }
}

pub(crate) fn persistent_webtorrent_cache_settings(app: &AppHandle) -> Option<(PathBuf, u64)> {
    persistent_stream_cache_settings(app).map(|settings| (settings.root, settings.limit_bytes))
}

fn persistent_stream_cache_key(identity: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(identity.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn persistent_stream_cache_manifest(path: &Path) -> Option<PersistentStreamCacheManifest> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn persistent_stream_cache_resident_bytes(total_size: u64, resident_blocks: &[u64]) -> u64 {
    resident_blocks.iter().fold(0u64, |total, block| {
        let start = block.saturating_mul(SINGLE_FILE_CACHE_BLOCK_BYTES);
        total.saturating_add(
            total_size
                .saturating_sub(start)
                .min(SINGLE_FILE_CACHE_BLOCK_BYTES),
        )
    })
}

fn active_persistent_stream_cache_dirs() -> HashSet<PathBuf> {
    let Ok(active) = ACTIVE_PERSISTENT_STREAM_CACHES.lock() else {
        return HashSet::new();
    };
    active.keys().cloned().collect()
}

fn prune_persistent_stream_cache(root: &Path, limit_bytes: u64) {
    let Ok(_prune_guard) = PERSISTENT_STREAM_CACHE_PRUNE_LOCK.lock() else {
        return;
    };
    let active = active_persistent_stream_cache_dirs();
    let Ok(children) = fs::read_dir(root) else {
        return;
    };
    let mut entries = Vec::new();
    let mut resident_total = 0u64;
    for child in children.flatten() {
        let entry_dir = child.path();
        if !entry_dir.is_dir() {
            continue;
        }
        let manifest_path = entry_dir.join("manifest.json");
        let Some(manifest) = persistent_stream_cache_manifest(&manifest_path) else {
            if !active.contains(&entry_dir) {
                let _ = fs::remove_dir_all(&entry_dir);
            }
            continue;
        };
        resident_total = resident_total.saturating_add(manifest.resident_bytes);
        entries.push((manifest.last_access_ms, manifest.resident_bytes, entry_dir));
    }
    entries.sort_by_key(|(last_access_ms, _, _)| *last_access_ms);
    let newest_entry_dir = entries.last().map(|(_, _, entry_dir)| entry_dir.clone());
    for (_, resident_bytes, entry_dir) in entries {
        if resident_total <= limit_bytes {
            break;
        }
        if active.contains(&entry_dir) || newest_entry_dir.as_ref() == Some(&entry_dir) {
            continue;
        }
        match fs::remove_dir_all(&entry_dir) {
            Ok(()) => {
                resident_total = resident_total.saturating_sub(resident_bytes);
                info!(
                    "Evicted persistent stream cache item: path={} bytes={} remaining_bytes={} limit_bytes={}",
                    entry_dir.display(),
                    resident_bytes,
                    resident_total,
                    limit_bytes
                );
            }
            Err(error) => warn!(
                "Failed to evict persistent stream cache item {}: {error}",
                entry_dir.display()
            ),
        }
    }
}

fn prepare_persistent_stream_cache_for_item(
    root: &Path,
    limit_bytes: u64,
    entry_dir: &Path,
    total_size: u64,
) {
    let Ok(_prune_guard) = PERSISTENT_STREAM_CACHE_PRUNE_LOCK.lock() else {
        return;
    };
    let active = active_persistent_stream_cache_dirs();
    let Ok(children) = fs::read_dir(root) else {
        return;
    };
    for child in children.flatten() {
        let candidate_dir = child.path();
        if !candidate_dir.is_dir() || candidate_dir == entry_dir || active.contains(&candidate_dir)
        {
            continue;
        }
        let candidate_is_oversized =
            persistent_stream_cache_manifest(&candidate_dir.join("manifest.json"))
                .is_some_and(|manifest| manifest.total_size > limit_bytes);
        if total_size <= limit_bytes && !candidate_is_oversized {
            continue;
        }
        match fs::remove_dir_all(&candidate_dir) {
            Ok(()) => info!(
                "Replaced persistent stream cache item: path={} new_total_size={} limit_bytes={}",
                candidate_dir.display(),
                total_size,
                limit_bytes
            ),
            Err(error) => warn!(
                "Failed to replace persistent stream cache item {}: {error}",
                candidate_dir.display()
            ),
        }
    }
}

impl SingleFileRangeCache {
    fn create(
        path: PathBuf,
        total_size: u64,
        tail_start: u64,
        retain_whole_file: bool,
    ) -> Result<Arc<Self>, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create streaming cache folder: {error}"))?;
        }
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("Failed to create streaming cache file: {error}"))?;
        mark_single_file_cache_sparse(&file)?;
        file.set_len(total_size)
            .map_err(|error| format!("Failed to size streaming cache file: {error}"))?;
        Ok(Arc::new(Self {
            path,
            file: Arc::new(file),
            total_size,
            retain_whole_file,
            fill_whole_file: AtomicBool::new(retain_whole_file),
            pinned_opening_bytes: AtomicU64::new(0),
            pinned_tail_start: AtomicU64::new(tail_start),
            producer_limit_bytes: AtomicU64::new(total_size),
            persistent: None,
            state: Mutex::new(SingleFileCacheState {
                covered_ranges: Vec::new(),
                block_access: HashMap::new(),
                block_readers: HashMap::new(),
                active_producers: Vec::new(),
                sequence: 1,
                next_fetch_id: 1,
                recent_failure: None,
                full_cache_priority_start: None,
                full_cache_generation: 0,
            }),
            changed: Condvar::new(),
        }))
    }

    fn open_persistent(
        settings: &PersistentStreamCacheSettings,
        identity: &str,
        provider: &str,
        total_size: u64,
        tail_start: u64,
        fill_whole_file: bool,
    ) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&settings.root)
            .map_err(|error| format!("Failed to create persistent stream cache folder: {error}"))?;

        let cache_key = persistent_stream_cache_key(identity);
        let entry_dir = settings.root.join(&cache_key);
        let mut active_caches = ACTIVE_PERSISTENT_STREAM_CACHES
            .lock()
            .map_err(|error| error.to_string())?;
        if let Some(registered_cache) = active_caches.get(&entry_dir) {
            if let Some(active_cache) = registered_cache.upgrade() {
                if active_cache.total_size != total_size {
                    return Err(
                        "Active persistent stream cache size does not match this source"
                            .to_string(),
                    );
                }
                active_cache
                    .pinned_tail_start
                    .fetch_min(tail_start, Ordering::AcqRel);
                if fill_whole_file {
                    active_cache.fill_whole_file.store(true, Ordering::Release);
                }
                info!(
                    "Reusing active persistent stream cache item: provider={} total_size={}",
                    provider, total_size
                );
                return Ok(active_cache);
            }
            return Err("Persistent stream cache item is still finalizing".to_string());
        }
        let manifest_path = entry_dir.join("manifest.json");
        let content_path = entry_dir.join("content.cache");
        let restored_manifest =
            persistent_stream_cache_manifest(&manifest_path).filter(|manifest| {
                manifest.version == PERSISTENT_STREAM_CACHE_VERSION
                    && manifest.cache_key == cache_key
                    && manifest.total_size == total_size
                    && content_path.is_file()
            });
        if restored_manifest.is_none() && entry_dir.exists() {
            fs::remove_dir_all(&entry_dir).map_err(|error| {
                format!("Failed to reset incompatible persistent stream cache: {error}")
            })?;
        }
        fs::create_dir_all(&entry_dir)
            .map_err(|error| format!("Failed to create persistent cache item folder: {error}"))?;
        let file = fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&content_path)
            .map_err(|error| format!("Failed to open persistent stream cache file: {error}"))?;
        mark_single_file_cache_sparse(&file)?;
        file.set_len(total_size)
            .map_err(|error| format!("Failed to size persistent stream cache file: {error}"))?;

        let mut covered_ranges = Vec::new();
        let mut block_access = HashMap::new();
        let mut sequence = 1u64;
        if let Some(manifest) = restored_manifest.as_ref() {
            covered_ranges = manifest
                .covered_ranges
                .iter()
                .filter_map(|(start, end)| {
                    (*start <= *end && *start < total_size)
                        .then_some((*start, (*end).min(total_size.saturating_sub(1))))
                })
                .collect();
            for block in &manifest.resident_blocks {
                if block.saturating_mul(SINGLE_FILE_CACHE_BLOCK_BYTES) < total_size {
                    sequence = sequence.saturating_add(1);
                    block_access.insert(*block, sequence);
                }
            }
        }

        let restored_bytes = persistent_stream_cache_resident_bytes(
            total_size,
            &block_access.keys().copied().collect::<Vec<_>>(),
        );
        let cache = Arc::new(Self {
            path: content_path,
            file: Arc::new(file),
            total_size,
            retain_whole_file: true,
            fill_whole_file: AtomicBool::new(fill_whole_file),
            pinned_opening_bytes: AtomicU64::new(0),
            pinned_tail_start: AtomicU64::new(tail_start),
            producer_limit_bytes: AtomicU64::new(total_size),
            persistent: Some(PersistentSingleFileCache {
                root: settings.root.clone(),
                entry_dir: entry_dir.clone(),
                manifest_path,
                cache_key,
                provider: provider.to_string(),
                limit_bytes: settings.limit_bytes,
                bytes_since_prune: AtomicU64::new(0),
            }),
            state: Mutex::new(SingleFileCacheState {
                covered_ranges,
                block_access,
                block_readers: HashMap::new(),
                active_producers: Vec::new(),
                sequence,
                next_fetch_id: 1,
                recent_failure: None,
                full_cache_priority_start: None,
                full_cache_generation: 0,
            }),
            changed: Condvar::new(),
        });
        active_caches.insert(entry_dir.clone(), Arc::downgrade(&cache));
        drop(active_caches);
        cache.persist_manifest()?;
        prepare_persistent_stream_cache_for_item(
            &settings.root,
            settings.limit_bytes,
            &entry_dir,
            total_size,
        );
        prune_persistent_stream_cache(&settings.root, settings.limit_bytes);
        info!(
            "Persistent stream cache item ready: provider={} restored_bytes={} total_size={} limit_bytes={}",
            provider, restored_bytes, total_size, settings.limit_bytes
        );
        Ok(cache)
    }

    fn is_persistent(&self) -> bool {
        self.persistent.is_some()
    }

    fn persist_manifest(&self) -> Result<(), String> {
        let Some(persistent) = self.persistent.as_ref() else {
            return Ok(());
        };
        let state = self.state.lock().map_err(|error| error.to_string())?;
        let mut resident_blocks = state.block_access.keys().copied().collect::<Vec<_>>();
        resident_blocks.sort_unstable();
        let manifest = PersistentStreamCacheManifest {
            version: PERSISTENT_STREAM_CACHE_VERSION,
            cache_key: persistent.cache_key.clone(),
            provider: persistent.provider.clone(),
            total_size: self.total_size,
            resident_bytes: persistent_stream_cache_resident_bytes(
                self.total_size,
                &resident_blocks,
            ),
            last_access_ms: stream_cache_now_ms(),
            covered_ranges: state.covered_ranges.clone(),
            resident_blocks,
        };
        drop(state);
        let encoded = serde_json::to_vec(&manifest)
            .map_err(|error| format!("Failed to encode persistent cache index: {error}"))?;
        let temporary_path = persistent.manifest_path.with_extension("json.tmp");
        fs::write(&temporary_path, encoded)
            .map_err(|error| format!("Failed to write persistent cache index: {error}"))?;
        if persistent.manifest_path.exists() {
            fs::remove_file(&persistent.manifest_path)
                .map_err(|error| format!("Failed to replace persistent cache index: {error}"))?;
        }
        fs::rename(&temporary_path, &persistent.manifest_path)
            .map_err(|error| format!("Failed to publish persistent cache index: {error}"))?;
        Ok(())
    }

    fn record_persistent_block(&self) -> Result<(), String> {
        let Some(persistent) = self.persistent.as_ref() else {
            return Ok(());
        };
        let pending = persistent
            .bytes_since_prune
            .fetch_add(SINGLE_FILE_CACHE_BLOCK_BYTES, Ordering::AcqRel)
            .saturating_add(SINGLE_FILE_CACHE_BLOCK_BYTES);
        if pending < PERSISTENT_STREAM_CACHE_PRUNE_INTERVAL_BYTES {
            return Ok(());
        }
        persistent.bytes_since_prune.store(0, Ordering::Release);
        self.persist_manifest()?;
        prune_persistent_stream_cache(&persistent.root, persistent.limit_bytes);
        Ok(())
    }

    fn pin_opening(&self, requested_bytes: u64) -> (u64, u64) {
        let requested_bytes = requested_bytes.min(self.total_size);
        let previous = self
            .pinned_opening_bytes
            .fetch_max(requested_bytes, Ordering::AcqRel);
        (previous, previous.max(requested_bytes))
    }

    fn covered_opening_bytes(&self) -> Result<u64, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        Ok(single_file_cache_covered_opening_bytes(
            &state.covered_ranges,
            self.total_size,
        ))
    }

    fn pin_tail(&self, requested_bytes: u64) -> (u64, u64) {
        let requested_bytes = requested_bytes.min(self.total_size);
        let requested_start = self.total_size.saturating_sub(requested_bytes);
        let previous_start = self
            .pinned_tail_start
            .fetch_min(requested_start, Ordering::AcqRel);
        (
            self.total_size.saturating_sub(previous_start),
            self.total_size
                .saturating_sub(previous_start.min(requested_start)),
        )
    }

    fn covered_tail_bytes(&self) -> Result<u64, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        Ok(single_file_cache_covered_tail_bytes(
            &state.covered_ranges,
            self.total_size,
        ))
    }

    fn set_producer_limit(&self, limit_bytes: u64) {
        self.producer_limit_bytes
            .store(limit_bytes.min(self.total_size), Ordering::Release);
    }

    fn clear_producer_limit(&self) {
        self.producer_limit_bytes
            .store(self.total_size, Ordering::Release);
        self.changed.notify_all();
    }

    fn plan(self: &Arc<Self>, position: u64) -> Result<SingleFileCachePlan, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        let producer_limit = self.producer_limit_bytes.load(Ordering::Acquire);
        if position >= producer_limit {
            return Err(format!(
                "Stream producer is temporarily limited to the first {producer_limit} bytes"
            ));
        }
        let producer_last = producer_limit.saturating_sub(1);
        state.sequence = state.sequence.saturating_add(1);
        let sequence = state.sequence;
        if single_file_cache_covered_end(&state.covered_ranges, position).is_some() {
            return Ok(SingleFileCachePlan::Cached);
        }
        if let Some(failure) = state.recent_failure.as_ref() {
            let expired = failure.occurred_at.elapsed()
                >= std::time::Duration::from_millis(SINGLE_FILE_CACHE_FAILURE_COOLDOWN_MS);
            if !expired && position >= failure.start && position <= failure.end {
                return Err(failure.message.clone());
            }
            if expired {
                state.recent_failure = None;
            }
        }
        if let Some(producer) = state.active_producers.iter_mut().find(|producer| {
            position >= producer.cursor
                && position
                    <= producer
                        .cursor
                        .saturating_add(SINGLE_FILE_CACHE_READ_AHEAD_BYTES)
        }) {
            producer.last_access = sequence;
            producer.demand_end = producer.demand_end.max(
                position
                    .saturating_add(SINGLE_FILE_CACHE_READ_AHEAD_BYTES)
                    .saturating_sub(1)
                    .min(producer_last),
            );
            self.changed.notify_all();
            return Ok(SingleFileCachePlan::Wait);
        }
        let tail_start = self.pinned_tail_start.load(Ordering::Acquire);
        let full_cache_generation =
            if self.fill_whole_file.load(Ordering::Acquire) && position < tail_start {
                state.full_cache_generation = state.full_cache_generation.saturating_add(1);
                state.full_cache_priority_start = Some(position);
                let generation = state.full_cache_generation;
                state.active_producers.retain(|producer| {
                    let keep = producer.cursor >= tail_start;
                    if !keep {
                        producer.cancel.store(true, Ordering::Release);
                    }
                    keep
                });
                self.changed.notify_all();
                Some(generation)
            } else {
                None
            };
        if state.active_producers.len() >= SINGLE_FILE_CACHE_MAX_PRODUCERS {
            if let Some(index) = state
                .active_producers
                .iter()
                .enumerate()
                .min_by_key(|(_, producer)| producer.last_access)
                .map(|(index, _)| index)
            {
                let preempted = state.active_producers.remove(index);
                preempted.cancel.store(true, Ordering::Release);
                self.changed.notify_all();
            }
        }
        let id = state.next_fetch_id;
        state.next_fetch_id = state.next_fetch_id.saturating_add(1);
        let upstream_end =
            single_file_cache_uncovered_end(&state.covered_ranges, position, producer_last)
                .ok_or_else(|| "Stream cache position became covered while planning".to_string())?;
        let demand_end = if full_cache_generation.is_some() {
            upstream_end
        } else {
            upstream_end.min(
                position
                    .saturating_add(SINGLE_FILE_CACHE_READ_AHEAD_BYTES)
                    .saturating_sub(1),
            )
        };
        let cancel = Arc::new(AtomicBool::new(false));
        state.active_producers.push(SingleFileActiveProducer {
            id,
            cursor: position,
            demand_end,
            last_access: sequence,
            cancel: cancel.clone(),
        });
        Ok(SingleFileCachePlan::StartProducer(
            SingleFileProducerPermit {
                cache: self.clone(),
                id,
                start: position,
                upstream_end,
                cancel,
                full_cache_generation,
            },
        ))
    }

    fn plan_full_cache_backfill(
        self: &Arc<Self>,
        completed: &SingleFileProducerPermit,
    ) -> Result<Option<SingleFileProducerPermit>, String> {
        let Some(generation) = completed.full_cache_generation else {
            return Ok(None);
        };
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        state
            .active_producers
            .retain(|producer| producer.id != completed.id);
        if state.full_cache_generation != generation {
            self.changed.notify_all();
            return Ok(None);
        }
        let Some(priority_start) = state.full_cache_priority_start else {
            self.changed.notify_all();
            return Ok(None);
        };
        let completed_forward = completed.start >= priority_start;
        let (phase, search_start, search_end) = if completed_forward {
            let forward_start = completed.upstream_end.saturating_add(1);
            if forward_start < self.total_size {
                ("forward", forward_start, self.total_size.saturating_sub(1))
            } else if let Some(backfill_end) = priority_start.checked_sub(1) {
                ("backfill", 0, backfill_end)
            } else {
                info!("Full stream cache completed forward pass from byte 0; no backfill required");
                self.changed.notify_all();
                return Ok(None);
            }
        } else {
            let Some(backfill_end) = priority_start.checked_sub(1) else {
                self.changed.notify_all();
                return Ok(None);
            };
            (
                "backfill",
                completed.upstream_end.saturating_add(1),
                backfill_end,
            )
        };
        let next_start =
            single_file_cache_first_uncovered(&state.covered_ranges, search_start, search_end);
        let (phase, next_start, search_end) = if let Some(next_start) = next_start {
            (phase, next_start, search_end)
        } else if completed_forward {
            let Some(backfill_end) = priority_start.checked_sub(1) else {
                info!("Full stream cache completed; every byte is already cached");
                self.changed.notify_all();
                return Ok(None);
            };
            let Some(backfill_start) =
                single_file_cache_first_uncovered(&state.covered_ranges, 0, backfill_end)
            else {
                info!("Full stream cache completed; every byte is already cached");
                self.changed.notify_all();
                return Ok(None);
            };
            ("backfill", backfill_start, backfill_end)
        } else {
            info!("Full stream cache completed; every byte is already cached");
            self.changed.notify_all();
            return Ok(None);
        };
        let next_end =
            single_file_cache_uncovered_end(&state.covered_ranges, next_start, search_end)
                .ok_or_else(|| {
                    "Full stream cache range became covered while planning".to_string()
                })?;

        state.sequence = state.sequence.saturating_add(1);
        let sequence = state.sequence;
        let id = state.next_fetch_id;
        state.next_fetch_id = state.next_fetch_id.saturating_add(1);
        let cancel = Arc::new(AtomicBool::new(false));
        state.active_producers.push(SingleFileActiveProducer {
            id,
            cursor: next_start,
            demand_end: next_end,
            last_access: sequence,
            cancel: cancel.clone(),
        });
        info!(
            "Full stream cache continuing phase={phase} missing_range={} priority_start={priority_start}",
            range_label(next_start, next_end)
        );
        self.changed.notify_all();
        Ok(Some(SingleFileProducerPermit {
            cache: self.clone(),
            id,
            start: next_start,
            upstream_end: next_end,
            cancel,
            full_cache_generation: Some(generation),
        }))
    }

    fn wait_for_change(&self) -> Result<(), String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        let _ = self
            .changed
            .wait_timeout(state, std::time::Duration::from_millis(100))
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn cancel_all_producers(&self) {
        if let Ok(mut state) = self.state.lock() {
            for producer in &state.active_producers {
                producer.cancel.store(true, Ordering::Release);
            }
            state.active_producers.clear();
            self.changed.notify_all();
        }
    }

    fn commit(&self, mut position: u64, mut data: &[u8]) -> Result<(), String> {
        while !data.is_empty() {
            let block = position / SINGLE_FILE_CACHE_BLOCK_BYTES;
            let block_start = block.saturating_mul(SINGLE_FILE_CACHE_BLOCK_BYTES);
            let block_end = block_start
                .saturating_add(SINGLE_FILE_CACHE_BLOCK_BYTES)
                .min(self.total_size);
            let fragment_len = data.len().min(block_end.saturating_sub(position) as usize);
            if fragment_len == 0 {
                break;
            }

            let evicted = {
                let mut state = self.state.lock().map_err(|error| error.to_string())?;
                let block_is_new = !state.block_access.contains_key(&block);
                let pinned_opening_bytes = self.pinned_opening_bytes.load(Ordering::Acquire);
                let pinned_tail_start = self.pinned_tail_start.load(Ordering::Acquire);
                let resident_block_limit = SINGLE_FILE_CACHE_ROLLING_BLOCKS.saturating_add(
                    single_file_cache_pinned_block_count(
                        self.total_size,
                        pinned_opening_bytes,
                        pinned_tail_start,
                    ),
                );
                let should_evict = !self.retain_whole_file
                    && block_is_new
                    && state.block_access.len() >= resident_block_limit;
                if should_evict {
                    let is_unpinned_unread = |candidate: u64| {
                        let candidate_start = candidate * SINGLE_FILE_CACHE_BLOCK_BYTES;
                        let candidate_end = candidate_start
                            .saturating_add(SINGLE_FILE_CACHE_BLOCK_BYTES)
                            .min(self.total_size)
                            .saturating_sub(1);
                        candidate_start >= pinned_opening_bytes
                            && candidate_end < pinned_tail_start
                            && state.block_readers.get(&candidate).copied().unwrap_or(0) == 0
                    };
                    let preferred_candidate = state
                        .block_access
                        .iter()
                        .filter(|(candidate, _)| {
                            let candidate_start = **candidate * SINGLE_FILE_CACHE_BLOCK_BYTES;
                            let candidate_end = candidate_start
                                .saturating_add(SINGLE_FILE_CACHE_BLOCK_BYTES)
                                .min(self.total_size)
                                .saturating_sub(1);
                            is_unpinned_unread(**candidate)
                                && !state.active_producers.iter().any(|producer| {
                                    single_file_cache_range_overlaps_producer_back_buffer(
                                        (candidate_start, candidate_end),
                                        producer.cursor,
                                    )
                                })
                        })
                        .min_by_key(|(_, access)| **access)
                        .map(|(candidate, _)| *candidate);
                    let candidate = preferred_candidate.or_else(|| {
                        state
                            .block_access
                            .iter()
                            .filter(|(candidate, _)| is_unpinned_unread(**candidate))
                            .min_by_key(|(_, access)| **access)
                            .map(|(candidate, _)| *candidate)
                    });
                    if let Some(candidate) = candidate {
                        state.block_access.remove(&candidate);
                        let start = candidate * SINGLE_FILE_CACHE_BLOCK_BYTES;
                        let end = start
                            .saturating_add(SINGLE_FILE_CACHE_BLOCK_BYTES)
                            .min(self.total_size);
                        remove_single_file_cache_range(
                            &mut state.covered_ranges,
                            (start, end.saturating_sub(1)),
                        );
                        Some((start, end))
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            if let Some((start, end)) = evicted {
                punch_single_file_cache_hole(&self.file, start, end)?;
            }

            write_single_file_cache_at(&self.file, position, &data[..fragment_len])
                .map_err(|error| format!("Failed to write streaming cache: {error}"))?;
            let added_block = {
                let mut state = self.state.lock().map_err(|error| error.to_string())?;
                state.sequence = state.sequence.saturating_add(1);
                let sequence = state.sequence;
                let added_block = state.block_access.insert(block, sequence).is_none();
                merge_single_file_cache_range(
                    &mut state.covered_ranges,
                    (
                        position,
                        position
                            .saturating_add(fragment_len as u64)
                            .saturating_sub(1),
                    ),
                );
                self.changed.notify_all();
                added_block
            };
            if added_block {
                self.record_persistent_block()?;
            }
            position = position.saturating_add(fragment_len as u64);
            data = &data[fragment_len..];
        }
        Ok(())
    }

    fn reserve_cached_range(
        &self,
        position: u64,
        request_end: u64,
        maximum_bytes: usize,
    ) -> Result<Option<SingleFileCacheReadReservation<'_>>, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        let Some(covered_end) = single_file_cache_covered_end(&state.covered_ranges, position)
        else {
            return Ok(None);
        };
        let end = covered_end.min(request_end).min(
            position
                .saturating_add(maximum_bytes.max(1) as u64)
                .saturating_sub(1),
        );
        let first_block = position / SINGLE_FILE_CACHE_BLOCK_BYTES;
        let last_block = end / SINGLE_FILE_CACHE_BLOCK_BYTES;
        let blocks = (first_block..=last_block).collect::<Vec<_>>();
        state.sequence = state.sequence.saturating_add(1);
        let sequence = state.sequence;
        for block in &blocks {
            *state.block_readers.entry(*block).or_insert(0) += 1;
            state.block_access.insert(*block, sequence);
        }
        drop(state);

        Ok(Some(SingleFileCacheReadReservation {
            cache: self,
            start: position,
            end,
            blocks,
        }))
    }

    fn read_cached_with_limit(
        &self,
        position: u64,
        request_end: u64,
        maximum_bytes: usize,
    ) -> Result<Option<Vec<u8>>, String> {
        let Some(reservation) = self.reserve_cached_range(position, request_end, maximum_bytes)?
        else {
            return Ok(None);
        };
        let mut output = vec![0u8; reservation.len()];

        let read_result = read_single_file_cache_at(&self.file, position, &mut output)
            .map_err(|error| format!("Failed to read streaming cache: {error}"));
        read_result?;
        Ok(Some(output))
    }

    fn read_cached(&self, position: u64, request_end: u64) -> Result<Option<Vec<u8>>, String> {
        self.read_cached_with_limit(position, request_end, SINGLE_FILE_CACHE_WRITE_BYTES)
    }
}

impl Drop for SingleFileRangeCache {
    fn drop(&mut self) {
        let Some(persistent) = self.persistent.as_ref() else {
            return;
        };
        if let Err(error) = self.persist_manifest() {
            warn!("Failed to finalize persistent stream cache index: {error}");
        }
        if let Ok(mut active) = ACTIVE_PERSISTENT_STREAM_CACHES.lock() {
            let owns_registration = active
                .get(&persistent.entry_dir)
                .is_some_and(|cache| std::ptr::eq(cache.as_ptr(), self));
            if owns_registration {
                active.remove(&persistent.entry_dir);
            }
        }
        prune_persistent_stream_cache(&persistent.root, persistent.limit_bytes);
    }
}

fn create_stream_range_cache(
    app: &AppHandle,
    identity: &str,
    provider: &str,
    disposable_path: PathBuf,
    total_size: u64,
    tail_start: u64,
    retain_whole_file: bool,
) -> Result<Arc<SingleFileRangeCache>, String> {
    if total_size > 0 {
        if let Some(settings) = persistent_stream_cache_settings(app) {
            match SingleFileRangeCache::open_persistent(
                &settings,
                identity,
                provider,
                total_size,
                tail_start,
                retain_whole_file,
            ) {
                Ok(cache) => return Ok(cache),
                Err(error) => warn!(
                    "Persistent stream cache unavailable for provider={provider}; using disposable cache: {error}"
                ),
            }
        }
    }
    SingleFileRangeCache::create(disposable_path, total_size, tail_start, retain_whole_file)
}

fn serve_single_file_cache_only<W: Write>(
    stream: &mut W,
    cache: &Arc<SingleFileRangeCache>,
    request_start: u64,
    request_end: u64,
) -> Result<u64, String> {
    let Some(reservation) = cache.reserve_cached_range(
        request_start,
        request_end,
        SINGLE_FILE_CACHE_ONLY_READ_BYTES,
    )?
    else {
        write!(
            stream,
            "HTTP/1.1 425 Too Early\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .map_err(|error| format!("Failed to write cache-only response: {error}"))?;
        return Ok(0);
    };
    let response_end = reservation.end;
    let response_length = reservation.len();

    write!(
        stream,
        "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {request_start}-{response_end}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        cache.total_size,
        response_length
    )
    .map_err(|error| format!("Failed to write cache-only headers: {error}"))?;

    let mut buffer = vec![0u8; SINGLE_FILE_CACHE_WRITE_BYTES.min(response_length)];
    let mut position = request_start;
    let mut response_bytes = 0u64;
    while position <= response_end {
        let remaining = response_end.saturating_sub(position).saturating_add(1) as usize;
        let chunk_length = remaining.min(buffer.len());
        read_single_file_cache_at(&cache.file, position, &mut buffer[..chunk_length])
            .map_err(|error| format!("Failed to read cache-only bytes: {error}"))?;
        stream
            .write_all(&buffer[..chunk_length])
            .map_err(|error| format!("Failed to stream cache-only bytes: {error}"))?;
        position = position.saturating_add(chunk_length as u64);
        response_bytes = response_bytes.saturating_add(chunk_length as u64);
    }
    Ok(response_bytes)
}

fn log_thumbfast_cache_only_response(
    provider: &'static str,
    request_start: u64,
    request_end: u64,
    response_bytes: u64,
) {
    let (status, status_code) = if response_bytes == 0 {
        ("miss", 425_u16)
    } else {
        ("hit", 206_u16)
    };

    debug!(
        target: "streamee_lib::thumbfast",
        source = "backend",
        subsystem = "thumbfast.cache_only",
        event = "thumbfast.cache_only.response",
        provider,
        status,
        status_code,
        request_start,
        request_end,
        response_bytes,
        "[Thumbfast] Cache-only response served"
    );
}

fn write_cache_only_head(stream: &mut TcpStream, total_size: u64) -> Result<(), String> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Length: {total_size}\r\nConnection: close\r\n\r\n"
    )
    .map_err(|error| format!("Failed to write cache-only HEAD response: {error}"))
}

fn emit_statistics_transfer(
    app: &AppHandle,
    source_type: &str,
    bytes: u64,
    source_id: Option<&str>,
    source_name: Option<&str>,
) {
    if bytes == 0 {
        return;
    }
    let _ = app.emit(
        "statistics://transfer",
        serde_json::json!({
            "source_type": source_type,
            "source_id": source_id,
            "source_name": source_name,
            "bytes": bytes,
        }),
    );
}

fn parse_http_range(value: &str, total_size: u64) -> Option<(u64, u64)> {
    let range = value.trim().strip_prefix("bytes=")?;
    if let Some(suffix) = range.strip_prefix('-') {
        let suffix_len = suffix.parse::<u64>().ok()?;
        if suffix_len == 0 {
            return None;
        }
        let start = total_size.saturating_sub(suffix_len);
        return Some((start, total_size.saturating_sub(1)));
    }
    let (start_raw, end_raw) = range.split_once('-')?;
    let start = start_raw.parse::<u64>().ok()?;
    let end = if end_raw.trim().is_empty() {
        total_size.saturating_sub(1)
    } else {
        end_raw.parse::<u64>().ok()?
    };
    if start > end || start >= total_size {
        None
    } else {
        Some((start, end.min(total_size.saturating_sub(1))))
    }
}

fn read_http_request(
    stream: &mut TcpStream,
) -> Result<(String, String, Option<String>, bool), String> {
    let mut buffer = Vec::new();
    let mut temp = [0u8; 1024];
    while buffer.len() < 16 * 1024 {
        let read = stream
            .read(&mut temp)
            .map_err(|e| format!("Failed to read proxy request: {}", e))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buffer);
    let mut lines = text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| "Proxy request was empty".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut range = None;
    let mut cache_only = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_string());
            } else if name.eq_ignore_ascii_case("x-streamee-cache-only") {
                cache_only = value.trim() == "1";
            }
        }
    }
    if !cache_only {
        cache_only = reqwest::Url::parse(&format!("http://127.0.0.1{path}"))
            .ok()
            .map(|url| {
                url.query_pairs()
                    .any(|(name, value)| name == "streamee-cache-only" && value == "1")
            })
            .unwrap_or(false);
    }
    Ok((method, path, range, cache_only))
}

fn write_proxy_error(mut stream: TcpStream, code: u16, label: &str) {
    let body = label.as_bytes();
    let _ = write!(
        stream,
        "HTTP/1.1 {code} {label}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(body);
}

fn range_label(start: u64, end: u64) -> String {
    format!("{start}-{end} ({} bytes)", end - start + 1)
}

fn is_client_disconnect_error(message: &str) -> bool {
    message.contains("os error 10053")
        || message.contains("os error 10054")
        || message.contains("Broken pipe")
        || message.contains("connection reset")
        || message.contains("connection aborted")
}

fn is_addon_cache_client_write_error(message: &str) -> bool {
    message.starts_with("Failed to write Addon cache response headers:")
        || message.starts_with("Failed to stream single-file cache:")
}

fn resolve_public_addon_url(url: &reqwest::Url) -> Result<(String, Vec<SocketAddr>), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Addon stream must use HTTP or HTTPS".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Addon stream URL has no host".to_string())?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Addon stream URL has no usable port".to_string())?;
    let addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|_| "Addon stream host could not be resolved".to_string())?
        .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| is_forbidden_torrent_source_ip(address.ip()))
    {
        return Err("Addon stream resolves to a local or non-public address".to_string());
    }
    Ok((host, addresses))
}

fn addon_proxy_client(url: &reqwest::Url) -> Result<reqwest::blocking::Client, String> {
    let (host, addresses) = resolve_public_addon_url(url)?;
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(
            ADDON_CONNECT_TIMEOUT_SECONDS,
        ))
        .resolve_to_addrs(&host, &addresses)
        .build()
        .map_err(|error| format!("Failed to create Addon stream client: {error}"))
}

fn addon_proxy_client_key(url: &reqwest::Url) -> Result<String, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Addon stream URL has no host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Addon stream URL has no usable port".to_string())?;
    Ok(format!("{}://{host}:{port}", url.scheme()))
}

fn addon_proxy_client_for_entry(
    entry: &AddonProxyEntry,
    url: &reqwest::Url,
) -> Result<reqwest::blocking::Client, String> {
    let key = addon_proxy_client_key(url)?;
    if let Some(client) = entry
        .http_clients
        .lock()
        .map_err(|error| error.to_string())?
        .get(&key)
        .cloned()
    {
        return Ok(client);
    }
    let client = addon_proxy_client(url)?;
    entry
        .http_clients
        .lock()
        .map_err(|error| error.to_string())?
        .insert(key, client.clone());
    Ok(client)
}

fn invalidate_addon_proxy_client(entry: &AddonProxyEntry, url: &reqwest::Url) {
    let Ok(key) = addon_proxy_client_key(url) else {
        return;
    };
    if let Ok(mut clients) = entry.http_clients.lock() {
        clients.remove(&key);
    }
}

fn probe_addon_stream_size(source_url: &str) -> Result<u64, String> {
    let mut failures = Vec::new();
    // Some direct-stream providers reject a one-byte range but return the
    // authoritative CDN Content-Range for a small opening request.
    for range_header in ["bytes=0-0", "bytes=0-1048575"] {
        let mut current_url = reqwest::Url::parse(source_url)
            .map_err(|_| "Addon stream URL is invalid".to_string())?;
        let probe_result = (|| -> Result<u64, String> {
            for redirect_count in 0..=10 {
                let client = addon_proxy_client(&current_url)?;
                let response = client
                    .get(current_url.clone())
                    .header(
                        reqwest::header::USER_AGENT,
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                    )
                    .header(reqwest::header::RANGE, range_header)
                    .timeout(std::time::Duration::from_secs(5))
                    .send()
                    .map_err(|error| format!("Addon size probe failed: {}", error.without_url()))?;
                if !response.status().is_redirection() {
                    if !response.status().is_success() {
                        return Err(format!(
                            "Addon size probe returned HTTP {}",
                            response.status()
                        ));
                    }
                    return addon_response_total_size(&response, None)
                        .filter(|total| *total > 0)
                        .ok_or_else(|| "Addon size probe did not return a file size".to_string());
                }
                if redirect_count == 10 {
                    return Err("Addon size probe exceeded the redirect limit".to_string());
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| "Addon size probe redirect had no destination".to_string())?;
                current_url = current_url
                    .join(location)
                    .map_err(|_| "Addon size probe redirect was invalid".to_string())?;
            }
            Err("Addon size probe returned no response".to_string())
        })();
        match probe_result {
            Ok(total_size) => return Ok(total_size),
            Err(error) => failures.push(format!("{range_header}: {error}")),
        }
    }
    Err(format!(
        "Addon size probe failed for all ranges: {}",
        failures.join("; ")
    ))
}

fn choose_addon_total_size(provided_size: u64, probed_size: Option<u64>) -> u64 {
    probed_size
        .filter(|size| *size > 0)
        .or((provided_size > 0).then_some(provided_size))
        .unwrap_or(0)
}

fn safe_stream_display_name(name: Option<&str>) -> Option<String> {
    let name = name?.trim();
    if name.is_empty() {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    if reqwest::Url::parse(name).is_ok()
        || lower.contains("?token=")
        || lower.contains("&token=")
        || name.contains("://")
    {
        return None;
    }
    Some(name.to_string())
}

#[derive(Clone)]
struct AddonProxyEntry {
    app_handle: AppHandle,
    session_id: String,
    addon_installation_id: Option<String>,
    addon_name: Option<String>,
    source_url: Arc<Mutex<Option<String>>>,
    resolved_source_url: Arc<Mutex<Option<String>>>,
    http_clients: Arc<Mutex<HashMap<String, reqwest::blocking::Client>>>,
    transfer: Arc<Mutex<AddonProxyTransfer>>,
    upstream_request_gate: Arc<Mutex<()>>,
    active: Arc<AtomicBool>,
    total_size: u64,
    tail_start: u64,
    range_cache: Arc<SingleFileRangeCache>,
    request_sequence: Arc<AtomicU64>,
    created_at: std::time::Instant,
}

struct AddonProxyTransfer {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    sample_bytes: u64,
    sample_started: std::time::Instant,
    covered_ranges: Vec<(u64, u64)>,
    covered_bytes: u64,
    sequence: u64,
}

static ADDON_PROXY_ENTRIES: Lazy<Mutex<HashMap<String, AddonProxyEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static ADDON_PROXY_PORT: Lazy<Mutex<Option<u16>>> = Lazy::new(|| Mutex::new(None));
static ADDON_PROXY_ID: AtomicU64 = AtomicU64::new(1);
const ADDON_TAIL_CACHE_BYTES: u64 = 64 * 1024 * 1024;
const ADDON_PROXY_ENTRY_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);
const ADDON_RATE_LIMIT_RETRIES: usize = 6;
const ADDON_GATEWAY_RETRY_DELAYS_SECONDS: [u64; 3] = [2, 5, 10];
const ADDON_CONNECT_TIMEOUT_SECONDS: u64 = 5;
const ADDON_NETWORK_RETRY_DELAYS_MS: [u64; 2] = [250, 1_000];

pub(crate) struct FingerprintCacheWindowStatus {
    pub(crate) covered_bytes: u64,
    pub(crate) required_bytes: u64,
    pub(crate) pinned_bytes: u64,
}

pub(crate) fn pin_intro_cache_for_stream_url(
    stream_url: &str,
    required_opening_seconds: f64,
    duration_seconds: f64,
) -> Result<Option<FingerprintCacheWindowStatus>, String> {
    let Ok(url) = reqwest::Url::parse(stream_url) else {
        return Ok(None);
    };
    if !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) {
        return Ok(None);
    }
    let segments = url
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    let [provider, id, ..] = segments.as_slice() else {
        return Ok(None);
    };
    let cache = match *provider {
        "addon" => ADDON_PROXY_ENTRIES
            .lock()
            .map_err(|error| error.to_string())?
            .get(*id)
            .map(|entry| entry.range_cache.clone()),
        _ => None,
    };
    let Some(cache) = cache else {
        return Ok(None);
    };
    let required_bytes =
        fingerprint_window_pin_bytes(cache.total_size, required_opening_seconds, duration_seconds);
    let retained_bytes =
        required_bytes.max(SINGLE_FILE_CACHE_INTRO_OPENING_PIN_BYTES.min(cache.total_size));
    let (previous, pinned) = cache.pin_opening(retained_bytes);
    if pinned > previous {
        info!(
            "[Segment Detection][Local] Pinned cached opening: provider={}, stream_id={}, previous_bytes={}, pinned_bytes={}",
            provider, id, previous, pinned
        );
    }
    Ok(Some(FingerprintCacheWindowStatus {
        covered_bytes: cache.covered_opening_bytes()?,
        required_bytes,
        pinned_bytes: pinned,
    }))
}

fn fingerprint_window_pin_bytes(
    total_size: u64,
    required_window_seconds: f64,
    duration_seconds: f64,
) -> u64 {
    if total_size == 0
        || !required_window_seconds.is_finite()
        || !duration_seconds.is_finite()
        || required_window_seconds <= 0.0
        || duration_seconds <= 0.0
    {
        return 0;
    }
    let window_ratio = (required_window_seconds / duration_seconds).clamp(0.0, 1.0);
    let variable_bitrate_headroom = (total_size as f64 * window_ratio * 1.5).ceil() as u64;
    variable_bitrate_headroom
        .saturating_add(SINGLE_FILE_CACHE_FINGERPRINT_HEADROOM_BYTES)
        .min(total_size)
}

pub(crate) fn pin_outro_cache_for_stream_url(
    stream_url: &str,
    required_tail_seconds: f64,
    duration_seconds: f64,
) -> Result<Option<FingerprintCacheWindowStatus>, String> {
    let Ok(url) = reqwest::Url::parse(stream_url) else {
        return Ok(None);
    };
    if !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) {
        return Ok(None);
    }
    let segments = url
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    let [provider, id, ..] = segments.as_slice() else {
        return Ok(None);
    };
    let cache = match *provider {
        "addon" => ADDON_PROXY_ENTRIES
            .lock()
            .map_err(|error| error.to_string())?
            .get(*id)
            .map(|entry| entry.range_cache.clone()),
        _ => None,
    };
    let Some(cache) = cache else {
        return Ok(None);
    };
    let required_bytes =
        fingerprint_window_pin_bytes(cache.total_size, required_tail_seconds, duration_seconds);
    let (previous, pinned) = cache.pin_tail(required_bytes);
    if pinned > previous {
        info!(
            "[Segment Detection][Local][Outro] Pinned cached tail: provider={}, stream_id={}, previous_bytes={}, pinned_bytes={}",
            provider, id, previous, pinned
        );
    }
    Ok(Some(FingerprintCacheWindowStatus {
        covered_bytes: cache.covered_tail_bytes()?,
        required_bytes,
        pinned_bytes: pinned,
    }))
}

fn addon_gateway_retry_delay(status: u16, retry_attempt: usize) -> Option<u64> {
    if !matches!(status, 502 | 522) {
        return None;
    }
    ADDON_GATEWAY_RETRY_DELAYS_SECONDS
        .get(retry_attempt)
        .copied()
}

fn addon_status_requires_original_fallback(status: u16) -> bool {
    !(200..300).contains(&status) && status != 416
}

fn wait_for_addon_retry(entry: &AddonProxyEntry, retry_seconds: u64) -> Result<(), String> {
    wait_for_addon_retry_ms(entry, retry_seconds.saturating_mul(1_000))
}

fn wait_for_addon_retry_ms(entry: &AddonProxyEntry, retry_milliseconds: u64) -> Result<(), String> {
    for _ in 0..retry_milliseconds.saturating_add(99) / 100 {
        if !entry.active.load(Ordering::SeqCst) {
            return Err("Addon stream session is no longer active".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(())
}

#[derive(Serialize)]
struct PreparedAddonStreamUrl {
    url: String,
    session_id: String,
}

#[derive(Debug, Serialize)]
struct SmartNextWarmupResult {
    provider: String,
    requested_bytes: u64,
    cached_bytes: u64,
    total_bytes: u64,
}

fn parse_addon_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.trim().strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = end.parse::<u64>().ok()?;
    let total = total.parse::<u64>().ok()?;
    (start <= end && end < total).then_some((start, end, total))
}

fn merge_addon_covered_range(ranges: &mut Vec<(u64, u64)>, added_range: (u64, u64)) -> u64 {
    ranges.push(added_range);
    ranges.sort_unstable_by_key(|range| range.0);
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges.drain(..) {
        if let Some(last) = merged.last_mut() {
            if start <= last.1.saturating_add(1) {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    let covered_bytes = merged.iter().fold(0u64, |total, (start, end)| {
        total.saturating_add(end.saturating_sub(*start).saturating_add(1))
    });
    *ranges = merged;
    covered_bytes
}

fn addon_response_total_size(
    response: &reqwest::blocking::Response,
    fallback: Option<u64>,
) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit_once('/'))
        .and_then(|(_, total)| total.parse::<u64>().ok())
        .filter(|total| *total > 0)
        .or(fallback)
        .or_else(|| {
            (response.status() == reqwest::StatusCode::OK)
                .then(|| response.content_length())
                .flatten()
                .filter(|total| *total > 0)
        })
}

fn addon_response_start(response: &reqwest::blocking::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_addon_content_range)
        .map(|range| range.0)
        .or_else(|| (response.status() == reqwest::StatusCode::OK).then_some(0))
}

fn emit_addon_transfer_progress(
    entry: &AddonProxyEntry,
    added_bytes: u64,
    covered_range: Option<(u64, u64)>,
    total_bytes: Option<u64>,
    complete: bool,
) {
    if !entry.active.load(Ordering::SeqCst) {
        return;
    }
    let (downloaded_bytes, covered_bytes, resolved_total, bytes_per_second, sequence) = {
        let Ok(mut transfer) = entry.transfer.lock() else {
            return;
        };
        if let Some(total) = total_bytes.filter(|total| *total > 0) {
            transfer.total_bytes = Some(total);
        }
        transfer.downloaded_bytes = transfer.downloaded_bytes.saturating_add(added_bytes);
        if let Some(range) = covered_range {
            transfer.covered_bytes = merge_addon_covered_range(&mut transfer.covered_ranges, range);
        }
        transfer.sample_bytes = transfer.sample_bytes.saturating_add(added_bytes);
        let elapsed = transfer.sample_started.elapsed();
        let bytes_per_second = if elapsed >= std::time::Duration::from_millis(500) {
            let speed = (transfer.sample_bytes as f64 / elapsed.as_secs_f64()) as u64;
            transfer.sample_bytes = 0;
            transfer.sample_started = std::time::Instant::now();
            speed
        } else {
            0
        };
        transfer.sequence = transfer.sequence.saturating_add(1);
        (
            transfer.downloaded_bytes,
            transfer.covered_bytes,
            transfer.total_bytes,
            bytes_per_second,
            transfer.sequence,
        )
    };

    if added_bytes > 0 {
        emit_statistics_transfer(
            &entry.app_handle,
            "addon",
            added_bytes,
            entry.addon_installation_id.as_deref(),
            entry.addon_name.as_deref(),
        );
    }
    let _ = entry.app_handle.emit(
        "addon://transfer-progress",
        serde_json::json!({
            "downloaded_bytes": downloaded_bytes,
            "covered_bytes": covered_bytes,
            "total_bytes": resolved_total,
            "bytes_per_second": bytes_per_second,
            "complete": complete,
            "session_id": entry.session_id,
            "sequence": sequence,
        }),
    );
}

fn emit_addon_stream_error(entry: &AddonProxyEntry, message: &str) {
    let _ = entry.app_handle.emit(
        "addon://stream-error",
        serde_json::json!({
            "session_id": entry.session_id,
            "message": message,
        }),
    );
}

fn copy_addon_upstream<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    entry: &AddonProxyEntry,
    total_bytes: Option<u64>,
    response_start: Option<u64>,
) -> std::io::Result<()> {
    let mut buffer = [0u8; 64 * 1024];
    let mut pending_bytes = 0u64;
    let mut last_emit = std::time::Instant::now();
    let mut next_covered_offset = response_start;
    let mut emit_pending = |added_bytes: u64, covered_length: u64, complete: bool| {
        let covered_range = next_covered_offset.and_then(|start| {
            (covered_length > 0).then_some((
                start,
                start.saturating_add(covered_length).saturating_sub(1),
            ))
        });
        if let Some(start) = next_covered_offset {
            next_covered_offset = Some(start.saturating_add(covered_length));
        }
        emit_addon_transfer_progress(entry, added_bytes, covered_range, total_bytes, complete);
    };
    loop {
        if !entry.active.load(Ordering::SeqCst) {
            return Ok(());
        }
        let read = match reader.read(&mut buffer) {
            Ok(0) => {
                emit_pending(pending_bytes, pending_bytes, true);
                return Ok(());
            }
            Ok(read) => read,
            Err(error) => {
                emit_pending(pending_bytes, pending_bytes, false);
                return Err(error);
            }
        };
        if let Err(error) = writer.write_all(&buffer[..read]) {
            emit_pending(
                pending_bytes.saturating_add(read as u64),
                pending_bytes.saturating_add(read as u64),
                false,
            );
            return Err(error);
        }
        pending_bytes = pending_bytes.saturating_add(read as u64);
        if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
            emit_pending(pending_bytes, pending_bytes, false);
            pending_bytes = 0;
            last_emit = std::time::Instant::now();
        }
    }
}

fn request_addon_upstream(
    entry: &AddonProxyEntry,
    range_header: Option<&str>,
    head_only: bool,
) -> Result<reqwest::blocking::Response, String> {
    if !entry.active.load(Ordering::SeqCst) {
        return Err("Addon stream session is no longer active".to_string());
    }
    // Coordinate request starts per playback session. A gateway backoff keeps
    // every MPV/Whisper caller behind the same gate instead of allowing each
    // reconnect to start an independent retry burst.
    let _request_guard = entry
        .upstream_request_gate
        .lock()
        .map_err(|error| error.to_string())?;
    if !entry.active.load(Ordering::SeqCst) {
        return Err("Addon stream session is no longer active".to_string());
    }
    let source_url = entry
        .source_url
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "Addon stream session is no longer active".to_string())?;
    let original_url =
        reqwest::Url::parse(&source_url).map_err(|_| "Addon stream URL is invalid".to_string())?;

    let mut rate_limit_attempt = 0;
    let mut gateway_retry_attempt = 0;
    let mut network_retry_attempt = 0;
    let mut force_original_route = false;
    'request_attempt: loop {
        let pinned_source_url = if force_original_route {
            None
        } else {
            entry
                .resolved_source_url
                .lock()
                .map_err(|error| error.to_string())?
                .clone()
        };
        let (initial_url, using_pinned_route) = match pinned_source_url {
            Some(url) => match reqwest::Url::parse(&url) {
                Ok(url) => (url, true),
                Err(_) => {
                    if let Ok(mut resolved_url) = entry.resolved_source_url.lock() {
                        resolved_url.take();
                    }
                    (original_url.clone(), false)
                }
            },
            None => (original_url.clone(), false),
        };
        info!(
            "Addon upstream route start: session_id={} method={} range={} initial_host={} route={}",
            entry.session_id,
            if head_only { "HEAD" } else { "GET" },
            range_header.unwrap_or("none"),
            initial_url.host_str().unwrap_or("unknown"),
            if using_pinned_route {
                "pinned-resolved-host"
            } else {
                "original-addon-host"
            }
        );
        let mut current_url = initial_url.clone();
        let mut response = None;
        let mut redirect_hops = 0usize;
        for redirect_count in 0..=10 {
            let client = addon_proxy_client_for_entry(entry, &current_url)?;
            let mut request = if head_only {
                client.head(current_url.clone())
            } else {
                client.get(current_url.clone())
            }
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            );
            if let Some(range) = range_header {
                request = request.header(reqwest::header::RANGE, range);
            }
            let next_response = match request.send() {
                Ok(response) => response,
                Err(error) => {
                    let transient = error.is_connect() || error.is_timeout();
                    let message = error.without_url().to_string();
                    if using_pinned_route {
                        warn!(
                            "Addon pinned upstream failed: session_id={} host={} range={}, retrying through original Addon route: {}",
                            entry.session_id,
                            current_url.host_str().unwrap_or("unknown"),
                            range_header.unwrap_or("none"),
                            message
                        );
                        invalidate_addon_proxy_client(entry, &current_url);
                        if let Ok(mut resolved_url) = entry.resolved_source_url.lock() {
                            resolved_url.take();
                        }
                        force_original_route = true;
                        rate_limit_attempt = 0;
                        gateway_retry_attempt = 0;
                        network_retry_attempt = 0;
                        continue 'request_attempt;
                    }
                    if transient {
                        if let Some(retry_ms) = ADDON_NETWORK_RETRY_DELAYS_MS
                            .get(network_retry_attempt)
                            .copied()
                        {
                            warn!(
                                "Addon upstream connection failed: host={}, range={}, retry={}/{}, waiting={}ms: {}",
                                current_url.host_str().unwrap_or("unknown"),
                                range_header.unwrap_or("none"),
                                network_retry_attempt + 1,
                                ADDON_NETWORK_RETRY_DELAYS_MS.len(),
                                retry_ms,
                                message
                            );
                            network_retry_attempt += 1;
                            invalidate_addon_proxy_client(entry, &current_url);
                            wait_for_addon_retry_ms(entry, retry_ms)?;
                            continue 'request_attempt;
                        }
                    }
                    return Err(format!("Addon stream request failed: {message}"));
                }
            };
            if !next_response.status().is_redirection() {
                response = Some(next_response);
                break;
            }
            if redirect_count == 10 {
                return Err("Addon stream exceeded the redirect limit".to_string());
            }
            let redirect_status = next_response.status();
            let redirect_from_host = current_url.host_str().unwrap_or("unknown").to_string();
            let location = next_response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Addon stream redirect had no valid destination".to_string())?;
            let redirect_url = current_url
                .join(location)
                .map_err(|_| "Addon stream redirect destination is invalid".to_string())?;
            redirect_hops += 1;
            info!(
                "Addon upstream redirect: session_id={} range={} hop={} status={} from_host={} to_host={}",
                entry.session_id,
                range_header.unwrap_or("none"),
                redirect_hops,
                redirect_status.as_u16(),
                redirect_from_host,
                redirect_url.host_str().unwrap_or("unknown")
            );
            current_url = redirect_url;
        }
        let response = response.ok_or_else(|| "Addon stream returned no response".to_string())?;
        let status = response.status();
        info!(
            "Addon upstream route final: session_id={} range={} redirect_hops={} final_host={} status={} route={}",
            entry.session_id,
            range_header.unwrap_or("none"),
            redirect_hops,
            current_url.host_str().unwrap_or("unknown"),
            status.as_u16(),
            if redirect_hops == 0 {
                "initial-host-response"
            } else {
                "redirected-host-response"
            }
        );
        if using_pinned_route && addon_status_requires_original_fallback(status.as_u16()) {
            warn!(
                "Addon pinned upstream returned HTTP {}: session_id={} host={} range={}, retrying through original Addon route",
                status.as_u16(),
                entry.session_id,
                current_url.host_str().unwrap_or("unknown"),
                range_header.unwrap_or("none")
            );
            invalidate_addon_proxy_client(entry, &current_url);
            if let Ok(mut resolved_url) = entry.resolved_source_url.lock() {
                resolved_url.take();
            }
            force_original_route = true;
            rate_limit_attempt = 0;
            gateway_retry_attempt = 0;
            network_retry_attempt = 0;
            drop(response);
            continue;
        }
        if status.is_success() && current_url != original_url {
            let resolved_url_value = current_url.to_string();
            let mut resolved_url = entry
                .resolved_source_url
                .lock()
                .map_err(|error| error.to_string())?;
            if resolved_url.as_deref() != Some(resolved_url_value.as_str()) {
                *resolved_url = Some(resolved_url_value);
                info!(
                    "Addon upstream route pinned: session_id={} resolved_host={} range={}",
                    entry.session_id,
                    current_url.host_str().unwrap_or("unknown"),
                    range_header.unwrap_or("none")
                );
            }
        }
        if status.as_u16() == 429 && rate_limit_attempt < ADDON_RATE_LIMIT_RETRIES {
            let fallback_seconds = [1u64, 2, 4, 8, 16, 30][rate_limit_attempt];
            let retry_seconds = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(fallback_seconds)
                .clamp(1, 60);
            let host = current_url.host_str().unwrap_or("unknown");
            warn!(
                "Addon upstream rate limited: host={host}, range={}, retry={}/{}, waiting={}s",
                range_header.unwrap_or("none"),
                rate_limit_attempt + 1,
                ADDON_RATE_LIMIT_RETRIES,
                retry_seconds
            );
            rate_limit_attempt += 1;
            drop(response);
            wait_for_addon_retry(entry, retry_seconds)?;
            continue;
        }
        if let Some(retry_seconds) =
            addon_gateway_retry_delay(status.as_u16(), gateway_retry_attempt)
        {
            let host = current_url.host_str().unwrap_or("unknown");
            warn!(
                "Addon upstream gateway error: host={host}, status={}, range={}, retry={}/{}, waiting={}s",
                status.as_u16(),
                range_header.unwrap_or("none"),
                gateway_retry_attempt + 1,
                ADDON_GATEWAY_RETRY_DELAYS_SECONDS.len(),
                retry_seconds
            );
            gateway_retry_attempt += 1;
            drop(response);
            wait_for_addon_retry(entry, retry_seconds)?;
            continue;
        }
        if !status.is_success() && status.as_u16() != 416 {
            let host = current_url.host_str().unwrap_or("unknown");
            warn!(
                "Addon upstream rejected stream request: host={host}, status={}, range={}",
                status.as_u16(),
                range_header.unwrap_or("none")
            );
            return Err(format!(
                "Addon stream host returned HTTP {}",
                status.as_u16()
            ));
        }
        return Ok(response);
    }
}

fn forward_addon_stream(
    mut stream: TcpStream,
    entry: &AddonProxyEntry,
    range_header: Option<&str>,
    head_only: bool,
) -> Result<(), String> {
    let mut response = request_addon_upstream(entry, range_header, head_only)?;
    let status = response.status();
    let reason = status.canonical_reason().unwrap_or("OK");
    let fallback_total = entry
        .transfer
        .lock()
        .ok()
        .and_then(|transfer| transfer.total_bytes);
    let total_bytes = addon_response_total_size(&response, fallback_total);
    let response_start = addon_response_start(&response);
    write!(stream, "HTTP/1.1 {} {reason}\r\n", status.as_u16())
        .map_err(|error| format!("Failed to write Addon proxy status: {error}"))?;
    for header in [
        reqwest::header::CONTENT_TYPE,
        reqwest::header::CONTENT_LENGTH,
        reqwest::header::CONTENT_RANGE,
        reqwest::header::ACCEPT_RANGES,
        reqwest::header::CONTENT_DISPOSITION,
    ] {
        if let Some(value) = response.headers().get(&header) {
            if let Ok(value) = value.to_str() {
                write!(stream, "{}: {value}\r\n", header.as_str())
                    .map_err(|error| format!("Failed to write Addon proxy header: {error}"))?;
            }
        }
    }
    write!(stream, "Connection: close\r\n\r\n")
        .map_err(|error| format!("Failed to finish Addon proxy headers: {error}"))?;
    emit_addon_transfer_progress(entry, 0, None, total_bytes, head_only);
    if !head_only {
        copy_addon_upstream(
            &mut response,
            &mut stream,
            entry,
            total_bytes,
            response_start,
        )
        .map_err(|error| format!("Failed to relay Addon stream: {error}"))?;
    }
    Ok(())
}

fn validate_addon_cached_response(
    response: &reqwest::blocking::Response,
    expected_start: u64,
    expected_end: u64,
    expected_total: u64,
) -> Result<(u64, u64, u64), String> {
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!(
            "Addon cache fill expected HTTP 206, received HTTP {}",
            response.status()
        ));
    }
    let range = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_addon_content_range)
        .ok_or_else(|| "Addon cache fill returned an invalid Content-Range".to_string())?;
    if range != (expected_start, expected_end, expected_total) {
        return Err(format!(
            "Addon cache fill range mismatch: expected {}-{}/{}, received {}-{}/{}",
            expected_start, expected_end, expected_total, range.0, range.1, range.2
        ));
    }
    Ok(range)
}

fn write_addon_cached_headers(
    stream: &mut TcpStream,
    entry: &AddonProxyEntry,
    request_start: u64,
    request_end: u64,
) -> Result<(), String> {
    let content_length = request_end - request_start + 1;
    write!(
        stream,
        "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {request_start}-{request_end}/{}\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n",
        entry.total_size
    )
    .map_err(|error| format!("Failed to write Addon cache response headers: {error}"))
}

fn run_addon_single_file_producer(
    entry: AddonProxyEntry,
    permit: &SingleFileProducerPermit,
) -> Result<(), String> {
    info!(
        "Addon single-file cache producer lane={} upstream_range={} read_ahead_bytes={}",
        permit.id,
        range_label(permit.start, permit.upstream_end),
        SINGLE_FILE_CACHE_READ_AHEAD_BYTES
    );
    let range_header = format!("bytes={}-{}", permit.start, permit.upstream_end);
    let mut response = request_addon_upstream(&entry, Some(&range_header), false)?;
    validate_addon_cached_response(
        &response,
        permit.start,
        permit.upstream_end,
        entry.total_size,
    )?;

    let mut cursor = permit.start;
    let mut buffer = vec![0u8; SINGLE_FILE_CACHE_WRITE_BYTES];
    let mut downloaded = 0u64;
    let mut pending_start = cursor;
    let mut pending_bytes = 0u64;
    let mut last_emit = std::time::Instant::now();
    while cursor <= permit.upstream_end && entry.active.load(Ordering::SeqCst) {
        let Some(wanted) = permit.next_read_len(cursor, buffer.len())? else {
            if pending_bytes > 0 {
                emit_addon_transfer_progress(
                    &entry,
                    pending_bytes,
                    Some((
                        pending_start,
                        pending_start
                            .saturating_add(pending_bytes)
                            .saturating_sub(1),
                    )),
                    Some(entry.total_size),
                    false,
                );
            }
            info!(
                "Addon single-file cache producer lane={} closed cursor={} downloaded_bytes={} reason={}",
                permit.id,
                cursor,
                downloaded,
                if permit.is_cancelled() { "cancelled" } else { "coordinator-removed" }
            );
            return Ok(());
        };
        let read = response
            .read(&mut buffer[..wanted])
            .map_err(|error| format!("Failed to read Addon cache producer: {error}"))?;
        if read == 0 {
            return Err(format!(
                "Addon cache producer ended at {cursor}, expected {}",
                permit.upstream_end.saturating_add(1)
            ));
        }
        entry.range_cache.commit(cursor, &buffer[..read])?;
        cursor = cursor.saturating_add(read as u64);
        permit.update_cursor(cursor);
        downloaded = downloaded.saturating_add(read as u64);
        pending_bytes = pending_bytes.saturating_add(read as u64);
        if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
            emit_addon_transfer_progress(
                &entry,
                pending_bytes,
                Some((
                    pending_start,
                    pending_start
                        .saturating_add(pending_bytes)
                        .saturating_sub(1),
                )),
                Some(entry.total_size),
                false,
            );
            pending_start = cursor;
            pending_bytes = 0;
            last_emit = std::time::Instant::now();
        }
    }
    if pending_bytes > 0 {
        emit_addon_transfer_progress(
            &entry,
            pending_bytes,
            Some((
                pending_start,
                pending_start
                    .saturating_add(pending_bytes)
                    .saturating_sub(1),
            )),
            Some(entry.total_size),
            false,
        );
    }
    if cursor <= permit.upstream_end {
        info!(
            "Addon single-file cache producer lane={} closed cursor={} downloaded_bytes={} reason=session-ended",
            permit.id, cursor, downloaded
        );
        return Ok(());
    }
    info!(
        "Addon single-file cache producer lane={} completed downloaded_bytes={}",
        permit.id, downloaded
    );
    Ok(())
}

fn serve_addon_single_file_range(
    stream: &mut TcpStream,
    entry: &AddonProxyEntry,
    request_start: u64,
    request_end: u64,
) -> Result<(), String> {
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(
            STREAM_CACHE_CLIENT_WRITE_TIMEOUT_SECONDS,
        )))
        .map_err(|error| format!("Failed to set proxy write timeout: {error}"))?;
    let mut position = request_start;
    let mut cache_hit_bytes = 0u64;

    while position <= request_end {
        if !entry.active.load(Ordering::SeqCst) {
            return Ok(());
        }
        match entry.range_cache.plan(position)? {
            SingleFileCachePlan::Cached => {
                let Some(bytes) = entry.range_cache.read_cached(position, request_end)? else {
                    continue;
                };
                stream
                    .write_all(&bytes)
                    .map_err(|error| format!("Failed to stream single-file cache: {error}"))?;
                position = position.saturating_add(bytes.len() as u64);
                cache_hit_bytes = cache_hit_bytes.saturating_add(bytes.len() as u64);
            }
            SingleFileCachePlan::Wait => entry.range_cache.wait_for_change()?,
            SingleFileCachePlan::StartProducer(permit) => {
                let producer_entry = entry.clone();
                std::thread::spawn(move || {
                    let mut permit = permit;
                    loop {
                        if let Err(error) =
                            run_addon_single_file_producer(producer_entry.clone(), &permit)
                        {
                            permit.record_failure(error.clone());
                            warn!("Addon single-file cache producer failed: {error}");
                            break;
                        }
                        match producer_entry.range_cache.plan_full_cache_backfill(&permit) {
                            Ok(Some(backfill)) => permit = backfill,
                            Ok(None) => break,
                            Err(error) => {
                                warn!("Addon full-cache backfill could not start: {error}");
                                break;
                            }
                        }
                    }
                });
                entry.range_cache.wait_for_change()?;
            }
        }
    }

    if cache_hit_bytes > 0 {
        info!(
            "Addon single-file cache served cached_bytes={cache_hit_bytes} range={}",
            range_label(request_start, request_end)
        );
    }
    Ok(())
}

fn serve_addon_cached_range(
    stream: &mut TcpStream,
    entry: &AddonProxyEntry,
    request_start: u64,
    request_end: u64,
    head_only: bool,
) -> Result<(), String> {
    write_addon_cached_headers(stream, entry, request_start, request_end)?;
    if head_only {
        return Ok(());
    }
    serve_addon_single_file_range(stream, entry, request_start, request_end)
}

fn handle_addon_proxy_connection(mut stream: TcpStream) {
    let (method, path, range_header, cache_only) = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            warn!("Addon proxy request parse failed: {error}");
            write_proxy_error(stream, 400, "Bad Request");
            return;
        }
    };
    let head_only = method.eq_ignore_ascii_case("HEAD");
    if !head_only && !method.eq_ignore_ascii_case("GET") {
        write_proxy_error(stream, 405, "Method Not Allowed");
        return;
    }
    let id = path
        .trim_start_matches('/')
        .strip_prefix("addon/")
        .and_then(|value| value.split('?').next())
        .unwrap_or("");
    let entry = ADDON_PROXY_ENTRIES
        .lock()
        .ok()
        .and_then(|entries| entries.get(id).cloned());
    let Some(entry) = entry else {
        write_proxy_error(stream, 404, "Not Found");
        return;
    };
    if cache_only {
        if head_only && range_header.is_none() {
            if let Err(error) = write_cache_only_head(&mut stream, entry.total_size) {
                warn!("Addon cache-only HEAD response failed: {error}");
            }
            return;
        }
        let Some((request_start, request_end)) = range_header
            .as_deref()
            .filter(|_| entry.total_size > 0)
            .and_then(|value| parse_http_range(value, entry.total_size))
        else {
            write_proxy_error(stream, 400, "Cache-Only Range Required");
            return;
        };
        match serve_single_file_cache_only(
            &mut stream,
            &entry.range_cache,
            request_start,
            request_end,
        ) {
            Ok(response_bytes) => log_thumbfast_cache_only_response(
                "addon",
                request_start,
                request_end,
                response_bytes,
            ),
            Err(error) if is_client_disconnect_error(&error) => {
                debug!("Addon cache-only client finished: {error}")
            }
            Err(error) => warn!("Addon cache-only response failed: {error}"),
        }
        return;
    }
    if let Some((request_start, request_end)) = range_header
        .as_deref()
        .filter(|_| entry.total_size > 0)
        .and_then(|value| parse_http_range(value, entry.total_size))
    {
        let response_end = request_end.min(entry.total_size.saturating_sub(1));
        let request_sequence = entry.request_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        if should_log_single_file_cache_request(request_sequence) {
            info!(
                "Addon single-file cache request id={} sequence={} requested_range={} response_range={} tail={} retain_whole_file={} fill_whole_file={}",
                id,
                request_sequence,
                range_label(request_start, request_end),
                range_label(request_start, response_end),
                request_start >= entry.tail_start,
                entry.range_cache.retain_whole_file,
                entry.range_cache.fill_whole_file.load(Ordering::Acquire)
            );
        }
        if let Err(error) =
            serve_addon_cached_range(&mut stream, &entry, request_start, response_end, head_only)
        {
            if is_client_disconnect_error(&error) || is_addon_cache_client_write_error(&error) {
                debug!("Addon single-file cache client finished: {error}");
            } else {
                warn!("Addon single-file cache response failed: {error}");
                emit_addon_stream_error(
                    &entry,
                    "Addon stream host did not respond. Try another result.",
                );
            }
        }
        return;
    }
    if let Err(error) = forward_addon_stream(stream, &entry, range_header.as_deref(), head_only) {
        if is_client_disconnect_error(&error) {
            debug!("Addon proxy client disconnected: {error}");
        } else {
            warn!("Addon proxy response failed: {error}");
            emit_addon_stream_error(
                &entry,
                "Addon stream host did not respond. Try another result.",
            );
        }
    }
}

fn ensure_addon_proxy_server() -> Result<u16, String> {
    if let Some(port) = *ADDON_PROXY_PORT.lock().map_err(|error| error.to_string())? {
        return Ok(port);
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Failed to bind Addon stream monitor: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed to read Addon stream monitor port: {error}"))?
        .port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    std::thread::spawn(move || handle_addon_proxy_connection(stream));
                }
                Err(error) => warn!("Addon stream monitor accept failed: {error}"),
            }
        }
    });
    *ADDON_PROXY_PORT.lock().map_err(|error| error.to_string())? = Some(port);
    info!("Addon stream monitor listening on 127.0.0.1:{port}");
    Ok(port)
}

fn addon_cache_dir() -> PathBuf {
    std::env::temp_dir()
        .join("Streamee")
        .join("addon-stream-cache")
}

fn cleanup_addon_entry_cache(entry: &AddonProxyEntry) {
    entry.range_cache.cancel_all_producers();
    if !entry.range_cache.is_persistent() {
        let _ = fs::remove_file(&entry.range_cache.path);
    }
}

fn cleanup_addon_proxy_cache() {
    let entries = ADDON_PROXY_ENTRIES
        .lock()
        .map(|mut entries| entries.drain().map(|(_, entry)| entry).collect::<Vec<_>>())
        .unwrap_or_default();
    for entry in entries {
        entry.active.store(false, Ordering::SeqCst);
        cleanup_addon_entry_cache(&entry);
    }
    let cache_dir = addon_cache_dir();
    if cache_dir.exists() {
        match fs::remove_dir_all(&cache_dir) {
            Ok(()) => info!("Cleared Addon stream cache: {}", cache_dir.display()),
            Err(error) => warn!(
                "Failed to clear Addon stream cache {}: {error}",
                cache_dir.display()
            ),
        }
    }
}

#[tauri::command]
async fn prepare_addon_stream_url(
    app: tauri::AppHandle,
    source_url: Option<String>,
    stream_handle: Option<String>,
    total_size: u64,
    display_name: Option<String>,
    addon_installation_id: Option<String>,
    addon_name: Option<String>,
    cache_identity: Option<String>,
    cache_whole_file_enabled: Option<bool>,
    whisper_deduplication_enabled: Option<bool>,
) -> Result<PreparedAddonStreamUrl, String> {
    let source_url = match (stream_handle.as_deref(), source_url) {
        (Some(handle), _) => addons::resolve_stream_handle(handle)?,
        (None, Some(url)) => url,
        (None, None) => return Err("A direct stream source is required".to_string()),
    };
    let parsed_url = reqwest::Url::parse(&source_url)
        .map_err(|_| "Addon did not provide a valid direct stream URL".to_string())?;
    validate_torrent_source_url(&parsed_url, Some(&[])).await?;
    let provided_total_size = total_size;
    let probe_url = source_url.clone();
    let probed_total_size = match tokio::task::spawn_blocking(move || {
        probe_addon_stream_size(&probe_url)
    })
    .await
    {
        Ok(Ok(resolved_size)) => {
            if provided_total_size > 0 && provided_total_size != resolved_size {
                warn!(
                    "Addon supplied size differs from upstream Content-Range: supplied_size={} upstream_size={}; using upstream size",
                    provided_total_size, resolved_size
                );
            } else {
                info!("Addon size probe resolved total_size={resolved_size}");
            }
            Some(resolved_size)
        }
        Ok(Err(error)) => {
            warn!(
                "Addon size probe failed: {}; falling back to supplied_size={}",
                error, provided_total_size
            );
            None
        }
        Err(error) => {
            warn!(
                "Addon size probe task failed: {}; falling back to supplied_size={}",
                error, provided_total_size
            );
            None
        }
    };
    let total_size = choose_addon_total_size(provided_total_size, probed_total_size);
    let port = ensure_addon_proxy_server()?;
    let id = format!(
        "{}-{}",
        std::process::id(),
        ADDON_PROXY_ID.fetch_add(1, Ordering::Relaxed)
    );
    let output_dir = addon_cache_dir();
    let tail_start = total_size.saturating_sub(ADDON_TAIL_CACHE_BYTES);
    let persistent_cache_identity = cache_identity
        .filter(|identity| !identity.trim().is_empty())
        .unwrap_or_else(|| {
            let mut stable_url = parsed_url.clone();
            stable_url.set_query(None);
            stable_url.set_fragment(None);
            format!(
                "addon:{}:{}:{}",
                stable_url,
                display_name.as_deref().unwrap_or_default(),
                total_size
            )
        });
    let range_cache = create_stream_range_cache(
        &app,
        &persistent_cache_identity,
        "addon",
        output_dir.join(format!("{id}.cache")),
        total_size,
        tail_start,
        cache_whole_file_enabled.unwrap_or(false),
    )?;
    let (_, pinned_opening_bytes) =
        range_cache.pin_opening(SINGLE_FILE_CACHE_BASE_OPENING_PIN_BYTES);
    let entry = AddonProxyEntry {
        app_handle: app,
        session_id: id.clone(),
        addon_installation_id: safe_stream_display_name(addon_installation_id.as_deref()),
        addon_name: safe_stream_display_name(addon_name.as_deref()),
        source_url: Arc::new(Mutex::new(Some(source_url))),
        resolved_source_url: Arc::new(Mutex::new(None)),
        http_clients: Arc::new(Mutex::new(HashMap::new())),
        transfer: Arc::new(Mutex::new(AddonProxyTransfer {
            downloaded_bytes: 0,
            total_bytes: (total_size > 0).then_some(total_size),
            sample_bytes: 0,
            sample_started: std::time::Instant::now(),
            covered_ranges: Vec::new(),
            covered_bytes: 0,
            sequence: 0,
        })),
        upstream_request_gate: Arc::new(Mutex::new(())),
        active: Arc::new(AtomicBool::new(true)),
        total_size,
        tail_start,
        range_cache,
        request_sequence: Arc::new(AtomicU64::new(0)),
        created_at: std::time::Instant::now(),
    };
    let now = std::time::Instant::now();
    let mut entries = ADDON_PROXY_ENTRIES
        .lock()
        .map_err(|error| error.to_string())?;
    let mut stale_entries = Vec::new();
    entries.retain(|_, entry| {
        let keep = now.duration_since(entry.created_at) <= ADDON_PROXY_ENTRY_MAX_AGE;
        if !keep {
            entry.active.store(false, Ordering::SeqCst);
            if let Ok(mut source_url) = entry.source_url.lock() {
                source_url.take();
            }
            if let Ok(mut resolved_source_url) = entry.resolved_source_url.lock() {
                resolved_source_url.take();
            }
            stale_entries.push(entry.clone());
        }
        keep
    });
    entries.insert(id.clone(), entry.clone());
    drop(entries);
    for stale_entry in stale_entries {
        cleanup_addon_entry_cache(&stale_entry);
    }
    info!(
        "Addon single-file stream cache: sparse=true max_producers={} read_ahead_bytes={} producer_back_buffer_bytes={} block_bytes={} rolling_limit_bytes={} pinned_opening_bytes={} persistent={} retain_whole_file={} fill_whole_file={} whisper_deduplication={} total_size={}",
        SINGLE_FILE_CACHE_MAX_PRODUCERS,
        SINGLE_FILE_CACHE_READ_AHEAD_BYTES,
        SINGLE_FILE_CACHE_PRODUCER_BACK_BUFFER_BYTES,
        SINGLE_FILE_CACHE_BLOCK_BYTES,
        SINGLE_FILE_CACHE_BLOCK_BYTES.saturating_mul(SINGLE_FILE_CACHE_ROLLING_BLOCKS as u64),
        pinned_opening_bytes,
        entry.range_cache.is_persistent(),
        entry.range_cache.retain_whole_file,
        entry.range_cache.fill_whole_file.load(Ordering::Acquire),
        whisper_deduplication_enabled.unwrap_or(false),
        total_size
    );
    let filename_query = safe_stream_display_name(display_name.as_deref())
        .as_deref()
        .map(|name| format!("?filename={}", urlencoding::encode(name)))
        .unwrap_or_default();
    Ok(PreparedAddonStreamUrl {
        url: format!("http://127.0.0.1:{port}/addon/{id}{filename_query}"),
        session_id: id,
    })
}

fn smart_next_proxy_cache(
    stream_url: &str,
) -> Result<(String, String, Arc<SingleFileRangeCache>, u64), String> {
    let parsed = reqwest::Url::parse(stream_url)
        .map_err(|_| "Smart Next warmup received an invalid stream URL".to_string())?;
    let is_loopback = parsed
        .host_str()
        .and_then(|host| host.parse::<IpAddr>().ok())
        .is_some_and(|address| address.is_loopback());
    if parsed.scheme() != "http" || !is_loopback {
        return Err("Smart Next warmup only accepts a prepared local stream URL".to_string());
    }

    let mut segments = parsed
        .path_segments()
        .ok_or_else(|| "Smart Next warmup URL has no proxy path".to_string())?;
    let provider = segments.next().unwrap_or_default();
    let session_id = segments.next().unwrap_or_default();
    if session_id.is_empty() || segments.next().is_some() {
        return Err("Smart Next warmup URL has an invalid proxy session".to_string());
    }

    match provider {
        "addon" => {
            let entry = ADDON_PROXY_ENTRIES
                .lock()
                .map_err(|error| error.to_string())?
                .get(session_id)
                .cloned()
                .ok_or_else(|| {
                    "Smart Next Addon warmup session is no longer available".to_string()
                })?;
            Ok((
                provider.to_string(),
                session_id.to_string(),
                entry.range_cache,
                entry.total_size,
            ))
        }
        _ => Err("Smart Next warmup URL is not a supported prepared proxy".to_string()),
    }
}

#[tauri::command]
async fn warm_smart_next_stream(stream_url: String) -> Result<SmartNextWarmupResult, String> {
    let (provider, session_id, range_cache, total_bytes) = smart_next_proxy_cache(&stream_url)?;
    if total_bytes == 0 {
        return Err("Smart Next warmup cannot determine the episode size".to_string());
    }

    let requested_bytes = smart_next_warmup_target_bytes(total_bytes);
    range_cache.set_producer_limit(requested_bytes);
    let (_, pinned_bytes) = range_cache.pin_opening(requested_bytes);
    let generation = SMART_NEXT_WARMUP_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    info!(
        "[Smart Next Autoload] warmup started provider={} session={} requested_bytes={} pinned_opening_bytes={} total_bytes={}",
        provider, session_id, requested_bytes, pinned_bytes, total_bytes
    );

    let request_url = stream_url.clone();
    let provider_for_task = provider.clone();
    let session_for_task = session_id.clone();
    let cached_bytes = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30 * 60))
            .build()
            .map_err(|error| format!("Could not create Smart Next warmup client: {error}"))?;
        let mut response = client
            .get(request_url)
            .header(reqwest::header::RANGE, format!("bytes=0-{}", requested_bytes - 1))
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .map_err(|error| format!("Smart Next warmup request failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Smart Next warmup proxy returned HTTP {}",
                response.status()
            ));
        }

        let mut buffer = vec![0u8; SINGLE_FILE_CACHE_WRITE_BYTES];
        let mut received = 0u64;
        let mut last_logged_bucket = 0u64;
        while received < requested_bytes {
            if SMART_NEXT_WARMUP_GENERATION.load(Ordering::SeqCst) != generation {
                info!(
                    "[Smart Next Autoload] warmup cancelled provider={} session={} cached_bytes={} requested_bytes={}",
                    provider_for_task, session_for_task, received, requested_bytes
                );
                return Err("Smart Next warmup was cancelled".to_string());
            }
            let remaining = requested_bytes.saturating_sub(received) as usize;
            let chunk_len = buffer.len().min(remaining);
            let read = response
                .read(&mut buffer[..chunk_len])
                .map_err(|error| format!("Smart Next warmup stream failed: {error}"))?;
            if read == 0 {
                break;
            }
            received = received.saturating_add(read as u64);
            let bucket = received.saturating_mul(10).checked_div(requested_bytes).unwrap_or(0);
            if bucket > last_logged_bucket && bucket < 10 {
                last_logged_bucket = bucket;
                info!(
                    "[Smart Next Autoload] warmup progress provider={} session={} cached_bytes={} requested_bytes={} percent={}",
                    provider_for_task,
                    session_for_task,
                    received,
                    requested_bytes,
                    bucket * 10
                );
            }
        }
        Ok(received)
    })
    .await
    .map_err(|error| format!("Smart Next warmup task failed: {error}"))??;

    if cached_bytes < requested_bytes {
        return Err(format!(
            "Smart Next warmup ended early after {cached_bytes} of {requested_bytes} bytes"
        ));
    }
    info!(
        "[Smart Next Autoload] warmup cap reached provider={} session={} cached_bytes={} requested_bytes={} total_bytes={}",
        provider, session_id, cached_bytes, requested_bytes, total_bytes
    );
    Ok(SmartNextWarmupResult {
        provider,
        requested_bytes,
        cached_bytes,
        total_bytes,
    })
}

#[tauri::command]
fn cancel_smart_next_warmup() {
    let generation = SMART_NEXT_WARMUP_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    info!("[Smart Next Autoload] cancellation requested generation={generation}");
}

#[tauri::command]
fn activate_smart_next_stream(stream_url: String) -> Result<(), String> {
    let (provider, session_id, range_cache, total_bytes) = smart_next_proxy_cache(&stream_url)?;
    range_cache.clear_producer_limit();
    info!(
        "[Smart Next Autoload] producer ceiling cleared for playback provider={} session={} total_bytes={}",
        provider, session_id, total_bytes
    );
    Ok(())
}

#[tauri::command]
fn release_addon_stream(session_id: String) -> Result<(), String> {
    let entry = ADDON_PROXY_ENTRIES
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&session_id);
    if let Some(entry) = entry {
        entry.active.store(false, Ordering::SeqCst);
        if let Ok(mut source_url) = entry.source_url.lock() {
            source_url.take();
        }
        if let Ok(mut resolved_source_url) = entry.resolved_source_url.lock() {
            resolved_source_url.take();
        }
        cleanup_addon_entry_cache(&entry);
    }
    Ok(())
}

fn parse_episode_number_with_context(
    filename: &str,
    preferred_season: Option<u32>,
) -> Option<(u32, u32)> {
    if let Some(parsed) = parse_episode_number(filename) {
        return Some(parsed);
    }

    let normalized = filename.replace('\\', "/").to_ascii_lowercase();
    let file_name = normalized.rsplit('/').next().unwrap_or(&normalized);
    let season = extract_season_from_path(&normalized)
        .or(preferred_season)
        .unwrap_or(1);
    let episode = extract_episode_from_name(file_name)?;
    Some((season, episode))
}

fn parse_episode_number(filename: &str) -> Option<(u32, u32)> {
    let lower = filename.to_ascii_lowercase();
    let bytes = lower.as_bytes();

    let parse_digits = |slice: &[u8]| -> Option<u32> {
        if slice.is_empty() || !slice.iter().all(|b| b.is_ascii_digit()) {
            return None;
        }
        std::str::from_utf8(slice).ok()?.parse::<u32>().ok()
    };

    for i in 0..bytes.len() {
        if bytes[i] == b's' {
            let mut season_end = i + 1;
            while season_end < bytes.len() && bytes[season_end].is_ascii_digit() {
                season_end += 1;
            }

            if season_end == i + 1 || season_end >= bytes.len() || bytes[season_end] != b'e' {
                continue;
            }

            let mut episode_end = season_end + 1;
            while episode_end < bytes.len() && bytes[episode_end].is_ascii_digit() {
                episode_end += 1;
            }

            if let (Some(season), Some(episode)) = (
                parse_digits(&bytes[i + 1..season_end]),
                parse_digits(&bytes[season_end + 1..episode_end]),
            ) {
                return Some((season, episode));
            }
        }

        if bytes[i].is_ascii_digit() {
            let mut season_end = i;
            while season_end < bytes.len() && bytes[season_end].is_ascii_digit() {
                season_end += 1;
            }

            if season_end >= bytes.len() || bytes[season_end] != b'x' {
                continue;
            }

            let mut episode_end = season_end + 1;
            while episode_end < bytes.len() && bytes[episode_end].is_ascii_digit() {
                episode_end += 1;
            }

            if let (Some(season), Some(episode)) = (
                parse_digits(&bytes[i..season_end]),
                parse_digits(&bytes[season_end + 1..episode_end]),
            ) {
                return Some((season, episode));
            }
        }
    }

    None
}

fn extract_season_from_path(path: &str) -> Option<u32> {
    for part in path.split('/') {
        if let Some(value) = extract_number_after_token(part, "season") {
            return Some(value);
        }
        if let Some(value) = extract_number_after_token(part, "s") {
            return Some(value);
        }
    }

    None
}

fn extract_episode_from_name(file_name: &str) -> Option<u32> {
    if let Some(value) = extract_number_after_token(file_name, "episode") {
        return Some(value);
    }
    if let Some(value) = extract_number_after_token(file_name, "ep") {
        return Some(value);
    }
    if let Some(value) = extract_number_after_token(file_name, "e") {
        return Some(value);
    }

    let stem = file_name
        .rsplit_once('.')
        .map(|(name, _)| name)
        .unwrap_or(file_name);

    if !stem.is_empty() && stem.chars().all(|c| c.is_ascii_digit()) {
        return stem.parse::<u32>().ok();
    }

    None
}

fn extract_number_after_token(input: &str, token: &str) -> Option<u32> {
    let bytes = input.as_bytes();
    let token_bytes = token.as_bytes();
    let mut i = 0;

    while i + token_bytes.len() <= bytes.len() {
        if &bytes[i..i + token_bytes.len()] != token_bytes {
            i += 1;
            continue;
        }

        let prev_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        if !prev_ok {
            i += 1;
            continue;
        }

        let mut j = i + token_bytes.len();
        while j < bytes.len() && matches!(bytes[j], b' ' | b'.' | b'_' | b'-') {
            j += 1;
        }

        let start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }

        let next_ok = j == bytes.len() || !bytes[j].is_ascii_alphanumeric();
        if start < j && next_ok {
            if let Ok(value) = input[start..j].parse::<u32>() {
                return Some(value);
            }
        }

        i += 1;
    }

    None
}

fn qbittorrent_ready_threshold(size: u64) -> u64 {
    const MIB: u64 = 1024 * 1024;
    const SMALL_FILE_LIMIT: u64 = 512 * MIB;
    const SMALL_FILE_READY_BYTES: u64 = 32 * MIB;
    const MIN_READY_BYTES: u64 = 64 * MIB;
    const MAX_READY_BYTES: u64 = 192 * MIB;

    if size == 0 {
        return 1;
    }

    if size <= SMALL_FILE_LIMIT {
        return size.min(SMALL_FILE_READY_BYTES);
    }

    let one_percent = size / 100;
    size.min(one_percent.clamp(MIN_READY_BYTES, MAX_READY_BYTES))
}

fn qbittorrent_piece_range_ready(file: &QbittorrentFileInfo, piece_states: &[u8]) -> bool {
    let Some([first_piece, last_piece]) = file.piece_range else {
        return true;
    };

    if first_piece >= piece_states.len()
        || last_piece >= piece_states.len()
        || first_piece > last_piece
    {
        return false;
    }

    piece_states[first_piece] == 2 && piece_states[last_piece] == 2
}

fn spawn_magnet_open(magnet_uri: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("cmd");
        hide_console_std(&mut command);
        command
            .args(["/C", "start", "", magnet_uri])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn prepare_and_open_qbittorrent_stream(
    app: tauri::AppHandle,
    magnet_uri: String,
    info_hash: Option<String>,
    display_title: Option<String>,
    preferred_season: Option<u32>,
    preferred_episode: Option<u32>,
    preferred_source_filename: Option<String>,
    position_x: Option<i32>,
    position_y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    start_position: Option<f64>,
    upscaler: Option<String>,
    seek_preview_enabled: Option<bool>,
    force_stereo_enabled: Option<bool>,
    rtx_hdr_enabled: Option<bool>,
    hdr_contrast_boost_enabled: Option<bool>,
    cache_whole_file_enabled: Option<bool>,
    preferred_subtitle_language: Option<String>,
    preferred_audio_language: Option<String>,
    prefer_sdh_subtitles: Option<bool>,
) -> Result<StreamLaunchResult, String> {
    let prepared = prepare_qbittorrent_stream_source(
        &magnet_uri,
        info_hash.as_deref(),
        preferred_season,
        preferred_episode,
        preferred_source_filename.as_deref(),
        None,
    )
    .await?;
    spawn_qbittorrent_transfer_monitor(
        app.clone(),
        prepared.torrent_hash.clone(),
        prepared.downloaded_bytes,
    );

    #[cfg(target_os = "windows")]
    {
        let cache_whole_file_enabled = cache_whole_file_enabled.unwrap_or(false);
        maybe_auto_enable_hdr_before_mpv(&app, Some(&prepared.file_name))?;
        let canonical_display_title = if prepared.file_name.trim().is_empty() {
            display_title.clone()
        } else {
            Some(prepared.file_name.clone())
        };
        let pid = launch_stream_with_mpv(
            &app,
            prepared.file_url.clone(),
            canonical_display_title,
            position_x,
            position_y,
            width,
            height,
            start_position,
            upscaler,
            seek_preview_enabled.unwrap_or(false),
            force_stereo_enabled.unwrap_or(true),
            rtx_hdr_enabled.unwrap_or(false),
            hdr_contrast_boost_enabled.unwrap_or(false),
            cache_whole_file_enabled,
            preferred_subtitle_language,
            preferred_audio_language,
            prefer_sdh_subtitles.unwrap_or(false),
        )
        .await?;

        return Ok(StreamLaunchResult {
            session_id: 0,
            pid,
            file_url: prepared.file_url,
            ready_bytes: prepared.ready_bytes,
            total_bytes: prepared.total_bytes,
            playlist_file_urls: prepared.playlist_file_urls,
            playlist_files: prepared.playlist_files,
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (
            app,
            display_title,
            position_x,
            position_y,
            width,
            height,
            start_position,
            upscaler,
            seek_preview_enabled,
            force_stereo_enabled,
            rtx_hdr_enabled,
            hdr_contrast_boost_enabled,
            cache_whole_file_enabled,
            preferred_subtitle_language,
            preferred_audio_language,
            prefer_sdh_subtitles,
        );
        Err("prepare_and_open_qbittorrent_stream is only implemented on Windows".to_string())
    }
}

#[tauri::command]
async fn prepare_qbittorrent_stream(
    app: tauri::AppHandle,
    magnet_uri: String,
    info_hash: Option<String>,
    preferred_season: Option<u32>,
    preferred_episode: Option<u32>,
    preferred_source_filename: Option<String>,
) -> Result<PreparedQbittorrentStreamResult, String> {
    let prepared = prepare_qbittorrent_stream_source(
        &magnet_uri,
        info_hash.as_deref(),
        preferred_season,
        preferred_episode,
        preferred_source_filename.as_deref(),
        None,
    )
    .await?;
    spawn_qbittorrent_transfer_monitor(
        app,
        prepared.torrent_hash.clone(),
        prepared.downloaded_bytes,
    );
    Ok(prepared)
}

#[tauri::command]
async fn prepare_smart_next_qbittorrent(
    app: tauri::AppHandle,
    magnet_uri: String,
    info_hash: Option<String>,
    preferred_season: Option<u32>,
    preferred_episode: Option<u32>,
    preferred_source_filename: Option<String>,
) -> Result<PreparedQbittorrentStreamResult, String> {
    let warmup_generation = SMART_NEXT_WARMUP_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let resolved_hash = resolve_info_hash(&magnet_uri, info_hash.as_deref()).await?;
    let result = prepare_qbittorrent_stream_source(
        &magnet_uri,
        Some(&resolved_hash),
        preferred_season,
        preferred_episode,
        preferred_source_filename.as_deref(),
        Some(warmup_generation),
    )
    .await;
    let prepared = match result {
        Ok(prepared) => prepared,
        Err(error) => {
            if let Ok(client) = qbittorrent_client().await {
                let base_url = get_qbittorrent_webui_base_url();
                let _ =
                    set_qbittorrent_torrent_paused(&client, &base_url, &resolved_hash, true).await;
            }
            warn!(
                "[Smart Next Autoload] qBittorrent warmup failed hash={} error={}",
                smart_next_hash_label(&resolved_hash),
                error
            );
            return Err(error);
        }
    };
    spawn_qbittorrent_transfer_monitor(
        app,
        prepared.torrent_hash.clone(),
        prepared.downloaded_bytes,
    );
    Ok(prepared)
}

fn smart_next_hash_label(info_hash: &str) -> String {
    info_hash.chars().take(8).collect()
}

#[tauri::command]
async fn resume_smart_next_qbittorrent(torrent_hash: String) -> Result<(), String> {
    let client = qbittorrent_client().await?;
    let base_url = get_qbittorrent_webui_base_url();
    let files = get_qbittorrent_files(&client, &base_url, &torrent_hash).await?;
    restore_qbittorrent_playback_downloads(&client, &base_url, &torrent_hash, &files).await?;
    info!(
        "[Smart Next Autoload] qBittorrent warmup resumed for playback hash={}",
        smart_next_hash_label(&torrent_hash)
    );
    Ok(())
}

#[tauri::command]
async fn pause_smart_next_qbittorrent(torrent_hash: String) -> Result<(), String> {
    let client = qbittorrent_client().await?;
    let base_url = get_qbittorrent_webui_base_url();
    set_qbittorrent_torrent_paused(&client, &base_url, &torrent_hash, true).await?;
    info!(
        "[Smart Next Autoload] qBittorrent warmup paused during cleanup hash={}",
        smart_next_hash_label(&torrent_hash)
    );
    Ok(())
}

#[tauri::command]
async fn load_prepared_mpv_stream(
    pid: u32,
    file_url: String,
    start_position: Option<f64>,
    ready_bytes: u64,
    total_bytes: u64,
    playlist_file_urls: Vec<String>,
    playlist_files: Option<Vec<StreamPlaylistItem>>,
    display_title: Option<String>,
) -> Result<StreamLaunchResult, String> {
    load_file_replace_with_title(&file_url, display_title.as_deref(), start_position)?;

    Ok(StreamLaunchResult {
        session_id: 0,
        pid,
        file_url,
        ready_bytes,
        total_bytes,
        playlist_file_urls,
        playlist_files: playlist_files.unwrap_or_default(),
    })
}

async fn prepare_qbittorrent_stream_source(
    magnet_uri: &str,
    info_hash: Option<&str>,
    preferred_season: Option<u32>,
    preferred_episode: Option<u32>,
    preferred_source_filename: Option<&str>,
    smart_next_warmup_generation: Option<u64>,
) -> Result<PreparedQbittorrentStreamResult, String> {
    let smart_next_warmup = smart_next_warmup_generation.is_some();
    let resolved_hash = resolve_info_hash(magnet_uri, info_hash).await?;
    let base_url = get_qbittorrent_webui_base_url();
    let client = qbittorrent_client().await?;
    let torrent =
        ensure_qbittorrent_torrent(&client, &base_url, magnet_uri, &resolved_hash).await?;

    let metadata_wait_started = std::time::Instant::now();
    let (target_file, torrent_files_snapshot) = loop {
        if smart_next_warmup_generation.is_some_and(|generation| {
            SMART_NEXT_WARMUP_GENERATION.load(Ordering::SeqCst) != generation
        }) {
            return Err("Smart Next qBittorrent warmup was cancelled".to_string());
        }
        if metadata_wait_started.elapsed() > std::time::Duration::from_secs(600) {
            return Err(format!(
                "Timed out waiting for qBittorrent metadata for {}",
                torrent.name
            ));
        }

        match get_qbittorrent_files(&client, &base_url, &torrent.hash).await {
            Ok(files) => {
                if let Some(file) = pick_qbittorrent_video_file(
                    &files,
                    preferred_season,
                    preferred_episode,
                    preferred_source_filename,
                ) {
                    break (file, files);
                }
            }
            Err(err) => {
                warn!(
                    "Waiting for qBittorrent file metadata for {}: {}",
                    torrent.name, err
                );
            }
        }

        tokio::time::sleep(if smart_next_warmup {
            std::time::Duration::from_millis(250)
        } else {
            std::time::Duration::from_secs(2)
        })
        .await;
    };
    let file_path = PathBuf::from(&torrent.save_path).join(&target_file.name);
    if smart_next_warmup {
        let skipped_ids = torrent_files_snapshot
            .iter()
            .filter(|file| file.index != target_file.index)
            .map(|file| file.index.to_string())
            .collect::<Vec<_>>()
            .join("|");
        set_qbittorrent_file_priority(&client, &base_url, &torrent.hash, &skipped_ids, 0).await?;
        set_qbittorrent_file_priority(
            &client,
            &base_url,
            &torrent.hash,
            &target_file.index.to_string(),
            7,
        )
        .await?;
        set_qbittorrent_torrent_paused(&client, &base_url, &torrent.hash, false).await?;
        info!(
            "[Smart Next Autoload] qBittorrent warmup started hash={} file={} requested_bytes={} total_bytes={}",
            smart_next_hash_label(&torrent.hash),
            media_file_base_name(&target_file.name),
            smart_next_warmup_target_bytes(target_file.size),
            target_file.size
        );
    } else {
        restore_qbittorrent_playback_downloads(
            &client,
            &base_url,
            &torrent.hash,
            &torrent_files_snapshot,
        )
        .await?;
    }

    // Build playlist: all video files sorted by parsed episode when possible, starting after the target file
    let mut all_video_files: Vec<&QbittorrentFileInfo> = torrent_files_snapshot
        .iter()
        .filter(|f| is_video_file(&f.name))
        .collect();
    all_video_files.sort_by(|a, b| compare_qbittorrent_episode_files(a, b, preferred_season));
    let playlist_files: Vec<StreamPlaylistItem> = all_video_files
        .iter()
        .skip_while(|f| f.name != target_file.name)
        .skip(1)
        .map(|f| {
            let url = PathBuf::from(&torrent.save_path)
                .join(&f.name)
                .to_string_lossy()
                .to_string();
            stream_playlist_item(url, f.name.clone(), f.size, preferred_season)
        })
        .collect();
    let playlist_file_urls = playlist_files.iter().map(|file| file.url.clone()).collect();

    let wait_started = std::time::Instant::now();
    let mut piece_state_warning_logged = false;
    let mut smart_next_last_logged_bucket = 0u64;
    let ready_bytes = loop {
        if smart_next_warmup_generation.is_some_and(|generation| {
            SMART_NEXT_WARMUP_GENERATION.load(Ordering::SeqCst) != generation
        }) {
            return Err("Smart Next qBittorrent warmup was cancelled".to_string());
        }
        if wait_started.elapsed() > std::time::Duration::from_secs(1800) {
            return Err(format!(
                "Timed out waiting for qBittorrent to download enough media for {}",
                target_file.name
            ));
        }

        let latest_files = get_qbittorrent_files(&client, &base_url, &torrent.hash).await?;
        let Some(latest_file) = latest_files
            .into_iter()
            .find(|file| file.name == target_file.name)
        else {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        };

        let estimated_ready_bytes =
            ((latest_file.progress * latest_file.size as f64).round() as u64).min(latest_file.size);
        let ready_threshold = if smart_next_warmup {
            smart_next_warmup_target_bytes(latest_file.size)
        } else {
            qbittorrent_ready_threshold(latest_file.size)
        };
        let progress_ready =
            latest_file.progress >= 1.0 || estimated_ready_bytes >= ready_threshold;
        if smart_next_warmup {
            let bucket = estimated_ready_bytes
                .saturating_mul(10)
                .checked_div(ready_threshold)
                .unwrap_or(0);
            if bucket > smart_next_last_logged_bucket && bucket < 10 {
                smart_next_last_logged_bucket = bucket;
                info!(
                    "[Smart Next Autoload] qBittorrent warmup progress hash={} file={} cached_bytes={} requested_bytes={} percent={}",
                    smart_next_hash_label(&torrent.hash),
                    media_file_base_name(&latest_file.name),
                    estimated_ready_bytes,
                    ready_threshold,
                    bucket * 10
                );
            }
        }

        let piece_range_ready = match get_qbittorrent_piece_states(
            &client,
            &base_url,
            &torrent.hash,
        )
        .await
        {
            Ok(piece_states) => qbittorrent_piece_range_ready(&latest_file, &piece_states),
            Err(err) => {
                if !piece_state_warning_logged {
                    warn!(
                            "qBittorrent piece states unavailable for {}; falling back to byte threshold: {}",
                            target_file.name, err
                        );
                    piece_state_warning_logged = true;
                }
                true
            }
        };

        if progress_ready && piece_range_ready {
            let ready = estimated_ready_bytes.max(1);
            if smart_next_warmup {
                set_qbittorrent_torrent_paused(&client, &base_url, &torrent.hash, true).await?;
                info!(
                    "[Smart Next Autoload] qBittorrent warmup cap reached hash={} file={} cached_bytes={} requested_bytes={} total_bytes={}",
                    smart_next_hash_label(&torrent.hash),
                    media_file_base_name(&latest_file.name),
                    ready,
                    ready_threshold,
                    latest_file.size
                );
            }
            info!(
                "[qBit ready] {} has {} / {} bytes ready; threshold={}, piece_range_ready={}",
                target_file.name, ready, latest_file.size, ready_threshold, piece_range_ready
            );
            break ready;
        }

        tokio::time::sleep(if smart_next_warmup {
            std::time::Duration::from_millis(250)
        } else {
            std::time::Duration::from_secs(2)
        })
        .await;
    };

    Ok(PreparedQbittorrentStreamResult {
        file_url: file_path.to_string_lossy().to_string(),
        file_name: media_file_base_name(&target_file.name),
        ready_bytes,
        total_bytes: target_file.size,
        playlist_file_urls,
        playlist_files,
        torrent_hash: torrent.hash,
        downloaded_bytes: torrent.downloaded,
    })
}

#[tauri::command]
async fn prepare_and_open_local_stream(
    app: tauri::AppHandle,
    file_path: String,
    playlist_file_urls: Vec<String>,
    display_title: Option<String>,
    position_x: Option<i32>,
    position_y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    start_position: Option<f64>,
    upscaler: Option<String>,
    seek_preview_enabled: Option<bool>,
    force_stereo_enabled: Option<bool>,
    rtx_hdr_enabled: Option<bool>,
    hdr_contrast_boost_enabled: Option<bool>,
    cache_whole_file_enabled: Option<bool>,
    preferred_subtitle_language: Option<String>,
    preferred_audio_language: Option<String>,
    prefer_sdh_subtitles: Option<bool>,
) -> Result<StreamLaunchResult, String> {
    let path = PathBuf::from(&file_path);
    if !path.is_file() {
        return Err(format!("Local video file not found: {}", path.display()));
    }

    let metadata =
        fs::metadata(&path).map_err(|err| format!("Failed to read {}: {}", path.display(), err))?;
    let file_url = path.to_string_lossy().to_string();
    let playlist_files = playlist_file_urls
        .iter()
        .map(|url| {
            let path = PathBuf::from(url);
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(url)
                .to_string();
            let size = fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            stream_playlist_item(url.clone(), name, size, None)
        })
        .collect();

    #[cfg(target_os = "windows")]
    {
        let cache_whole_file_enabled = cache_whole_file_enabled.unwrap_or(false);
        let pid = launch_stream_with_mpv(
            &app,
            file_url.clone(),
            display_title,
            position_x,
            position_y,
            width,
            height,
            start_position,
            upscaler,
            seek_preview_enabled.unwrap_or(false),
            force_stereo_enabled.unwrap_or(true),
            rtx_hdr_enabled.unwrap_or(false),
            hdr_contrast_boost_enabled.unwrap_or(false),
            cache_whole_file_enabled,
            preferred_subtitle_language,
            preferred_audio_language,
            prefer_sdh_subtitles.unwrap_or(false),
        )
        .await?;

        return Ok(StreamLaunchResult {
            session_id: 0,
            pid,
            file_url,
            ready_bytes: metadata.len(),
            total_bytes: metadata.len(),
            playlist_file_urls,
            playlist_files,
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (
            app,
            display_title,
            position_x,
            position_y,
            width,
            height,
            start_position,
            upscaler,
            seek_preview_enabled,
            force_stereo_enabled,
            rtx_hdr_enabled,
            hdr_contrast_boost_enabled,
            cache_whole_file_enabled,
            preferred_subtitle_language,
            preferred_audio_language,
            prefer_sdh_subtitles,
            playlist_file_urls,
            playlist_files,
        );
        Err("prepare_and_open_local_stream is only implemented on Windows".to_string())
    }
}

#[tauri::command]
async fn send_to_qbittorrent(source_uri: String, info_hash: Option<String>) -> Result<(), String> {
    let resolved_hash = resolve_info_hash(&source_uri, info_hash.as_deref()).await?;
    let base_url = get_qbittorrent_webui_base_url();
    let client = qbittorrent_client().await?;

    ensure_qbittorrent_torrent(&client, &base_url, &source_uri, &resolved_hash).await?;
    Ok(())
}

#[tauri::command]
async fn set_player_media_title(title: String) -> Result<(), String> {
    set_mpv_media_title(&title)
}

#[tauri::command]
async fn set_discord_presence_enabled(enabled: bool) -> Result<(), String> {
    discord_presence::set_enabled(enabled)
}

#[tauri::command]
async fn update_discord_presence(
    payload: discord_presence::DiscordPresencePayload,
) -> Result<(), String> {
    discord_presence::update(payload)
}

#[tauri::command]
async fn clear_discord_presence() -> Result<(), String> {
    discord_presence::clear()
}

#[tauri::command]
async fn get_file_path(filename: String) -> Result<String, String> {
    let state = torrent::get_file_path_from_state(&filename).await?;
    match state {
        Some((known_name, path)) => {
            let resolved = if known_name == filename {
                path.clone()
            } else if path.is_dir() {
                path.join(&filename)
            } else {
                path.clone()
            };
            if resolved.exists() {
                Ok(resolved.to_string_lossy().to_string())
            } else {
                Err("File not found on disk (torrent may be in-memory)".to_string())
            }
        }
        None => Err("No active torrent".to_string()),
    }
}

#[tauri::command]
async fn get_whisper_stream_url(file_index: usize) -> Result<String, String> {
    torrent::get_whisper_stream_url(file_index).await
}

#[tauri::command]
async fn stop_torrent() -> Result<(), String> {
    info!("DEBUG: stop_torrent called");
    torrent::stop_download().await
}

#[tauri::command]
async fn pause_torrent() -> Result<(), String> {
    info!("Pausing torrent");
    torrent::pause_download().await
}

#[tauri::command]
async fn resume_torrent() -> Result<(), String> {
    info!("Resuming torrent");
    torrent::resume_download().await
}

#[tauri::command]
async fn stop_player() -> Result<(), String> {
    info!("Stopping player");
    mpv_ipc::stop_player_session()
}

#[tauri::command]
async fn stop_mpv_process(pid: u32) -> Result<(), String> {
    info!("Stopping MPV process by pid: {}", pid);

    #[cfg(target_os = "windows")]
    {
        let pid_arg = pid.to_string();
        let mut command = std::process::Command::new("taskkill");
        hide_console_std(&mut command);
        let status = command
            .args(["/PID", pid_arg.as_str(), "/T", "/F"])
            .status()
            .map_err(|err| format!("Failed to stop MPV process {}: {}", pid, err))?;

        if status.success() {
            mpv_ipc::wait_for_player_pipe_release(pid, std::time::Duration::from_secs(8)).await?;
            info!(
                "MPV process {} and its IPC watcher session have stopped",
                pid
            );
            Ok(())
        } else {
            Err(format!("taskkill failed for MPV process {}", pid))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let pid_arg = pid.to_string();
        let status = std::process::Command::new("kill")
            .args(["-TERM", pid_arg.as_str()])
            .status()
            .map_err(|err| format!("Failed to stop MPV process {}: {}", pid, err))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("kill failed for MPV process {}", pid))
        }
    }
}

#[tauri::command]
async fn seek_player_time(position: f64, expected_filename: String) -> Result<(), String> {
    info!(
        "Seeking to absolute time: {}, expected_filename={:?}",
        position, expected_filename
    );
    seek_absolute_time(position, &expected_filename)
}

#[tauri::command]
async fn set_player_detected_segments(
    segments: Vec<PlayerDetectedSegment>,
    expected_filename: String,
) -> Result<(), String> {
    set_detected_segments(segments, &expected_filename)
}

#[tauri::command]
async fn get_player_tracks() -> Result<Vec<Track>, String> {
    fetch_player_tracks()
}

#[tauri::command]
async fn set_player_track(track_type: String, track_id: i32) -> Result<(), String> {
    info!("Setting {} track to {}", track_type, track_id);
    set_mpv_player_track(&track_type, track_id)
}

#[tauri::command]
async fn load_subtitle(path: String) -> Result<(), String> {
    info!("Loading subtitle file: {}", path);
    load_subtitle_file(&path)
}

#[tauri::command]
async fn transcribe_with_whisperlive(
    app: tauri::AppHandle,
    wl_state: tauri::State<'_, SharedWhisperLiveState>,
    source_url: String,
    title: Option<String>,
    language: Option<String>,
    session_id: u64,
    start_seconds: Option<f64>,
) -> Result<(), String> {
    whisperlive::run_client(
        app,
        wl_state.inner().clone(),
        source_url,
        title,
        language,
        session_id,
        start_seconds,
    )
    .await
}

fn streamee_log_dir() -> PathBuf {
    std::env::temp_dir().join("streamee_logs")
}

#[tauri::command]
async fn install_whisperlive(pip_index_url: Option<String>) -> Result<String, String> {
    whisperlive::install_whisperlive(pip_index_url).await
}

#[tauri::command]
async fn test_whisperlive_runtime(
    app: tauri::AppHandle,
    deep: Option<bool>,
) -> Result<whisperlive::WhisperLiveRuntimeInfo, String> {
    whisperlive::test_whisperlive_runtime(app, deep.unwrap_or(false)).await
}

#[tauri::command]
async fn get_rife_runtime_info(
    model: Option<String>,
) -> Result<rife_runtime::RifeRuntimeInfo, String> {
    rife_runtime::runtime_info(model.as_deref().unwrap_or("4.6"))
}

#[tauri::command]
async fn install_rife_runtime(
    app: AppHandle,
    model: Option<String>,
) -> Result<rife_runtime::RifeRuntimeInfo, String> {
    rife_runtime::install(app, model.unwrap_or_else(|| "4.6".to_string())).await
}

#[tauri::command]
async fn stop_whisperlive_server(
    wl_state: tauri::State<'_, SharedWhisperLiveState>,
) -> Result<(), String> {
    whisperlive::stop_server(wl_state.inner()).await;
    Ok(())
}

#[tauri::command]
async fn stop_whisperlive_client(
    wl_state: tauri::State<'_, SharedWhisperLiveState>,
) -> Result<(), String> {
    whisperlive::stop_client(wl_state.inner()).await;
    Ok(())
}

#[tauri::command]
async fn stop_audio_normalizer_runtime(app_handle: AppHandle) -> Result<(), String> {
    stop_audio_normalizer_and_emit(&app_handle)
}

pub(crate) fn find_mpv(app: &AppHandle) -> Option<String> {
    // Prefer the bundled resource path when running from an installed app.
    if let Ok(mpv_path) = app.path().resolve("mpv/mpv.exe", BaseDirectory::Resource) {
        if mpv_path.exists() {
            info!("Found bundled MPV resource at: {}", mpv_path.display());
            return Some(mpv_path.to_string_lossy().to_string());
        }
    }

    // 1. Check bundled location (Streamee root/mpv/)
    // For dev: src-tauri/target/debug/streamee.exe -> need 3 levels up
    // For prod: Streamee/streamee.exe -> need 1 level up
    let exe_path = std::env::current_exe().ok()?;
    let exe_dir = exe_path.parent()?;

    // Try multiple levels of parent folders
    let mut current = exe_dir.to_path_buf();
    for _ in 0..4 {
        let mpv_path = current.join("mpv").join("mpv.exe");
        if mpv_path.exists() {
            info!("Found bundled MPV at: {}", mpv_path.display());
            return Some(mpv_path.to_string_lossy().to_string());
        }
        if !current.pop() {
            break; // reached root
        }
    }

    // 2. Check SVP bundled MPV
    let possible_paths = vec![
        "C:\\Program Files (x86)\\SVP 4\\mpv64\\mpv.exe",
        "C:\\Program Files\\SVP 4\\mpv64\\mpv.exe",
        "C:\\Program Files\\MPV\\mpv.exe",
        "C:\\Program Files (x86)\\MPV\\mpv.exe",
        "C:\\mpv\\mpv.exe",
        "C:\\Portable\\mpv\\mpv.exe",
        "C:\\Tools\\mpv\\mpv.exe",
    ];

    for path in possible_paths {
        if std::path::Path::new(path).exists() {
            info!("Found MPV at: {}", path);
            return Some(path.to_string());
        }
    }

    let mut command = std::process::Command::new("where");
    hide_console_std(&mut command);
    if let Ok(output) = command.arg("mpv").output() {
        if output.status.success() {
            if let Ok(path) = String::from_utf8(output.stdout) {
                let first_line = path.lines().next()?;
                info!("Found MPV via PATH: {}", first_line);
                return Some(first_line.trim().to_string());
            }
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn normalize_path_for_mpv_script_opt(path: &str) -> String {
    let trimmed = path
        .strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix("//?/"))
        .unwrap_or(path);
    trimmed.replace('\\', "/")
}

#[tauri::command]
async fn fetch_kinocheck_trailer(
    media_type: String,
    tmdb_id: u64,
) -> Result<Option<KinoCheckTrailer>, String> {
    let endpoint = match media_type.as_str() {
        "movie" => "movies",
        "series" | "tv" => "shows",
        other => return Err(format!("Unsupported KinoCheck media type: {other}")),
    };

    let response = REMOTE_METADATA_HTTP_CLIENT
        .get(format!("https://api.kinocheck.com/{endpoint}"))
        .query(&[
            ("tmdb_id", tmdb_id.to_string()),
            ("language", "en".to_string()),
            ("categories", "Trailer".to_string()),
        ])
        .timeout(REMOTE_METADATA_TIMEOUT)
        .send()
        .await
        .map_err(|err| format!("Failed to fetch KinoCheck trailer: {err}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    if !response.status().is_success() {
        return Err(format!(
            "KinoCheck trailer request failed with HTTP {}",
            response.status()
        ));
    }

    let payload = response
        .json::<KinoCheckMovieResponse>()
        .await
        .map_err(|err| format!("Failed to parse KinoCheck trailer response: {err}"))?;

    Ok(payload.trailer)
}

#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    info!("Opening external: {}", url);

    let is_video = url.ends_with(".mp4")
        || url.ends_with(".mkv")
        || url.ends_with(".avi")
        || url.ends_with(".mov")
        || url.ends_with(".webm")
        || url.ends_with(".m4v");

    #[cfg(target_os = "windows")]
    {
        if is_video {
            if let Some(mpv_path) = find_mpv(&app) {
                info!("Found MPV at: {}, launching with: {}", mpv_path, url);
                let mut command = std::process::Command::new(&mpv_path);
                hide_console_std(&mut command);
                let child = command.arg(&url).spawn().map_err(|e| e.to_string())?;
                let pid = child.id();
                if let Err(err) = attach_mpv_to_main_window(&app, pid).await {
                    warn!("Failed to attach MPV window to app owner: {}", err);
                }
                return Ok(());
            }
        }

        let mut command = std::process::Command::new("cmd");
        hide_console_std(&mut command);
        command
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
async fn launch_stream_with_mpv(
    app: &AppHandle,
    url: String,
    display_title: Option<String>,
    position_x: Option<i32>,
    position_y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    start_position: Option<f64>,
    upscaler_setting: Option<String>,
    seek_preview_enabled: bool,
    force_stereo_enabled: bool,
    rtx_hdr_enabled: bool,
    hdr_contrast_boost_enabled: bool,
    cache_whole_file_enabled: bool,
    preferred_subtitle_language: Option<String>,
    preferred_audio_language: Option<String>,
    prefer_sdh_subtitles: bool,
) -> Result<u32, String> {
    let pid = launch_mpv_process(
        app,
        Some(url),
        start_position,
        display_title,
        position_x,
        position_y,
        width,
        height,
        upscaler_setting,
        seek_preview_enabled,
        force_stereo_enabled,
        rtx_hdr_enabled,
        hdr_contrast_boost_enabled,
        cache_whole_file_enabled,
        preferred_subtitle_language,
        preferred_audio_language,
        prefer_sdh_subtitles,
    )
    .await?;
    Ok(pid)
}

#[cfg(target_os = "windows")]
async fn launch_idle_mpv(
    app: &AppHandle,
    display_title: Option<String>,
    position_x: Option<i32>,
    position_y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    upscaler_setting: Option<String>,
    seek_preview_enabled: bool,
    force_stereo_enabled: bool,
    rtx_hdr_enabled: bool,
    hdr_contrast_boost_enabled: bool,
    cache_whole_file_enabled: bool,
    preferred_subtitle_language: Option<String>,
    preferred_audio_language: Option<String>,
    prefer_sdh_subtitles: bool,
) -> Result<u32, String> {
    launch_mpv_process(
        app,
        None,
        None,
        display_title,
        position_x,
        position_y,
        width,
        height,
        upscaler_setting,
        seek_preview_enabled,
        force_stereo_enabled,
        rtx_hdr_enabled,
        hdr_contrast_boost_enabled,
        cache_whole_file_enabled,
        preferred_subtitle_language,
        preferred_audio_language,
        prefer_sdh_subtitles,
    )
    .await
}

#[cfg(target_os = "windows")]
async fn launch_mpv_process(
    app: &AppHandle,
    initial_url: Option<String>,
    start_position: Option<f64>,
    display_title: Option<String>,
    position_x: Option<i32>,
    position_y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    upscaler_setting: Option<String>,
    seek_preview_enabled: bool,
    force_stereo_enabled: bool,
    rtx_hdr_enabled: bool,
    hdr_contrast_boost_enabled: bool,
    cache_whole_file_enabled: bool,
    preferred_subtitle_language: Option<String>,
    preferred_audio_language: Option<String>,
    prefer_sdh_subtitles: bool,
) -> Result<u32, String> {
    let mpv_path = find_mpv(app).ok_or_else(|| "MPV not found".to_string())?;
    match initial_url.as_ref() {
        Some(url) => info!(
            "Found MPV at: {}, launching stream: {}",
            mpv_path,
            redact_sensitive_url(url)
        ),
        None => info!("Found MPV at: {}, launching idle player shell", mpv_path),
    }
    let upscaler = VideoUpscaler::from_setting(upscaler_setting.as_deref());
    let sharpen_enabled = get_store_setting(app, "mpvSharpenEnabled").as_deref() != Some("false");
    let sharpen_mode = if sharpen_enabled {
        match get_store_setting(app, "mpvSharpenPreset")
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("standard") => "standard",
            Some("adaptive") => "adaptive",
            Some("ultra") => "ultra",
            Some("ultra-custom") | Some("ultracustom") => "ultra-custom",
            Some("auto") => "auto",
            _ => upscaler.sharpen_default(),
        }
    } else {
        "off"
    };
    let denoise_enabled = get_store_setting(app, "mpvDenoiseEnabled").as_deref() != Some("false");
    let denoise_mode = if denoise_enabled { "bilateral" } else { "off" };
    let denoise_strength = match get_store_setting(app, "mpvDenoiseStrength")
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("low") => "low",
        Some("high") => "high",
        _ => "medium",
    };
    let deband_enabled = get_store_setting(app, "mpvDebandEnabled").as_deref() != Some("false");
    let smart_ultrawide_fill_mode = match get_store_setting(app, "mpvSmartUltrawideFillMode")
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("efficient") => "efficient",
        Some("dynamic") => "dynamic",
        _ => "off",
    };
    let black_bar_lighting_enabled =
        get_store_setting(app, "mpvBlackBarLightingEnabled").as_deref() != Some("false");
    let vsr_before_svp = get_store_setting(app, "mpvVsrBeforeSvp").as_deref() != Some("false");
    let rife_requested = get_store_setting(app, "mpvRifeEnabled").as_deref() == Some("true");
    let rife_runtime_path = rife_runtime::managed_runtime_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let rife_model = match get_store_setting(app, "mpvRifeModel")
        .as_deref()
        .map(str::trim)
    {
        Some("4.6") => "4.6",
        Some("4.9") => "4.9",
        Some("4.16-lite") => "4.16-lite",
        Some("4.18") => "4.18",
        Some("4.25") => "4.25",
        _ => "4.6",
    };
    let rife_multiplier = if get_store_setting(app, "mpvRifeMultiplier").as_deref() == Some("3") {
        3
    } else {
        2
    };
    let rife_gpu_streams = if get_store_setting(app, "mpvRifeGpuStreams").as_deref() == Some("1") {
        1
    } else {
        2
    };
    let rife_processing_mode = match get_store_setting(app, "mpvRifeProcessingResolution")
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("native") => "native",
        Some("720") => "720",
        Some("1080") => "1080",
        _ => "auto",
    };
    let rife_scale = match get_store_setting(app, "mpvRifeScale").as_deref() {
        Some("0.2") => "0.2",
        Some("0.25") => "0.25",
        Some("0.4") => "0.4",
        Some("0.5") => "0.5",
        Some("1.0") => "1.0",
        _ => "auto",
    };
    let rife_before_upscaling_requested =
        get_store_setting(app, "mpvRifeBeforeUpscaling").as_deref() != Some("false");
    let rife_before_upscaling =
        upscaler != VideoUpscaler::RtxVsr || rife_before_upscaling_requested;
    let rife_filter_concurrency = if rife_model == "4.6" && rife_processing_mode == "auto" {
        12
    } else {
        4
    };
    info!("Selected video upscaler: {}", upscaler.label());
    info!(
        "MPV video processing defaults: sharpen={} ({}), denoise={} ({}), deband={}, smart_black_bar_fill={}, black_bar_lighting={}, vsr_before_svp={}",
        sharpen_enabled,
        sharpen_mode,
        denoise_enabled,
        denoise_strength,
        deband_enabled,
        smart_ultrawide_fill_mode,
        black_bar_lighting_enabled,
        vsr_before_svp
    );
    info!("RTX Video HDR for MPV: {}", rtx_hdr_enabled);
    maybe_auto_enable_hdr_before_mpv(app, display_title.as_deref())?;
    SKIP_AUTO_HDR_ON_NEXT_LAUNCH.store(false, Ordering::SeqCst);
    let windows_hdr_enabled = detect_windows_hdr_for_app_window(app);
    info!(
        "MPV HDR contrast boost: requested={}, windows_hdr_active={}, applied={}",
        hdr_contrast_boost_enabled,
        windows_hdr_enabled,
        rtx_hdr_enabled && hdr_contrast_boost_enabled && windows_hdr_enabled
    );
    info!("MPV full streamed file cache: {}", cache_whole_file_enabled);
    let subtitle_language = normalize_mpv_language(preferred_subtitle_language.as_deref());
    let audio_language = normalize_mpv_language(preferred_audio_language.as_deref());
    info!(
        "Selected media language preferences: subtitles={}, audio={}, prefer_sdh={}",
        subtitle_language, audio_language, prefer_sdh_subtitles
    );
    let mpv_dir = Path::new(&mpv_path)
        .parent()
        .ok_or_else(|| "Could not determine MPV directory".to_string())?
        .to_path_buf();
    let rife_script_path = mpv_dir.join("scripts").join("streamee_rife.py");
    let rife_runtime_dir = PathBuf::from(&rife_runtime_path);
    let rife_model_filename = format!("rife_v{}.onnx", rife_model.replace('-', "_"));
    let rife_required_paths = [
        rife_script_path.clone(),
        rife_runtime_dir.join("vstrt.dll"),
        rife_runtime_dir.join("vsmlrt.py"),
        rife_runtime_dir.join("vsmlrt-cuda").join("nvinfer_10.dll"),
        rife_runtime_dir
            .join("models")
            .join("rife")
            .join(&rife_model_filename),
    ];
    let missing_rife_path = rife_required_paths.iter().find(|path| !path.exists());
    let rife_enabled = rife_requested && missing_rife_path.is_none();
    if rife_requested {
        if let Some(path) = missing_rife_path {
            error!(
                "Streamee RIFE disabled for this MPV session because a runtime file is missing: {}",
                path.display()
            );
        } else {
            info!(
                "Streamee RIFE enabled: model={}, multiplier={}x, gpu_streams={}, processing_mode={}, scale={}, filter_concurrency={}, before_upscaling={}, runtime={}",
                rife_model,
                rife_multiplier,
                rife_gpu_streams,
                rife_processing_mode,
                rife_scale,
                rife_filter_concurrency,
                rife_before_upscaling,
                rife_runtime_dir.display()
            );
        }
    }

    let mut cmd_args = Vec::new();
    let is_remote_initial_stream = initial_url
        .as_deref()
        .map(|url| {
            let lower = url.to_ascii_lowercase();
            (lower.starts_with("http://") || lower.starts_with("https://"))
                && !lower.contains("127.0.0.1")
                && !lower.contains("localhost")
        })
        .unwrap_or(false);
    if initial_url.is_some() {
        if let Some(position) =
            start_position.filter(|position| position.is_finite() && *position > 0.0)
        {
            let atomic_start = position.clamp(0.0, 100.0);
            info!("Launching MPV with atomic resume start: {atomic_start}%");
            cmd_args.push(format!("--start={atomic_start}%"));
        }
    }
    if let Some(url) = initial_url {
        cmd_args.push(url);
    } else {
        cmd_args.push("--idle=yes".to_string());
        cmd_args.push("--force-window=yes".to_string());
    }

    cmd_args.extend([
        "--vo=gpu-next".to_string(),
        "--hwdec=d3d11va".to_string(),
        "--gpu-api=d3d11".to_string(),
        format!("--deband={}", if deband_enabled { "yes" } else { "no" }),
        "--no-resume-playback".to_string(),
        "--force-window-position".to_string(),
        "--border=no".to_string(),
        "--keepaspect-window=no".to_string(),
        format!("--input-ipc-server={}", crate::mpv_ipc::get_mpv_pipe_name()),
        "--hr-seek=no".to_string(),
        "--cache=yes".to_string(),
        "--cache-pause-initial=yes".to_string(),
        "--cache-pause-wait=2".to_string(),
        "--network-timeout=300".to_string(),
        "--prefetch-playlist=no".to_string(),
        "--sub-scale=1.2".to_string(),
        format!("--slang={subtitle_language}"),
        format!("--alang={audio_language}"),
        "--subs-with-matching-audio=yes".to_string(),
        "--sub-auto=fuzzy".to_string(),
        // MPV can downmix a surround source to a stereo device even when the
        // Force Stereo setting is off. Preserve headroom for either path.
        "--audio-normalize-downmix=yes".to_string(),
    ]);

    if is_remote_initial_stream {
        cmd_args.push("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36".to_string());
        cmd_args.push("--stream-buffer-size=64MiB".to_string());
        cmd_args.push("--sid=no".to_string());
        cmd_args.push("--secondary-sid=no".to_string());
    } else {
        cmd_args.push("--stream-buffer-size=8MiB".to_string());
    }

    if cache_whole_file_enabled {
        cmd_args.extend([
            "--cache-on-disk=yes".to_string(),
            "--demuxer-seekable-cache=yes".to_string(),
            "--cache-secs=86400".to_string(),
            "--demuxer-readahead-secs=86400".to_string(),
            "--demuxer-max-bytes=64GiB".to_string(),
            "--demuxer-max-back-bytes=64GiB".to_string(),
        ]);
    } else {
        cmd_args.extend([
            "--cache-on-disk=no".to_string(),
            "--demuxer-max-bytes=1280MiB".to_string(),
            format!(
                "--demuxer-max-back-bytes={}MiB",
                SINGLE_FILE_CACHE_PRODUCER_BACK_BUFFER_BYTES / (1024 * 1024)
            ),
            "--cache-secs=600".to_string(),
            "--demuxer-readahead-secs=450".to_string(),
        ]);
    }

    if force_stereo_enabled {
        cmd_args.push("--audio-channels=stereo".to_string());
        // Keep the source layout through decoding and let MPV perform the
        // stereo mix with headroom. Decoder-side downmixing bypasses MPV's
        // downmix normalization and can clip a 5.1/7.1 source before the
        // audio normalizer's final limiter sees it.
        cmd_args.push("--ad-lavc-downmix=no".to_string());
    }

    match upscaler {
        VideoUpscaler::RtxVsr => {}
        VideoUpscaler::SSimSuperRes => {
            if rtx_hdr_enabled && !rife_enabled {
                cmd_args.push("--vf=d3d11vpp=nvidia-true-hdr".to_string());
            }
            cmd_args.push("--scale=ewa_lanczossharp".to_string());
            cmd_args.push("--cscale=ewa_lanczos".to_string());
            cmd_args.push(format!(
                "--glsl-shader={}",
                mpv_dir.join("shaders").join("ssim_superres.glsl").display()
            ));
        }
        VideoUpscaler::Fsr => {
            if rtx_hdr_enabled && !rife_enabled {
                cmd_args.push("--vf=d3d11vpp=nvidia-true-hdr".to_string());
            }
            cmd_args.push("--scale=ewa_lanczossharp".to_string());
            cmd_args.push("--cscale=ewa_lanczos".to_string());
            cmd_args.push(format!(
                "--glsl-shader={}",
                mpv_dir.join("shaders").join("fsr.glsl").display()
            ));
        }
    }
    if rife_enabled {
        let normalized_rife_script =
            normalize_path_for_mpv_script_opt(&rife_script_path.to_string_lossy());
        cmd_args.push(format!(
            "--vf-add=@streamee-rife:vapoursynth=file=%{}%{}:buffered-frames={}:concurrent-frames={}",
            normalized_rife_script.len(),
            normalized_rife_script,
            rife_filter_concurrency,
            rife_filter_concurrency
        ));
        if rtx_hdr_enabled && upscaler != VideoUpscaler::RtxVsr {
            cmd_args.push("--vf-add=@streamee-rtx-hdr:d3d11vpp=nvidia-true-hdr".to_string());
        }
    }
    let mut script_opts = vec![
        format!(
            "thumbfast-enabled={}",
            if seek_preview_enabled { "yes" } else { "no" }
        ),
        format!("streamee_sharpen-default_mode={sharpen_mode}"),
        format!("streamee_sharpen-default_denoise_mode={denoise_mode}"),
        format!("streamee_sharpen-default_denoise_strength={denoise_strength}"),
        format!("streamee_smart_ultrawide_fill-default_mode={smart_ultrawide_fill_mode}"),
        format!(
            "streamee_smart_ultrawide_fill-lighting_enabled={}",
            if black_bar_lighting_enabled {
                "yes"
            } else {
                "no"
            }
        ),
        format!(
            "streamee_vsr-enabled={}",
            if upscaler == VideoUpscaler::RtxVsr {
                "yes"
            } else {
                "no"
            }
        ),
        format!(
            "streamee_vsr-rtx_hdr={}",
            if rtx_hdr_enabled { "yes" } else { "no" }
        ),
        format!(
            "streamee_vsr-hdr_contrast_boost={}",
            if hdr_contrast_boost_enabled {
                "yes"
            } else {
                "no"
            }
        ),
        format!(
            "streamee_vsr-before_svp={}",
            if vsr_before_svp { "yes" } else { "no" }
        ),
        format!(
            "streamee_vsr-rife_before_upscaling={}",
            if rife_before_upscaling { "yes" } else { "no" }
        ),
    ];

    if seek_preview_enabled {
        let normalized_mpv_path = normalize_path_for_mpv_script_opt(&mpv_path);
        script_opts.push("thumbfast-network=yes".to_string());
        script_opts.push("thumbfast-cache_only=yes".to_string());
        script_opts.push(format!("thumbfast-mpv_path={}", normalized_mpv_path));
        script_opts.push("thumbfast-spawn_first=no".to_string());
        script_opts.push("thumbfast-hwdec=auto-copy".to_string());
        script_opts.push("thumbfast-quit_after_inactivity=10".to_string());
        info!(
            "MPV seek preview enabled with cache-only Thumbfast helper path: {}",
            normalized_mpv_path
        );
    }

    cmd_args.push(format!("--script-opts={}", script_opts.join(",")));

    if let Some(title) = display_title.as_ref() {
        cmd_args.push(format!("--force-media-title={title}"));
        cmd_args.push(format!("--title=Streamee - {title}"));
    }

    let mpv_log_path = streamee_log_dir().join("MPV.log");
    let mpv_scratch_log_path = streamee_log_dir().join("MPV.raw.log");
    if MPV_STRUCTURED_LOGGING_ENABLED {
        cmd_args.push(format!("--log-file={}", mpv_scratch_log_path.display()));
        cmd_args.push("--msg-level=all=info".to_string());
        info!(
            event = "mpv.logging_enabled",
            source = "backend",
            subsystem = "mpv.logging",
            path = %mpv_log_path.display(),
            level = "info",
            "MPV structured log ingestion enabled"
        );
    } else {
        info!(
            event = "mpv.logging_disabled",
            source = "backend",
            subsystem = "mpv.logging",
            "MPV structured log ingestion is disabled"
        );
    }

    if let (Some(x), Some(y)) = (position_x, position_y) {
        let geo = match (width, height) {
            (Some(w), Some(h)) => format!("{}x{}+{}+{}", w, h, x, y),
            _ => format!("+{}+{}", x, y),
        };
        cmd_args.push(format!("--geometry={}", geo));
        info!("MPV geometry: {}", geo);
    }

    let redacted_args = cmd_args
        .iter()
        .map(|arg| redact_mpv_arg(arg))
        .collect::<Vec<_>>();
    debug!(
        event = "mpv.launch_arguments",
        source = "backend",
        subsystem = "mpv.launch",
        args = ?redacted_args,
        "Final MPV arguments prepared"
    );
    let mut cmd = std::process::Command::new(&mpv_path);
    hide_console_std(&mut cmd);
    cmd.args(&cmd_args);
    if rife_enabled {
        cmd.env("STREAMEE_RIFE_RUNTIME", &rife_runtime_path)
            .env("STREAMEE_RIFE_MODEL", rife_model)
            .env("STREAMEE_RIFE_MULTIPLIER", rife_multiplier.to_string())
            .env("STREAMEE_RIFE_GPU_STREAMS", rife_gpu_streams.to_string())
            .env("STREAMEE_RIFE_PROCESSING_MODE", rife_processing_mode)
            .env("STREAMEE_RIFE_SCALE", rife_scale);
    }
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            restore_auto_enabled_hdr_after_mpv_exit(app);
            return Err(err.to_string());
        }
    };
    let pid = child.id();
    if MPV_STRUCTURED_LOGGING_ENABLED {
        logging::start_mpv_log_ingestion(mpv_scratch_log_path, mpv_log_path, pid);
    }
    info!(
        event = "mpv.spawned",
        source = "backend",
        subsystem = "mpv.launch",
        playback_session_id = pid,
        pid,
        "MPV process spawned"
    );
    start_svp_from_settings(app);
    if let Err(err) = attach_mpv_to_main_window(app, pid).await {
        warn!("Failed to attach MPV window to app owner: {}", err);
    }
    Ok(pid)
}

#[cfg(target_os = "windows")]
fn detect_windows_hdr_for_app_window(app: &AppHandle) -> bool {
    match detect_windows_hdr_for_app_window_inner(app) {
        Ok(enabled) => enabled,
        Err(err) => {
            warn!(
                "Could not detect Windows HDR state; leaving MPV HDR contrast boost off: {}",
                err
            );
            false
        }
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_hdr_for_app_window_inner(app: &AppHandle) -> Result<bool, String> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput, IDXGIOutput6,
        DXGI_ERROR_NOT_FOUND,
    };
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTONEAREST};

    let hwnd = get_main_window_hwnd(app)?;
    let target_monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if target_monitor.0.is_null() {
        return Err("MonitorFromWindow returned no monitor".to_string());
    }

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }
        .map_err(|err| format!("CreateDXGIFactory1 failed: {err}"))?;

    let mut adapter_index = 0;
    loop {
        let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(adapter_index) } {
            Ok(adapter) => adapter,
            Err(err) if err.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(err) => return Err(format!("EnumAdapters1({adapter_index}) failed: {err}")),
        };

        let mut output_index = 0;
        loop {
            let output: IDXGIOutput = match unsafe { adapter.EnumOutputs(output_index) } {
                Ok(output) => output,
                Err(err) if err.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(err) => {
                    return Err(format!(
                        "EnumOutputs(adapter={}, output={}) failed: {}",
                        adapter_index, output_index, err
                    ))
                }
            };

            if let Ok(output6) = output.cast::<IDXGIOutput6>() {
                let desc = unsafe { output6.GetDesc1() }
                    .map_err(|err| format!("IDXGIOutput6::GetDesc1 failed: {err}"))?;
                if desc.Monitor == target_monitor {
                    let hdr_enabled = desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
                    info!(
                        "Detected Windows HDR for Streamee monitor: color_space={:?}, bits_per_color={}, hdr_active={}",
                        desc.ColorSpace,
                        desc.BitsPerColor,
                        hdr_enabled
                    );
                    return Ok(hdr_enabled);
                }
            }

            output_index += 1;
        }

        adapter_index += 1;
    }

    Err("No DXGI output matched the Streamee window monitor".to_string())
}

#[cfg(target_os = "windows")]
fn get_main_window_hwnd(app: &AppHandle) -> Result<windows::Win32::Foundation::HWND, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let handle = window.window_handle().map_err(|e| e.to_string())?;

    match handle.as_raw() {
        RawWindowHandle::Win32(raw) => Ok(windows::Win32::Foundation::HWND(
            raw.hwnd.get() as *mut core::ffi::c_void
        )),
        other => Err(format!("Unsupported main window handle: {:?}", other)),
    }
}

#[cfg(target_os = "windows")]
fn content_name_has_hdr_or_dv_tag(name: &str) -> bool {
    let tokens = name
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_lowercase())
        .collect::<Vec<_>>();

    tokens.iter().any(|token| {
        matches!(
            token.as_str(),
            "hdr" | "hdr10" | "hdr10plus" | "dv" | "dovi" | "dolbyvision"
        )
    }) || tokens
        .windows(2)
        .any(|pair| pair[0] == "dolby" && pair[1] == "vision")
}

#[cfg(target_os = "windows")]
fn maybe_auto_enable_hdr_before_mpv(
    app: &AppHandle,
    content_name: Option<&str>,
) -> Result<(), String> {
    if SKIP_AUTO_HDR_ON_NEXT_LAUNCH.load(Ordering::SeqCst) {
        info!("Auto HDR skipped once after a manual HDR button restart");
        return Ok(());
    }
    if get_store_setting(app, "mpvAutoHdrEnabled").as_deref() != Some("true") {
        return Ok(());
    }
    let Some(content_name) = content_name else {
        info!("Auto HDR skipped: no pre-launch content name was available");
        return Ok(());
    };
    if !content_name_has_hdr_or_dv_tag(content_name) {
        info!("Auto HDR skipped: no HDR/DV release tag in {content_name:?}");
        return Ok(());
    }

    let target = windows_hdr::target_for_window(get_main_window_hwnd(app)?)?;
    let current = windows_hdr::get_for_target(target)?;
    if !current.supported {
        warn!("Auto HDR skipped: the playback monitor does not support Windows HDR");
        return Ok(());
    }
    if current.enabled {
        *AUTO_HDR_TARGET.lock().map_err(|err| err.to_string())? = Some(target);
        info!(
            "Auto HDR: Windows HDR was already enabled on the playback monitor; tracking it for MPV exit cleanup"
        );
        return Ok(());
    }

    let updated = windows_hdr::set_for_target(target, true)?;
    if !updated.enabled {
        return Err(
            "Windows reported HDR still disabled after the auto-enable request".to_string(),
        );
    }
    *AUTO_HDR_TARGET.lock().map_err(|err| err.to_string())? = Some(target);
    info!("Auto HDR enabled Windows HDR before launching MPV");
    std::thread::sleep(std::time::Duration::from_millis(250));
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn suppress_auto_hdr_for_manual_restart() {
    SKIP_AUTO_HDR_ON_NEXT_LAUNCH.store(true, Ordering::SeqCst);
    SKIP_HDR_RESTORE_ON_NEXT_MPV_EXIT.store(true, Ordering::SeqCst);
}

#[cfg(target_os = "windows")]
pub(crate) fn restore_auto_enabled_hdr_after_mpv_exit(app: &AppHandle) {
    if SKIP_HDR_RESTORE_ON_NEXT_MPV_EXIT.swap(false, Ordering::SeqCst) {
        info!("Keeping managed Windows HDR state across the requested MPV restart");
        return;
    }
    let target = match AUTO_HDR_TARGET.lock() {
        Ok(mut managed) => managed.take(),
        Err(err) => {
            warn!("Could not lock auto HDR state during MPV exit: {err}");
            None
        }
    };
    let Some(target) = target else {
        return;
    };
    if get_store_setting(app, "mpvAutoHdrOffOnExit").as_deref() != Some("true") {
        info!("Leaving auto-enabled Windows HDR on after MPV exit per Settings");
        return;
    }
    match windows_hdr::set_for_target(target, false) {
        Ok(_) => info!("Restored SDR on the playback monitor after MPV exit"),
        Err(err) => warn!("Could not restore SDR after MPV exit: {err}"),
    }
}

#[cfg(target_os = "windows")]
fn find_mpv_window_by_pid(pid: u32) -> Result<Option<windows::Win32::Foundation::HWND>, String> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
    };

    struct WindowSearch {
        target_pid: u32,
        found_hwnd: Option<HWND>,
    }

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut WindowSearch);

        if search.found_hwnd.is_some() {
            return BOOL(1);
        }

        let mut window_pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut window_pid));
        if window_pid == search.target_pid && IsWindowVisible(hwnd).as_bool() {
            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut rect).is_ok()
                && rect.right - rect.left > 0
                && rect.bottom - rect.top > 0
            {
                search.found_hwnd = Some(hwnd);
            }
        }

        BOOL(1)
    }

    let mut search = WindowSearch {
        target_pid: pid,
        found_hwnd: None,
    };

    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_proc),
            LPARAM((&mut search as *mut WindowSearch) as isize),
        );
    }

    Ok(search.found_hwnd)
}

#[cfg(target_os = "windows")]
pub(crate) fn get_mpv_monitor_hdr_state(pid: u32) -> Result<windows_hdr::HdrState, String> {
    let hwnd = find_mpv_window_by_pid(pid)?
        .ok_or_else(|| format!("Could not find the MPV window for process {pid}"))?;
    windows_hdr::get_for_window(hwnd)
}

#[cfg(target_os = "windows")]
pub(crate) fn toggle_mpv_monitor_hdr(pid: u32) -> Result<windows_hdr::HdrState, String> {
    let hwnd = find_mpv_window_by_pid(pid)?
        .ok_or_else(|| format!("Could not find the MPV window for process {pid}"))?;
    let target = windows_hdr::target_for_window(hwnd)?;
    let previous = windows_hdr::get_for_target(target)?;
    let updated = windows_hdr::toggle_for_window(hwnd)?;

    if updated.supported && !previous.enabled && updated.enabled {
        *AUTO_HDR_TARGET.lock().map_err(|err| err.to_string())? = Some(target);
        info!("Tracking manually enabled Windows HDR for restoration on MPV exit");
    } else if previous.enabled && !updated.enabled {
        *AUTO_HDR_TARGET.lock().map_err(|err| err.to_string())? = None;
        info!("Cleared managed Windows HDR state after manual disable");
    }

    Ok(updated)
}

#[cfg(target_os = "windows")]
fn delete_mpv_taskbar_tab(hwnd_raw: usize) {
    use windows::core::GUID;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitialize, CoUninitialize, CLSCTX_INPROC_SERVER,
    };
    use windows::Win32::UI::Shell::ITaskbarList;

    const CLSID_TASKBAR_LIST: GUID = GUID {
        data1: 0x56FDF344,
        data2: 0xFD6D,
        data3: 0x11D0,
        data4: [0x95, 0x8A, 0x00, 0x60, 0x97, 0xC9, 0xA0, 0x90],
    };

    unsafe {
        let hwnd = windows::Win32::Foundation::HWND(hwnd_raw as *mut core::ffi::c_void);
        let init = CoInitialize(None);
        if let Ok(tl) =
            CoCreateInstance::<_, ITaskbarList>(&CLSID_TASKBAR_LIST, None, CLSCTX_INPROC_SERVER)
        {
            let _ = tl.HrInit();
            let _ = tl.DeleteTab(hwnd);
        }
        if init == windows::Win32::Foundation::S_OK {
            CoUninitialize();
        }
    }
}

// Thread-locals used exclusively by the WinEvent hook callback.
// The callback is always delivered on the same thread that called SetWinEventHook.
#[cfg(target_os = "windows")]
std::thread_local! {
    static TL_ATTACH_PID:    std::cell::Cell<u32>   = std::cell::Cell::new(0);
    static TL_ATTACH_OWNER:  std::cell::Cell<isize> = std::cell::Cell::new(0);
    static TL_ATTACH_THREAD: std::cell::Cell<u32>   = std::cell::Cell::new(0);
    static TL_ATTACH_FOUND:  std::cell::Cell<usize> = std::cell::Cell::new(0);
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn mpv_win_event_proc(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    _event: u32,
    hwnd: windows::Win32::Foundation::HWND,
    id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    use windows::Win32::Foundation::{LPARAM, RECT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
        PostThreadMessageW, SetWindowLongPtrW, SetWindowLongW, SetWindowPos, GWLP_HWNDPARENT,
        GWL_EXSTYLE, HWND_TOP, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_NULL,
        WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    // OBJID_WINDOW == 0; skip non-window accessiblity events
    if id_object != 0 || hwnd.0.is_null() {
        return;
    }
    if TL_ATTACH_FOUND.with(|c| c.get()) != 0 {
        return;
    }

    let target_pid = TL_ATTACH_PID.with(|c| c.get());
    let mut window_pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut window_pid));
    if window_pid != target_pid {
        return;
    }

    if !IsWindowVisible(hwnd).as_bool() {
        return;
    }
    let mut rect: RECT = std::mem::zeroed();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return;
    }
    if rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0 {
        return;
    }

    // Set owner + strip WS_EX_APPWINDOW *before* Explorer processes
    // HSHELL_WINDOWCREATED on its thread, preventing the taskbar button.
    let owner = TL_ATTACH_OWNER.with(|c| c.get());
    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner);
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    let new_ex = (ex | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0;
    let _ = SetWindowLongW(hwnd, GWL_EXSTYLE, new_ex as i32);
    let _ = SetWindowPos(
        hwnd,
        Some(HWND_TOP),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
    );

    info!(
        "MPV win-event hook: attached pid {} exstyle {:x}->{:x}",
        target_pid, ex, new_ex
    );
    TL_ATTACH_FOUND.with(|c| c.set(hwnd.0 as usize));

    let tid = TL_ATTACH_THREAD.with(|c| c.get());
    let _ = PostThreadMessageW(tid, WM_NULL, WPARAM(0), LPARAM(0));
}

// DEAD CODE marker replaced — see attach_mpv_to_main_window below.
#[cfg(target_os = "windows")]
async fn attach_mpv_to_main_window(app: &AppHandle, pid: u32) -> Result<(), String> {
    let owner_hwnd = get_main_window_hwnd(app)?.0 as isize;

    // Run detection on a dedicated blocking thread so we can drive a Win32
    // message loop.  SetWinEventHook (WINEVENT_OUTOFCONTEXT) delivers callbacks
    // on the calling thread via PeekMessage — no polling delay needed.
    let hwnd_raw = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        use windows::Win32::System::Threading::GetCurrentThreadId;
        use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent};
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, PeekMessageW, TranslateMessage, EVENT_OBJECT_SHOW, MSG, PM_REMOVE,
            WINEVENT_OUTOFCONTEXT,
        };

        TL_ATTACH_PID.with(|c| c.set(pid));
        TL_ATTACH_OWNER.with(|c| c.set(owner_hwnd));
        TL_ATTACH_FOUND.with(|c| c.set(0));
        let tid = unsafe { GetCurrentThreadId() };
        TL_ATTACH_THREAD.with(|c| c.set(tid));

        let hook = unsafe {
            SetWinEventHook(
                EVENT_OBJECT_SHOW,
                EVENT_OBJECT_SHOW,
                None,
                Some(mpv_win_event_proc),
                pid,
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        if hook.is_invalid() {
            return Err(format!("SetWinEventHook failed for pid {}", pid));
        }

        let start = std::time::Instant::now();
        let mut msg: MSG = unsafe { std::mem::zeroed() };

        let found = loop {
            let f = TL_ATTACH_FOUND.with(|c| c.get());
            if f != 0 {
                break f;
            }

            if start.elapsed() > std::time::Duration::from_secs(20) {
                unsafe {
                    let _ = UnhookWinEvent(hook);
                }
                return Err(format!("Timed out waiting for MPV window {}", pid));
            }

            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            // 1 ms sleep keeps CPU usage low while still being much faster than
            // any tokio::time::sleep across an await boundary (~15 ms on Windows).
            std::thread::sleep(std::time::Duration::from_millis(1));
        };

        unsafe {
            let _ = UnhookWinEvent(hook);
        }
        TL_ATTACH_FOUND.with(|c| c.set(0));
        Ok(found)
    })
    .await
    .map_err(|e| format!("MPV attach task failed: {}", e))??;

    // DeleteTab removes any taskbar button the Shell may have registered before
    // our hook fired.  Retry at 200 ms and 1 s in case the Shell re-adds it.
    tokio::task::spawn_blocking(move || {
        delete_mpv_taskbar_tab(hwnd_raw);
        std::thread::sleep(std::time::Duration::from_millis(200));
        delete_mpv_taskbar_tab(hwnd_raw);
        std::thread::sleep(std::time::Duration::from_millis(800));
        delete_mpv_taskbar_tab(hwnd_raw);
    })
    .await
    .ok();

    Ok(())
}

#[tauri::command]
async fn get_mpv_window_pos() -> Result<(i32, i32, i32, i32), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowRect};

        unsafe {
            let class_name: Vec<u16> = "mpv\0".encode_utf16().collect();
            let hwnd = FindWindowW(PCWSTR(class_name.as_ptr()), None);

            if hwnd.is_err() {
                return Err("Could not find MPV window".to_string());
            }

            let hwnd = hwnd.unwrap();
            let mut rect = std::mem::zeroed();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                return Ok((
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                ));
            }
        }
    }

    Err("Failed to get MPV position".to_string())
}

#[tauri::command]
async fn move_mpv_window(pid: u32, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
    tracing::debug!(
        "Moving MPV window {} to ({}, {}) size {}x{}",
        pid,
        x,
        y,
        width,
        height
    );

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_NOZORDER};

        unsafe {
            let hwnd = match find_mpv_window_by_pid(pid)? {
                Some(hwnd) => hwnd,
                None => {
                    warn!("Could not find MPV window for pid {}", pid);
                    return Err("Could not find MPV window handle".to_string());
                }
            };
            tracing::debug!("Found window handle: {:?}", hwnd);

            let result = SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                x,
                y,
                width as i32,
                height as i32,
                SWP_NOZORDER,
            );

            if result.is_ok() {
                tracing::debug!("Window moved and resized successfully");
            } else {
                warn!("SetWindowPos failed: {:?}", result);
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn restore_smart_next_window_state(pid: u32, fullscreen: Option<bool>) -> Result<(), String> {
    let active_pid = mpv_ipc::current_player_pid()?;
    if active_pid != pid {
        return Err(format!(
            "MPV process changed before Smart Next window state could be restored ({pid} -> {active_pid})"
        ));
    }

    if let Some(fullscreen) = fullscreen {
        mpv_ipc::set_player_fullscreen(fullscreen)?;
    }

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            BringWindowToTop, SetForegroundWindow, SetWindowPos, HWND_TOP, SWP_NOMOVE, SWP_NOSIZE,
            SWP_SHOWWINDOW,
        };

        let hwnd = find_mpv_window_by_pid(pid)?
            .ok_or_else(|| format!("Could not find the MPV window for process {pid}"))?;
        unsafe {
            if let Err(error) = SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            ) {
                warn!("Could not raise the Smart Next MPV window: {error}");
            }
            if let Err(error) = BringWindowToTop(hwnd) {
                warn!("Could not bring the Smart Next MPV window to the top: {error}");
            }
            if !SetForegroundWindow(hwnd).as_bool() {
                warn!("Windows declined to foreground the Smart Next MPV window");
            }
        }
    }

    Ok(())
}

#[tauri::command]
async fn open_magnet(magnet_uri: String) -> Result<(), String> {
    info!("Opening magnet: {}", magnet_uri);
    spawn_magnet_open(&magnet_uri)
}

#[tauri::command]
async fn select_svp_executable(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file = app
        .dialog()
        .file()
        .add_filter("Applications", &["exe"])
        .blocking_pick_file();

    Ok(file.map(|path| path.to_string()))
}

#[tauri::command]
async fn select_local_video_files(
    app: tauri::AppHandle,
) -> Result<Option<Vec<LocalVideoFile>>, String> {
    use tauri_plugin_dialog::DialogExt;

    let files = app
        .dialog()
        .file()
        .add_filter(
            "Video files",
            &["mp4", "mkv", "avi", "mov", "webm", "m4v", "wmv", "flv"],
        )
        .blocking_pick_files();

    let Some(files) = files else {
        return Ok(None);
    };

    let mut videos = Vec::new();
    for file in files {
        let path = PathBuf::from(file.to_string());
        if let Some(video) = local_video_file_from_path(&path)? {
            videos.push(video);
        }
    }

    Ok(Some(videos))
}

#[tauri::command]
async fn select_local_video_folder(
    app: tauri::AppHandle,
) -> Result<Option<Vec<LocalVideoFile>>, String> {
    use tauri_plugin_dialog::DialogExt;

    let folder = app.dialog().file().blocking_pick_folder();
    let Some(folder) = folder else {
        return Ok(None);
    };

    let root = PathBuf::from(folder.to_string());
    let mut videos = Vec::new();
    collect_local_video_files(&root, &mut videos)?;
    Ok(Some(videos))
}

#[tauri::command]
async fn set_setting(
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    if key.starts_with("sharedRendererStorage") {
        info!(
            subsystem = "storage",
            "Setting {} ({} bytes)",
            key,
            value.len()
        );
    } else {
        info!(subsystem = "storage", "Setting {} = {}", key, value);
    }

    let handle_lock = state.torrent_app_handle.lock().map_err(|e| e.to_string())?;
    let app_handle = handle_lock
        .as_ref()
        .ok_or_else(|| "Application settings store is unavailable".to_string())?;
    let store = app_handle
        .store("settings.json")
        .map_err(|e| e.to_string())?;
    store.set(&key, serde_json::Value::String(value));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn get_setting(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    info!(subsystem = "storage", "Getting setting: {}", key);

    let handle_lock = state.torrent_app_handle.lock().map_err(|e| e.to_string())?;
    let app_handle = handle_lock
        .as_ref()
        .ok_or_else(|| "Application settings store is unavailable".to_string())?;
    let store = app_handle
        .store("settings.json")
        .map_err(|e| e.to_string())?;
    if let Some(value) = store.get(&key) {
        if let Some(s) = value.as_str() {
            return Ok(Some(s.to_string()));
        }
    }

    Ok(None)
}

const XREL_RELEASE_CACHE_STORE_FILE: &str = "xrel-release-cache.json";
const XREL_RELEASE_CACHE_STORE_KEY: &str = "releaseQualityCacheV2";
const XREL_RELEASE_CACHE_MAX_BYTES: usize = 16 * 1024 * 1024;

#[tauri::command]
async fn read_xrel_release_cache(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let store = app
        .store(XREL_RELEASE_CACHE_STORE_FILE)
        .map_err(|error| error.to_string())?;
    Ok(store.get(XREL_RELEASE_CACHE_STORE_KEY))
}

#[tauri::command]
async fn write_xrel_release_cache(app: AppHandle, value: String) -> Result<(), String> {
    if value.len() > XREL_RELEASE_CACHE_MAX_BYTES {
        return Err(format!(
            "xREL release cache is too large ({} bytes; maximum is {} bytes)",
            value.len(),
            XREL_RELEASE_CACHE_MAX_BYTES
        ));
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&value)
        .map_err(|error| format!("Failed to parse xREL release cache: {error}"))?;

    let store = app
        .store(XREL_RELEASE_CACHE_STORE_FILE)
        .map_err(|error| error.to_string())?;
    store.set(XREL_RELEASE_CACHE_STORE_KEY, parsed);
    store.save().map_err(|error| error.to_string())?;
    info!(
        subsystem = "storage",
        "Saved xREL release cache to AppData ({} bytes)",
        value.len()
    );
    Ok(())
}

#[tauri::command]
async fn clear_xrel_release_cache(app: AppHandle) -> Result<(), String> {
    let store = app
        .store(XREL_RELEASE_CACHE_STORE_FILE)
        .map_err(|error| error.to_string())?;
    store.delete(XREL_RELEASE_CACHE_STORE_KEY);
    store.save().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn configure_remote_control(
    app_handle: AppHandle,
    enabled: bool,
    port: u16,
) -> Result<remote_server::RemoteServerInfo, String> {
    remote_server::configure(app_handle, enabled, port)
}

#[tauri::command]
fn get_remote_control_info() -> remote_server::RemoteServerInfo {
    remote_server::get_info()
}

fn get_store_setting(app: &AppHandle, key: &str) -> Option<String> {
    app.store("settings.json")
        .ok()
        .and_then(|store| store.get(key))
        .and_then(|value| value.as_str().map(|s| s.to_string()))
}

fn get_svp_executable_path(app: &AppHandle) -> String {
    get_store_setting(app, "svpExecutablePath")
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SVP_EXECUTABLE_PATH.to_string())
}

pub(crate) fn get_bool_setting(app: &AppHandle, key: &str) -> bool {
    matches!(get_store_setting(app, key).as_deref(), Some("true"))
}

fn clean_executable_path(executable_path: &str) -> String {
    executable_path.trim().trim_matches('"').to_string()
}

#[cfg(target_os = "windows")]
fn start_svp_process(executable_path: &str) -> Result<(), String> {
    let path = PathBuf::from(clean_executable_path(executable_path));
    if !path.is_file() {
        return Err(format!("SVP executable not found: {}", path.display()));
    }

    let mut command = std::process::Command::new(&path);
    hide_console_std(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Failed to start SVP: {}", err))
}

#[cfg(target_os = "windows")]
fn stop_svp_process(executable_path: &str) -> Result<(), String> {
    let path = PathBuf::from(clean_executable_path(executable_path));
    let image_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "SVP executable path has no file name".to_string())?;

    let mut command = std::process::Command::new("taskkill");
    hide_console_std(&mut command);
    let output = command
        .args(["/F", "/T", "/IM", image_name])
        .output()
        .map_err(|err| format!("Failed to stop SVP: {}", err))?;
    if output.status.success() {
        info!("Stopped SVP process tree for {image_name}");
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let details = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|message| !message.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
    Err(if details.is_empty() {
        format!(
            "Failed to stop SVP process tree for {image_name}: taskkill exited with {}",
            output.status
        )
    } else {
        format!(
            "Failed to stop SVP process tree for {image_name}: taskkill exited with {}: {details}",
            output.status
        )
    })
}

#[cfg(target_os = "windows")]
fn start_svp_from_settings(app: &AppHandle) {
    if !get_bool_setting(app, "svpAutoStartEnabled") {
        return;
    }

    let path = get_svp_executable_path(app);
    match start_svp_process(&path) {
        Ok(()) => info!("Started SVP from {}", path),
        Err(err) => warn!("{}", err),
    }
}

#[tauri::command]
async fn restart_svp(app: AppHandle, executable_path: Option<String>) -> Result<(), String> {
    let path = executable_path.unwrap_or_else(|| get_svp_executable_path(&app));

    #[cfg(target_os = "windows")]
    {
        let _ = stop_svp_process(&path);
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        start_svp_process(&path)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn restart_svp_from_settings(app: &AppHandle) -> Result<(), String> {
    let path = get_svp_executable_path(app);
    let _ = stop_svp_process(&path);
    std::thread::sleep(std::time::Duration::from_millis(600));
    start_svp_process(&path)
}

#[tauri::command]
async fn stop_svp(app: AppHandle, executable_path: Option<String>) -> Result<(), String> {
    let path = executable_path.unwrap_or_else(|| get_svp_executable_path(&app));

    #[cfg(target_os = "windows")]
    {
        stop_svp_process(&path)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Audio Normalizer commands
// ---------------------------------------------------------------------------

fn persist_audio_normalizer_settings(app_handle: &AppHandle) -> Result<(), String> {
    let store = app_handle
        .store("settings.json")
        .map_err(|e| e.to_string())?;

    let config = audio_normalizer::get_config();
    let preset = audio_normalizer::get_preset_name();
    let config_value = serde_json::to_value(config).map_err(|e| e.to_string())?;

    let _ = store.set("audioNormalizerConfig", config_value);
    let _ = store.set("audioNormalizerPreset", serde_json::Value::String(preset));
    if let Some(custom_preset) = audio_normalizer::get_custom_preset() {
        let custom_value = serde_json::to_value(custom_preset).map_err(|e| e.to_string())?;
        let _ = store.set("audioNormalizerCustomPreset", custom_value);
    }
    store.save().map_err(|e| e.to_string())
}

fn emit_audio_normalizer_snapshot(
    app_handle: &AppHandle,
    reason: impl Into<String>,
) -> Result<(), String> {
    let state = audio_normalizer::get_state();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;

    let payload = audio_normalizer::TelemetryPayload {
        timestamp_ms: now.as_secs_f64() * 1000.0,
        momentary_lufs: state.momentary_lufs,
        short_term_lufs: state.short_term_lufs,
        integrated_lufs: state.integrated_lufs,
        true_peak_db: state.true_peak_db,
        true_peak_source: state.true_peak_source,
        limiter_input_peak_db: state.limiter_input_peak_db,
        limiter_input_peak_source: state.limiter_input_peak_source,
        output_peak_db: state.output_peak_db,
        output_peak_source: state.output_peak_source,
        limiter_reduction_db: state.limiter_reduction_db,
        smoothed_lufs: state.smoothed_lufs,
        desired_gain_db: state.desired_gain_db,
        slow_gain_db: state.slow_gain_db,
        fast_gain_db: state.fast_gain_db,
        transient_cut_db: state.transient_cut_db,
        current_gain_db: state.current_gain_db,
        effective_max_gain_db: state.effective_max_gain_db,
        adaptive_gain_extra_db: state.adaptive_gain_extra_db,
        adaptive_gain_state: state.adaptive_gain_state,
        gate_signal_lufs: state.gate_signal_lufs,
        gate_threshold_lufs: state.gate_threshold_lufs,
        gate_normalization_offset_db: state.gate_normalization_offset_db,
        gate_ambient_floor_lufs: state.gate_ambient_floor_lufs,
        gate_foreground_lufs: state.gate_foreground_lufs,
        gate_open_threshold_lufs: state.gate_open_threshold_lufs,
        gate_close_threshold_lufs: state.gate_close_threshold_lufs,
        gate_observed_range_lu: state.gate_observed_range_lu,
        gate_observed_secs: state.gate_observed_secs,
        gate_observation_window_secs: state.gate_observation_window_secs,
        gate_confidence: state.gate_confidence,
        gate_detector_ready: state.gate_detector_ready,
        gate_model_state: state.gate_model_state,
        gate_model_age_secs: state.gate_model_age_secs,
        gate_phase: state.gate_phase,
        adaptive_gate_enabled: state.adaptive_gate_enabled,
        adaptive_gate_mode: state.adaptive_gate_mode,
        subtitle_assist_enabled: state.subtitle_assist_enabled,
        subtitle_assist_active: state.subtitle_assist_active,
        gate_detector_mode: state.gate_detector_mode,
        gate_acquiring: state.gate_acquiring,
        is_gated: state.is_gated,
        connected: state.connected,
        paused: state.paused,
        manual_mode: state.manual_mode,
        reason: reason.into(),
    };

    app_handle
        .emit("audio-normalizer://telemetry", &payload)
        .map_err(|e| e.to_string())
}

fn emit_audio_normalizer_log(
    app_handle: &AppHandle,
    event_type: impl Into<String>,
    message: impl Into<String>,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;

    let entry = audio_normalizer::EventLogEntry {
        timestamp_ms: now.as_secs_f64() * 1000.0,
        event_type: event_type.into(),
        message: message.into(),
    };

    app_handle
        .emit("audio-normalizer://event-log", &entry)
        .map_err(|e| e.to_string())
}

fn stop_audio_normalizer_and_emit(app_handle: &AppHandle) -> Result<(), String> {
    audio_normalizer::stop_normalizer();
    audio_normalizer::clear_state();
    emit_audio_normalizer_snapshot(app_handle, "no_data")
}

#[tauri::command]
async fn set_audio_normalizer_enabled(app_handle: AppHandle, enabled: bool) -> Result<(), String> {
    info!("Audio normalizer enabled: {}", enabled);
    let mut config = audio_normalizer::get_config();
    config.enabled = enabled;
    audio_normalizer::set_config(config);
    persist_audio_normalizer_settings(&app_handle)?;

    if enabled {
        audio_normalizer::start_normalizer(app_handle);
    } else {
        stop_audio_normalizer_and_emit(&app_handle)?;
    }
    Ok(())
}

#[tauri::command]
async fn install_audio_normalizer(app_handle: AppHandle) -> Result<String, String> {
    info!("Enabling audio normalizer");
    set_audio_normalizer_enabled(app_handle, true).await?;
    Ok(
        "Audio normalizer enabled. It will connect automatically when MPV playback starts."
            .to_string(),
    )
}

#[tauri::command]
async fn set_audio_normalizer_config(
    app_handle: AppHandle,
    config: serde_json::Value,
) -> Result<(), String> {
    let parsed: audio_normalizer::NormalizerConfig =
        serde_json::from_value(config).map_err(|e| e.to_string())?;
    info!("Audio normalizer config updated");
    let was_enabled = audio_normalizer::get_config().enabled;
    audio_normalizer::set_config(parsed);
    let is_enabled = audio_normalizer::get_config().enabled;

    if is_enabled && !was_enabled {
        audio_normalizer::start_normalizer(app_handle.clone());
    } else if !is_enabled && was_enabled {
        stop_audio_normalizer_and_emit(&app_handle)?;
    } else if is_enabled {
        audio_normalizer::request_reset();
    }

    persist_audio_normalizer_settings(&app_handle)?;
    Ok(())
}

#[tauri::command]
async fn get_audio_normalizer_config() -> Result<serde_json::Value, String> {
    let config = audio_normalizer::get_config();
    serde_json::to_value(config).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_audio_normalizer_state() -> Result<serde_json::Value, String> {
    let state = audio_normalizer::get_state();
    serde_json::to_value(state).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_audio_normalizer_preset(app_handle: AppHandle, preset: String) -> Result<(), String> {
    info!("Audio normalizer preset: {}", preset);
    audio_normalizer::apply_preset(&preset)?;
    if audio_normalizer::get_config().enabled {
        audio_normalizer::request_reset();
    }
    persist_audio_normalizer_settings(&app_handle)?;
    Ok(())
}

#[tauri::command]
async fn reset_audio_normalizer_state() -> Result<(), String> {
    info!("Audio normalizer state reset requested");
    audio_normalizer::request_reset();
    Ok(())
}

#[tauri::command]
async fn set_audio_normalizer_manual_gain(
    app_handle: AppHandle,
    gain_db: f64,
) -> Result<(), String> {
    info!("Audio normalizer manual gain set to {} dB", gain_db);
    audio_normalizer::set_manual_gain(gain_db)?;
    emit_audio_normalizer_snapshot(&app_handle, "manual_gain")?;
    emit_audio_normalizer_log(
        &app_handle,
        "manual_gain",
        format!("Applied manual gain {} dB", gain_db),
    )?;
    Ok(())
}

#[tauri::command]
async fn set_audio_normalizer_manual_mode(
    app_handle: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    info!("Audio normalizer manual mode: {}", enabled);
    audio_normalizer::set_manual_mode(enabled);
    emit_audio_normalizer_snapshot(&app_handle, if enabled { "manual_mode" } else { "steady" })?;
    emit_audio_normalizer_log(
        &app_handle,
        if enabled {
            "manual_mode_on"
        } else {
            "manual_mode_off"
        },
        if enabled {
            "Manual mode enabled, rider updates paused"
        } else {
            "Manual mode disabled, rider updates resumed"
        },
    )?;
    Ok(())
}

#[tauri::command]
async fn get_audio_normalizer_debug_info() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let debug_info = audio_normalizer::get_debug_info()?;
        return serde_json::to_value(debug_info).map_err(|e| e.to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Audio normalizer debug info is not implemented for this platform".to_string())
    }
}

#[tauri::command]
async fn save_audio_normalizer_custom_preset(
    app_handle: AppHandle,
    config: serde_json::Value,
) -> Result<(), String> {
    let parsed: audio_normalizer::NormalizerConfig =
        serde_json::from_value(config).map_err(|e| e.to_string())?;
    let was_enabled = audio_normalizer::get_config().enabled;
    audio_normalizer::set_custom_preset(parsed.clone());
    audio_normalizer::set_config(parsed);
    audio_normalizer::set_preset_name("custom");

    let is_enabled = audio_normalizer::get_config().enabled;
    if is_enabled && !was_enabled {
        audio_normalizer::start_normalizer(app_handle.clone());
    } else if !is_enabled && was_enabled {
        stop_audio_normalizer_and_emit(&app_handle)?;
    } else if is_enabled {
        audio_normalizer::request_reset();
    }

    persist_audio_normalizer_settings(&app_handle)?;
    emit_audio_normalizer_log(
        &app_handle,
        "preset",
        "Saved and applied current settings as custom preset",
    )?;
    Ok(())
}

pub fn run() {
    let log_paths = match logging::init_tracing() {
        Ok(paths) => paths,
        Err(err) => {
            eprintln!("[Streamee] Failed to initialize file logging: {}", err);
            tracing_subscriber::fmt()
                .with_env_filter("warn,streamee_lib=debug")
                .init();
            logging::LoggingPaths {
                root: streamee_log_dir(),
                structured: streamee_log_dir().join("Streamee.jsonl"),
                mpv_scratch: streamee_log_dir().join("MPV.log"),
                file_logging_enabled: false,
                app_session_id: logging::app_session_id().to_string(),
            }
        }
    };

    if log_paths.file_logging_enabled {
        info!(
            event = "app.starting",
            source = "backend",
            subsystem = "app",
            app_session_id = %log_paths.app_session_id,
            log_dir = %log_paths.root.display(),
            structured_log = %log_paths.structured.display(),
            mpv_scratch_log = %log_paths.mpv_scratch.display(),
            "Starting Streamee Tauri application"
        );
    } else {
        warn!(
            event = "logger.file_logging_unavailable",
            subsystem = "logging",
            "Starting Streamee without structured file logging"
        );
    }

    let app_state = AppState {
        session_initialized: AtomicBool::new(false),
        torrent_app_handle: std::sync::Mutex::new(None),
    };

    let wl_state: SharedWhisperLiveState = std::sync::Arc::new(tokio::sync::Mutex::new(
        whisperlive::WhisperLiveState::default(),
    ));

    tauri::Builder::default()
        .manage(app_state)
        .manage(wl_state)
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            info!("Tauri app setup complete");
            #[cfg(target_os = "windows")]
            install_emergency_scram_hotkey();
            cleanup_persistent_stream_cache_on_startup(app.handle());
            cleanup_addon_proxy_cache();

            torrent::set_app_handle(app.handle().clone());
            whisperlive::set_app_handle(app.handle().clone());

            if let Some(window) = app.get_webview_window("main") {
                info!("Main window created successfully");
                #[cfg(target_os = "windows")]
                install_webview_process_recovery(&window);
                let _ = window.show();
            }

            let state = app.state::<AppState>();
            if let Ok(mut handle) = state.torrent_app_handle.lock() {
                *handle = Some(app.handle().clone());
            }

            if let Ok(store) = app.handle().store("settings.json") {
                if let Some(value) = store.get("audioNormalizerConfig") {
                    match serde_json::from_value::<audio_normalizer::NormalizerConfig>(
                        value.clone(),
                    ) {
                        Ok(config) => {
                            let enabled = config.enabled;
                            audio_normalizer::set_config(config);
                            info!("Loaded audio normalizer config from store");

                            if let Some(custom_value) = store.get("audioNormalizerCustomPreset") {
                                if let Ok(custom_preset) =
                                    serde_json::from_value::<audio_normalizer::NormalizerConfig>(
                                        custom_value.clone(),
                                    )
                                {
                                    audio_normalizer::set_custom_preset(custom_preset);
                                }
                            }

                            if let Some(preset_value) = store.get("audioNormalizerPreset") {
                                if let Some(preset) = preset_value.as_str() {
                                    let normalized_preset =
                                        if preset == "night" { "medium" } else { preset };
                                    if normalized_preset == "custom" {
                                        match audio_normalizer::apply_preset(normalized_preset) {
                                            Ok(()) => {
                                                info!(
                                                    "Loaded audio normalizer custom preset from store"
                                                );
                                            }
                                            Err(err) => {
                                                warn!(
                                                    "Failed to apply saved audio normalizer custom preset: {}",
                                                    err
                                                );
                                                audio_normalizer::set_preset_name(
                                                    normalized_preset,
                                                );
                                            }
                                        }
                                    } else {
                                        audio_normalizer::set_preset_name(normalized_preset);
                                    }
                                }
                            }

                            if enabled {
                                audio_normalizer::start_normalizer(app.handle().clone());
                            }
                        }
                        Err(err) => {
                            warn!("Failed to parse saved audio normalizer config: {}", err);
                        }
                    }
                } else if let Some(value) = store.get("audioNormalizerPreset") {
                    if let Some(preset) = value.as_str() {
                        let normalized_preset = if preset == "night" { "medium" } else { preset };
                        let _ = audio_normalizer::apply_preset(normalized_preset);
                        info!(
                            "Loaded audio normalizer preset from store: {}",
                            normalized_preset
                        );
                    }
                }
            }

            let remote_enabled = get_bool_setting(app.handle(), "remoteControlEnabled");
            let remote_port = get_store_setting(app.handle(), "remoteControlPort")
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(8585);
            if let Err(error) =
                remote_server::configure(app.handle().clone(), remote_enabled, remote_port)
            {
                warn!("Could not restore remote control server: {error}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            write_renderer_log_batch,
            api_keys::get_api_key,
            api_keys::has_api_key,
            api_keys::set_api_key,
            api_keys::clear_api_keys,
            addons::install_addon,
            addons::refresh_addon_manifest,
            addons::fetch_addon_streams,
            addons::probe_addon_streams,
            addons::remove_addon,
            start_torrent,
            stop_torrent,
            get_torrent_stats,
            get_torrent_files,
            get_file_progress,
            get_pieces,
            get_file_path,
            get_stream_url,
            get_whisper_stream_url,
            get_torrent_health,
            test_torrent_port,
            prepare_stream_url,
            prepare_and_open_stream,
            prelaunch_mpv,
            prepare_and_load_stream,
            prepare_and_open_qbittorrent_stream,
            prepare_qbittorrent_stream,
            prepare_smart_next_qbittorrent,
            resume_smart_next_qbittorrent,
            pause_smart_next_qbittorrent,
            prepare_addon_stream_url,
            warm_smart_next_stream,
            cancel_smart_next_warmup,
            activate_smart_next_stream,
            release_addon_stream,
            load_prepared_mpv_stream,
            prepare_and_open_local_stream,
            pause_torrent,
            resume_torrent,
            stop_player,
            stop_mpv_process,
            seek_player_time,
            set_player_detected_segments,
            get_player_tracks,
            set_player_track,
            set_player_media_title,
            set_discord_presence_enabled,
            update_discord_presence,
            clear_discord_presence,
            load_subtitle,
            transcribe_with_whisperlive,
            install_whisperlive,
            test_whisperlive_runtime,
            get_rife_runtime_info,
            install_rife_runtime,
            stop_whisperlive_server,
            stop_whisperlive_client,
            stop_audio_normalizer_runtime,
            open_external,
            move_mpv_window,
            restore_smart_next_window_state,
            get_mpv_window_pos,
            open_magnet,
            send_to_qbittorrent,
            select_svp_executable,
            select_local_video_files,
            select_local_video_folder,
            set_setting,
            get_setting,
            read_xrel_release_cache,
            write_xrel_release_cache,
            clear_xrel_release_cache,
            configure_remote_control,
            get_remote_control_info,
            restart_svp,
            stop_svp,
            start_player_observing,
            stop_player_observing,
            get_player_info,
            playlist_add,
            playlist_next,
            playlist_prev,
            set_smart_next_available,
            get_pending_smart_next_request,
            ack_smart_next_request,
            show_player_message,
            get_playlist_info,
            fetch_introdb_segments,
            detect_player_chapter_segments,
            detect_intro_skipper_segment,
            detect_intro_skipper_outro_segment,
            fetch_kinocheck_trailer,
            set_audio_normalizer_enabled,
            install_audio_normalizer,
            set_audio_normalizer_config,
            get_audio_normalizer_config,
            get_audio_normalizer_state,
            set_audio_normalizer_preset,
            reset_audio_normalizer_state,
            set_audio_normalizer_manual_gain,
            set_audio_normalizer_manual_mode,
            get_audio_normalizer_debug_info,
            save_audio_normalizer_custom_preset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod stream_cache_tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn detects_hdr_and_dolby_vision_release_tags_without_matching_hdrip() {
        for name in [
            "Movie.2160p.HDR10.HEVC.mkv",
            "Movie.2160p.HDR10+.mkv",
            "Movie.2160p.DV.WEB-DL.mkv",
            "Movie.DoVi.REMUX.mkv",
            "Movie Dolby Vision 2160p.mkv",
        ] {
            assert!(content_name_has_hdr_or_dv_tag(name), "missed {name}");
        }
        assert!(!content_name_has_hdr_or_dv_tag(
            "Movie.1080p.HDRip.x264.mkv"
        ));
        assert!(!content_name_has_hdr_or_dv_tag(
            "Movie.1080p.BluRay.x264.mkv"
        ));
    }

    #[test]
    fn parses_and_clamps_single_http_ranges() {
        assert_eq!(parse_http_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_http_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_http_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_http_range("bytes=100-", 100), None);
        assert_eq!(parse_http_range("bytes=20-10", 100), None);
        assert_eq!(parse_http_range("bytes=0-1,4-5", 100), None);
    }

    #[test]
    fn addon_cache_client_backpressure_does_not_become_a_source_failure() {
        assert!(is_addon_cache_client_write_error(
            "Failed to stream single-file cache: A connection attempt failed (os error 10060)"
        ));
        assert!(is_addon_cache_client_write_error(
            "Failed to write Addon cache response headers: Broken pipe"
        ));
        assert!(!is_addon_cache_client_write_error(
            "Failed to read Addon cache producer: operation timed out"
        ));
    }

    #[test]
    fn rejects_non_public_torrent_source_addresses() {
        assert!(is_forbidden_torrent_source_ip("127.0.0.1".parse().unwrap()));
        assert!(is_forbidden_torrent_source_ip("10.0.0.1".parse().unwrap()));
        assert!(is_forbidden_torrent_source_ip(
            "100.64.0.1".parse().unwrap()
        ));
        assert!(is_forbidden_torrent_source_ip(
            "198.18.0.1".parse().unwrap()
        ));
        assert!(is_forbidden_torrent_source_ip(
            "169.254.1.1".parse().unwrap()
        ));
        assert!(is_forbidden_torrent_source_ip("::1".parse().unwrap()));
        assert!(is_forbidden_torrent_source_ip("fc00::1".parse().unwrap()));
        assert!(is_forbidden_torrent_source_ip(
            "::ffff:127.0.0.1".parse().unwrap()
        ));
        assert!(!is_forbidden_torrent_source_ip("1.1.1.1".parse().unwrap()));
        assert!(!is_forbidden_torrent_source_ip(
            "::ffff:1.1.1.1".parse().unwrap()
        ));
        assert!(!is_forbidden_torrent_source_ip(
            "2606:4700:4700::1111".parse().unwrap()
        ));
    }

    #[test]
    fn local_torrent_sources_require_an_exact_configured_origin() {
        let source = reqwest::Url::parse("http://127.0.0.1:9117/dl/path").unwrap();
        assert!(torrent_source_matches_allowed_origin(
            &source,
            &["http://127.0.0.1:9117".to_string()]
        ));
        assert!(!torrent_source_matches_allowed_origin(
            &source,
            &["http://127.0.0.1:9696".to_string()]
        ));
        assert!(!torrent_source_matches_allowed_origin(
            &source,
            &["http://example.test".to_string()]
        ));
    }

    #[test]
    fn single_file_cache_ranges_merge_remove_and_report_coverage() {
        let mut ranges = Vec::new();
        merge_single_file_cache_range(&mut ranges, (10, 19));
        merge_single_file_cache_range(&mut ranges, (20, 29));
        assert_eq!(ranges, vec![(10, 29)]);

        remove_single_file_cache_range(&mut ranges, (15, 24));
        assert_eq!(ranges, vec![(10, 14), (25, 29)]);
        assert_eq!(single_file_cache_covered_end(&ranges, 12), Some(14));
        assert_eq!(single_file_cache_covered_end(&ranges, 20), None);
        assert_eq!(single_file_cache_covered_opening_bytes(&ranges, 30), 0);
        assert_eq!(single_file_cache_covered_tail_bytes(&ranges, 30), 5);

        merge_single_file_cache_range(&mut ranges, (0, 9));
        assert_eq!(single_file_cache_covered_opening_bytes(&ranges, 30), 15);
        assert_eq!(single_file_cache_covered_tail_bytes(&ranges, 30), 5);
    }

    #[test]
    fn single_file_cache_protects_each_producers_recent_back_buffer() {
        let mib = 1024 * 1024;
        let cursor = 384 * mib;
        assert!(single_file_cache_range_overlaps_producer_back_buffer(
            (128 * mib, 129 * mib - 1),
            cursor
        ));
        assert!(single_file_cache_range_overlaps_producer_back_buffer(
            (383 * mib, cursor - 1),
            cursor
        ));
        assert!(!single_file_cache_range_overlaps_producer_back_buffer(
            (0, 128 * mib - 1),
            cursor
        ));
        assert!(!single_file_cache_range_overlaps_producer_back_buffer(
            (cursor, 385 * mib - 1),
            cursor
        ));
        assert_eq!(SINGLE_FILE_CACHE_PRODUCER_BACK_BUFFER_BYTES, 256 * mib);
    }

    #[test]
    fn single_file_cache_budget_counts_pinned_blocks_outside_rolling_limit() {
        let mib = 1024 * 1024;
        assert_eq!(
            single_file_cache_pinned_block_count(1024 * mib, 256 * mib, 960 * mib),
            320
        );
        assert_eq!(
            single_file_cache_pinned_block_count(128 * mib, 128 * mib, 64 * mib),
            128
        );
    }

    #[test]
    fn single_file_cache_request_logging_samples_churn() {
        assert!(should_log_single_file_cache_request(1));
        assert!(should_log_single_file_cache_request(4));
        assert!(!should_log_single_file_cache_request(5));
        assert!(!should_log_single_file_cache_request(99));
        assert!(should_log_single_file_cache_request(100));
    }

    #[test]
    fn single_file_cache_eviction_keeps_active_producer_back_buffer() {
        let total_size = 1024 * SINGLE_FILE_CACHE_BLOCK_BYTES;
        let path = std::env::temp_dir().join(format!(
            "streamee-single-file-cache-back-buffer-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache =
            SingleFileRangeCache::create(path.clone(), total_size, total_size, false).unwrap();
        let producer = match cache.plan(300 * SINGLE_FILE_CACHE_BLOCK_BYTES).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected producer"),
        };
        producer.update_cursor(384 * SINGLE_FILE_CACHE_BLOCK_BYTES);

        cache
            .commit(128 * SINGLE_FILE_CACHE_BLOCK_BYTES, &[1])
            .unwrap();
        for block in 0..SINGLE_FILE_CACHE_ROLLING_BLOCKS as u64 {
            if block != 128 {
                cache
                    .commit(block * SINGLE_FILE_CACHE_BLOCK_BYTES, &[1])
                    .unwrap();
            }
        }
        cache
            .commit(
                SINGLE_FILE_CACHE_ROLLING_BLOCKS as u64 * SINGLE_FILE_CACHE_BLOCK_BYTES,
                &[1],
            )
            .unwrap();

        let state = cache.state.lock().unwrap();
        assert!(single_file_cache_covered_end(
            &state.covered_ranges,
            128 * SINGLE_FILE_CACHE_BLOCK_BYTES
        )
        .is_some());
        assert!(single_file_cache_covered_end(&state.covered_ranges, 0).is_none());
        assert_eq!(state.block_access.len(), SINGLE_FILE_CACHE_ROLLING_BLOCKS);
        drop(state);

        drop((producer, cache));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn single_file_cache_budget_falls_back_inside_a_fully_protected_back_buffer() {
        let total_size = 512 * SINGLE_FILE_CACHE_BLOCK_BYTES;
        let path = std::env::temp_dir().join(format!(
            "streamee-single-file-cache-hard-budget-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache =
            SingleFileRangeCache::create(path.clone(), total_size, total_size, false).unwrap();
        let producer = match cache.plan(SINGLE_FILE_CACHE_BLOCK_BYTES).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected producer"),
        };
        producer.update_cursor(257 * SINGLE_FILE_CACHE_BLOCK_BYTES);

        for block in 1..=SINGLE_FILE_CACHE_ROLLING_BLOCKS as u64 {
            cache
                .commit(block * SINGLE_FILE_CACHE_BLOCK_BYTES, &[1])
                .unwrap();
        }
        cache
            .commit(257 * SINGLE_FILE_CACHE_BLOCK_BYTES, &[1])
            .unwrap();

        let state = cache.state.lock().unwrap();
        assert_eq!(state.block_access.len(), SINGLE_FILE_CACHE_ROLLING_BLOCKS);
        assert!(single_file_cache_covered_end(
            &state.covered_ranges,
            SINGLE_FILE_CACHE_BLOCK_BYTES
        )
        .is_none());
        assert!(single_file_cache_covered_end(
            &state.covered_ranges,
            257 * SINGLE_FILE_CACHE_BLOCK_BYTES
        )
        .is_some());
        drop(state);

        drop((producer, cache));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn single_file_cache_eviction_keeps_pinned_opening() {
        let total_size = 320 * SINGLE_FILE_CACHE_BLOCK_BYTES;
        let path = std::env::temp_dir().join(format!(
            "streamee-single-file-cache-pinned-opening-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache =
            SingleFileRangeCache::create(path.clone(), total_size, total_size, false).unwrap();
        cache.pin_opening(SINGLE_FILE_CACHE_BLOCK_BYTES);

        for block in 0..=SINGLE_FILE_CACHE_ROLLING_BLOCKS as u64 + 1 {
            cache
                .commit(block * SINGLE_FILE_CACHE_BLOCK_BYTES, &[1])
                .unwrap();
        }

        let state = cache.state.lock().unwrap();
        assert!(single_file_cache_covered_end(&state.covered_ranges, 0).is_some());
        assert!(single_file_cache_covered_end(
            &state.covered_ranges,
            SINGLE_FILE_CACHE_BLOCK_BYTES
        )
        .is_none());
        assert_eq!(
            state.block_access.len(),
            SINGLE_FILE_CACHE_ROLLING_BLOCKS + 1
        );
        drop(state);

        drop(cache);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn fingerprint_window_pin_scales_with_media_bitrate_and_analysis_window() {
        let gib = 1024 * 1024 * 1024;
        assert_eq!(
            fingerprint_window_pin_bytes(8 * gib, 720.0, 3_600.0),
            2_644_089_242
        );
        assert_eq!(
            fingerprint_window_pin_bytes(500 * 1024 * 1024, 120.0, 480.0),
            263_716_864
        );
        assert_eq!(fingerprint_window_pin_bytes(8 * gib, 0.0, 3_600.0), 0);
    }

    #[test]
    fn single_file_cache_eviction_keeps_dynamically_pinned_tail() {
        let total_size = 320 * SINGLE_FILE_CACHE_BLOCK_BYTES;
        let path = std::env::temp_dir().join(format!(
            "streamee-single-file-cache-pinned-tail-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache =
            SingleFileRangeCache::create(path.clone(), total_size, total_size, false).unwrap();
        cache.pin_tail(SINGLE_FILE_CACHE_BLOCK_BYTES);
        cache
            .commit(total_size - SINGLE_FILE_CACHE_BLOCK_BYTES, &[1])
            .unwrap();
        for block in 0..=SINGLE_FILE_CACHE_ROLLING_BLOCKS as u64 {
            cache
                .commit(block * SINGLE_FILE_CACHE_BLOCK_BYTES, &[1])
                .unwrap();
        }

        let state = cache.state.lock().unwrap();
        assert!(single_file_cache_covered_end(
            &state.covered_ranges,
            total_size - SINGLE_FILE_CACHE_BLOCK_BYTES
        )
        .is_some());
        assert!(single_file_cache_covered_end(&state.covered_ranges, 0).is_none());
        assert_eq!(
            state.block_access.len(),
            SINGLE_FILE_CACHE_ROLLING_BLOCKS + 1
        );
        drop(state);

        drop(cache);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn single_file_cache_supports_random_reads_and_writes() {
        let total_size = 8 * 1024 * 1024;
        let path = std::env::temp_dir().join(format!(
            "streamee-single-file-cache-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache = SingleFileRangeCache::create(
            path.clone(),
            total_size,
            total_size - (2 * 1024 * 1024),
            false,
        )
        .unwrap();

        cache.commit((2 * 1024 * 1024) + 123, b"middle").unwrap();
        cache.commit(total_size - 4, b"tail").unwrap();
        assert_eq!(
            cache
                .read_cached((2 * 1024 * 1024) + 123, (2 * 1024 * 1024) + 128)
                .unwrap(),
            Some(b"middle".to_vec())
        );
        assert_eq!(
            cache.read_cached(total_size - 4, total_size - 1).unwrap(),
            Some(b"tail".to_vec())
        );
        assert_eq!(fs::metadata(&path).unwrap().len(), total_size);

        drop(cache);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn full_single_file_cache_prioritizes_latest_seek_then_backfills_prefix() {
        let total_size = 512 * 1024 * 1024;
        let tail_start = total_size - ADDON_TAIL_CACHE_BYTES;
        let path = std::env::temp_dir().join(format!(
            "streamee-full-cache-seek-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache =
            SingleFileRangeCache::create(path.clone(), total_size, tail_start, true).unwrap();

        let first_seek = 256 * 1024 * 1024;
        let first = match cache.plan(first_seek).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected full-cache producer at first seek"),
        };
        assert_eq!(first.start, first_seek);
        assert_eq!(first.upstream_end, total_size - 1);
        assert_eq!(
            cache.state.lock().unwrap().active_producers[0].demand_end,
            total_size - 1
        );

        let later_seek = 384 * 1024 * 1024;
        let latest = match cache.plan(later_seek).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected latest seek to supersede the earlier producer"),
        };
        assert!(first.is_cancelled());
        assert_eq!(latest.start, later_seek);
        assert!(cache.plan_full_cache_backfill(&first).unwrap().is_none());

        let backfill = cache
            .plan_full_cache_backfill(&latest)
            .unwrap()
            .expect("expected prefix backfill after the forward pass");
        assert_eq!(backfill.start, 0);
        assert_eq!(backfill.upstream_end, later_seek - 1);

        drop((first, latest, backfill, cache));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn full_single_file_cache_skips_already_covered_bytes_between_missing_ranges() {
        let total_size = 32;
        let path = std::env::temp_dir().join(format!(
            "streamee-full-cache-covered-gap-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache =
            SingleFileRangeCache::create(path.clone(), total_size, total_size, true).unwrap();
        cache.commit(8, &[1; 8]).unwrap();

        let first = match cache.plan(0).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected the first missing range producer"),
        };
        assert_eq!((first.start, first.upstream_end), (0, 7));
        cache.commit(0, &[2; 8]).unwrap();

        let second = cache
            .plan_full_cache_backfill(&first)
            .unwrap()
            .expect("expected a producer after the covered range");
        assert_eq!((second.start, second.upstream_end), (16, 31));
        cache.commit(16, &[3; 16]).unwrap();
        assert!(cache.plan_full_cache_backfill(&second).unwrap().is_none());

        drop((first, second, cache));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn persistent_single_file_cache_restores_downloaded_ranges() {
        let root = std::env::temp_dir().join(format!(
            "streamee-persistent-cache-restore-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let settings = PersistentStreamCacheSettings {
            root: root.clone(),
            limit_bytes: 16 * 1024 * 1024,
        };
        let total_size = 4 * 1024 * 1024;
        let position = (2 * 1024 * 1024) + 123;
        let cache = SingleFileRangeCache::open_persistent(
            &settings,
            "addon:restore-test:0",
            "addon",
            total_size,
            total_size - (1024 * 1024),
            true,
        )
        .unwrap();
        cache.commit(position, b"reused").unwrap();
        drop(cache);

        let restored = SingleFileRangeCache::open_persistent(
            &settings,
            "addon:restore-test:0",
            "addon",
            total_size,
            total_size - (1024 * 1024),
            true,
        )
        .unwrap();
        assert_eq!(
            restored.read_cached(position, position + 5).unwrap(),
            Some(b"reused".to_vec())
        );
        drop(restored);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn persistent_single_file_cache_reuses_an_active_identity() {
        let root = std::env::temp_dir().join(format!(
            "streamee-persistent-cache-active-reuse-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let settings = PersistentStreamCacheSettings {
            root: root.clone(),
            limit_bytes: 16 * 1024 * 1024,
        };
        let total_size = 4 * 1024 * 1024;
        let first = SingleFileRangeCache::open_persistent(
            &settings,
            "addon:active-reuse-test:0",
            "addon",
            total_size,
            total_size - (1024 * 1024),
            true,
        )
        .unwrap();
        let second = SingleFileRangeCache::open_persistent(
            &settings,
            "addon:active-reuse-test:0",
            "addon",
            total_size,
            total_size - (2 * 1024 * 1024),
            true,
        )
        .unwrap();

        assert!(Arc::ptr_eq(&first, &second));
        first.commit(512, b"shared").unwrap();
        assert_eq!(
            second.read_cached(512, 517).unwrap(),
            Some(b"shared".to_vec())
        );

        drop(first);
        assert!(second.is_persistent());
        drop(second);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn persistent_cache_without_full_mpv_cache_stays_demand_bounded() {
        let root = std::env::temp_dir().join(format!(
            "streamee-persistent-cache-demand-bounded-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let settings = PersistentStreamCacheSettings {
            root: root.clone(),
            limit_bytes: 1024 * 1024 * 1024,
        };
        let total_size = 512 * 1024 * 1024;
        let cache = SingleFileRangeCache::open_persistent(
            &settings,
            "addon:demand-bounded-test:0",
            "addon",
            total_size,
            total_size - (64 * 1024 * 1024),
            false,
        )
        .unwrap();

        assert!(cache.retain_whole_file);
        assert!(!cache.fill_whole_file.load(Ordering::Acquire));
        let producer = match cache.plan(0).unwrap() {
            SingleFileCachePlan::StartProducer(producer) => producer,
            _ => panic!("expected a demand-bounded producer"),
        };
        assert_eq!(producer.upstream_end, total_size - 1);
        assert!(producer.full_cache_generation.is_none());
        assert_eq!(
            cache.state.lock().unwrap().active_producers[0].demand_end,
            SINGLE_FILE_CACHE_READ_AHEAD_BYTES - 1
        );

        drop(producer);
        drop(cache);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn persistent_stream_cache_prunes_oldest_inactive_item_first() {
        let root = std::env::temp_dir().join(format!(
            "streamee-persistent-cache-prune-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let old_dir = root.join("old");
        let recent_dir = root.join("recent");
        fs::create_dir_all(&old_dir).unwrap();
        fs::create_dir_all(&recent_dir).unwrap();
        for (entry_dir, cache_key, last_access_ms) in
            [(&old_dir, "old", 1u64), (&recent_dir, "recent", 2u64)]
        {
            let manifest = PersistentStreamCacheManifest {
                version: PERSISTENT_STREAM_CACHE_VERSION,
                cache_key: cache_key.to_string(),
                provider: "test".to_string(),
                total_size: 4 * 1024 * 1024,
                resident_bytes: 4 * 1024 * 1024,
                last_access_ms,
                covered_ranges: Vec::new(),
                resident_blocks: Vec::new(),
            };
            fs::write(
                entry_dir.join("manifest.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
        }

        prune_persistent_stream_cache(&root, 4 * 1024 * 1024);

        assert!(!old_dir.exists());
        assert!(recent_dir.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn persistent_stream_cache_retains_oversized_item_until_replaced() {
        let root = std::env::temp_dir().join(format!(
            "streamee-persistent-cache-oversized-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let settings = PersistentStreamCacheSettings {
            root: root.clone(),
            limit_bytes: 4 * 1024 * 1024,
        };
        let oversized_identity = "addon:oversized-test:0";
        let oversized_dir = root.join(persistent_stream_cache_key(oversized_identity));
        let oversized = SingleFileRangeCache::open_persistent(
            &settings,
            oversized_identity,
            "addon",
            8 * 1024 * 1024,
            7 * 1024 * 1024,
            true,
        )
        .unwrap();
        oversized.commit(0, &vec![1; 5 * 1024 * 1024]).unwrap();
        drop(oversized);

        prune_persistent_stream_cache(&root, settings.limit_bytes);
        assert!(oversized_dir.exists());

        let replacement_identity = "addon:replacement-test:0";
        let replacement_dir = root.join(persistent_stream_cache_key(replacement_identity));
        let replacement = SingleFileRangeCache::open_persistent(
            &settings,
            replacement_identity,
            "addon",
            2 * 1024 * 1024,
            1024 * 1024,
            true,
        )
        .unwrap();
        assert!(!oversized_dir.exists());
        assert!(replacement_dir.exists());

        drop(replacement);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn single_file_cache_only_http_is_an_immediate_local_snapshot() {
        let total_size = 8 * 1024 * 1024;
        let path = std::env::temp_dir().join(format!(
            "streamee-single-file-cache-only-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache =
            SingleFileRangeCache::create(path.clone(), total_size, total_size, false).unwrap();

        let mut missing_response = Vec::new();
        assert_eq!(
            serve_single_file_cache_only(&mut missing_response, &cache, 0, total_size - 1).unwrap(),
            0
        );
        assert!(missing_response.starts_with(b"HTTP/1.1 425 Too Early\r\n"));
        assert!(cache.state.lock().unwrap().active_producers.is_empty());

        let producer = match cache.plan(0).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected normal playback producer"),
        };
        let demand_end = cache.state.lock().unwrap().active_producers[0].demand_end;
        let mut in_flight_response = Vec::new();
        assert_eq!(
            serve_single_file_cache_only(&mut in_flight_response, &cache, 0, total_size - 1)
                .unwrap(),
            0
        );
        assert!(in_flight_response.starts_with(b"HTTP/1.1 425 Too Early\r\n"));
        assert_eq!(
            cache.state.lock().unwrap().active_producers[0].demand_end,
            demand_end
        );

        cache.commit(0, b"cached opening").unwrap();
        let mut cached_response = Vec::new();
        assert_eq!(
            serve_single_file_cache_only(&mut cached_response, &cache, 0, total_size - 1).unwrap(),
            14
        );
        let header_end = cached_response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("cache-only response headers");
        let headers = String::from_utf8_lossy(&cached_response[..header_end]);
        assert!(headers.contains("Content-Range: bytes 0-13/8388608"));
        assert!(headers.contains("Content-Length: 14"));
        assert_eq!(&cached_response[header_end + 4..], b"cached opening");

        let large_offset = 1024 * 1024;
        let large_cached_range = vec![7u8; 2 * SINGLE_FILE_CACHE_WRITE_BYTES];
        cache.commit(large_offset, &large_cached_range).unwrap();
        let mut large_response = Vec::new();
        assert_eq!(
            serve_single_file_cache_only(
                &mut large_response,
                &cache,
                large_offset,
                total_size - 1,
            )
            .unwrap(),
            large_cached_range.len() as u64
        );
        let large_header_end = large_response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("large cache-only response headers");
        assert_eq!(
            &large_response[large_header_end + 4..],
            large_cached_range.as_slice()
        );

        drop((producer, cache));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn single_file_cache_limits_and_preempts_producers() {
        let total_size = 512 * 1024 * 1024;
        let path = std::env::temp_dir().join(format!(
            "streamee-single-file-cache-plan-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache = SingleFileRangeCache::create(
            path.clone(),
            total_size,
            total_size - ADDON_TAIL_CACHE_BYTES,
            false,
        )
        .unwrap();
        let first = match cache.plan(0).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected first producer"),
        };
        assert_eq!(first.upstream_end, total_size - 1);
        let second = match cache.plan(128 * 1024 * 1024).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected second producer"),
        };
        let third = match cache.plan(256 * 1024 * 1024).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected preempting producer"),
        };

        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(!third.is_cancelled());

        drop((first, second, third, cache));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn single_file_cache_extends_one_producer_across_read_ahead_boundaries() {
        let total_size = 256 * 1024 * 1024;
        let path = std::env::temp_dir().join(format!(
            "streamee-single-file-cache-demand-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache =
            SingleFileRangeCache::create(path.clone(), total_size, total_size, false).unwrap();
        let producer = match cache.plan(0).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected producer lane"),
        };
        producer.update_cursor(SINGLE_FILE_CACHE_READ_AHEAD_BYTES);

        assert!(matches!(
            cache.plan(SINGLE_FILE_CACHE_READ_AHEAD_BYTES).unwrap(),
            SingleFileCachePlan::Wait
        ));
        assert_eq!(
            producer
                .next_read_len(
                    SINGLE_FILE_CACHE_READ_AHEAD_BYTES,
                    SINGLE_FILE_CACHE_WRITE_BYTES
                )
                .unwrap(),
            Some(SINGLE_FILE_CACHE_WRITE_BYTES)
        );
        assert_eq!(cache.state.lock().unwrap().active_producers.len(), 1);
        producer.record_failure("producer failed".to_string());
        assert!(matches!(
            cache.plan(SINGLE_FILE_CACHE_READ_AHEAD_BYTES),
            Err(error) if error == "producer failed"
        ));

        drop((producer, cache));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn single_file_cache_paused_producer_waits_for_new_demand() {
        let total_size = 256 * 1024 * 1024;
        let path = std::env::temp_dir().join(format!(
            "streamee-single-file-cache-pause-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache =
            SingleFileRangeCache::create(path.clone(), total_size, total_size, false).unwrap();
        let producer = match cache.plan(0).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected producer"),
        };
        producer.update_cursor(SINGLE_FILE_CACHE_READ_AHEAD_BYTES);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let producer_thread = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            result_tx
                .send(producer.next_read_len(
                    SINGLE_FILE_CACHE_READ_AHEAD_BYTES,
                    SINGLE_FILE_CACHE_WRITE_BYTES,
                ))
                .unwrap();
        });
        ready_rx.recv().unwrap();

        assert!(matches!(
            cache.plan(SINGLE_FILE_CACHE_READ_AHEAD_BYTES).unwrap(),
            SingleFileCachePlan::Wait
        ));
        assert_eq!(
            result_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap()
                .unwrap(),
            Some(SINGLE_FILE_CACHE_WRITE_BYTES)
        );
        producer_thread.join().unwrap();

        drop(cache);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn episode_only_names_use_directory_or_preferred_season_context() {
        assert_eq!(
            parse_episode_number_with_context("Season 2/Episode 03.mkv", None),
            Some((2, 3))
        );
        assert_eq!(
            parse_episode_number_with_context("Episode 03.mkv", Some(4)),
            Some((4, 3))
        );
        assert_eq!(
            parse_episode_number_with_context("Episode 03.mkv", None),
            Some((1, 3))
        );

        let item = stream_playlist_item(
            "http://127.0.0.1/addon/1".to_string(),
            "Season 2/Show - Episode 03.mkv".to_string(),
            100,
            None,
        );
        assert_eq!(item.name, "Show - Episode 03.mkv");
        assert_eq!((item.season, item.episode), (Some(2), Some(3)));
    }

    #[test]
    fn stream_display_names_and_logs_reject_sensitive_urls() {
        assert_eq!(
            safe_stream_display_name(Some("Season 1/Show.S01E01.mkv")),
            Some("Season 1/Show.S01E01.mkv".to_string())
        );
        assert_eq!(
            safe_stream_display_name(Some("https://cdn.example/file?token=secret")),
            None
        );
        assert_eq!(
            redact_sensitive_url("https://example.test/file?token=secret&x=1"),
            "https://example.test/file?token=<redacted>&x=1"
        );
        assert_eq!(
            redact_sensitive_url("https://tracker.test/dl?PassKey=secret&id=1"),
            "https://tracker.test/dl?PassKey=<redacted>&id=1"
        );
        assert_eq!(
            redact_sensitive_url("https://api.example.test/search?apikey=secret&query=test"),
            "https://api.example.test/search?apikey=<redacted>&query=test"
        );
    }

    #[test]
    fn smart_next_warmup_uses_ten_percent_with_one_gib_cap() {
        assert_eq!(smart_next_warmup_target_bytes(0), 0);
        assert_eq!(smart_next_warmup_target_bytes(1), 1);
        assert_eq!(smart_next_warmup_target_bytes(1_000), 100);
        assert_eq!(
            smart_next_warmup_target_bytes(5 * 1024 * 1024 * 1024),
            512 * 1024 * 1024
        );
        assert_eq!(
            smart_next_warmup_target_bytes(20 * 1024 * 1024 * 1024),
            SMART_NEXT_WARMUP_MAX_BYTES
        );
    }

    #[test]
    fn smart_next_warmup_ceiling_blocks_proxy_read_ahead_until_playback() {
        let path = std::env::temp_dir().join(format!(
            "streamee-smart-next-ceiling-{}-{}.cache",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache =
            SingleFileRangeCache::create(path.clone(), 32 * 1024 * 1024, 32 * 1024 * 1024, false)
                .unwrap();
        let limit = 4 * 1024 * 1024;
        cache.set_producer_limit(limit);
        let permit = match cache.plan(0).unwrap() {
            SingleFileCachePlan::StartProducer(permit) => permit,
            _ => panic!("expected a bounded producer"),
        };
        assert_eq!(permit.upstream_end, limit - 1);
        drop(permit);
        assert!(cache.plan(limit).is_err());
        cache.clear_producer_limit();
        assert!(matches!(
            cache.plan(limit).unwrap(),
            SingleFileCachePlan::StartProducer(_)
        ));
        drop(cache);
        let _ = fs::remove_file(path);
    }
}
