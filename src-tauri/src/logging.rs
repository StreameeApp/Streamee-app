use std::fs::{create_dir_all, rename, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::filter::{filter_fn, EnvFilter};
use tracing_subscriber::fmt;
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::prelude::*;
use tracing_subscriber::Layer;

const LOG_SCHEMA_VERSION: u64 = 1;
const MAX_LOG_FILE_BYTES: u64 = 50 * 1024 * 1024;
const LOG_ARCHIVE_COUNT: usize = 4;
const LOG_CHANNEL_CAPACITY: usize = 8_192;
const REDACTED: &str = "<redacted>";

static APP_SESSION_ID: OnceLock<String> = OnceLock::new();
static ACTIVE_MPV_LOG_PID: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
#[cfg(windows)]
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

#[derive(Clone, Debug)]
pub struct LoggingPaths {
    pub root: PathBuf,
    pub structured: PathBuf,
    pub mpv_scratch: PathBuf,
    pub file_logging_enabled: bool,
    pub app_session_id: String,
}

struct RotatingLogFile {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    max_bytes: u64,
    archive_count: usize,
}

impl RotatingLogFile {
    fn open(path: PathBuf, max_bytes: u64, archive_count: usize) -> io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            path,
            file: Some(file),
            size,
            max_bytes,
            archive_count,
        })
    }

    fn archive_path(&self, generation: usize) -> PathBuf {
        let stem = self
            .path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Streamee");
        let extension = self
            .path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("jsonl");
        self.path
            .with_file_name(format!("{stem}.{generation}.{extension}"))
    }

    fn rotate(&mut self) -> io::Result<()> {
        if let Some(mut file) = self.file.take() {
            file.flush()?;
        }

        if self.archive_count > 0 {
            let oldest = self.archive_path(self.archive_count);
            match std::fs::remove_file(&oldest) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            for generation in (1..self.archive_count).rev() {
                let source = self.archive_path(generation);
                if source.exists() {
                    rename(source, self.archive_path(generation + 1))?;
                }
            }
            if self.path.exists() {
                rename(&self.path, self.archive_path(1))?;
            }
        } else if self.path.exists() {
            std::fs::remove_file(&self.path)?;
        }

        self.file = Some(
            OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&self.path)?,
        );
        self.size = 0;
        Ok(())
    }

    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let bytes = line.as_bytes();
        if self.size > 0 && self.size.saturating_add(bytes.len() as u64) > self.max_bytes {
            self.rotate()?;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("structured log file is not open"))?;
        file.write_all(bytes)?;
        self.size = self.size.saturating_add(bytes.len() as u64);
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            file.flush()?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct EventVisitor {
    fields: Map<String, Value>,
}

impl EventVisitor {
    fn insert(&mut self, field: &Field, value: Value) {
        self.fields.insert(field.name().to_string(), value);
    }
}

impl Visit for EventVisitor {
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.insert(field, Value::Bool(value));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.insert(field, Value::Number(value.into()));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.insert(field, Value::Number(value.into()));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        let json = serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null);
        self.insert(field, json);
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.insert(field, Value::String(value.to_string()));
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.insert(field, Value::String(value.to_string()));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.insert(field, Value::String(format!("{value:?}")));
    }
}

#[derive(Clone)]
struct StructuredJsonLayer {
    sender: SyncSender<String>,
    dropped: Arc<AtomicU64>,
}

impl StructuredJsonLayer {
    fn send_line(&self, line: String) {
        match self.sender.try_send(line) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn report_dropped_if_needed(&self) {
        let dropped = self.dropped.swap(0, Ordering::AcqRel);
        if dropped == 0 {
            return;
        }
        match self.sender.try_send(dropped_event_line(dropped)) {
            Ok(()) => {}
            Err(_) => {
                self.dropped.fetch_add(dropped, Ordering::Relaxed);
            }
        }
    }
}

fn dropped_event_line(dropped: u64) -> String {
    json_line(structured_value(
        Level::WARN,
        "streamee_lib::logging",
        Map::from_iter([
            ("source".to_string(), Value::String("backend".to_string())),
            (
                "subsystem".to_string(),
                Value::String("logging".to_string()),
            ),
            (
                "event".to_string(),
                Value::String("logger.events_dropped".to_string()),
            ),
            (
                "message".to_string(),
                Value::String("Structured logging queue overflowed".to_string()),
            ),
            ("dropped_count".to_string(), Value::Number(dropped.into())),
        ]),
    ))
}

impl<S> Layer<S> for StructuredJsonLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        self.report_dropped_if_needed();
        let mut visitor = EventVisitor::default();
        event.record(&mut visitor);
        let value = structured_value(
            *event.metadata().level(),
            event.metadata().target(),
            visitor.fields,
        );
        self.send_line(json_line(value));
    }
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn default_subsystem(target: &str) -> String {
    target
        .strip_prefix("streamee_lib::")
        .unwrap_or(target)
        .replace("::", ".")
}

