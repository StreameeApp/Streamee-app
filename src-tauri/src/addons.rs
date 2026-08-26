use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use reqwest::{redirect::Policy, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, ToSocketAddrs},
    time::{Duration, Instant},
};
use uuid::Uuid;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const STREAM_HANDLE_TTL: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Clone)]
struct AddonStreamHandle {
    installation_id: String,
    source_url: String,
    created_at: Instant,
}

static STREAM_HANDLES: Lazy<Mutex<HashMap<String, AddonStreamHandle>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static ADDON_STREAM_SIZE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)\b")
        .expect("add-on stream size regex must compile")
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonResourceDescriptor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub types: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub id_prefixes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AddonResource {
    Name(String),
    Descriptor(AddonResourceDescriptor),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonBehaviorHints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adult: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p2p: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configurable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_required: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonManifestSnapshot {
    pub id: String,
    pub version: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    pub resources: Vec<AddonResource>,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub id_prefixes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior_hints: Option<AddonBehaviorHints>,
}

impl AddonManifestSnapshot {
    fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() || self.version.trim().is_empty() || self.name.trim().is_empty() {
            return Err("The add-on manifest is missing its id, version, or name".to_string());
        }
        if self.resources.is_empty() {
            return Err("The add-on manifest does not declare any resources".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAddonRecord {
    pub installation_id: String,
    pub addon_id: String,
    pub manifest_url_secret_ref: String,
    pub manifest: AddonManifestSnapshot,
    pub enabled: bool,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonStreamRequest {
    pub installation_id: String,
    pub media_type: String,
    pub content_id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StremioStreamBehaviorHints {
    filename: Option<String>,
    video_size: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StremioStream {
    name: Option<String>,
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    info_hash: Option<String>,
    file_idx: Option<u32>,
    #[serde(default)]
    behavior_hints: StremioStreamBehaviorHints,
}

#[derive(Debug, Deserialize)]
struct StremioStreamResponse {
    #[serde(default)]
    streams: Vec<StremioStream>,
}

fn parse_addon_stream_size(values: impl IntoIterator<Item = impl AsRef<str>>) -> Option<u64> {
    for value in values {
        let Some(captures) = ADDON_STREAM_SIZE_RE.captures(value.as_ref()) else {
            continue;
        };
        let amount = captures.get(1)?.as_str().parse::<f64>().ok()?;
        let multiplier = match captures.get(2)?.as_str().to_ascii_uppercase().as_str() {
            "KB" => 1024_u64,
            "MB" => 1024_u64.pow(2),
            "GB" => 1024_u64.pow(3),
            "TB" => 1024_u64.pow(4),
            _ => continue,
        };
        let bytes = amount * multiplier as f64;
        if amount > 0.0 && bytes.is_finite() && bytes <= u64::MAX as f64 {
            return Some(bytes.round() as u64);
        }
    }
    None
}

fn addon_stream_size(stream: &StremioStream) -> Option<u64> {
    stream
        .behavior_hints
        .video_size
        .filter(|size| *size > 0)
        .or_else(|| {
            parse_addon_stream_size(
                [
                    stream.title.as_deref(),
                    stream.name.as_deref(),
                    stream.description.as_deref(),
                    stream.behavior_hints.filename.as_deref(),
                ]
                .into_iter()
                .flatten(),
            )
        })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonStreamResult {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub playback_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

fn credential_target(installation_id: &str) -> String {
    format!("Streamee/addon/{installation_id}/manifestUrl")
}

fn secret_ref(installation_id: &str) -> String {
    format!("addon-manifest-url:{installation_id}")
}

#[cfg(windows)]
fn vault_write(installation_id: &str, value: &str) -> Result<(), String> {
    use windows::core::PWSTR;
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let mut target = credential_target(installation_id)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut username = "Streamee"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut blob = value.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(username.as_mut_ptr()),
        ..Default::default()
    };
    unsafe { CredWriteW(&credential, 0) }
        .map_err(|error| format!("Windows Credential Manager rejected the add-on URL: {error}"))
}

#[cfg(windows)]
fn vault_read(installation_id: &str) -> Result<Option<String>, String> {
    use std::ptr::null_mut;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target = credential_target(installation_id)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut credential: *mut CREDENTIALW = null_mut();
    let result = unsafe {
        CredReadW(
            PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut credential,
        )
    };
    if let Err(error) = result {
        if error.code() == ERROR_NOT_FOUND.to_hresult() {
            return Ok(None);
        }
        return Err(format!(
            "Windows Credential Manager could not read the add-on URL: {error}"
        ));
    }
    if credential.is_null() {
        return Ok(None);
    }
    let value = unsafe {
        let record = &*credential;
        let bytes =
            std::slice::from_raw_parts(record.CredentialBlob, record.CredentialBlobSize as usize);
        let value = String::from_utf8(bytes.to_vec())
            .map_err(|_| "The stored add-on URL is not valid UTF-8".to_string());
        CredFree(credential.cast());
        value
    }?;
    Ok(Some(value))
}

#[cfg(windows)]
fn vault_delete(installation_id: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    let target = credential_target(installation_id)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
        Err(error) => Err(format!(
            "Windows Credential Manager could not delete the add-on URL: {error}"
        )),
    }
}

#[cfg(not(windows))]
fn vault_write(_installation_id: &str, _value: &str) -> Result<(), String> {
    Err("Secure add-on URL storage is available only on Windows".to_string())
}

#[cfg(not(windows))]
fn vault_read(_installation_id: &str) -> Result<Option<String>, String> {
    Err("Secure add-on URL storage is available only on Windows".to_string())
}

#[cfg(not(windows))]
fn vault_delete(_installation_id: &str) -> Result<(), String> {
    Err("Secure add-on URL storage is available only on Windows".to_string())
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

fn is_forbidden_remote_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_broadcast()
                || address.is_multicast()
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
        }
    }
}

fn normalize_manifest_url(value: &str) -> Result<Url, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Enter an add-on manifest URL".to_string());
    }
    let normalized = if let Some(rest) = trimmed.strip_prefix("stremio://") {
        format!("https://{rest}")
    } else {
        trimmed.to_string()
    };
    let mut url = Url::parse(&normalized).map_err(|_| "The add-on manifest URL is invalid")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Add-on URLs cannot contain HTTP username or password fields".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "The add-on manifest URL has no host".to_string())?;
    let loopback = is_loopback_host(host);
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("Add-on URLs must use HTTPS; HTTP is allowed only for loopback add-ons".to_string());
    }
    if host.eq_ignore_ascii_case("localhost") {
        url.set_host(Some("127.0.0.1"))
            .map_err(|_| "The loopback add-on URL is invalid".to_string())?;
    }
    url.set_fragment(None);
    if !url.path().to_ascii_lowercase().ends_with("/manifest.json") {
        let path = format!("{}/manifest.json", url.path().trim_end_matches('/'));
        url.set_path(&path);
    }
    Ok(url)
}

async fn client_for_url(url: &Url) -> Result<reqwest::Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "The add-on URL has no host".to_string())?
        .to_string();
    let mut builder = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(Policy::none())
        .user_agent("Streamee/addon-protocol-v1");

    if !is_loopback_host(&host) {
        let port = url.port_or_known_default().unwrap_or(443);
        let lookup_host = host.clone();
        let addresses = tokio::task::spawn_blocking(move || {
            (lookup_host.as_str(), port)
                .to_socket_addrs()
                .map(|items| items.collect::<Vec<_>>())
        })
        .await
        .map_err(|_| "The add-on host lookup failed".to_string())?
        .map_err(|_| "The add-on host could not be resolved".to_string())?;
        if addresses.is_empty()
            || addresses
                .iter()
                .any(|address| is_forbidden_remote_address(address.ip()))
        {
            return Err("The remote add-on resolved to a private or unsafe network address".to_string());
        }
        builder = builder.resolve_to_addrs(&host, &addresses);
    }

    builder
        .build()
        .map_err(|_| "The secure add-on client could not be created".to_string())
}

