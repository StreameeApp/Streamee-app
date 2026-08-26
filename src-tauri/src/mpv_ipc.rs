#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
#[cfg(target_os = "windows")]
use std::sync::Mutex;
#[cfg(target_os = "windows")]
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{debug, info, warn};

/// Get the pipe name used for MPV IPC (used by lib.rs when launching MPV).
/// This intentionally stays stable so external tools like SVP can discover MPV.
pub fn get_mpv_pipe_name() -> &'static str {
    &MPV_PIPE_NAME
}

#[allow(unused_imports)]
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(target_os = "windows")]
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE, OPEN_EXISTING,
};

static MPV_IPC_RUNNING: AtomicBool = AtomicBool::new(false);
static WATCHER_RUNNING: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static WATCHED_MPV_PID: AtomicU32 = AtomicU32::new(0);
#[cfg(target_os = "windows")]
static SMART_NEXT_PENDING_REQUEST: once_cell::sync::Lazy<Mutex<Option<SmartNextPendingRequest>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Copy, Serialize)]
pub struct SmartNextPendingRequest {
    pub request_id: i64,
    pub mpv_pid: u32,
}

impl SmartNextPendingRequest {
    fn belongs_to(self, mpv_pid: u32) -> bool {
        self.mpv_pid != 0 && self.mpv_pid == mpv_pid
    }
}

#[cfg(target_os = "windows")]
fn clear_pending_smart_next_request_for_pid(mpv_pid: u32, reason: &str) {
    let Ok(mut pending) = SMART_NEXT_PENDING_REQUEST.lock() else {
        return;
    };
    if pending.is_some_and(|request| request.belongs_to(mpv_pid)) {
        info!("[MPV IPC] Clearing Smart Next request for MPV {mpv_pid}: {reason}");
        *pending = None;
    }
}

// Keep the pipe name stable to match bundled mpv.conf and preserve SVP hooking.
static MPV_PIPE_NAME: once_cell::sync::Lazy<String> =
    once_cell::sync::Lazy::new(|| "\\\\.\\pipe\\mpvpipe".to_string());