fn normalize_identifier(value: &str) -> String {
    value
        .chars()
        .take(120)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn legacy_subsystem(message: &str) -> Option<String> {
    let mut rest = message.trim_start();
    let mut segments = Vec::new();
    while let Some(after_open) = rest.strip_prefix('[') {
        let end = after_open.find(']')?;
        let segment = normalize_identifier(&after_open[..end]);
        if !segment.is_empty() {
            segments.push(segment);
        }
        rest = &after_open[end + 1..];
    }
    (!segments.is_empty()).then(|| segments.join("."))
}

fn legacy_message_field(message: &str, key: &str) -> Option<Value> {
    let lower = message.to_ascii_lowercase();
    let pattern = format!("{}=", key.to_ascii_lowercase());
    let start = lower.find(&pattern)? + pattern.len();
    let end = message[start..]
        .find(|ch: char| matches!(ch, ',' | ' ' | '\t' | '\r' | '\n' | ']' | ';'))
        .map(|offset| start + offset)
        .unwrap_or(message.len());
    let raw = message[start..end].trim_matches(|ch| matches!(ch, '"' | '\''));
    if raw.is_empty() {
        return None;
    }
    if matches!(key, "duration_ms" | "session_id" | "request_id") {
        if let Ok(value) = raw.parse::<u64>() {
            return Some(Value::Number(value.into()));
        }
    }
    Some(Value::String(raw.to_string()))
}

fn take_string(fields: &mut Map<String, Value>, key: &str) -> Option<String> {
    fields.remove(key).map(|value| match value {
        Value::String(value) => value,
        other => other.to_string(),
    })
}

fn structured_value(level: Level, target: &str, mut fields: Map<String, Value>) -> Value {
    if let Some(Value::String(fields_json)) = fields.remove("fields_json") {
        if let Ok(Value::Object(extra_fields)) = serde_json::from_str::<Value>(&fields_json) {
            for (key, value) in extra_fields {
                fields.entry(key).or_insert(value);
            }
        }
    }
    let message =
        take_string(&mut fields, "message").unwrap_or_else(|| "Structured log event".to_string());
    let source = take_string(&mut fields, "source").unwrap_or_else(|| "backend".to_string());
    let subsystem = take_string(&mut fields, "subsystem")
        .unwrap_or_else(|| legacy_subsystem(&message).unwrap_or_else(|| default_subsystem(target)));
    let event = take_string(&mut fields, "event")
        .unwrap_or_else(|| format!("{}.message", normalize_identifier(&subsystem)));

    let mut root = Map::from_iter([
        (
            "schema_version".to_string(),
            Value::Number(LOG_SCHEMA_VERSION.into()),
        ),
        (
            "timestamp".to_string(),
            Value::Number(unix_timestamp_ms().into()),
        ),
        (
            "level".to_string(),
            Value::String(level.as_str().to_ascii_lowercase()),
        ),
        ("source".to_string(), Value::String(source)),
        ("subsystem".to_string(), Value::String(subsystem)),
        ("event".to_string(), Value::String(event)),
        ("message".to_string(), Value::String(message.clone())),
        (
            "app_session_id".to_string(),
            Value::String(app_session_id().to_string()),
        ),
        ("target".to_string(), Value::String(target.to_string())),
    ]);

    for key in [
        "playback_session_id",
        "session_id",
        "request_id",
        "provider",
        "duration_ms",
        "error_kind",
        "status",
    ] {
        if let Some(value) = fields
            .remove(key)
            .or_else(|| legacy_message_field(&message, key))
        {
            root.insert(key.to_string(), value);
        }
    }
    if !fields.is_empty() {
        root.insert("fields".to_string(), Value::Object(fields));
    }

    let mut value = Value::Object(root);
    redact_json_value(&mut value);
    value
}

fn json_line(value: Value) -> String {
    let mut line = serde_json::to_string(&value).unwrap_or_else(|error| {
        format!(
            "{{\"schema_version\":1,\"timestamp\":{},\"level\":\"error\",\"source\":\"backend\",\"subsystem\":\"logging\",\"event\":\"logger.serialize_failed\",\"message\":{}}}",
            unix_timestamp_ms(),
            serde_json::to_string(&error.to_string())
                .unwrap_or_else(|_| "\"serialization failed\"".to_string())
        )
    });
    line.push('\n');
    line
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    [
        "password",
        "passwd",
        "secret",
        "token",
        "apikey",
        "authorization",
        "cookie",
        "passkey",
        "signature",
        "authkey",
        "rsskey",
        "downloadkey",
        "magnet",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

pub fn redact_text(input: &str) -> String {
    let trimmed = input.trim_start();
    if trimmed.to_ascii_lowercase().starts_with("magnet:?") {
        return "magnet:?<redacted>".to_string();
    }

    let mut redacted = redact_url_user_info(input);
    for key in [
        "apikey",
        "api_key",
        "x-api-key",
        "token",
        "access_token",
        "refresh_token",
        "security_token",
        "authorization",
        "cookie",
        "set-cookie",
        "password",
        "secret",
        "auth",
        "signature",
        "sig",
        "credential",
        "key-pair-id",
        "policy",
        "expires",
        "passkey",
        "authkey",
        "rsskey",
        "download_key",
    ] {
        for separator in ["=", "%3d", ":"] {
            let pattern = format!("{key}{separator}");
            let mut search_from = 0;
            while search_from < redacted.len() {
                let lower = redacted[search_from..].to_ascii_lowercase();
                let Some(relative_start) = lower.find(&pattern) else {
                    break;
                };
                let value_start = search_from + relative_start + pattern.len();
                let value_end = redacted[value_start..]
                    .find(|ch: char| matches!(ch, '&' | ',' | ' ' | '\"' | '\'' | '}' | ']'))
                    .map(|index| value_start + index)
                    .unwrap_or(redacted.len());
                if value_end > value_start {
                    redacted.replace_range(value_start..value_end, REDACTED);
                }
                search_from = value_start.saturating_add(REDACTED.len());
            }
        }
    }

    let lower = redacted.to_ascii_lowercase();
    if let Some(start) = lower.find("bearer ") {
        let value_start = start + "bearer ".len();
        let value_end = redacted[value_start..]
            .find(char::is_whitespace)
            .map(|index| value_start + index)
            .unwrap_or(redacted.len());
        redacted.replace_range(value_start..value_end, REDACTED);
    }
    redacted
}

fn redact_url_user_info(input: &str) -> String {
    let mut output = input.to_string();
    let mut search_from = 0;
    while search_from < output.len() {
        let Some(scheme_offset) = output[search_from..].find("://") else {
            break;
        };
        let authority_start = search_from + scheme_offset + 3;
        let authority_end = output[authority_start..]
            .find(|ch: char| {
                matches!(
                    ch,
                    '/' | '?' | '#' | ' ' | '\t' | '\r' | '\n' | '"' | '\'' | ',' | '}' | ']'
                )
            })
            .map(|offset| authority_start + offset)
            .unwrap_or(output.len());
        let user_info_end = output[authority_start..authority_end]
            .rfind('@')
            .map(|offset| authority_start + offset);
        if let Some(user_info_end) = user_info_end {
            output.replace_range(authority_start..user_info_end, REDACTED);
            search_from = authority_start + REDACTED.len() + 1;
        } else {
            search_from = authority_end.max(authority_start.saturating_add(1));
        }
    }
    output
}

pub fn redact_json_value(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object.iter_mut() {
                if is_sensitive_key(key) {
                    *value = Value::String(REDACTED.to_string());
                } else {
                    redact_json_value(value);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                redact_json_value(value);
            }
        }
        Value::String(text) => {
            *text = redact_text(text);
        }
        _ => {}
    }
}

pub fn app_session_id() -> &'static str {
    APP_SESSION_ID.get_or_init(|| format!("{}-{}", unix_timestamp_ms(), std::process::id()))
}

#[derive(Debug, PartialEq)]
struct MpvLogLine {
    elapsed_ms: u64,
    level: String,
    module: String,
    message: String,
}

fn parse_mpv_log_line(line: &str) -> Option<MpvLogLine> {
    let line = line.trim_end();
    let elapsed_end = line.find(']')?;
    let elapsed_seconds = line.get(1..elapsed_end)?.trim().parse::<f64>().ok()?;
    let after_elapsed = line.get(elapsed_end + 1..)?;
    let level_end = after_elapsed.find(']')?;
    let level = after_elapsed.get(1..level_end)?.trim().to_string();
    let after_level = after_elapsed.get(level_end + 1..)?;
    let module_end = after_level.find(']')?;
    let module = after_level.get(1..module_end)?.trim().to_string();
    let message = after_level.get(module_end + 1..)?.trim_start().to_string();
    Some(MpvLogLine {
        elapsed_ms: (elapsed_seconds.max(0.0) * 1_000.0).round() as u64,
        level,
        module,
        message,
    })
}

fn mpv_noise_category(entry: &MpvLogLine) -> Option<&'static str> {
    if !matches!(
        entry.level.to_ascii_lowercase().as_str(),
        "d" | "debug" | "v" | "verbose" | "trace"
    ) {
        return None;
    }

    let module = entry.module.to_ascii_lowercase();
    let message = entry.message.trim();

    if module == "swscale" && message == "Using zimg." {
        return Some("swscale_reinitialization");
    }

    if module == "ffmpeg"
        && (message.starts_with("Parsed_ebur128_") || message.starts_with("filter: n:"))
    {
        return Some("audio_meter_frame");
    }

    if module == "cplayer"
        && message.starts_with("Run command: af-command")
        && message.contains("label=\"rider-")
    {
        return Some("normalizer_filter_command");
    }

    // MPV emits the fully expanded menu configuration whenever scripts refresh
    // it. This can be tens of kilobytes and does not describe playback state.
    if module == "cplayer" && message.starts_with("Set property: user-data/menu/items=") {
        return Some("menu_configuration");
    }

    if module.starts_with("ipc_")
        && (matches!(message, "Client connected" | "Client disconnected")
            || message.starts_with("Destroying client handle"))
    {
        return Some("ipc_client_lifecycle");
    }

    if module == "vo/gpu-next/libplacebo" {
        if message.starts_with("Discontinuous source PTS jump ") {
            return Some("source_pts_discontinuity");
        }

        if matches!(message, "fragment shader source:" | "vertex shader source:") {
            return Some("shader_source");
        }

        if let Some((line_number, _)) = message
            .strip_prefix('[')
            .and_then(|rest| rest.split_once(']'))
        {
            let line_number = line_number.trim();
            if !line_number.is_empty() && line_number.chars().all(|ch| ch.is_ascii_digit()) {
                return Some("shader_source");
            }
        }
    }

    if module == "lavfi"
        && (message.is_empty()
            || message == "Filter graph:"
            || message.starts_with('+')
            || message.starts_with('|'))
    {
        return Some("filter_graph_diagram");
    }

    None
}

