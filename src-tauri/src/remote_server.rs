use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

const DEFAULT_REMOTE_PORT: u16 = 8585;
const REMOTE_HTML: &str = include_str!("../remote/index.html");
const REMOTE_MANIFEST: &str = include_str!("../remote/manifest.webmanifest");
const REMOTE_SERVICE_WORKER: &str = include_str!("../remote/sw.js");
const REMOTE_ICON: &[u8] = include_bytes!("../icons/icon.ico");
const REMOTE_ICON_192: &[u8] = include_bytes!("../remote/icon-192.png");
const REMOTE_ICON_512: &[u8] = include_bytes!("../remote/icon-512.png");

struct RemoteRuntime {
    port: u16,
    shutdown: Arc<AtomicBool>,
}

static REMOTE_RUNTIME: Lazy<Mutex<Option<RemoteRuntime>>> = Lazy::new(|| Mutex::new(None));
static REMOTE_ENABLED: AtomicBool = AtomicBool::new(false);
static REMOTE_PORT: AtomicU16 = AtomicU16::new(DEFAULT_REMOTE_PORT);

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RemoteServerInfo {
    pub(crate) enabled: bool,
    pub(crate) running: bool,
    pub(crate) port: u16,
    pub(crate) local_url: String,
    pub(crate) lan_url: String,
}

#[derive(Debug, Serialize)]
struct RemoteState {
    #[serde(flatten)]
    player: crate::mpv_ipc::RemotePlayerState,
    windows_volume: f64,
    svp_running: bool,
    normalizer_enabled: bool,
    normalizer_active: bool,
}

#[derive(Debug, Deserialize)]
struct RemoteCommand {
    command: String,
    value: Option<f64>,
}

#[derive(Debug, Serialize)]
struct CommandResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn local_network_address() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    if address.is_loopback() {
        None
    } else {
        Some(address.to_string())
    }
}

fn server_info(enabled: bool, running: bool, port: u16) -> RemoteServerInfo {
    let lan_host = local_network_address().unwrap_or_else(|| "127.0.0.1".to_string());
    RemoteServerInfo {
        enabled,
        running,
        port,
        local_url: format!("http://127.0.0.1:{port}"),
        lan_url: format!("http://{lan_host}:{port}"),
    }
}

pub(crate) fn get_info() -> RemoteServerInfo {
    let enabled = REMOTE_ENABLED.load(Ordering::SeqCst);
    let port = REMOTE_PORT.load(Ordering::SeqCst);
    match REMOTE_RUNTIME.lock() {
        Ok(runtime) => server_info(enabled, runtime.is_some(), port),
        Err(_) => server_info(enabled, false, port),
    }
}