#[cfg(target_os = "windows")]
fn set_main_window_always_on_top(app_handle: &AppHandle, always_on_top: bool) {
    let Some(window) = app_handle.get_webview_window("main") else {
        warn!("[MPV IPC] Main window not found while syncing always-on-top state");
        return;
    };

    if let Err(err) = window.set_always_on_top(always_on_top) {
        warn!("[MPV IPC] Could not sync main window always-on-top state: {err}");
    } else {
        info!("[MPV IPC] Main window always-on-top: {always_on_top}");
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct MpvCommand {
    pub(crate) command: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) request_id: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct MpvResponse {
    #[serde(rename = "error")]
    pub(crate) error: Option<String>,
    #[serde(rename = "data")]
    pub(crate) data: Option<serde_json::Value>,
    #[serde(rename = "event")]
    pub(crate) event: Option<String>,
    #[serde(rename = "id")]
    pub(crate) id: Option<i32>,
    #[serde(rename = "name")]
    pub(crate) name: Option<String>,
}

#[cfg(target_os = "windows")]
fn set_hdr_state_property(pipe: HANDLE, state: crate::windows_hdr::HdrState) {
    let value = if !state.supported {
        "unsupported"
    } else if state.enabled {
        "on"
    } else {
        "off"
    };
    let command = MpvCommand {
        command: vec![
            serde_json::json!("set_property"),
            serde_json::json!("user-data/streamee-hdr-state"),
            serde_json::json!(value),
        ],
        request_id: None,
    };
    let _ = send_command(pipe, &command);

    let notify_osc = MpvCommand {
        command: vec![
            serde_json::json!("script-message-to"),
            serde_json::json!("PlexOSC"),
            serde_json::json!("streamee-hdr-state"),
            serde_json::json!(value),
        ],
        request_id: None,
    };
    let _ = send_command(pipe, &notify_osc);
}

#[cfg(target_os = "windows")]
fn set_svp_enabled_property(pipe: HANDLE, enabled: bool) {
    let value = if enabled { "true" } else { "false" };
    let command = MpvCommand {
        command: vec![
            serde_json::json!("set_property"),
            serde_json::json!("user-data/streamee-svp-enabled"),
            serde_json::json!(enabled),
        ],
        request_id: None,
    };
    let _ = send_command(pipe, &command);

    let notify_osc = MpvCommand {
        command: vec![
            serde_json::json!("script-message-to"),
            serde_json::json!("PlexOSC"),
            serde_json::json!("streamee-svp-enabled"),
            serde_json::json!(value),
        ],
        request_id: None,
    };
    let _ = send_command(pipe, &notify_osc);
}

#[cfg(target_os = "windows")]
fn show_hdr_message(pipe: HANDLE, message: &str) {
    let command = MpvCommand {
        command: vec![
            serde_json::json!("show-text"),
            serde_json::json!(message),
            serde_json::json!(2500),
        ],
        request_id: None,
    };
    let _ = send_command(pipe, &command);
}

#[tauri::command]
pub async fn set_smart_next_available(available: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe().ok_or_else(|| "MPV not connected".to_string())?;
        let command = MpvCommand {
            command: vec![
                serde_json::json!("set_property"),
                serde_json::json!("user-data/streamee-smart-next-available"),
                serde_json::json!(available),
            ],
            request_id: None,
        };
        let result = send_command(pipe, &command);
        unsafe {
            let _ = CloseHandle(pipe);
        }
        confirmed_unit_command(result, "set Smart Next availability")
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = available;
        Err("Not implemented for this platform".to_string())
    }
}

#[tauri::command]
pub async fn get_pending_smart_next_request() -> Option<SmartNextPendingRequest> {
    #[cfg(target_os = "windows")]
    {
        let watched_pid = WATCHED_MPV_PID.load(Ordering::SeqCst);
        let Ok(mut pending) = SMART_NEXT_PENDING_REQUEST.lock() else {
            return None;
        };
        match *pending {
            Some(request) if request.belongs_to(watched_pid) => Some(request),
            Some(request) => {
                info!(
                    "[MPV IPC] Dropping stale Smart Next request {} for MPV {}; active MPV is {}",
                    request.request_id, request.mpv_pid, watched_pid
                );
                *pending = None;
                None
            }
            None => None,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[tauri::command]
pub async fn ack_smart_next_request(request_id: i64, mpv_pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        let Ok(mut pending) = SMART_NEXT_PENDING_REQUEST.lock() else {
            return false;
        };
        let acknowledged = pending
            .is_some_and(|request| request.request_id == request_id && request.mpv_pid == mpv_pid);
        if acknowledged {
            *pending = None;
            info!("[MPV IPC] Smart Next request {request_id} acknowledged");
        }
        acknowledged
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (request_id, mpv_pid);
        false
    }
}

#[tauri::command]
pub async fn show_player_message(message: String, duration_ms: Option<u64>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe_with_retry()
            .ok_or_else(|| "MPV not connected after retry".to_string())?;
        let command = MpvCommand {
            command: vec![
                serde_json::json!("show-text"),
                serde_json::json!(message),
                serde_json::json!(duration_ms.unwrap_or(2500).clamp(500, 10_000)),
            ],
            request_id: None,
        };
        let result = send_command(pipe, &command);
        unsafe {
            let _ = CloseHandle(pipe);
        }
        confirmed_unit_command(result, "show player message")
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (message, duration_ms);
        Err("Not implemented for this platform".to_string())
    }
}

fn parse_track_list(data: serde_json::Value) -> Vec<crate::Track> {
    let Some(items) = data.as_array() else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let track_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if track_type != "audio" && track_type != "sub" {
                return None;
            }

            let id = item.get("id").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
            if id < 0 {
                return None;
            }

            Some(crate::Track {
                id,
                type_: track_type.to_string(),
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                lang: item
                    .get("lang")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                codec: item
                    .get("codec")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                selected: item
                    .get("selected")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                hearing_impaired: item
                    .get("hearing-impaired")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct PlaybackSessionState {
    paused: bool,
    percent_pos: f64,
    playback_time: f64,
    duration: f64,
    filename: String,
    playlist_pos: i64,
    saw_eof_reached: bool,
    saw_end_file: bool,
    eof_emitted: bool,
    closed_emitted: bool,
    seek_guard_until: Option<std::time::Instant>,
    last_progress_at: std::time::Instant,
}

#[cfg(target_os = "windows")]
impl PlaybackSessionState {
    fn new() -> Self {
        Self {
            paused: true,
            percent_pos: 0.0,
            playback_time: 0.0,
            duration: 0.0,
            filename: String::new(),
            playlist_pos: 0,
            saw_eof_reached: false,
            saw_end_file: false,
            eof_emitted: false,
            closed_emitted: false,
            seek_guard_until: None,
            last_progress_at: std::time::Instant::now(),
        }
    }

    fn reset_for_reconnect(&mut self) {
        *self = Self::new();
    }

    fn update_progress(&mut self, percent_pos: f64) {
        self.percent_pos = percent_pos;
        self.last_progress_at = std::time::Instant::now();
    }

    fn update_playback_time(&mut self, playback_time: f64) {
        self.playback_time = playback_time;
        self.last_progress_at = std::time::Instant::now();
    }

    fn update_duration(&mut self, duration: f64) {
        self.duration = duration;
    }

    fn update_filename(&mut self, filename: String) {
        self.filename = filename;
    }

    fn update_playlist_pos(&mut self, playlist_pos: i64) {
        self.playlist_pos = playlist_pos;
    }

    fn reset_for_playlist_item(&mut self, playlist_pos: i64) {
        self.percent_pos = 0.0;
        self.playback_time = 0.0;
        self.duration = 0.0;
        self.filename.clear();
        self.playlist_pos = playlist_pos;
        self.saw_eof_reached = false;
        self.saw_end_file = false;
        self.eof_emitted = false;
        self.closed_emitted = false;
        self.seek_guard_until = None;
        self.last_progress_at = std::time::Instant::now();
    }

    fn mark_end_observed(&mut self) {
        self.saw_eof_reached = true;
        self.saw_end_file = true;
    }

    fn mark_seek_started(&mut self) {
        self.seek_guard_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(6));
    }

    fn mark_playback_restart(&mut self) {
        self.seek_guard_until = Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
    }

    fn seek_guard_active(&self) -> bool {
        self.seek_guard_until
            .map(|until| std::time::Instant::now() < until)
            .unwrap_or(false)
    }

    fn natural_end_confirmed(&self) -> bool {
        self.saw_eof_reached
            || self.saw_end_file
            || (self.duration > 0.0
                && self.playback_time > 0.0
                && self.playback_time >= self.duration - 1.0
                && self.percent_pos >= 99.0)
    }

    fn recent_progress(&self) -> bool {
        self.last_progress_at.elapsed() <= std::time::Duration::from_secs(2)
    }
}

#[cfg(target_os = "windows")]
fn emit_eof_once(app_handle: &AppHandle, state: &mut PlaybackSessionState, reason: &str) -> bool {
    if state.eof_emitted || state.closed_emitted {
        return false;
    }

    state.eof_emitted = true;
    info!("[MPV IPC] EOF confirmed via {}", reason);
    // Emit final progress so position is persisted before EOF
    let _ = app_handle.emit(
        "player://progress",
        serde_json::json!({
            "percent_pos": state.percent_pos,
            "playback_time": state.playback_time,
            "duration": state.duration,
            "filename": state.filename,
            "playlist_pos": state.playlist_pos,
        }),
    );
    let _ = app_handle.emit(
        "player://eof",
        serde_json::json!({
            "percent_pos": state.percent_pos,
            "playback_time": state.playback_time,
            "duration": state.duration,
            "filename": state.filename,
            "playlist_pos": state.playlist_pos,
        }),
    );
    true
}

#[cfg(target_os = "windows")]
fn emit_closed_once(
    app_handle: &AppHandle,
    state: &mut PlaybackSessionState,
    reason: &str,
) -> bool {
    if state.eof_emitted || state.closed_emitted {
        return false;
    }

    state.closed_emitted = true;
    info!("[MPV IPC] Player closed via {}", reason);
    // Emit final progress so position is persisted before close
    let _ = app_handle.emit(
        "player://progress",
        serde_json::json!({
            "percent_pos": state.percent_pos,
            "playback_time": state.playback_time,
            "duration": state.duration,
            "filename": state.filename,
            "playlist_pos": state.playlist_pos,
        }),
    );
    let _ = app_handle.emit(
        "player://closed",
        serde_json::json!({
            "percent_pos": state.percent_pos,
            "playback_time": state.playback_time,
            "duration": state.duration,
            "filename": state.filename,
            "playlist_pos": state.playlist_pos,
        }),
    );
    true
}

#[cfg(target_os = "windows")]
fn classify_disconnect(state: &PlaybackSessionState) -> Option<&'static str> {
    if state.seek_guard_active() {
        return None;
    }

    if state.natural_end_confirmed() {
        Some("eof")
    } else if state.recent_progress()
        && ((state.duration > 0.0
            && (state.percent_pos >= 99.0 || state.playback_time >= state.duration - 1.0))
            || state.percent_pos >= 99.5)
    {
        Some("likely-eof")
    } else {
        Some("closed")
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn connect_to_mpv_pipe() -> Option<HANDLE> {
    connect_to_mpv_pipe_with_logging(true)
}

#[cfg(target_os = "windows")]
fn connect_to_mpv_pipe_with_retry() -> Option<HANDLE> {
    const ATTEMPTS: usize = 5;
    const RETRY_DELAY: Duration = Duration::from_millis(50);

    for attempt in 0..ATTEMPTS {
        if let Some(pipe) = connect_to_mpv_pipe() {
            return Some(pipe);
        }
        if attempt + 1 < ATTEMPTS {
            std::thread::sleep(RETRY_DELAY);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn connect_to_mpv_pipe_with_logging(log_success: bool) -> Option<HANDLE> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Pipes::WaitNamedPipeW;

    let pipe_name_str = format!("{}\0", &*MPV_PIPE_NAME);
    let pipe_name: Vec<u16> = pipe_name_str.encode_utf16().collect();

    unsafe {
        let result = WaitNamedPipeW(PCWSTR(pipe_name.as_ptr()), 100);
        if !result.as_bool() {
            return None;
        }

        // GENERIC_READ (0x80000000) | GENERIC_WRITE (0x40000000) = 0xC0000000
        let handle = CreateFileW(
            PCWSTR(pipe_name.as_ptr()),
            0xC0000000u32, // GENERIC_READ | GENERIC_WRITE
            FILE_SHARE_MODE(0),
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        );

        if let Ok(handle) = handle {
            if log_success {
                info!("[MPV IPC] Connected to pipe successfully");
            }
            return Some(handle);
        }
        None
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn send_command(pipe: HANDLE, command: &MpvCommand) -> Option<MpvResponse> {
    let json = serde_json::to_string(command).ok()?;
    let mut message = json.clone().into_bytes();
    message.push(b'\n');

    unsafe {
        let mut written = 0u32;
        if WriteFile(pipe, Some(&message), Some(&mut written), None).is_ok() {
            // MPV sends newline-delimited JSON. The buffer may contain multiple
            // lines (command responses + unsolicited event notifications).
            // Try each line until we find a valid command response.
            let mut accumulated = Vec::new();
            for _attempt in 0..5 {
                let mut buffer = vec![0u8; 8192];
                let mut read = 0u32;
                if ReadFile(pipe, Some(&mut buffer), Some(&mut read as *mut u32), None).is_err()
                    || read == 0
                {
                    break;
                }
                accumulated.extend_from_slice(&buffer[..read as usize]);

                // Parse each newline-delimited JSON line
                let text = String::from_utf8_lossy(&accumulated);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(resp) = serde_json::from_str::<MpvResponse>(trimmed) {
                        // Only return actual command responses (they have an "error" field),
                        // skip event notifications (they have an "event" field instead).
                        if resp.error.is_some() {
                            return Some(resp);
                        }
                    }
                }
            }
        }
        None
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct MpvPlaylistIdentity {
    playlist_pos: i64,
    filename: String,
    path: String,
    media_title: String,
}

#[cfg(target_os = "windows")]
fn get_property_value(pipe: HANDLE, property: &str) -> Option<serde_json::Value> {
    let command = MpvCommand {
        command: vec![
            serde_json::json!("get_property"),
            serde_json::json!(property),
        ],
        request_id: None,
    };

    send_command(pipe, &command).and_then(|response| {
        if response.error.as_deref() == Some("success") {
            response.data
        } else {
            None
        }
    })
}

#[cfg(target_os = "windows")]
fn get_string_property(pipe: HANDLE, property: &str) -> Option<String> {
    get_property_value(pipe, property).and_then(|value| {
        value
            .as_str()
            .map(ToOwned::to_owned)
            .or_else(|| value.as_i64().map(|number| number.to_string()))
    })
}

#[cfg(target_os = "windows")]
fn read_current_playlist_identity() -> Option<MpvPlaylistIdentity> {
    // Use a short-lived IPC client that has no observed properties. Querying on
    // the watcher pipe can consume and discard unsolicited property events.
    let pipe = connect_to_mpv_pipe_with_logging(false)?;
    let identity = (|| {
        let playlist_pos = get_property_value(pipe, "playlist-pos")?.as_i64()?;
        let filename = get_string_property(pipe, "filename")?;
        let path = get_string_property(pipe, "path").unwrap_or_default();
        let media_title = get_string_property(pipe, "media-title").unwrap_or_default();
        Some(MpvPlaylistIdentity {
            playlist_pos,
            filename,
            path,
            media_title,
        })
    })();

    unsafe {
        let _ = CloseHandle(pipe);
    }
    identity
}

#[cfg(target_os = "windows")]
fn confirmed_unit_command(result: Option<MpvResponse>, action: &str) -> Result<(), String> {
    match result.and_then(|response| response.error) {
        Some(error) if error == "success" => Ok(()),
        Some(error) => Err(format!("MPV {action} failed: {error}")),
        None => Err(format!("MPV did not confirm {action}")),
    }
}

pub(crate) fn set_player_fullscreen(fullscreen: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe_with_logging(false)
            .ok_or_else(|| "MPV not connected".to_string())?;
        let result = confirmed_unit_command(
            send_command(
                pipe,
                &MpvCommand {
                    command: vec![
                        serde_json::json!("set_property"),
                        serde_json::json!("fullscreen"),
                        serde_json::json!(fullscreen),
                    ],
                    request_id: None,
                },
            ),
            "fullscreen restore",
        );
        unsafe {
            let _ = CloseHandle(pipe);
        }
        result
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = fullscreen;
        Err("Not implemented for this platform".to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RemotePlaylistItem {
    pub(crate) index: i64,
    pub(crate) title: String,
    pub(crate) current: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RemotePlayerState {
    pub(crate) connected: bool,
    pub(crate) paused: bool,
    pub(crate) position: f64,
    pub(crate) duration: f64,
    pub(crate) percent: f64,
    pub(crate) title: String,
    pub(crate) filename: String,
    pub(crate) playlist_pos: i64,
    pub(crate) playlist_count: i64,
    pub(crate) mpv_volume: f64,
    pub(crate) fullscreen: bool,
    pub(crate) speed: f64,
    pub(crate) subtitle: String,
    pub(crate) audio: String,
    pub(crate) tracks: Vec<crate::Track>,
    pub(crate) hdr_supported: bool,
    pub(crate) hdr_enabled: bool,
    pub(crate) playlist: Vec<RemotePlaylistItem>,
}

impl Default for RemotePlayerState {
    fn default() -> Self {
        Self {
            connected: false,
            paused: false,
            position: 0.0,
            duration: 0.0,
            percent: 0.0,
            title: "Nothing playing".to_string(),
            filename: String::new(),
            playlist_pos: 0,
            playlist_count: 0,
            mpv_volume: 100.0,
            fullscreen: false,
            speed: 1.0,
            subtitle: "OFF".to_string(),
            audio: "DEFAULT".to_string(),
            tracks: Vec::new(),
            hdr_supported: false,
            hdr_enabled: false,
            playlist: Vec::new(),
        }
    }
}

#[cfg(target_os = "windows")]
fn selected_track_label(track_list: Option<&serde_json::Value>, track_type: &str) -> String {
    let Some(tracks) = track_list.and_then(serde_json::Value::as_array) else {
        return if track_type == "sub" {
            "OFF"
        } else {
            "DEFAULT"
        }
        .to_string();
    };

    let Some(track) = tracks.iter().find(|track| {
        track.get("type").and_then(serde_json::Value::as_str) == Some(track_type)
            && track
                .get("selected")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
    }) else {
        return if track_type == "sub" {
            "OFF"
        } else {
            "DEFAULT"
        }
        .to_string();
    };

    let language = track
        .get("lang")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("UND")
        .to_uppercase();
    let title = track
        .get("title")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty());

    if track_type == "audio" {
        let channels = track
            .get("demux-channel-count")
            .and_then(serde_json::Value::as_i64)
            .map(|count| match count {
                1 => "1.0".to_string(),
                2 => "2.0".to_string(),
                6 => "5.1".to_string(),
                8 => "7.1".to_string(),
                other => other.to_string(),
            });
        return channels
            .map(|channels| format!("{language} {channels}"))
            .unwrap_or(language);
    }

    title
        .map(|title| format!("{language} · {title}"))
        .unwrap_or(language)
}

pub(crate) fn remote_player_state() -> Result<RemotePlayerState, String> {
    #[cfg(target_os = "windows")]
    {
        let Some(pipe) = connect_to_mpv_pipe_with_logging(false) else {
            return Ok(RemotePlayerState::default());
        };

        let result = (|| {
            let paused = get_property_value(pipe, "pause")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let position = get_property_value(pipe, "playback-time")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            let duration = get_property_value(pipe, "duration")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            let percent = get_property_value(pipe, "percent-pos")
                .and_then(|value| value.as_f64())
                .unwrap_or_else(|| {
                    if duration > 0.0 {
                        position / duration * 100.0
                    } else {
                        0.0
                    }
                });
            let filename = get_string_property(pipe, "filename").unwrap_or_default();
            let title = get_string_property(pipe, "media-title")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| filename.clone());
            let playlist_pos = get_property_value(pipe, "playlist-pos")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let playlist_count = get_property_value(pipe, "playlist-count")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            let mpv_volume = get_property_value(pipe, "volume")
                .and_then(|value| value.as_f64())
                .unwrap_or(100.0);
            let fullscreen = get_property_value(pipe, "fullscreen")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let speed = get_property_value(pipe, "speed")
                .and_then(|value| value.as_f64())
                .unwrap_or(1.0);
            let track_list = get_property_value(pipe, "track-list");
            let subtitle = selected_track_label(track_list.as_ref(), "sub");
            let audio = selected_track_label(track_list.as_ref(), "audio");
            let tracks = track_list.clone().map(parse_track_list).unwrap_or_default();
            let hdr_state = get_string_property(pipe, "user-data/streamee-hdr-state")
                .unwrap_or_else(|| "unsupported".to_string());

            let playlist = get_property_value(pipe, "playlist")
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .enumerate()
                .map(|(index, item)| RemotePlaylistItem {
                    index: index as i64,
                    title: item
                        .get("title")
                        .or_else(|| item.get("filename"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("Untitled")
                        .to_string(),
                    current: item
                        .get("current")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(index as i64 == playlist_pos),
                })
                .collect();

            Ok(RemotePlayerState {
                connected: true,
                paused,
                position,
                duration,
                percent: percent.clamp(0.0, 100.0),
                title,
                filename,
                playlist_pos,
                playlist_count,
                mpv_volume,
                fullscreen,
                speed,
                subtitle,
                audio,
                tracks,
                hdr_supported: hdr_state != "unsupported",
                hdr_enabled: hdr_state == "on",
                playlist,
            })
        })();

        unsafe {
            let _ = CloseHandle(pipe);
        }
        result
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(RemotePlayerState::default())
    }
}

pub(crate) fn current_player_pid() -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    {
        let watched_pid = WATCHED_MPV_PID.load(Ordering::SeqCst);
        if watched_pid != 0 {
            return Ok(watched_pid);
        }

        let pipe = connect_to_mpv_pipe_with_logging(false)
            .ok_or_else(|| "MPV not connected".to_string())?;
        let pid = get_property_value(pipe, "pid")
            .and_then(|value| value.as_u64())
            .map(|value| value as u32)
            .ok_or_else(|| "Could not read MPV process id".to_string());
        unsafe {
            let _ = CloseHandle(pipe);
        }
        pid
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Not implemented for this platform".to_string())
    }
}

pub(crate) fn remote_player_command(command: &str, value: Option<f64>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe_with_logging(false)
            .ok_or_else(|| "MPV not connected".to_string())?;

        let mpv_command = match command {
            "play_pause" => vec![serde_json::json!("cycle"), serde_json::json!("pause")],
            "play" => vec![
                serde_json::json!("set_property"),
                serde_json::json!("pause"),
                serde_json::json!(false),
            ],
            "pause" => vec![
                serde_json::json!("set_property"),
                serde_json::json!("pause"),
                serde_json::json!(true),
            ],
            "stop" => vec![serde_json::json!("quit")],
            "seek_relative" => vec![
                serde_json::json!("seek"),
                serde_json::json!(value.unwrap_or(0.0).clamp(-600.0, 600.0)),
                serde_json::json!("relative+exact"),
            ],
            "seek_percent" => vec![
                serde_json::json!("seek"),
                serde_json::json!(value.unwrap_or(0.0).clamp(0.0, 100.0)),
                serde_json::json!("absolute-percent+exact"),
            ],
            "next" => {
                let playlist_count = get_property_value(pipe, "playlist-count")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let playlist_pos = get_property_value(pipe, "playlist-pos")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0);
                let loop_playlist = get_property_value(pipe, "loop-playlist")
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "no".to_string());
                let smart_next_available =
                    get_property_value(pipe, "user-data/streamee-smart-next-available")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false);

                if should_request_smart_next(
                    playlist_count,
                    playlist_pos,
                    &loop_playlist,
                    smart_next_available,
                ) {
                    let previous_request =
                        get_property_value(pipe, "user-data/streamee-smart-next-request")
                            .and_then(|value| value.as_i64())
                            .unwrap_or(0);
                    let unix_millis = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis()
                        .min(i64::MAX as u128) as i64;
                    let request_id = next_smart_next_request_id(previous_request, unix_millis);
                    info!("[MPV IPC] Remote Next requested Smart Next {request_id}");
                    vec![
                        serde_json::json!("set_property"),
                        serde_json::json!("user-data/streamee-smart-next-request"),
                        serde_json::json!(request_id),
                    ]
                } else {
                    vec![
                        serde_json::json!("playlist-next"),
                        serde_json::json!("force"),
                    ]
                }
            }
            "previous" => vec![
                serde_json::json!("playlist-prev"),
                serde_json::json!("force"),
            ],
            "volume_set" => vec![
                serde_json::json!("set_property"),
                serde_json::json!("volume"),
                serde_json::json!(value.unwrap_or(100.0).clamp(0.0, 130.0)),
            ],
            "volume_step" => vec![
                serde_json::json!("add"),
                serde_json::json!("volume"),
                serde_json::json!(value.unwrap_or(0.0).signum()),
            ],
            "fullscreen_toggle" => {
                vec![serde_json::json!("cycle"), serde_json::json!("fullscreen")]
            }
            "subtitle_cycle" => vec![serde_json::json!("cycle"), serde_json::json!("sub")],
            "audio_cycle" => vec![serde_json::json!("cycle"), serde_json::json!("audio")],
            "speed_cycle" => {
                let current = get_property_value(pipe, "speed")
                    .and_then(|value| value.as_f64())
                    .unwrap_or(1.0);
                let next = if current < 1.24 {
                    1.25
                } else if current < 1.49 {
                    1.5
                } else if current < 1.99 {
                    2.0
                } else {
                    1.0
                };
                vec![
                    serde_json::json!("set_property"),
                    serde_json::json!("speed"),
                    serde_json::json!(next),
                ]
            }
            _ => {
                unsafe {
                    let _ = CloseHandle(pipe);
                }
                return Err(format!("Unknown remote player command: {command}"));
            }
        };

        let result = confirmed_unit_command(
            send_command(
                pipe,
                &MpvCommand {
                    command: mpv_command,
                    request_id: None,
                },
            ),
            command,
        );
        unsafe {
            let _ = CloseHandle(pipe);
        }
        result
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (command, value);
        Err("Not implemented for this platform".to_string())
    }
}

fn should_request_smart_next(
    playlist_count: i64,
    playlist_pos: i64,
    loop_playlist: &str,
    smart_next_available: bool,
) -> bool {
    let has_queued_next = playlist_count > 1 && playlist_pos.saturating_add(1) < playlist_count;
    smart_next_available && !has_queued_next && loop_playlist == "no"
}

fn next_smart_next_request_id(previous_request: i64, unix_millis: i64) -> i64 {
    previous_request.saturating_add(1).max(unix_millis)
}

pub fn fetch_player_tracks() -> Result<Vec<crate::Track>, String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = match connect_to_mpv_pipe() {
            Some(p) => p,
            None => return Err("MPV not connected".to_string()),
        };

        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("get_property"),
                serde_json::json!("track-list"),
            ],
            request_id: None,
        };

        let tracks = match send_command(pipe, &cmd) {
            Some(resp) => {
                let tracks = resp.data.map(parse_track_list).unwrap_or_default();
                unsafe {
                    let _ = CloseHandle(pipe);
                }
                tracks
            }
            None => {
                unsafe {
                    let _ = CloseHandle(pipe);
                }
                Vec::new()
            }
        };

        Ok(tracks)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Not implemented for this platform".to_string())
    }
}

pub fn get_selected_audio_ff_index() -> Result<Option<i32>, String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe().ok_or_else(|| "MPV not connected".to_string())?;
        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("get_property"),
                serde_json::json!("current-tracks/audio/ff-index"),
            ],
            request_id: None,
        };
        let response = send_command(pipe, &cmd);
        unsafe {
            let _ = CloseHandle(pipe);
        }

        Ok(response
            .and_then(|value| value.data)
            .and_then(|value| value.as_i64())
            .and_then(|value| i32::try_from(value).ok()))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Not implemented for this platform".to_string())
    }
}