fn mpv_subsystem(module: &str) -> String {
    let module = module
        .chars()
        .take(80)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("mpv.{}", module.trim_matches('_'))
}

fn thumbfast_metadata(message: &str) -> Option<(&'static str, &'static str, Option<u64>)> {
    let (event, status) = if message.starts_with("[Thumbfast] preview unavailable:") {
        ("thumbfast.preview.unavailable", "cache_miss")
    } else if message.starts_with("[Thumbfast] preview timed out:") {
        ("thumbfast.preview.timed_out", "timeout")
    } else if message.starts_with("[Thumbfast] preview rendered:") {
        ("thumbfast.preview.rendered", "rendered")
    } else if message.starts_with("[Thumbfast] helper started:") {
        ("thumbfast.helper.started", "started")
    } else if message.starts_with("[Thumbfast] helper failed:") {
        ("thumbfast.helper.failed", "failed")
    } else if message.starts_with("[Thumbfast] helper exited:") {
        ("thumbfast.helper.exited", "completed")
    } else if message.starts_with("[Thumbfast] helper stopping:") {
        ("thumbfast.helper.stopping", "stopping")
    } else if message.starts_with("[Thumbfast] helper idle cleanup:") {
        ("thumbfast.helper.inactive", "inactive")
    } else if message.starts_with("[Thumbfast] helper not started:") {
        ("thumbfast.helper.not_started", "unsupported_source")
    } else {
        return None;
    };

    let duration_ms = message
        .split_whitespace()
        .find_map(|part| part.strip_prefix("duration_ms="))
        .and_then(|value| value.parse::<u64>().ok());
    Some((event, status, duration_ms))
}