pub(crate) fn configure(
    app: AppHandle,
    enabled: bool,
    port: u16,
) -> Result<RemoteServerInfo, String> {
    if !(1024..=65535).contains(&port) {
        return Err("Remote port must be between 1024 and 65535".to_string());
    }
    REMOTE_ENABLED.store(enabled, Ordering::SeqCst);
    REMOTE_PORT.store(port, Ordering::SeqCst);

    {
        let mut runtime = REMOTE_RUNTIME
            .lock()
            .map_err(|error| format!("Could not lock remote server state: {error}"))?;
        if enabled
            && runtime
                .as_ref()
                .map(|existing| existing.port == port)
                .unwrap_or(false)
        {
            return Ok(server_info(true, true, port));
        }
        if let Some(existing) = runtime.take() {
            existing.shutdown.store(true, Ordering::SeqCst);
        }
    }

    if !enabled {
        info!("Remote control server disabled");
        return Ok(server_info(false, false, port));
    }

    let address = format!("0.0.0.0:{port}");
    let listener = (0..20)
        .find_map(|_| match TcpListener::bind(&address) {
            Ok(listener) => Some(Ok(listener)),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                std::thread::sleep(Duration::from_millis(25));
                None
            }
            Err(error) => Some(Err(error)),
        })
        .transpose()
        .map_err(|error| format!("Could not start remote control on port {port}: {error}"))?
        .ok_or_else(|| format!("Remote control port {port} is already in use"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure remote control listener: {error}"))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let loop_shutdown = shutdown.clone();
    std::thread::spawn(move || {
        info!("Remote control listening on 0.0.0.0:{port}");
        while !loop_shutdown.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let request_app = app.clone();
                    std::thread::spawn(move || {
                        if let Err(error) = handle_connection(stream, request_app) {
                            warn!("Remote control request failed: {error}");
                        }
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(200));
                }
                Err(error) => {
                    warn!("Remote control listener error: {error}");
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
        info!("Remote control server stopped");
    });

    *REMOTE_RUNTIME
        .lock()
        .map_err(|error| format!("Could not save remote server state: {error}"))? =
        Some(RemoteRuntime { port, shutdown });
    Ok(server_info(true, true, port))
}

fn read_request(stream: &mut TcpStream) -> Result<(String, String, String, String), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut header_end = None;
    let mut content_length = 0usize;

    loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| format!("Could not read request: {error}"))?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
        if request.len() > 65_536 {
            return Err("Remote request was too large".to_string());
        }

        if header_end.is_none() {
            header_end = request.windows(4).position(|window| window == b"\r\n\r\n");
            if let Some(end) = header_end {
                let headers = String::from_utf8_lossy(&request[..end]);
                content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
            }
        }

        if let Some(end) = header_end {
            if request.len() >= end + 4 + content_length {
                break;
            }
        }
    }

    let end = header_end.ok_or_else(|| "Malformed HTTP request".to_string())?;
    let headers = String::from_utf8_lossy(&request[..end]);
    let request_line = headers
        .lines()
        .next()
        .ok_or_else(|| "Missing HTTP request line".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts
        .next()
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();
    let body_start = end + 4;
    let body_end = (body_start + content_length).min(request.len());
    let body = String::from_utf8_lossy(&request[body_start..body_end]).to_string();
    let content_type = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-type")
                .then(|| value.trim().to_ascii_lowercase())
        })
        .unwrap_or_default();
    Ok((method, path, body, content_type))
}

fn write_response<S: Write>(
    stream: &mut S,
    status: &str,
    content_type: &str,
    body: &[u8],
    cache_control: &str,
) -> Result<(), String> {
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: {cache_control}\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(headers.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|error| format!("Could not write response: {error}"))
}

fn json_response<T: Serialize, S: Write>(
    stream: &mut S,
    status: &str,
    value: &T,
) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    write_response(
        stream,
        status,
        "application/json; charset=utf-8",
        &body,
        "no-store",
    )
}

fn current_remote_state(app: &AppHandle) -> RemoteState {
    let mut player = crate::mpv_ipc::remote_player_state().unwrap_or_default();
    if player.connected {
        if let Ok(pid) = crate::mpv_ipc::current_player_pid() {
            if let Ok(hdr) = crate::get_mpv_monitor_hdr_state(pid) {
                player.hdr_supported = hdr.supported;
                player.hdr_enabled = hdr.enabled;
            }
        }
    }
    let normalizer_config = crate::audio_normalizer::get_config();
    let normalizer_state = crate::audio_normalizer::get_state();
    RemoteState {
        player,
        windows_volume: crate::windows_volume::get_master_volume().unwrap_or(0.0),
        svp_running: is_svp_running(app),
        normalizer_enabled: normalizer_config.enabled,
        normalizer_active: normalizer_config.enabled && normalizer_state.connected,
    }
}

#[cfg(target_os = "windows")]
fn svp_image_name(app: &AppHandle) -> Option<String> {
    PathBuf::from(crate::get_svp_executable_path(app))
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
}