async fn fetch_json<T: DeserializeOwned>(url: &Url) -> Result<T, String> {
    let client = client_for_url(url).await?;
    let mut response = client
        .get(url.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "The add-on request timed out".to_string()
            } else {
                "The add-on could not be reached".to_string()
            }
        })?;
    if response.status().is_redirection() {
        return Err("The add-on redirected to another address; install its final manifest URL".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("The add-on returned HTTP {}", response.status().as_u16()));
    }
    if response.content_length().unwrap_or(0) > MAX_JSON_BYTES as u64 {
        return Err("The add-on response is too large".to_string());
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The add-on response could not be read".to_string())?
    {
        if body.len().saturating_add(chunk.len()) > MAX_JSON_BYTES {
            return Err("The add-on response is too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "The add-on returned invalid JSON".to_string())
}

fn stream_resource_url(manifest_url: &Url, media_type: &str, content_id: &str) -> Result<Url, String> {
    if media_type != "movie" && media_type != "series" {
        return Err("The add-on media type must be movie or series".to_string());
    }
    if content_id.trim().is_empty() || content_id.contains('/') || content_id.contains('\\') {
        return Err("The add-on content id is invalid".to_string());
    }
    let mut url = manifest_url.clone();
    let root = url
        .path()
        .strip_suffix("/manifest.json")
        .ok_or_else(|| "The stored add-on manifest URL is invalid".to_string())?;
    url.set_path(&format!("{root}/stream/{media_type}/{content_id}.json"));
    Ok(url)
}

fn read_manifest_url(installation_id: &str) -> Result<Url, String> {
    let value = vault_read(installation_id)?
        .ok_or_else(|| "The installed add-on URL is unavailable; reinstall the add-on".to_string())?;
    normalize_manifest_url(&value)
}

fn remove_expired_stream_handles(handles: &mut HashMap<String, AddonStreamHandle>) {
    handles.retain(|_, entry| entry.created_at.elapsed() < STREAM_HANDLE_TTL);
}

pub(crate) fn resolve_stream_handle(handle: &str) -> Result<String, String> {
    let mut handles = STREAM_HANDLES.lock();
    remove_expired_stream_handles(&mut handles);
    handles
        .get(handle)
        .map(|entry| entry.source_url.clone())
        .ok_or_else(|| "The add-on stream has expired; search again".to_string())
}

#[tauri::command]
pub async fn install_addon(manifest_url: String) -> Result<InstalledAddonRecord, String> {
    let normalized_url = normalize_manifest_url(&manifest_url)?;
    let manifest: AddonManifestSnapshot = fetch_json(&normalized_url).await?;
    manifest.validate()?;

    let installation_id = Uuid::new_v4().to_string();
    vault_write(&installation_id, normalized_url.as_str())?;
    let now = chrono_like_timestamp();
    Ok(InstalledAddonRecord {
        installation_id: installation_id.clone(),
        addon_id: manifest.id.clone(),
        manifest_url_secret_ref: secret_ref(&installation_id),
        manifest,
        enabled: true,
        installed_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub async fn refresh_addon_manifest(installation_id: String) -> Result<AddonManifestSnapshot, String> {
    let manifest_url = read_manifest_url(&installation_id)?;
    let manifest: AddonManifestSnapshot = fetch_json(&manifest_url).await?;
    manifest.validate()?;
    Ok(manifest)
}

#[tauri::command]
pub async fn fetch_addon_streams(request: AddonStreamRequest) -> Result<Vec<AddonStreamResult>, String> {
    let manifest_url = read_manifest_url(&request.installation_id)?;
    let stream_url = stream_resource_url(&manifest_url, &request.media_type, &request.content_id)?;
    let response: StremioStreamResponse = fetch_json(&stream_url).await?;
    let mut results = Vec::new();
    let mut handles = STREAM_HANDLES.lock();
    remove_expired_stream_handles(&mut handles);

    for (index, stream) in response.streams.into_iter().enumerate() {
        let size = addon_stream_size(&stream);
        let title = stream
            .behavior_hints
            .filename
            .as_deref()
            .or(stream.title.as_deref())
            .or(stream.name.as_deref())
            .unwrap_or("Add-on stream")
            .trim()
            .to_string();
        let description = stream.description.filter(|value| !value.trim().is_empty());
        let filename = stream
            .behavior_hints
            .filename
            .filter(|value| !value.trim().is_empty());

        if let Some(source_url) = stream.url.filter(|value| !value.trim().is_empty()) {
            let Ok(parsed_url) = Url::parse(&source_url) else {
                continue;
            };
            if parsed_url.scheme() != "https" && parsed_url.scheme() != "http" {
                continue;
            }
            let handle = Uuid::new_v4().to_string();
            handles.insert(
                handle.clone(),
                AddonStreamHandle {
                    installation_id: request.installation_id.clone(),
                    source_url,
                    created_at: Instant::now(),
                },
            );
            results.push(AddonStreamResult {
                id: format!("{}:{index}", request.installation_id),
                title,
                description,
                playback_kind: "http".to_string(),
                stream_handle: Some(handle),
                info_hash: stream.info_hash,
                file_index: stream.file_idx,
                filename,
                size,
            });
        } else if let Some(info_hash) = stream.info_hash.filter(|value| !value.trim().is_empty()) {
            results.push(AddonStreamResult {
                id: format!("{}:{index}", request.installation_id),
                title,
                description,
                playback_kind: "torrent".to_string(),
                stream_handle: None,
                info_hash: Some(info_hash),
                file_index: stream.file_idx,
                filename,
                size,
            });
        }
    }
    Ok(results)
}

#[tauri::command]
pub fn remove_addon(installation_id: String) -> Result<(), String> {
    vault_delete(&installation_id)?;
    STREAM_HANDLES
        .lock()
        .retain(|_, entry| entry.installation_id != installation_id);
    Ok(())
}

fn chrono_like_timestamp() -> String {
    // The renderer treats this as an opaque sortable timestamp. Avoid adding a time dependency
    // solely for installation metadata; milliseconds since epoch is stable and JSON-safe.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_stremio_urls_without_discarding_configuration() {
        let url = normalize_manifest_url("stremio://example.com/config-token/manifest.json?mode=one#ignored")
            .unwrap();
        assert_eq!(
            url.as_str(),
            "https://example.com/config-token/manifest.json?mode=one"
        );
    }

    #[test]
    fn permits_http_only_for_loopback_addons() {
        assert!(normalize_manifest_url("http://127.0.0.1:7000/manifest.json").is_ok());
        assert!(normalize_manifest_url("http://example.com/manifest.json").is_err());
    }

    #[test]
    fn builds_stream_urls_from_configured_manifest_paths() {
        let manifest = normalize_manifest_url("https://example.com/config/manifest.json?token=opaque").unwrap();
        let stream = stream_resource_url(&manifest, "series", "tt123:1:2").unwrap();
        assert_eq!(
            stream.as_str(),
            "https://example.com/config/stream/series/tt123:1:2.json?token=opaque"
        );
    }

    #[test]
    fn derives_stream_size_from_original_title_before_using_filename() {
        let stream = StremioStream {
            title: Some("Provider metadata 💾 1.63 GB".to_string()),
            behavior_hints: StremioStreamBehaviorHints {
                filename: Some("Example.2160p.WEB-DL.mkv".to_string()),
                video_size: None,
            },
            ..Default::default()
        };

        assert_eq!(addon_stream_size(&stream), Some(1_750_199_173));
    }

    #[test]
    fn prefers_structured_video_size_over_rounded_text_metadata() {
        let stream = StremioStream {
            title: Some("Provider metadata 💾 4.5 GB".to_string()),
            behavior_hints: StremioStreamBehaviorHints {
                filename: Some("Example.2160p.WEB-DL.mkv".to_string()),
                video_size: Some(4_830_585_325),
            },
            ..Default::default()
        };

        assert_eq!(addon_stream_size(&stream), Some(4_830_585_325));
    }

    #[test]
    #[ignore = "requires STREAMEE_ADDON_SMOKE_URL and live network access"]
    fn live_manifest_install_and_secure_storage_round_trip() {
        let manifest_url = std::env::var("STREAMEE_ADDON_SMOKE_URL")
            .expect("STREAMEE_ADDON_SMOKE_URL must contain a public manifest URL");
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let installed = runtime.block_on(install_addon(manifest_url)).unwrap();
        assert!(!installed.manifest.id.is_empty());
        assert!(vault_read(&installed.installation_id).unwrap().is_some());
        remove_addon(installed.installation_id.clone()).unwrap();
        assert_eq!(vault_read(&installed.installation_id).unwrap(), None);
    }
}