fn cached_window_end_seconds(cache_state: &serde_json::Value, window_start_seconds: f64) -> f64 {
    const OPENING_START_TOLERANCE_SECONDS: f64 = 5.0;
    const RANGE_GAP_TOLERANCE_SECONDS: f64 = 0.5;

    if !window_start_seconds.is_finite() || window_start_seconds < 0.0 {
        return 0.0;
    }

    let bof_cached = cache_state
        .get("bof-cached")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let mut ranges = cache_state
        .get("seekable-ranges")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|range| {
            let start = range.get("start")?.as_f64()?;
            let end = range.get("end")?.as_f64()?;
            (start.is_finite() && end.is_finite() && end > start).then_some((start, end))
        })
        .collect::<Vec<_>>();
    ranges.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut merged_ranges: Vec<(f64, f64)> = Vec::new();
    for (start, end) in ranges {
        if let Some((_, merged_end)) = merged_ranges.last_mut() {
            if start <= *merged_end + RANGE_GAP_TOLERANCE_SECONDS {
                *merged_end = merged_end.max(end);
                continue;
            }
        }
        merged_ranges.push((start, end));
    }

    if window_start_seconds <= f64::EPSILON {
        let Some((opening_start, opening_end)) = merged_ranges.first().copied() else {
            return 0.0;
        };
        if !bof_cached && opening_start > OPENING_START_TOLERANCE_SECONDS {
            return 0.0;
        }
        return (opening_end - opening_start).max(0.0);
    }

    merged_ranges
        .into_iter()
        .find(|(start, end)| *start <= window_start_seconds && *end >= window_start_seconds)
        .map(|(_, end)| end)
        .unwrap_or(0.0)
}