fn emit_mpv_log_line(pid: u32, entry: MpvLogLine) {
    let subsystem = mpv_subsystem(&entry.module);
    let message = redact_text(&entry.message);
    if let Some((event, status, duration_ms)) = thumbfast_metadata(&message) {
        match entry.level.to_ascii_lowercase().as_str() {
            "f" | "fatal" | "e" | "error" => tracing::error!(
                target: "streamee_lib::mpv",
                source = "mpv",
                subsystem = "mpv.thumbfast",
                event = event,
                playback_session_id = pid,
                status = status,
                duration_ms = duration_ms,
                mpv_elapsed_ms = entry.elapsed_ms,
                mpv_level = %entry.level,
                "{message}"
            ),
            "w" | "warn" => tracing::warn!(
                target: "streamee_lib::mpv",
                source = "mpv",
                subsystem = "mpv.thumbfast",
                event = event,
                playback_session_id = pid,
                status = status,
                duration_ms = duration_ms,
                mpv_elapsed_ms = entry.elapsed_ms,
                mpv_level = %entry.level,
                "{message}"
            ),
            _ => tracing::info!(
                target: "streamee_lib::mpv",
                source = "mpv",
                subsystem = "mpv.thumbfast",
                event = event,
                playback_session_id = pid,
                status = status,
                duration_ms = duration_ms,
                mpv_elapsed_ms = entry.elapsed_ms,
                mpv_level = %entry.level,
                "{message}"
            ),
        }
        return;
    }
    match entry.level.to_ascii_lowercase().as_str() {
        "f" | "fatal" | "e" | "error" => tracing::error!(
            target: "streamee_lib::mpv",
            source = "mpv",
            subsystem = %subsystem,
            event = "mpv.message",
            playback_session_id = pid,
            mpv_elapsed_ms = entry.elapsed_ms,
            mpv_level = %entry.level,
            "{message}"
        ),
        "w" | "warn" => tracing::warn!(
            target: "streamee_lib::mpv",
            source = "mpv",
            subsystem = %subsystem,
            event = "mpv.message",
            playback_session_id = pid,
            mpv_elapsed_ms = entry.elapsed_ms,
            mpv_level = %entry.level,
            "{message}"
        ),
        "i" | "info" | "s" | "status" => tracing::info!(
            target: "streamee_lib::mpv",
            source = "mpv",
            subsystem = %subsystem,
            event = "mpv.message",
            playback_session_id = pid,
            mpv_elapsed_ms = entry.elapsed_ms,
            mpv_level = %entry.level,
            "{message}"
        ),
        _ => tracing::debug!(
            target: "streamee_lib::mpv",
            source = "mpv",
            subsystem = %subsystem,
            event = "mpv.message",
            playback_session_id = pid,
            mpv_elapsed_ms = entry.elapsed_ms,
            mpv_level = %entry.level,
            "{message}"
        ),
    }
}