#[cfg(target_os = "windows")]
fn is_svp_running(app: &AppHandle) -> bool {
    let Some(image_name) = svp_image_name(app) else {
        return false;
    };
    let mut command = std::process::Command::new("tasklist");
    command.creation_flags(CREATE_NO_WINDOW.0);
    command
        .args([
            "/FI",
            &format!("IMAGENAME eq {image_name}"),
            "/FO",
            "CSV",
            "/NH",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .to_ascii_lowercase()
                .contains(&format!("\"{}\"", image_name.to_ascii_lowercase()))
        })
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn is_svp_running(_app: &AppHandle) -> bool {
    false
}

fn execute_command(app: &AppHandle, command: RemoteCommand) -> Result<(), String> {
    match command.command.as_str() {
        "windows_volume_set" => {
            crate::windows_volume::set_master_volume(command.value.unwrap_or(100.0))?;
            Ok(())
        }
        "windows_volume_step" => {
            crate::windows_volume::step_master_volume(command.value.unwrap_or(0.0))?;
            Ok(())
        }
        "hdr_toggle" => {
            let pid = crate::mpv_ipc::current_player_pid()?;
            let state = crate::toggle_mpv_monitor_hdr(pid)?;
            if !state.supported {
                return Err("HDR is not supported on the playback monitor".to_string());
            }
            crate::suppress_auto_hdr_for_manual_restart();
            Ok(())
        }
        "svp_toggle" => {
            #[cfg(target_os = "windows")]
            {
                let path = crate::get_svp_executable_path(app);
                if is_svp_running(app) {
                    crate::stop_svp_process(&path)
                } else {
                    crate::start_svp_process(&path)
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                Err("SVP control is only available on Windows".to_string())
            }
        }
        "normalizer_restart" => {
            if !crate::audio_normalizer::get_config().enabled {
                return Err("Audio Normalizer is disabled in Settings".to_string());
            }
            crate::stop_audio_normalizer_and_emit(app)?;
            crate::audio_normalizer::start_normalizer(app.clone());
            Ok(())
        }
        "use_whisper" => {
            crate::mpv_ipc::current_player_pid()?;
            app.emit("remote://use-whisper", ())
                .map_err(|error| format!("Could not request Whisper subtitles: {error}"))
        }
        "subtitle_set" | "audio_set" => {
            let value = command
                .value
                .filter(|value| {
                    value.is_finite()
                        && value.fract() == 0.0
                        && *value >= i32::MIN as f64
                        && *value <= i32::MAX as f64
                })
                .ok_or_else(|| "A valid track id is required".to_string())?;
            let track_type = if command.command == "subtitle_set" {
                "sub"
            } else {
                "audio"
            };
            crate::mpv_ipc::set_player_track(track_type, value as i32)
        }
        player_command => crate::mpv_ipc::remote_player_command(player_command, command.value),
    }
}

fn handle_connection(mut stream: TcpStream, app: AppHandle) -> Result<(), String> {
    let (method, path, body, content_type) = read_request(&mut stream)?;
    match (method.as_str(), path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => write_response(
            &mut stream,
            "200 OK",
            "text/html; charset=utf-8",
            REMOTE_HTML.as_bytes(),
            "no-cache",
        ),
        ("GET", "/manifest.webmanifest") => write_response(
            &mut stream,
            "200 OK",
            "application/manifest+json; charset=utf-8",
            REMOTE_MANIFEST.as_bytes(),
            "public, max-age=3600",
        ),
        ("GET", "/sw.js") => write_response(
            &mut stream,
            "200 OK",
            "application/javascript; charset=utf-8",
            REMOTE_SERVICE_WORKER.as_bytes(),
            "no-cache",
        ),
        ("GET", "/icon.ico") => write_response(
            &mut stream,
            "200 OK",
            "image/x-icon",
            REMOTE_ICON,
            "public, max-age=86400",
        ),
        ("GET", "/icon-192.png") => write_response(
            &mut stream,
            "200 OK",
            "image/png",
            REMOTE_ICON_192,
            "public, max-age=86400",
        ),
        ("GET", "/icon-512.png") => write_response(
            &mut stream,
            "200 OK",
            "image/png",
            REMOTE_ICON_512,
            "public, max-age=86400",
        ),
        ("GET", "/api/health") => {
            json_response(&mut stream, "200 OK", &serde_json::json!({ "ok": true }))
        }
        ("GET", "/api/state") => json_response(&mut stream, "200 OK", &current_remote_state(&app)),
        ("POST", "/api/command") => {
            if !content_type.starts_with("application/json") {
                return json_response(
                    &mut stream,
                    "415 Unsupported Media Type",
                    &CommandResponse {
                        ok: false,
                        error: Some("Remote commands require application/json".to_string()),
                    },
                );
            }
            let parsed = serde_json::from_str::<RemoteCommand>(&body)
                .map_err(|error| format!("Invalid remote command: {error}"));
            match parsed.and_then(|command| execute_command(&app, command)) {
                Ok(()) => json_response(
                    &mut stream,
                    "200 OK",
                    &CommandResponse {
                        ok: true,
                        error: None,
                    },
                ),
                Err(error) => json_response(
                    &mut stream,
                    "400 Bad Request",
                    &CommandResponse {
                        ok: false,
                        error: Some(error),
                    },
                ),
            }
        }
        _ => write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not found",
            "no-store",
        ),
    }
}