pub fn get_player_cached_window_end_seconds(window_start_seconds: f64) -> Result<f64, String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe_with_logging(false)
            .ok_or_else(|| "MPV is not available yet".to_string())?;
        let cache_state =
            get_property_value(pipe, "demuxer-cache-state").unwrap_or(serde_json::Value::Null);
        let buffered_through_seconds =
            cached_window_end_seconds(&cache_state, window_start_seconds);

        unsafe {
            let _ = CloseHandle(pipe);
        }
        Ok(buffered_through_seconds)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window_start_seconds;
        Err("MPV buffer inspection is only supported on Windows".to_string())
    }
}

fn cached_tail_seconds(cache_state: &serde_json::Value, duration_seconds: f64) -> f64 {
    const EOF_TOLERANCE_SECONDS: f64 = 1.0;
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
        return 0.0;
    }

    let eof_cached = cache_state
        .get("eof-cached")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let mut ranges = cache_state
        .get("seekable-ranges")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|range| {
            let start = range.get("start")?.as_f64()?;
            let end = range.get("end")?.as_f64()?;
            (start.is_finite() && end.is_finite() && end > start).then_some((start, end))
        })
        .collect::<Vec<_>>();
    ranges.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let Some((mut tail_start, tail_end)) = ranges.pop() else {
        return 0.0;
    };
    if !eof_cached && tail_end + EOF_TOLERANCE_SECONDS < duration_seconds {
        return 0.0;
    }
    while let Some((start, end)) = ranges.pop() {
        if end + 0.5 < tail_start {
            break;
        }
        tail_start = tail_start.min(start);
    }
    (duration_seconds.min(tail_end) - tail_start.max(0.0)).max(0.0)
}

pub fn get_player_cached_tail_seconds(duration_seconds: f64) -> Result<f64, String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe_with_logging(false)
            .ok_or_else(|| "MPV is not available yet".to_string())?;
        let cache_state =
            get_property_value(pipe, "demuxer-cache-state").unwrap_or(serde_json::Value::Null);
        let buffered_seconds = cached_tail_seconds(&cache_state, duration_seconds);

        unsafe {
            let _ = CloseHandle(pipe);
        }
        Ok(buffered_seconds)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = duration_seconds;
        Err("MPV buffer inspection is only supported on Windows".to_string())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedAudioTrack {
    pub id: i64,
    pub identity: String,
}

fn normalized_audio_identity_component(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

pub fn get_selected_audio_track() -> Result<SelectedAudioTrack, String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe_with_logging(false)
            .ok_or_else(|| "MPV is not available yet".to_string())?;
        let track_id = get_property_value(pipe, "aid").and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
        });
        let track_list = get_property_value(pipe, "track-list");
        unsafe {
            let _ = CloseHandle(pipe);
        }
        let track_id = track_id.ok_or_else(|| "MPV has no selected audio track".to_string())?;
        let selected_track = track_list
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .and_then(|tracks| {
                tracks.iter().find(|track| {
                    track.get("type").and_then(serde_json::Value::as_str) == Some("audio")
                        && track.get("id").and_then(serde_json::Value::as_i64) == Some(track_id)
                })
            });
        let identity = selected_track
            .map(|track| {
                let language = normalized_audio_identity_component(
                    track.get("lang").and_then(serde_json::Value::as_str),
                );
                let title = normalized_audio_identity_component(
                    track.get("title").and_then(serde_json::Value::as_str),
                );
                let codec = normalized_audio_identity_component(
                    track.get("codec").and_then(serde_json::Value::as_str),
                );
                let channels = track
                    .get("demux-channel-count")
                    .and_then(serde_json::Value::as_i64)
                    .map(|value| value.to_string())
                    .unwrap_or_default();
                let external = track
                    .get("external")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                format!(
                    "lang={language}|title={title}|codec={codec}|channels={channels}|external={external}"
                )
            })
            .unwrap_or_else(|| format!("aid={track_id}"));
        Ok(SelectedAudioTrack {
            id: track_id,
            identity,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("MPV audio track inspection is only supported on Windows".to_string())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct MpvChapter {
    pub title: String,
    pub time: f64,
}

pub fn get_player_chapters() -> Result<Vec<MpvChapter>, String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe().ok_or_else(|| "MPV not connected".to_string())?;
        let chapter_list = get_property_value(pipe, "chapter-list");
        unsafe {
            let _ = CloseHandle(pipe);
        }

        let chapters = chapter_list
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|chapter| {
                let time = chapter.get("time")?.as_f64()?;
                let title = chapter
                    .get("title")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                (time.is_finite() && time >= 0.0 && !title.is_empty())
                    .then_some(MpvChapter { title, time })
            })
            .collect();
        Ok(chapters)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Not implemented for this platform".to_string())
    }
}

pub fn set_player_track(track_type: &str, track_id: i32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = match connect_to_mpv_pipe() {
            Some(p) => p,
            None => return Err("MPV not connected".to_string()),
        };

        let property = match track_type {
            "audio" => "aid",
            "sub" => "sid",
            other => return Err(format!("Unsupported track type: {}", other)),
        };

        let value = if track_id < 0 {
            serde_json::Value::String("no".to_string())
        } else {
            serde_json::json!(track_id)
        };

        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("set_property"),
                serde_json::json!(property),
                value,
            ],
            request_id: None,
        };

        let result = send_command(pipe, &cmd);
        unsafe {
            let _ = CloseHandle(pipe);
        }

        match result {
            Some(resp) if resp.error.as_deref().unwrap_or("success") == "success" => Ok(()),
            Some(resp) => Err(resp
                .error
                .unwrap_or_else(|| "Failed to set track".to_string())),
            None => Err("No response from MPV".to_string()),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (track_type, track_id);
        Err("Not implemented for this platform".to_string())
    }
}

pub fn load_subtitle_file(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = match connect_to_mpv_pipe() {
            Some(p) => p,
            None => return Err("MPV not connected".to_string()),
        };

        let before_tracks = {
            let cmd = MpvCommand {
                command: vec![
                    serde_json::json!("get_property"),
                    serde_json::json!("track-list"),
                ],
                request_id: None,
            };
            send_command(pipe, &cmd)
                .and_then(|resp| resp.data)
                .map(parse_track_list)
                .unwrap_or_default()
        };

        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("sub-add"),
                serde_json::json!(path),
                serde_json::json!("select"),
            ],
            request_id: None,
        };

        let result = send_command(pipe, &cmd);

        match result {
            Some(resp) if resp.error.as_deref().unwrap_or("success") == "success" => {
                let after_tracks = {
                    let track_cmd = MpvCommand {
                        command: vec![
                            serde_json::json!("get_property"),
                            serde_json::json!("track-list"),
                        ],
                        request_id: None,
                    };
                    send_command(pipe, &track_cmd)
                        .and_then(|track_resp| track_resp.data)
                        .map(parse_track_list)
                        .unwrap_or_default()
                };

                let next_subtitle = after_tracks
                    .iter()
                    .filter(|track| track.type_ == "sub")
                    .find(|track| !before_tracks.iter().any(|before| before.id == track.id))
                    .cloned()
                    .or_else(|| {
                        after_tracks
                            .iter()
                            .filter(|track| track.type_ == "sub" && track.selected)
                            .cloned()
                            .next()
                    })
                    .or_else(|| {
                        after_tracks
                            .iter()
                            .filter(|track| track.type_ == "sub")
                            .cloned()
                            .max_by_key(|track| track.id)
                    });

                if let Some(track) = next_subtitle {
                    let select_cmd = MpvCommand {
                        command: vec![
                            serde_json::json!("set_property"),
                            serde_json::json!("sid"),
                            serde_json::json!(track.id),
                        ],
                        request_id: None,
                    };
                    let _ = send_command(pipe, &select_cmd);
                    info!(
                        "[MPV IPC] Loaded generated subtitle track {} for {}",
                        track.id, path
                    );
                }

                unsafe {
                    let _ = CloseHandle(pipe);
                }
                Ok(())
            }
            Some(resp) => {
                unsafe {
                    let _ = CloseHandle(pipe);
                }
                Err(resp
                    .error
                    .unwrap_or_else(|| "Failed to load subtitle".to_string()))
            }
            None => {
                unsafe {
                    let _ = CloseHandle(pipe);
                }
                Err("No response from MPV".to_string())
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("Not implemented for this platform".to_string())
    }
}

pub fn upsert_live_subtitle_file(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe().ok_or_else(|| "MPV not connected".to_string())?;
        let track_list = send_command(
            pipe,
            &MpvCommand {
                command: vec![
                    serde_json::json!("get_property"),
                    serde_json::json!("track-list"),
                ],
                request_id: None,
            },
        )
        .and_then(|response| response.data)
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
        let normalized_path = path.replace('/', "\\").to_ascii_lowercase();
        let mut matching_tracks: Vec<(i64, bool)> = track_list
            .iter()
            .filter(|track| track.get("type").and_then(|value| value.as_str()) == Some("sub"))
            .filter_map(|track| {
                let external_filename = track
                    .get("external-filename")
                    .and_then(|value| value.as_str())?;
                if external_filename.replace('/', "\\").to_ascii_lowercase() != normalized_path {
                    return None;
                }
                Some((
                    track.get("id").and_then(|value| value.as_i64())?,
                    track
                        .get("selected")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false),
                ))
            })
            .collect();

        if !matching_tracks.is_empty() {
            matching_tracks.sort_by_key(|(_, selected)| !*selected);
            let keep_id = matching_tracks[0].0;
            for (track_id, _) in matching_tracks.iter().skip(1) {
                let _ = send_command(
                    pipe,
                    &MpvCommand {
                        command: vec![serde_json::json!("sub-remove"), serde_json::json!(track_id)],
                        request_id: None,
                    },
                );
            }
            let _ = send_command(
                pipe,
                &MpvCommand {
                    command: vec![
                        serde_json::json!("set_property"),
                        serde_json::json!("sid"),
                        serde_json::json!(keep_id),
                    ],
                    request_id: None,
                },
            );
            let result = send_command(
                pipe,
                &MpvCommand {
                    command: vec![serde_json::json!("sub-reload"), serde_json::json!(keep_id)],
                    request_id: None,
                },
            );
            unsafe {
                let _ = CloseHandle(pipe);
            }
            return match result {
                Some(response) if response.error.as_deref().unwrap_or("success") == "success" => {
                    Ok(())
                }
                Some(response) => Err(response
                    .error
                    .unwrap_or_else(|| "Failed to reload live subtitle".to_string())),
                None => Err("No response from MPV".to_string()),
            };
        }

        unsafe {
            let _ = CloseHandle(pipe);
        }
        load_subtitle_file(path)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("Not implemented for this platform".to_string())
    }
}