#[cfg(windows)]
fn process_is_running(pid: u32) -> bool {
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else {
        return false;
    };
    let running = unsafe { WaitForSingleObject(handle, 0) } == WAIT_TIMEOUT;
    let _ = unsafe { CloseHandle(handle) };
    running
}

#[cfg(not(windows))]
fn process_is_running(_pid: u32) -> bool {
    false
}

pub fn start_mpv_log_ingestion(path: PathBuf, pid: u32) {
    ACTIVE_MPV_LOG_PID.store(pid as u64, Ordering::SeqCst);
    let _ = std::thread::Builder::new()
        .name(format!("streamee-mpv-log-{pid}"))
        .spawn(move || {
            let mut file = None;
            for _ in 0..100 {
                if ACTIVE_MPV_LOG_PID.load(Ordering::SeqCst) != pid as u64 {
                    return;
                }
                match File::open(&path) {
                    Ok(opened) => {
                        file = Some(opened);
                        break;
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
            let Some(file) = file else {
                tracing::warn!(
                    target: "streamee_lib::mpv",
                    source = "mpv",
                    subsystem = "mpv.logging",
                    event = "mpv.log_open_failed",
                    playback_session_id = pid,
                    path = %path.display(),
                    "Could not open MPV scratch log for structured ingestion"
                );
                return;
            };

            let mut reader = BufReader::new(file);
            let mut line = String::new();
            let mut process_ended_at = None;
            let mut suppressed_noise_count = 0u64;
            loop {
                if ACTIVE_MPV_LOG_PID.load(Ordering::SeqCst) != pid as u64 {
                    break;
                }
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        if process_is_running(pid) {
                            process_ended_at = None;
                        } else {
                            let ended_at =
                                process_ended_at.get_or_insert_with(std::time::Instant::now);
                            if ended_at.elapsed() >= Duration::from_millis(500) {
                                break;
                            }
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Ok(_) => {
                        process_ended_at = None;
                        if let Some(entry) = parse_mpv_log_line(&line) {
                            if mpv_noise_category(&entry).is_some() {
                                suppressed_noise_count = suppressed_noise_count.saturating_add(1);
                            } else {
                                emit_mpv_log_line(pid, entry);
                            }
                        } else if !line.trim().is_empty() {
                            tracing::debug!(
                                target: "streamee_lib::mpv",
                                source = "mpv",
                                subsystem = "mpv.unparsed",
                                event = "mpv.unstructured_line",
                                playback_session_id = pid,
                                raw = %redact_text(line.trim()),
                                "MPV emitted an unstructured log line"
                            );
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            target: "streamee_lib::mpv",
                            source = "mpv",
                            subsystem = "mpv.logging",
                            event = "mpv.log_read_failed",
                            playback_session_id = pid,
                            error_kind = %error.kind(),
                            "Failed to read MPV scratch log: {error}"
                        );
                        break;
                    }
                }
            }

            if suppressed_noise_count > 0 {
                tracing::info!(
                    target: "streamee_lib::mpv",
                    source = "mpv",
                    subsystem = "mpv.logging",
                    event = "mpv.noise_suppressed",
                    playback_session_id = pid,
                    suppressed_count = suppressed_noise_count,
                    "Suppressed repetitive MPV debug records"
                );
            }

            if ACTIVE_MPV_LOG_PID
                .compare_exchange(pid as u64, 0, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                drop(reader);
                if let Err(error) = std::fs::remove_file(&path) {
                    if error.kind() != io::ErrorKind::NotFound {
                        tracing::debug!(
                            target: "streamee_lib::mpv",
                            source = "mpv",
                            subsystem = "mpv.logging",
                            event = "mpv.scratch_cleanup_failed",
                            playback_session_id = pid,
                            error_kind = %error.kind(),
                            "Could not remove ingested MPV scratch log: {error}"
                        );
                    }
                }
            }
        });
}

fn write_cleanup_batch(log_dir: &Path) -> Result<PathBuf, String> {
    let path = log_dir.join("DeleteStreameeLogs.bat");
    let script = r#"@echo off
setlocal
set "LOG_DIR=%~dp0"
echo Deleting Streamee log files in "%LOG_DIR%"
del /q "%LOG_DIR%Streamee.jsonl" 2>nul
del /q "%LOG_DIR%Streamee.1.jsonl" 2>nul
del /q "%LOG_DIR%Streamee.2.jsonl" 2>nul
del /q "%LOG_DIR%Streamee.3.jsonl" 2>nul
del /q "%LOG_DIR%Streamee.4.jsonl" 2>nul
del /q "%LOG_DIR%MPV.log" 2>nul
echo Done.
"#;

    std::fs::write(&path, script)
        .map_err(|error| format!("Failed to write cleanup batch {:?}: {error}", path))?;
    Ok(path)
}

fn start_writer(path: PathBuf) -> Result<StructuredJsonLayer, String> {
    let rotating = RotatingLogFile::open(path.clone(), MAX_LOG_FILE_BYTES, LOG_ARCHIVE_COUNT)
        .map_err(|error| format!("Failed to open structured log {:?}: {error}", path))?;
    let (sender, receiver) = sync_channel::<String>(LOG_CHANNEL_CAPACITY);
    let dropped = Arc::new(AtomicU64::new(0));
    let writer_dropped = dropped.clone();
    std::thread::Builder::new()
        .name("streamee-json-logger".to_string())
        .spawn(move || {
            let mut rotating = rotating;
            loop {
                match receiver.recv_timeout(Duration::from_millis(250)) {
                    Ok(line) => {
                        if let Err(error) = rotating.write_line(&line) {
                            eprintln!("[Streamee] Structured log write failed: {error}");
                        }
                        for _ in 0..LOG_CHANNEL_CAPACITY {
                            match receiver.try_recv() {
                                Ok(line) => {
                                    if let Err(error) = rotating.write_line(&line) {
                                        eprintln!(
                                            "[Streamee] Structured log write failed: {error}"
                                        );
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        let dropped = writer_dropped.swap(0, Ordering::AcqRel);
                        if dropped > 0 {
                            if let Err(error) = rotating.write_line(&dropped_event_line(dropped)) {
                                eprintln!("[Streamee] Dropped-event log write failed: {error}");
                            }
                        }
                        let _ = rotating.flush();
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        let dropped = writer_dropped.swap(0, Ordering::AcqRel);
                        if dropped > 0 {
                            if let Err(error) = rotating.write_line(&dropped_event_line(dropped)) {
                                eprintln!("[Streamee] Dropped-event log write failed: {error}");
                            }
                        }
                        let _ = rotating.flush();
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        let dropped = writer_dropped.swap(0, Ordering::AcqRel);
                        if dropped > 0 {
                            let _ = rotating.write_line(&dropped_event_line(dropped));
                        }
                        let _ = rotating.flush();
                        break;
                    }
                }
            }
        })
        .map_err(|error| format!("Failed to start structured log writer: {error}"))?;

    Ok(StructuredJsonLayer { sender, dropped })
}

fn should_capture_structured(target: &str, level: &Level) -> bool {
    (target.starts_with("streamee_lib") && *level <= Level::DEBUG) || *level <= Level::WARN
}

pub fn init_tracing() -> Result<LoggingPaths, String> {
    let root = std::env::temp_dir().join("streamee_logs");
    create_dir_all(&root)
        .map_err(|error| format!("Failed to create log directory {:?}: {error}", root))?;
    let _cleanup_batch = write_cleanup_batch(&root)?;

    let structured = root.join("Streamee.jsonl");
    let mpv_scratch = root.join("MPV.log");
    let structured_layer = start_writer(structured.clone())?.with_filter(filter_fn(|metadata| {
        should_capture_structured(metadata.target(), metadata.level())
    }));
    let console_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("warn,streamee_lib=debug"));
    let console_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(false)
        .with_ansi(cfg!(debug_assertions))
        .with_filter(console_filter);

    tracing_subscriber::registry()
        .with(console_layer)
        .with(structured_layer)
        .init();

    Ok(LoggingPaths {
        root,
        structured,
        mpv_scratch,
        file_logging_enabled: true,
        app_session_id: app_session_id().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "streamee-logging-test-{name}-{}-{}",
            std::process::id(),
            unix_timestamp_ms()
        ))
    }

    #[test]
    fn rotates_only_between_complete_lines() {
        let root = test_dir("rotation");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("Streamee.jsonl");
        let mut writer = RotatingLogFile::open(path.clone(), 24, 2).unwrap();
        writer.write_line("{\"line\":1}\n").unwrap();
        writer.write_line("{\"line\":2}\n").unwrap();
        writer.write_line("{\"line\":3}\n").unwrap();
        writer.flush().unwrap();

        let current = std::fs::read_to_string(&path).unwrap();
        let archived = std::fs::read_to_string(root.join("Streamee.1.jsonl")).unwrap();
        assert_eq!(current, "{\"line\":3}\n");
        assert_eq!(archived, "{\"line\":1}\n{\"line\":2}\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retention_never_exceeds_the_configured_generation_count() {
        let root = test_dir("retention");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("Streamee.jsonl");
        let mut writer = RotatingLogFile::open(path.clone(), 11, 4).unwrap();
        for line in 0..8 {
            writer
                .write_line(&format!("{{\"line\":{line}}}\n"))
                .unwrap();
        }
        writer.flush().unwrap();

        assert!(path.exists());
        for generation in 1..=4 {
            assert!(root.join(format!("Streamee.{generation}.jsonl")).exists());
        }
        assert!(!root.join("Streamee.5.jsonl").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queue_overload_is_reported_as_a_structured_event() {
        let (sender, receiver) = sync_channel::<String>(1);
        let layer = StructuredJsonLayer {
            sender,
            dropped: Arc::new(AtomicU64::new(0)),
        };
        layer.send_line("first\n".to_string());
        layer.send_line("second\n".to_string());
        assert_eq!(receiver.recv().unwrap(), "first\n");

        layer.report_dropped_if_needed();
        let dropped: Value = serde_json::from_str(receiver.recv().unwrap().trim()).unwrap();
        assert_eq!(dropped["event"], "logger.events_dropped");
        assert_eq!(dropped["fields"]["dropped_count"], 1);
    }

    #[test]
    fn release_logging_policy_keeps_app_debug_and_dependency_warnings() {
        assert!(should_capture_structured(
            "streamee_lib::torrent",
            &Level::DEBUG
        ));
        assert!(should_capture_structured("reqwest", &Level::WARN));
        assert!(!should_capture_structured("reqwest", &Level::INFO));
        assert!(!should_capture_structured(
            "streamee_lib::torrent",
            &Level::TRACE
        ));
    }

    #[test]
    fn recursively_redacts_credentials_and_magnets() {
        let mut value = serde_json::json!({
            "accessToken": "top-secret",
            "nested": {
                "url": "https://example.test/file?token=abc&safe=1",
                "source": "magnet:?xt=urn:btih:123"
            }
        });
        redact_json_value(&mut value);
        assert_eq!(value["accessToken"], REDACTED);
        assert_eq!(
            value["nested"]["url"],
            "https://example.test/file?token=<redacted>&safe=1"
        );
        assert_eq!(value["nested"]["source"], "magnet:?<redacted>");
    }

    #[test]
    fn redacts_url_user_info_and_signed_query_values() {
        assert_eq!(
            redact_text(
                "request=https://viewer:password@example.test/video?X-Amz-Credential=abc&safe=1"
            ),
            "request=https://<redacted>@example.test/video?X-Amz-Credential=<redacted>&safe=1"
        );
    }

    #[test]
    fn structured_event_contains_required_filter_fields() {
        let value = structured_value(
            Level::INFO,
            "streamee_lib::torrent",
            Map::from_iter([
                (
                    "event".to_string(),
                    Value::String("torrent.ready".to_string()),
                ),
                ("session_id".to_string(), Value::Number(42.into())),
            ]),
        );
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["level"], "info");
        assert_eq!(value["source"], "backend");
        assert_eq!(value["subsystem"], "torrent");
        assert_eq!(value["event"], "torrent.ready");
        assert_eq!(value["session_id"], 42);
        assert!(value.get("status").is_none());
        assert!(value["timestamp"].as_u64().is_some());
        assert!(value["app_session_id"].as_str().is_some());
    }

    #[test]
    fn explicit_status_is_preserved_without_inference_from_log_level() {
        let explicit = structured_value(
            Level::INFO,
            "streamee_lib::torrent",
            Map::from_iter([("status".to_string(), Value::String("ready".to_string()))]),
        );
        let failure = structured_value(Level::ERROR, "streamee_lib::torrent", Map::new());

        assert_eq!(explicit["status"], "ready");
        assert!(failure.get("status").is_none());
    }

    #[test]
    fn legacy_messages_gain_filterable_subsystems_and_known_fields() {
        let value = structured_value(
            Level::INFO,
            "streamee_lib",
            Map::from_iter([(
                "message".to_string(),
                Value::String(
                    "[Add-on][Proxy] Complete: provider=addon session_id=42 status=206 duration_ms=18"
                        .to_string(),
                ),
            )]),
        );
        assert_eq!(value["subsystem"], "add-on.proxy");
        assert_eq!(value["event"], "add-on.proxy.message");
        assert_eq!(value["provider"], "addon");
        assert_eq!(value["session_id"], 42);
        assert_eq!(value["status"], "206");
        assert_eq!(value["duration_ms"], 18);
    }

    #[test]
    fn renderer_fields_promote_decimal_duration_to_the_top_level_schema() {
        let value = structured_value(
            Level::INFO,
            "streamee_lib::renderer",
            Map::from_iter([
                (
                    "message".to_string(),
                    Value::String(
                        "[Performance] Board catalogs first row ready: 33.5ms".to_string(),
                    ),
                ),
                ("source".to_string(), Value::String("renderer".to_string())),
                (
                    "fields_json".to_string(),
                    Value::String(r#"{"duration_ms":33.5}"#.to_string()),
                ),
            ]),
        );

        assert_eq!(value["duration_ms"].as_f64(), Some(33.5));
        assert!(value.get("fields").is_none());
    }

    #[test]
    fn parses_mpv_elapsed_level_module_and_message() {
        let parsed = parse_mpv_log_line(
            "[  69.150][d][vo/gpu-next/libplacebo] Discontinuous source PTS jump",
        )
        .expect("MPV line should parse");
        assert_eq!(parsed.elapsed_ms, 69_150);
        assert_eq!(parsed.level, "d");
        assert_eq!(parsed.module, "vo/gpu-next/libplacebo");
        assert_eq!(parsed.message, "Discontinuous source PTS jump");
        assert_eq!(mpv_subsystem(&parsed.module), "mpv.vo_gpu-next_libplacebo");
    }

    #[test]
    fn promotes_thumbfast_lifecycle_messages() {
        assert_eq!(
            thumbfast_metadata(
                "[Thumbfast] preview rendered: request_time=42.000 duration_ms=87 status=rendered width=200 height=112"
            ),
            Some(("thumbfast.preview.rendered", "rendered", Some(87)))
        );
        assert_eq!(
            thumbfast_metadata(
                "[Thumbfast] preview unavailable: cache_state=outside_seekable_range request_time=42.000 status=cache_miss"
            ),
            Some(("thumbfast.preview.unavailable", "cache_miss", None))
        );
        assert_eq!(thumbfast_metadata("unrelated MPV message"), None);
    }

    #[test]
    fn suppresses_only_known_repetitive_mpv_debug_records() {
        let entry = |level: &str, module: &str, message: &str| MpvLogLine {
            elapsed_ms: 0,
            level: level.to_string(),
            module: module.to_string(),
            message: message.to_string(),
        };

        assert_eq!(
            mpv_noise_category(&entry("d", "swscale", "Using zimg.")),
            Some("swscale_reinitialization")
        );
        assert_eq!(
            mpv_noise_category(&entry(
                "debug",
                "ffmpeg",
                "Parsed_ebur128_0: t: 1.0 TARGET:-23 LUFS"
            )),
            Some("audio_meter_frame")
        );
        assert_eq!(
            mpv_noise_category(&entry(
                "d",
                "cplayer",
                "Run command: af-command, flags=64, args=[label=\"rider-gain\"]"
            )),
            Some("normalizer_filter_command")
        );
        assert_eq!(
            mpv_noise_category(&entry(
                "v",
                "cplayer",
                "Set property: user-data/menu/items=[{\"type\":\"submenu\"}]"
            )),
            Some("menu_configuration")
        );
        assert_eq!(
            mpv_noise_category(&entry("d", "ipc_632", "Client connected")),
            Some("ipc_client_lifecycle")
        );
        assert_eq!(
            mpv_noise_category(&entry("d", "vo/gpu-next/libplacebo", "[  1] #version 450")),
            Some("shader_source")
        );
        assert_eq!(
            mpv_noise_category(&entry("d", "lavfi", "+-------------+")),
            Some("filter_graph_diagram")
        );

        assert_eq!(
            mpv_noise_category(&entry("warn", "swscale", "Using zimg.")),
            None
        );
        assert_eq!(
            mpv_noise_category(&entry(
                "d",
                "vo/gpu-next/libplacebo",
                "Discontinuous source PTS jump 130.910799 -> 130.928513"
            )),
            Some("source_pts_discontinuity")
        );
        assert_eq!(
            mpv_noise_category(&entry(
                "warn",
                "vo/gpu-next/libplacebo",
                "Discontinuous source PTS jump 130.910799 -> 130.928513"
            )),
            None
        );
        assert_eq!(
            mpv_noise_category(&entry("d", "cplayer", "Failed to open stream")),
            None
        );
    }
}