pub fn set_media_title(title: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe().ok_or_else(|| "MPV not connected".to_string())?;
        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("set_property"),
                serde_json::json!("force-media-title"),
                serde_json::json!(title),
            ],
            request_id: None,
        };

        let result = send_command(pipe, &cmd);
        unsafe {
            let _ = CloseHandle(pipe);
        }

        match result {
            Some(resp) if resp.error.as_deref().unwrap_or("success") == "success" => Ok(()),
            Some(resp) => Err(resp
                .error
                .unwrap_or_else(|| "Failed to set media title".to_string())),
            None => Err("No response from MPV".to_string()),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = title;
        Err("Not implemented for this platform".to_string())
    }
}

pub fn seek_absolute_time(seconds: f64, expected_filename: &str) -> Result<(), String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("Invalid absolute seek time".to_string());
    }
    if expected_filename.trim().is_empty() {
        return Err("Expected MPV filename is required for an absolute seek".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe_with_retry()
            .ok_or_else(|| "MPV not connected after retry".to_string())?;
        let current_filename = get_property_value(pipe, "filename")
            .and_then(|value| value.as_str().map(str::to_owned));
        if current_filename.as_deref() != Some(expected_filename) {
            unsafe {
                let _ = CloseHandle(pipe);
            }
            return Err(format!(
                "MPV item changed before segment seek (expected {expected_filename:?}, current {current_filename:?})"
            ));
        }
        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("seek"),
                serde_json::json!(seconds),
                serde_json::json!("absolute+exact"),
            ],
            request_id: None,
        };

        let result = send_command(pipe, &cmd);
        unsafe {
            let _ = CloseHandle(pipe);
        }

        match result {
            Some(resp) if resp.error.as_deref().unwrap_or("success") == "success" => Ok(()),
            Some(resp) => Err(resp
                .error
                .unwrap_or_else(|| "Failed to seek player".to_string())),
            None => Err("No response from MPV".to_string()),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (seconds, expected_filename);
        Err("Not implemented for this platform".to_string())
    }
}

#[cfg(target_os = "windows")]
fn refresh_playback_position(pipe: HANDLE, state: &mut PlaybackSessionState) -> bool {
    let mut updated = false;

    if let Some(position) = get_property_value(pipe, "percent-pos").and_then(|value| value.as_f64())
    {
        state.update_progress(position);
        updated = true;
    }

    if let Some(playback_time) =
        get_property_value(pipe, "playback-time").and_then(|value| value.as_f64())
    {
        state.update_playback_time(playback_time);
        updated = true;
    }

    // Duration is initially unavailable while MPV is idle/loading. Its one
    // observed property-change can be consumed by one of the commands sharing
    // this IPC pipe, leaving every later progress event at duration=0. Refresh
    // it with position so resumed playback and segment detection cannot remain
    // permanently gated after the file becomes ready.
    if let Some(duration) = get_property_value(pipe, "duration").and_then(|value| value.as_f64()) {
        if duration.is_finite() && duration > 0.0 {
            state.update_duration(duration);
        }
    }

    updated
}

#[cfg(target_os = "windows")]
fn read_events(pipe: HANDLE) -> Vec<MpvResponse> {
    use std::time::{Duration, Instant};
    use windows::Win32::System::Pipes::PeekNamedPipe;

    let start = Instant::now();

    let mut bytes_available = 0u32;
    unsafe {
        let _ = PeekNamedPipe(pipe, None, 0, None, Some(&mut bytes_available), None);
    }

    if start.elapsed() > Duration::from_millis(50) || bytes_available == 0 {
        return Vec::new();
    }

    std::thread::sleep(Duration::from_millis(10));

    unsafe {
        let mut buffer = vec![0u8; 8192];
        let mut read = 0u32;

        let result = ReadFile(pipe, Some(&mut buffer), Some(&mut read as *mut u32), None);

        if result.is_ok() && read > 0 {
            let data = &buffer[..read as usize];
            let text = String::from_utf8_lossy(data);
            // Parse ALL lines, not just the first — avoids dropping buffered events
            return text
                .lines()
                .filter_map(|line| serde_json::from_str::<MpvResponse>(line).ok())
                .collect();
        }
        Vec::new()
    }
}

#[cfg(target_os = "windows")]
pub fn start_player_watcher(app_handle: AppHandle) {
    if WATCHER_RUNNING.swap(true, Ordering::SeqCst) {
        info!("Player watcher already running");
        return;
    }

    std::thread::spawn(move || {
        info!("Starting MPV IPC watcher (will connect when MPV starts)");

        loop {
            if !WATCHER_RUNNING.load(Ordering::SeqCst) {
                break;
            }

            let pipe = match connect_to_mpv_pipe() {
                Some(p) => p,
                None => {
                    std::thread::sleep(Duration::from_millis(2000));
                    continue;
                }
            };

            info!("Connected to MPV IPC pipe");
            let _ = app_handle.emit("player://reconnected", serde_json::json!({}));

            let mut mpv_pid = 0u32;
            unsafe {
                use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
                let _ = GetNamedPipeServerProcessId(pipe, &mut mpv_pid);
            }
            WATCHED_MPV_PID.store(mpv_pid, Ordering::SeqCst);

            for (id, property) in [
                (1, "pause"),
                (4, "duration"),
                (5, "filename"),
                (6, "playlist-pos"),
                (7, "aid"),
            ] {
                let cmd = MpvCommand {
                    command: vec![
                        serde_json::json!("observe_property"),
                        serde_json::json!(id),
                        serde_json::json!(property),
                    ],
                    request_id: Some(id),
                };
                let _ = send_command(pipe, &cmd);
            }

            if mpv_pid != 0 {
                if let Ok(state) = crate::get_mpv_monitor_hdr_state(mpv_pid) {
                    set_hdr_state_property(pipe, state);
                }
            }
            set_svp_enabled_property(
                pipe,
                crate::get_bool_setting(&app_handle, "svpAutoStartEnabled"),
            );

            let mut current_state = PlaybackSessionState::new();
            current_state.reset_for_reconnect();
            let mut was_paused = true;
            let mut last_playlist_pos: i64 = -1;
            let mut last_playlist_filename = String::new();
            let mut last_playlist_path = String::new();
            let mut playlist_identity_dirty = false;
            let mut last_progress_emit = std::time::Instant::now();
            let progress_interval = std::time::Duration::from_secs(2);
            let mut last_progress_poll = std::time::Instant::now();
            let mut last_pause_poll = std::time::Instant::now();
            let pause_poll_interval = std::time::Duration::from_millis(500);
            let mut last_pipe_health_check = std::time::Instant::now();
            let pipe_health_check_interval = std::time::Duration::from_secs(2);
            let mut last_audio_track_id: Option<i64> = None;
            let mut audio_track_initialized = false;
            let mut main_window_always_on_top: Option<bool> = None;
            let mut last_hdr_toggle_request = 0i64;
            let mut last_svp_restart_request = 0i64;
            let mut last_smart_next_request = 0i64;
            let mut pipe_disconnected = false;

            // Get initial state before entering loop
            {
                let pause_cmd = MpvCommand {
                    command: vec![
                        serde_json::json!("get_property"),
                        serde_json::json!("pause"),
                    ],
                    request_id: None,
                };
                if let Some(resp) = send_command(pipe, &pause_cmd) {
                    if let Some(data) = resp.data {
                        if let Some(is_paused) = data.as_bool() {
                            was_paused = is_paused;
                            current_state.paused = is_paused;
                        }
                    }
                }

                refresh_playback_position(pipe, &mut current_state);
            }

            loop {
                if !WATCHER_RUNNING.load(Ordering::SeqCst) {
                    unsafe {
                        let _ = CloseHandle(pipe);
                    }
                    break;
                }

                // Poll pause state every 500ms
                if last_pause_poll.elapsed() >= pause_poll_interval {
                    last_pause_poll = std::time::Instant::now();
                    // Command polling on the observed pipe can consume MPV
                    // property notifications. Reconcile playlist identity on
                    // the same cadence through a separate IPC client.
                    playlist_identity_dirty = true;

                    // Get current pause state
                    let pause_cmd = MpvCommand {
                        command: vec![
                            serde_json::json!("get_property"),
                            serde_json::json!("pause"),
                        ],
                        request_id: None,
                    };
                    if let Some(resp) = send_command(pipe, &pause_cmd) {
                        if let Some(data) = resp.data {
                            if let Some(is_paused) = data.as_bool() {
                                // Emit immediately on state change
                                if is_paused && !was_paused {
                                    debug!(
                                        "[MPV IPC] Pause detected at {}%",
                                        current_state.percent_pos
                                    );
                                    let _ = app_handle.emit(
                                        "player://pause",
                                        serde_json::json!({
                                            "percent_pos": current_state.percent_pos,
                                            "playback_time": current_state.playback_time,
                                            "duration": current_state.duration,
                                            "filename": current_state.filename,
                                            "playlist_pos": current_state.playlist_pos,
                                        }),
                                    );
                                } else if !is_paused && was_paused {
                                    debug!("[MPV IPC] Play detected");
                                    let _ = app_handle.emit(
                                        "player://play",
                                        serde_json::json!({
                                            "percent_pos": current_state.percent_pos,
                                            "playback_time": current_state.playback_time,
                                            "duration": current_state.duration,
                                            "filename": current_state.filename,
                                            "playlist_pos": current_state.playlist_pos,
                                        }),
                                    );
                                }
                                current_state.paused = is_paused;
                                was_paused = is_paused;
                            }
                        }
                    }

                    if let Some(always_on_top) =
                        get_property_value(pipe, "ontop").and_then(|value| value.as_bool())
                    {
                        if main_window_always_on_top != Some(always_on_top) {
                            set_main_window_always_on_top(&app_handle, always_on_top);
                            main_window_always_on_top = Some(always_on_top);
                        }
                    }

                    if last_progress_poll.elapsed() >= progress_interval {
                        last_progress_poll = std::time::Instant::now();
                        if refresh_playback_position(pipe, &mut current_state) {
                            let _ = app_handle.emit(
                                "player://progress",
                                serde_json::json!({
                                    "percent_pos": current_state.percent_pos,
                                    "playback_time": current_state.playback_time,
                                    "duration": current_state.duration,
                                    "filename": current_state.filename,
                                    "playlist_pos": current_state.playlist_pos,
                                }),
                            );
                            last_progress_emit = std::time::Instant::now();
                        }
                    }

                    let current_audio_track_id =
                        get_property_value(pipe, "aid").and_then(|value| {
                            value.as_i64().or_else(|| {
                                value.as_str().and_then(|text| text.parse::<i64>().ok())
                            })
                        });
                    if !audio_track_initialized || current_audio_track_id != last_audio_track_id {
                        audio_track_initialized = true;
                        last_audio_track_id = current_audio_track_id;
                        let _ = app_handle.emit(
                            "player://audio-track-changed",
                            serde_json::json!({ "track_id": current_audio_track_id }),
                        );
                    }

                    // Poll a durable user-data request rather than relying on a
                    // transient client-message event, which another IPC read
                    // could consume before this watcher sees it.
                    let hdr_request_cmd = MpvCommand {
                        command: vec![
                            serde_json::json!("get_property"),
                            serde_json::json!("user-data/streamee-hdr-toggle-request"),
                        ],
                        request_id: None,
                    };
                    if let Some(request) = send_command(pipe, &hdr_request_cmd)
                        .and_then(|response| response.data)
                        .and_then(|value| value.as_i64())
                    {
                        if request > last_hdr_toggle_request && mpv_pid != 0 {
                            last_hdr_toggle_request = request;
                            match crate::toggle_mpv_monitor_hdr(mpv_pid) {
                                Ok(state) => {
                                    set_hdr_state_property(pipe, state);
                                    if state.supported {
                                        crate::suppress_auto_hdr_for_manual_restart();
                                        show_hdr_message(
                                            pipe,
                                            if state.enabled {
                                                "Windows HDR enabled on playback monitor"
                                            } else {
                                                "Windows HDR disabled on playback monitor"
                                            },
                                        );
                                        let _ = app_handle.emit(
                                            "player://hdr-restart-required",
                                            serde_json::json!({
                                                "pid": mpv_pid,
                                                "enabled": state.enabled,
                                                "percent_pos": current_state.percent_pos,
                                                "playback_time": current_state.playback_time,
                                                "duration": current_state.duration,
                                                "filename": current_state.filename,
                                                "playlist_pos": current_state.playlist_pos,
                                            }),
                                        );
                                    } else {
                                        show_hdr_message(
                                            pipe,
                                            "HDR is not supported on the playback monitor",
                                        );
                                    }
                                }
                                Err(err) => show_hdr_message(
                                    pipe,
                                    &format!("Could not toggle Windows HDR: {err}"),
                                ),
                            }
                        }
                    }

                    let svp_request_cmd = MpvCommand {
                        command: vec![
                            serde_json::json!("get_property"),
                            serde_json::json!("user-data/streamee-svp-restart-request"),
                        ],
                        request_id: None,
                    };
                    if let Some(request) = send_command(pipe, &svp_request_cmd)
                        .and_then(|response| response.data)
                        .and_then(|value| value.as_i64())
                    {
                        if request > last_svp_restart_request {
                            last_svp_restart_request = request;
                            match crate::restart_svp_from_settings(&app_handle) {
                                Ok(()) => show_hdr_message(pipe, "SVP restarted"),
                                Err(err) => {
                                    show_hdr_message(pipe, &format!("Could not restart SVP: {err}"))
                                }
                            }
                        }
                    }

                    let smart_next_request_cmd = MpvCommand {
                        command: vec![
                            serde_json::json!("get_property"),
                            serde_json::json!("user-data/streamee-smart-next-request"),
                        ],
                        request_id: None,
                    };
                    if let Some(request) = send_command(pipe, &smart_next_request_cmd)
                        .and_then(|response| response.data)
                        .and_then(|value| value.as_i64())
                    {
                        if request > 0 && request != last_smart_next_request {
                            last_smart_next_request = request;
                            let clear_request_cmd = MpvCommand {
                                command: vec![
                                    serde_json::json!("set_property"),
                                    serde_json::json!("user-data/streamee-smart-next-request"),
                                    serde_json::json!(0),
                                ],
                                request_id: None,
                            };
                            let _ = send_command(pipe, &clear_request_cmd);
                            let accepted = SMART_NEXT_PENDING_REQUEST
                                .lock()
                                .map(|mut pending| {
                                    if pending.is_none() {
                                        *pending = Some(SmartNextPendingRequest {
                                            request_id: request,
                                            mpv_pid,
                                        });
                                        true
                                    } else {
                                        false
                                    }
                                })
                                .unwrap_or(false);
                            if accepted {
                                info!(
                                    "[MPV IPC] Smart Next request {request} retained for renderer (MPV {mpv_pid})"
                                );
                                let _ = app_handle.emit(
                                    "player://smart-next-requested",
                                    serde_json::json!({
                                        "request_id": request,
                                        "mpv_pid": mpv_pid,
                                        "filename": current_state.filename,
                                        "playlist_pos": current_state.playlist_pos,
                                    }),
                                );
                            } else {
                                debug!("[MPV IPC] Ignoring Smart Next request {request}; another request is still pending");
                            }
                        }
                    }
                }

                let events = read_events(pipe);
                if !events.is_empty() {
                    for resp in events {
                        if let Some(event_type) = resp.event.as_deref() {
                            match event_type {
                                "property-change" => {
                                    let id = resp.id.unwrap_or(0);
                                    let name = resp.name.clone().unwrap_or_default();
                                    let data = resp.data.clone();

                                    match id {
                                        1 if name == "pause" => {
                                            if let Some(data_val) = data {
                                                if let Some(is_paused) = data_val.as_bool() {
                                                    if is_paused && !was_paused {
                                                        refresh_playback_position(
                                                            pipe,
                                                            &mut current_state,
                                                        );
                                                        info!(
                                                            "[MPV IPC] Pause detected at {}%",
                                                            current_state.percent_pos
                                                        );
                                                        let _ = app_handle.emit("player://pause", serde_json::json!({
                                                        "percent_pos": current_state.percent_pos,
                                                        "playback_time": current_state.playback_time,
                                                        "duration": current_state.duration,
                                                        "filename": current_state.filename,
                                                        "playlist_pos": current_state.playlist_pos,
                                                    }));
                                                        // Always emit progress on pause so position is saved
                                                        let _ = app_handle.emit("player://progress", serde_json::json!({
                                                        "percent_pos": current_state.percent_pos,
                                                        "playback_time": current_state.playback_time,
                                                        "duration": current_state.duration,
                                                        "filename": current_state.filename,
                                                        "playlist_pos": current_state.playlist_pos,
                                                    }));
                                                        last_progress_emit =
                                                            std::time::Instant::now();
                                                    } else if !is_paused && was_paused {
                                                        info!("[MPV IPC] Play detected");
                                                        let _ = app_handle.emit("player://play", serde_json::json!({
                                                        "percent_pos": current_state.percent_pos,
                                                        "playback_time": current_state.playback_time,
                                                        "duration": current_state.duration,
                                                        "filename": current_state.filename,
                                                        "playlist_pos": current_state.playlist_pos,
                                                    }));
                                                    }
                                                    current_state.paused = is_paused;
                                                    was_paused = is_paused;
                                                }
                                            }
                                        }
                                        2 if name == "percent-pos" => {
                                            if let Some(data_val) = data {
                                                if let Some(pos) = data_val.as_f64() {
                                                    current_state.update_progress(pos);

                                                    // Throttle progress events to every 2 seconds
                                                    if last_progress_emit.elapsed()
                                                        >= progress_interval
                                                    {
                                                        let _ = app_handle.emit("player://progress", serde_json::json!({
                                                        "percent_pos": pos,
                                                        "playback_time": current_state.playback_time,
                                                        "duration": current_state.duration,
                                                        "filename": current_state.filename,
                                                        "playlist_pos": current_state.playlist_pos,
                                                    }));
                                                        last_progress_emit =
                                                            std::time::Instant::now();
                                                    }
                                                }
                                            }
                                        }
                                        3 if name == "playback-time" => {
                                            if let Some(data_val) = data {
                                                if let Some(time) = data_val.as_f64() {
                                                    current_state.update_playback_time(time);
                                                    if last_progress_emit.elapsed()
                                                        >= progress_interval
                                                    {
                                                        let _ = app_handle.emit("player://progress", serde_json::json!({
                                                        "percent_pos": current_state.percent_pos,
                                                        "playback_time": current_state.playback_time,
                                                        "duration": current_state.duration,
                                                        "filename": current_state.filename,
                                                        "playlist_pos": current_state.playlist_pos,
                                                    }));
                                                        last_progress_emit =
                                                            std::time::Instant::now();
                                                    }
                                                }
                                            }
                                        }
                                        4 if name == "duration" => {
                                            if let Some(data_val) = data {
                                                if let Some(dur) = data_val.as_f64() {
                                                    current_state.update_duration(dur);
                                                }
                                            }
                                        }
                                        5 if name == "filename" => {
                                            if let Some(data_val) = data {
                                                let previous_filename =
                                                    current_state.filename.clone();
                                                if let Some(n) = data_val.as_str() {
                                                    current_state.update_filename(n.to_string());
                                                } else if let Some(n) = data_val.as_i64() {
                                                    current_state.update_filename(n.to_string());
                                                }
                                                playlist_identity_dirty |=
                                                    current_state.filename != previous_filename;
                                            }
                                        }
                                        6 if name == "playlist-pos" => {
                                            if let Some(data_val) = data {
                                                if let Some(pos) = data_val.as_i64() {
                                                    if pos != last_playlist_pos {
                                                        current_state.update_playlist_pos(pos);
                                                        playlist_identity_dirty = true;
                                                    }
                                                }
                                            }
                                        }
                                        7 if name == "aid" => {
                                            let track_id = data.as_ref().and_then(|value| {
                                                value.as_i64().or_else(|| {
                                                    value
                                                        .as_str()
                                                        .and_then(|text| text.parse::<i64>().ok())
                                                })
                                            });
                                            if !audio_track_initialized
                                                || track_id != last_audio_track_id
                                            {
                                                audio_track_initialized = true;
                                                last_audio_track_id = track_id;
                                                let _ = app_handle.emit(
                                                    "player://audio-track-changed",
                                                    serde_json::json!({ "track_id": track_id }),
                                                );
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                "eof-reached" => {
                                    if current_state.seek_guard_active()
                                        && !current_state.natural_end_confirmed()
                                    {
                                        debug!("[MPV IPC] Ignoring eof-reached during seek grace");
                                        continue;
                                    }
                                    info!(
                                        "[MPV IPC] EOF reached at {}%",
                                        current_state.percent_pos
                                    );
                                    current_state.mark_end_observed();
                                    let _ = emit_eof_once(
                                        &app_handle,
                                        &mut current_state,
                                        "eof-reached",
                                    );
                                    let _ = app_handle.emit(
                                        "player://stop",
                                        serde_json::json!({
                                            "percent_pos": current_state.percent_pos,
                                            "playback_time": current_state.playback_time,
                                            "duration": current_state.duration,
                                            "filename": current_state.filename,
                                            "playlist_pos": current_state.playlist_pos,
                                        }),
                                    );
                                }
                                "playback-start" => {
                                    info!("[MPV IPC] Playback started");
                                    current_state.paused = false;
                                    was_paused = false;
                                    let _ = app_handle.emit(
                                        "player://play",
                                        serde_json::json!({
                                            "percent_pos": current_state.percent_pos,
                                            "playback_time": current_state.playback_time,
                                            "duration": current_state.duration,
                                            "filename": current_state.filename,
                                            "playlist_pos": current_state.playlist_pos,
                                        }),
                                    );
                                    let _ = app_handle.emit(
                                        "player://progress",
                                        serde_json::json!({
                                            "percent_pos": current_state.percent_pos,
                                            "playback_time": current_state.playback_time,
                                            "duration": current_state.duration,
                                            "filename": current_state.filename,
                                            "playlist_pos": current_state.playlist_pos,
                                        }),
                                    );
                                    last_progress_emit = std::time::Instant::now();
                                }
                                "seek" => {
                                    info!("[MPV IPC] Seek detected");
                                    current_state.mark_seek_started();
                                    refresh_playback_position(pipe, &mut current_state);
                                    let _ = app_handle.emit(
                                        "player://seek",
                                        serde_json::json!({
                                            "percent_pos": current_state.percent_pos,
                                            "playback_time": current_state.playback_time,
                                            "duration": current_state.duration,
                                            "filename": current_state.filename,
                                            "playlist_pos": current_state.playlist_pos,
                                        }),
                                    );
                                }
                                "playback-restart" => {
                                    info!("[MPV IPC] Playback restart after seek/load");
                                    current_state.mark_playback_restart();
                                    current_state.paused = false;
                                    was_paused = false;
                                    refresh_playback_position(pipe, &mut current_state);
                                    let _ = app_handle.emit(
                                        "player://progress",
                                        serde_json::json!({
                                            "percent_pos": current_state.percent_pos,
                                            "playback_time": current_state.playback_time,
                                            "duration": current_state.duration,
                                            "filename": current_state.filename,
                                            "playlist_pos": current_state.playlist_pos,
                                        }),
                                    );
                                    last_progress_emit = std::time::Instant::now();
                                }
                                "idle" => {
                                    if current_state.seek_guard_active()
                                        && !current_state.eof_emitted
                                    {
                                        debug!("[MPV IPC] Ignoring idle during seek grace");
                                        continue;
                                    }
                                    info!("[MPV IPC] Idle state");
                                    let _ = app_handle.emit(
                                        "player://stop",
                                        serde_json::json!({
                                            "percent_pos": current_state.percent_pos,
                                            "playback_time": current_state.playback_time,
                                            "duration": current_state.duration,
                                            "filename": current_state.filename,
                                            "playlist_pos": current_state.playlist_pos,
                                        }),
                                    );
                                }
                                "quit" => {
                                    if current_state.seek_guard_active()
                                        && !current_state.eof_emitted
                                    {
                                        debug!("[MPV IPC] Ignoring quit during seek grace");
                                        continue;
                                    }
                                    if current_state.natural_end_confirmed() {
                                        let _ =
                                            emit_eof_once(&app_handle, &mut current_state, "quit");
                                    } else if current_state.eof_emitted {
                                        debug!("[MPV IPC] Quit after confirmed EOF");
                                    } else {
                                        let _ = emit_closed_once(
                                            &app_handle,
                                            &mut current_state,
                                            "quit",
                                        );
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                } else {
                    if last_pipe_health_check.elapsed() >= pipe_health_check_interval {
                        last_pipe_health_check = std::time::Instant::now();
                        let test_cmd = MpvCommand {
                            command: vec![
                                serde_json::json!("get_property"),
                                serde_json::json!("pause"),
                            ],
                            request_id: None,
                        };
                        if send_command(pipe, &test_cmd).is_none() {
                            pipe_disconnected = true;
                            if let Some(classification) = classify_disconnect(&current_state) {
                                if classification == "eof" || classification == "likely-eof" {
                                    let _ = emit_eof_once(
                                        &app_handle,
                                        &mut current_state,
                                        classification,
                                    );
                                } else {
                                    let _ = emit_closed_once(
                                        &app_handle,
                                        &mut current_state,
                                        "pipe-disconnect",
                                    );
                                }
                            } else {
                                debug!("[MPV IPC] Suppressing pipe-disconnect during seek grace");
                            }
                            unsafe {
                                let _ = CloseHandle(pipe);
                            }
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }

                if playlist_identity_dirty {
                    if let Some(identity) = read_current_playlist_identity() {
                        let identity_changed = identity.playlist_pos != last_playlist_pos
                            || identity.filename != last_playlist_filename
                            || identity.path != last_playlist_path;

                        if identity_changed {
                            if identity.playlist_pos != last_playlist_pos {
                                current_state.reset_for_playlist_item(identity.playlist_pos);
                            }
                            current_state.update_playlist_pos(identity.playlist_pos);
                            current_state.update_filename(identity.filename.clone());

                            info!(
                                "[MPV IPC] Playlist identity changed: pos {} -> {}, filename={:?}, media_title={:?}",
                                last_playlist_pos,
                                identity.playlist_pos,
                                identity.filename,
                                identity.media_title
                            );
                            let _ = app_handle.emit(
                                "player://playlist_changed",
                                serde_json::json!({
                                    "playlist_pos": identity.playlist_pos,
                                    "filename": identity.filename,
                                    "path": identity.path,
                                    "media_title": identity.media_title,
                                }),
                            );

                            last_playlist_pos = identity.playlist_pos;
                            last_playlist_filename = identity.filename;
                            last_playlist_path = identity.path;
                        }
                        playlist_identity_dirty = false;
                    }
                }
            }

            unsafe {
                let _ = CloseHandle(pipe);
            }
            if pipe_disconnected {
                crate::restore_auto_enabled_hdr_after_mpv_exit(&app_handle);
            }
            if main_window_always_on_top == Some(true) {
                set_main_window_always_on_top(&app_handle, false);
            }
            let _ =
                WATCHED_MPV_PID.compare_exchange(mpv_pid, 0, Ordering::SeqCst, Ordering::SeqCst);
            clear_pending_smart_next_request_for_pid(mpv_pid, "MPV session ended");
            std::thread::sleep(Duration::from_millis(500));
        }

        info!("MPV IPC watcher stopped");
        WATCHER_RUNNING.store(false, Ordering::SeqCst);
    });
}

#[cfg(target_os = "windows")]
pub async fn wait_for_player_pipe_release(pid: u32, timeout: Duration) -> Result<(), String> {
    let started = std::time::Instant::now();
    while WATCHED_MPV_PID.load(Ordering::SeqCst) == pid {
        if started.elapsed() >= timeout {
            return Err(format!(
                "Timed out waiting for MPV process {pid} IPC session to close"
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn stop_player_watcher() {
    info!("Stopping MPV IPC watcher");
    WATCHER_RUNNING.store(false, Ordering::SeqCst);
    if let Ok(mut pending) = SMART_NEXT_PENDING_REQUEST.lock() {
        *pending = None;
    }
}

#[cfg(test)]
mod smart_next_tests {
    use super::{
        cached_tail_seconds, cached_window_end_seconds, mpv_start_option,
        next_smart_next_request_id, should_request_smart_next, SmartNextPendingRequest,
    };

    #[test]
    fn pending_request_belongs_only_to_its_mpv_session() {
        let request = SmartNextPendingRequest {
            request_id: 10_000,
            mpv_pid: 200,
        };

        assert!(request.belongs_to(200));
        assert!(!request.belongs_to(100));
        assert!(!SmartNextPendingRequest {
            request_id: 10_000,
            mpv_pid: 0,
        }
        .belongs_to(0));
    }

    #[test]
    fn remote_next_uses_smart_next_only_at_the_playlist_end() {
        assert!(should_request_smart_next(1, 0, "no", true));
        assert!(should_request_smart_next(3, 2, "no", true));
        assert!(!should_request_smart_next(3, 1, "no", true));
        assert!(!should_request_smart_next(1, 0, "inf", true));
        assert!(!should_request_smart_next(1, 0, "no", false));
    }

    #[test]
    fn remote_smart_next_request_ids_are_monotonic() {
        assert_eq!(next_smart_next_request_id(50, 1_000), 1_000);
        assert_eq!(next_smart_next_request_id(1_000, 900), 1_001);
        assert_eq!(next_smart_next_request_id(i64::MAX, 900), i64::MAX);
    }

    #[test]
    fn mpv_start_option_uses_a_bounded_percent_value() {
        assert_eq!(mpv_start_option(Some(50.25)), Some("50.25%".to_string()));
        assert_eq!(mpv_start_option(Some(150.0)), Some("100%".to_string()));
        assert_eq!(mpv_start_option(Some(0.0)), None);
        assert_eq!(mpv_start_option(Some(f64::NAN)), None);
    }

    #[test]
    fn cached_opening_accepts_small_timestamp_offset_and_rejects_resume() {
        let state = serde_json::json!({
            "bof-cached": true,
            "seekable-ranges": [
                { "start": 120.0, "end": 301.0 },
                { "start": 0.0, "end": 120.25 },
                { "start": 500.0, "end": 600.0 }
            ]
        });
        assert!((cached_window_end_seconds(&state, 0.0) - 301.0).abs() < f64::EPSILON);

        let mkv_start_offset_state = serde_json::json!({
            "bof-cached": false,
            "seekable-ranges": [{ "start": 1.001, "end": 646.020 }]
        });
        assert!((cached_window_end_seconds(&mkv_start_offset_state, 0.0) - 645.019).abs() < 0.001);

        let resumed_state = serde_json::json!({
            "bof-cached": false,
            "seekable-ranges": [{ "start": 1_800.0, "end": 2_200.0 }]
        });
        assert_eq!(cached_window_end_seconds(&resumed_state, 0.0), 0.0);
    }

    #[test]
    fn cached_window_accepts_part_two_coverage_without_timestamp_zero() {
        let ready = serde_json::json!({
            "bof-cached": false,
            "seekable-ranges": [
                { "start": 30.0, "end": 500.0 },
                { "start": 500.25, "end": 839.0 }
            ]
        });
        assert_eq!(cached_window_end_seconds(&ready, 360.0), 839.0);

        let missing_start = serde_json::json!({
            "bof-cached": false,
            "seekable-ranges": [{ "start": 361.0, "end": 839.0 }]
        });
        assert_eq!(cached_window_end_seconds(&missing_start, 360.0), 0.0);
    }

    #[test]
    fn cached_tail_requires_eof_or_a_range_reaching_duration() {
        let ready = serde_json::json!({
            "eof-cached": true,
            "seekable-ranges": [
                { "start": 2_700.0, "end": 3_000.0 },
                { "start": 2_400.0, "end": 2_700.25 }
            ]
        });
        assert!((cached_tail_seconds(&ready, 3_000.0) - 600.0).abs() < f64::EPSILON);

        let incomplete = serde_json::json!({
            "eof-cached": false,
            "seekable-ranges": [{ "start": 2_400.0, "end": 2_900.0 }]
        });
        assert_eq!(cached_tail_seconds(&incomplete, 3_000.0), 0.0);

        let duration_reached = serde_json::json!({
            "eof-cached": false,
            "seekable-ranges": [{ "start": 2_760.0, "end": 3_000.0 }]
        });
        assert!((cached_tail_seconds(&duration_reached, 3_000.0) - 240.0).abs() < f64::EPSILON);
    }
}

#[tauri::command]
pub async fn start_player_observing(app_handle: AppHandle) -> Result<String, String> {
    info!("DEBUG: start_player_observing called");
    // Only start if not already running - avoid duplicate watchers
    if WATCHER_RUNNING.load(Ordering::SeqCst) {
        info!("DEBUG: Player watcher already running, skipping start");
        return Ok("Player already observing".to_string());
    }

    stop_player_watcher();
    // Small delay to let old thread finish
    std::thread::sleep(Duration::from_millis(100));
    MPV_IPC_RUNNING.store(false, Ordering::SeqCst);

    info!("DEBUG: Starting player watcher");
    start_player_watcher(app_handle);
    MPV_IPC_RUNNING.store(true, Ordering::SeqCst);
    info!("DEBUG: Player observing started successfully");
    Ok("Player observing started".to_string())
}

#[tauri::command]
pub async fn stop_player_observing() -> Result<String, String> {
    info!("DEBUG: stop_player_observing called");
    stop_player_watcher();
    MPV_IPC_RUNNING.store(false, Ordering::SeqCst);
    Ok("Player observing stopped".to_string())
}

#[tauri::command]
pub async fn get_player_info() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = match connect_to_mpv_pipe() {
            Some(p) => p,
            None => return Err("MPV not connected".to_string()),
        };

        let mut player_info = serde_json::json!({
            "connected": true,
            "mpv_pid": null,
            "fullscreen": null,
            "paused": null,
            "percent_pos": null,
            "playback_time": null,
            "duration": null,
            "filename": null,
            "playlist_pos": null,
        });

        let cmd = MpvCommand {
            command: vec![serde_json::json!("get_property"), serde_json::json!("pid")],
            request_id: None,
        };
        if let Some(resp) = send_command(pipe, &cmd) {
            if let Some(data) = resp.data {
                player_info["mpv_pid"] = data;
            }
        }

        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("get_property"),
                serde_json::json!("fullscreen"),
            ],
            request_id: None,
        };
        if let Some(resp) = send_command(pipe, &cmd) {
            if let Some(data) = resp.data {
                player_info["fullscreen"] = data;
            }
        }

        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("get_property"),
                serde_json::json!("pause"),
            ],
            request_id: None,
        };
        if let Some(resp) = send_command(pipe, &cmd) {
            if let Some(data) = resp.data {
                player_info["paused"] = data;
            }
        }

        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("get_property"),
                serde_json::json!("percent-pos"),
            ],
            request_id: None,
        };
        if let Some(resp) = send_command(pipe, &cmd) {
            if let Some(data) = resp.data {
                player_info["percent_pos"] = data;
            }
        }

        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("get_property"),
                serde_json::json!("playback-time"),
            ],
            request_id: None,
        };
        if let Some(resp) = send_command(pipe, &cmd) {
            if let Some(data) = resp.data {
                player_info["playback_time"] = data;
            }
        }

        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("get_property"),
                serde_json::json!("duration"),
            ],
            request_id: None,
        };
        if let Some(resp) = send_command(pipe, &cmd) {
            if let Some(data) = resp.data {
                player_info["duration"] = data;
            }
        }

        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("get_property"),
                serde_json::json!("filename"),
            ],
            request_id: None,
        };
        if let Some(resp) = send_command(pipe, &cmd) {
            if let Some(data) = resp.data {
                player_info["filename"] = data;
            }
        }

        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("get_property"),
                serde_json::json!("playlist-pos"),
            ],
            request_id: None,
        };
        if let Some(resp) = send_command(pipe, &cmd) {
            if let Some(data) = resp.data {
                player_info["playlist_pos"] = data;
            }
        }

        unsafe {
            let _ = CloseHandle(pipe);
        }

        Ok(player_info)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Not implemented for this platform".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
pub fn start_player_watcher(_app_handle: AppHandle) {}

#[cfg(not(target_os = "windows"))]
pub fn stop_player_watcher() {}

#[cfg(target_os = "windows")]
pub fn stop_player_session() -> Result<(), String> {
    let pipe = connect_to_mpv_pipe().ok_or_else(|| "MPV not connected".to_string())?;
    let quit_cmd = MpvCommand {
        command: vec![serde_json::json!("quit")],
        request_id: None,
    };

    let result = send_command(pipe, &quit_cmd);
    unsafe {
        let _ = CloseHandle(pipe);
    }

    match result {
        Some(resp) if resp.error.as_deref().unwrap_or("success") == "success" => Ok(()),
        Some(resp) => Err(resp
            .error
            .unwrap_or_else(|| "Failed to stop player".to_string())),
        None => Err("No response from MPV".to_string()),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn stop_player_session() -> Result<(), String> {
    Err("Not implemented for this platform".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn start_player_observing(_app_handle: AppHandle) -> Result<String, String> {
    Err("Not implemented for this platform".to_string())
}

#[tauri::command]
pub async fn playlist_add(url: String, title: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = match connect_to_mpv_pipe() {
            Some(p) => p,
            None => return Err("MPV not connected".to_string()),
        };
        let mut command = vec![
            serde_json::json!("loadfile"),
            serde_json::json!(url),
            serde_json::json!("append"),
        ];
        if let Some(title) = title.filter(|title| !title.trim().is_empty()) {
            command.push(serde_json::json!(-1));
            command.push(serde_json::json!({
                "force-media-title": title,
            }));
        }
        let cmd = MpvCommand {
            command,
            request_id: None,
        };
        let result = send_command(pipe, &cmd);
        unsafe {
            let _ = CloseHandle(pipe);
        }
        confirmed_unit_command(result, "playlist append")
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Not implemented for this platform".to_string())
    }
}

fn mpv_start_option(start_position: Option<f64>) -> Option<String> {
    start_position
        .filter(|position| position.is_finite() && *position > 0.0)
        .map(|position| format!("{}%", position.clamp(0.0, 100.0)))
}

pub fn load_file_replace_with_title(
    url: &str,
    title: Option<&str>,
    start_position: Option<f64>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = connect_to_mpv_pipe().ok_or_else(|| "MPV not connected".to_string())?;
        let mut command = vec![
            serde_json::json!("loadfile"),
            serde_json::json!(url),
            serde_json::json!("replace"),
        ];
        let mut options = serde_json::Map::new();
        if let Some(title) = title.filter(|title| !title.trim().is_empty()) {
            options.insert("force-media-title".to_string(), serde_json::json!(title));
        }
        if let Some(start) = mpv_start_option(start_position) {
            info!("[MPV IPC] Loading file with atomic resume start {start}");
            options.insert("start".to_string(), serde_json::json!(start));
        }
        if !options.is_empty() {
            command.push(serde_json::json!(-1));
            command.push(serde_json::Value::Object(options));
        }
        let cmd = MpvCommand {
            command,
            request_id: None,
        };
        let result = send_command(pipe, &cmd);
        unsafe {
            let _ = CloseHandle(pipe);
        }

        match result.and_then(|response| response.error) {
            Some(error) if error == "success" => Ok(()),
            Some(error) => Err(format!("MPV loadfile failed: {}", error)),
            None => Err("MPV did not confirm loadfile".to_string()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
        let _ = title;
        Err("Not implemented for this platform".to_string())
    }
}

#[tauri::command]
pub async fn playlist_next() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = match connect_to_mpv_pipe() {
            Some(p) => p,
            None => return Err("MPV not connected".to_string()),
        };
        let cmd = MpvCommand {
            command: vec![serde_json::json!("playlist_next")],
            request_id: None,
        };
        let result = send_command(pipe, &cmd);
        unsafe {
            let _ = CloseHandle(pipe);
        }
        confirmed_unit_command(result, "playlist next")
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Not implemented for this platform".to_string())
    }
}

#[tauri::command]
pub async fn playlist_prev() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = match connect_to_mpv_pipe() {
            Some(p) => p,
            None => return Err("MPV not connected".to_string()),
        };
        let cmd = MpvCommand {
            command: vec![serde_json::json!("playlist_prev")],
            request_id: None,
        };
        let result = send_command(pipe, &cmd);
        unsafe {
            let _ = CloseHandle(pipe);
        }
        confirmed_unit_command(result, "playlist previous")
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Not implemented for this platform".to_string())
    }
}

#[tauri::command]
pub async fn get_playlist_info() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let pipe = match connect_to_mpv_pipe() {
            Some(p) => p,
            None => return Err("MPV not connected".to_string()),
        };
        let cmd = MpvCommand {
            command: vec![
                serde_json::json!("get_property"),
                serde_json::json!("playlist"),
            ],
            request_id: None,
        };
        let result = send_command(pipe, &cmd);
        unsafe {
            let _ = CloseHandle(pipe);
        }
        match result {
            Some(response) if response.error.as_deref() == Some("success") => {
                Ok(response.data.unwrap_or(serde_json::json!([])))
            }
            Some(response) => Err(format!(
                "MPV playlist query failed: {}",
                response
                    .error
                    .unwrap_or_else(|| "unknown error".to_string())
            )),
            None => Err("MPV did not confirm playlist query".to_string()),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Not implemented for this platform".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn stop_player_observing() -> Result<String, String> {
    Err("Not implemented for this platform".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn get_player_info() -> Result<serde_json::Value, String> {
    Err("Not implemented for this platform".to_string())
}
