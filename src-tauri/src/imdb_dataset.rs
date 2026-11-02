use flate2::read::GzDecoder;
use reqwest::header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const SOURCE_URL: &str = "https://datasets.imdbws.com/title.ratings.tsv.gz";
const CHANGE_EVENT: &str = "imdb-dataset://changed";
const DAY_MS: u64 = 86_400_000;
const RETRY_MS: u64 = 3_600_000;
const MAGIC: &[u8; 8] = b"STRIMDB1";
const HEADER_BYTES: u64 = 24;
const RECORD_BYTES: u64 = 24;
const MAX_ROWS: usize = 5_000_000;
const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DECODED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ROW_BYTES: u64 = 128;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Config {
    enabled: bool,
    last_checked_at: Option<u64>,
    last_attempt_at: Option<u64>,
    etag: Option<String>,
    source_modified_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetStatus {
    revision: u64,
    enabled: bool,
    ready: bool,
    refreshing: bool,
    entry_count: u64,
    downloaded_at: Option<u64>,
    last_checked_at: Option<u64>,
    source_modified_at: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct DatasetRating {
    rating: f64,
    votes: u64,
}

struct Index {
    path: PathBuf,
    downloaded_at: u64,
    count: u64,
}

impl Index {
    fn open(path: &Path) -> Result<Self, String> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let (downloaded_at, count) = Self::read_header(&mut file)?;
        Ok(Self {
            path: path.to_path_buf(),
            downloaded_at,
            count,
        })
    }

    fn read_header(file: &mut File) -> Result<(u64, u64), String> {
        let mut header = [0_u8; HEADER_BYTES as usize];
        file.read_exact(&mut header).map_err(|e| e.to_string())?;
        let downloaded_at = u64::from_le_bytes(header[8..16].try_into().unwrap());
        let count = u64::from_le_bytes(header[16..24].try_into().unwrap());
        if &header[..8] != MAGIC
            || count == 0
            || count > MAX_ROWS as u64
            || file.metadata().map_err(|e| e.to_string())?.len()
                != HEADER_BYTES + count * RECORD_BYTES
        {
            return Err(
                "The saved IMDb ratings index is incomplete. Refresh to replace it.".into(),
            );
        }
        Ok((downloaded_at, count))
    }

    fn lookup(&mut self, id: u64) -> Result<Option<DatasetRating>, String> {
        // Keep handles short-lived so another Streamee process can replace the index.
        let mut file = File::open(&self.path).map_err(|e| e.to_string())?;
        (self.downloaded_at, self.count) = Self::read_header(&mut file)?;
        let (mut low, mut high) = (0, self.count);
        let mut record = [0_u8; RECORD_BYTES as usize];
        while low < high {
            let middle = low + (high - low) / 2;
            file.seek(SeekFrom::Start(HEADER_BYTES + middle * RECORD_BYTES))
                .map_err(|e| e.to_string())?;
            file.read_exact(&mut record).map_err(|e| e.to_string())?;
            let found = u64::from_le_bytes(record[..8].try_into().unwrap());
            let rating = f64::from_le_bytes(record[8..16].try_into().unwrap());
            let votes = u64::from_le_bytes(record[16..24].try_into().unwrap());
            if found == 0 || !valid_rating(rating, votes) {
                return Err(
                    "The saved IMDb index contains a damaged rating. Download it again.".into(),
                );
            }
            match found.cmp(&id) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return Ok(Some(DatasetRating { rating, votes })),
            }
        }
        Ok(None)
    }
}

struct Inner {
    revision: u64,
    config: Config,
    index: Option<Index>,
    refreshing: bool,
    error: Option<String>,
}

impl Inner {
    fn status(&self) -> DatasetStatus {
        DatasetStatus {
            revision: self.revision,
            enabled: self.config.enabled,
            ready: self.index.is_some(),
            refreshing: self.refreshing,
            entry_count: self.index.as_ref().map_or(0, |index| index.count),
            downloaded_at: self.index.as_ref().map(|index| index.downloaded_at),
            last_checked_at: self.config.last_checked_at,
            source_modified_at: self.config.source_modified_at.clone(),
            error: self.error.clone(),
        }
    }

    fn due(&self, now: u64) -> bool {
        self.config.enabled
            && !self.refreshing
            && (self.index.is_none()
                || self
                    .config
                    .last_checked_at
                    .is_none_or(|last| now.saturating_sub(last) >= DAY_MS))
            && self
                .config
                .last_attempt_at
                .is_none_or(|last| now.saturating_sub(last) >= RETRY_MS)
    }
}

struct Dataset {
    root: PathBuf,
    inner: Mutex<Inner>,
    generation: AtomicU64,
}

struct PendingFile(PathBuf);
impl Drop for PendingFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct CancellableReader<'a, R> {
    reader: R,
    generation: &'a AtomicU64,
    expected: u64,
}
impl<R: Read> Read for CancellableReader<'_, R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if self.generation.load(Ordering::Acquire) != self.expected {
            return Err(std::io::Error::other("The IMDb update was canceled."));
        }
        self.reader.read(bytes)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn title_id(value: &str) -> Option<u64> {
    let digits = value.strip_prefix("tt")?;
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok().filter(|id| *id > 0)
}

fn valid_rating(rating: f64, votes: u64) -> bool {
    rating.is_finite()
        && (1.0..=10.0).contains(&rating)
        && (1..=9_007_199_254_740_991).contains(&votes)
}

fn read_dataset_line(reader: &mut impl BufRead) -> Result<Option<(String, u64)>, String> {
    let mut line = Vec::new();
    let bytes = reader
        .take(MAX_ROW_BYTES + 1)
        .read_until(b'\n', &mut line)
        .map_err(|error| format!("Could not read the IMDb dataset: {error}"))?
        as u64;
    if bytes == 0 {
        return Ok(None);
    }
    if bytes > MAX_ROW_BYTES {
        return Err("An IMDb dataset row exceeded its size limit.".into());
    }
    let line = String::from_utf8(line).map_err(|_| "The IMDb dataset was not valid UTF-8.")?;
    Ok(Some((
        line.trim_end_matches(['\r', '\n']).to_string(),
        bytes,
    )))
}

fn parse_ratings(reader: impl Read) -> Result<Vec<(u64, f64, u64)>, String> {
    let mut reader = BufReader::new(reader.take(MAX_DECODED_BYTES + 1));
    let (header, mut bytes) =
        read_dataset_line(&mut reader)?.ok_or("The IMDb dataset was empty.")?;
    if header != "tconst\taverageRating\tnumVotes" {
        return Err("Unexpected IMDb dataset format.".into());
    }
    let mut rows = Vec::new();
    while let Some((line, count)) = read_dataset_line(&mut reader)? {
        bytes += count;
        if bytes > MAX_DECODED_BYTES || rows.len() >= MAX_ROWS {
            return Err("The IMDb dataset exceeded its size limit.".into());
        }
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() != 3 {
            return Err("The IMDb dataset contained an incomplete row.".into());
        }
        let id = title_id(fields[0]).ok_or("Invalid title ID in the IMDb dataset.")?;
        let rating = fields[1]
            .parse::<f64>()
            .map_err(|_| "Invalid IMDb score.")?;
        let votes = fields[2]
            .parse::<u64>()
            .map_err(|_| "Invalid IMDb vote count.")?;
        if !valid_rating(rating, votes) {
            return Err("The IMDb dataset contained an invalid rating.".into());
        }
        rows.push((id, rating, votes));
    }
    if rows.is_empty() {
        return Err("The IMDb dataset contained no ratings.".into());
    }
    rows.sort_unstable_by_key(|row| row.0);
    if rows.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err("The IMDb dataset contained duplicate titles.".into());
    }
    Ok(rows)
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|e| format!("Could not save the IMDb ratings update: {e}"))
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| e.to_string())
}

impl Dataset {
    fn open(root: PathBuf) -> Self {
        let mut error = None;
        let config = match fs::read(root.join("settings.json")) {
            Ok(data) => serde_json::from_slice(&data).unwrap_or_else(|_| {
                error = Some("The saved IMDb dataset settings could not be read. Automatic downloads are off.".into());
                Config::default()
            }),
            Err(reason) => {
                if reason.kind() != std::io::ErrorKind::NotFound { error = Some(format!("Could not read IMDb dataset settings: {reason}")); }
                Config::default()
            }
        };
        let index = match Index::open(&root.join("ratings.bin")) {
            Ok(index) => Some(index),
            Err(reason) => {
                if root.join("ratings.bin").exists() {
                    error = Some(format!(
                        "The saved IMDb index needs to be downloaded again: {reason}"
                    ));
                }
                None
            }
        };
        Self {
            root,
            generation: AtomicU64::new(0),
            inner: Mutex::new(Inner {
                revision: 0,
                config,
                index,
                refreshing: false,
                error,
            }),
        }
    }

    fn save_config(&self, config: &Config) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let temporary = PendingFile(
            self.root
                .join(format!("settings-{}.json.tmp", uuid::Uuid::new_v4())),
        );
        let mut file = File::create(&temporary.0).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(config).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        replace_file(&temporary.0, &self.root.join("settings.json"))
    }

    fn set_enabled(&self, enabled: bool) -> Result<DatasetStatus, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let mut config = inner.config.clone();
        if enabled && !config.enabled {
            config.last_attempt_at = None;
        }
        config.enabled = enabled;
        self.save_config(&config)?;
        if inner.config.enabled != enabled {
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
        inner.config = config;
        inner.error = None;
        inner.revision += 1;
        Ok(inner.status())
    }

    fn clear(&self) -> Result<DatasetStatus, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let config = Config::default();
        self.save_config(&config)?;
        self.generation.fetch_add(1, Ordering::AcqRel);
        inner.config = config;
        drop(inner.index.take());
        inner.error = None;
        for name in ["ratings.bin", "ratings.bin.tmp", "settings.json.tmp"] {
            if let Err(error) = fs::remove_file(self.root.join(name)) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    inner.error = Some(format!("Could not delete saved IMDb ratings: {error}"));
                }
            }
        }
        // Report cleanup errors through status even after the preference has been disabled.
        let cleanup = (|| -> Result<(), String> {
            // Clean up interrupted updates left by a previous process, without removing unrelated files.
            for entry in fs::read_dir(&self.root).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if ((name.starts_with("ratings-") && name.ends_with(".bin.tmp"))
                    || (name.starts_with("settings-") && name.ends_with(".json.tmp")))
                    && entry
                        .file_type()
                        .map_err(|error| error.to_string())?
                        .is_file()
                {
                    if let Err(error) = fs::remove_file(entry.path()) {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            inner.error = Some(format!(
                                "Could not delete an interrupted IMDb update: {error}"
                            ));
                        }
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = cleanup {
            inner.error = Some(format!(
                "Could not clean up interrupted IMDb updates: {error}"
            ));
        }
        inner.revision += 1;
        Ok(inner.status())
    }

    fn download(
        &self,
        url: &str,
        config: &Config,
        previous_count: u64,
        generation: u64,
    ) -> Result<Option<(Option<String>, Option<String>)>, String> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(180))
            .user_agent("Streamee personal IMDb dataset downloader")
            .build()
            .map_err(|e| e.to_string())?;
        let mut request = client.get(url).header("Accept-Encoding", "identity");
        if previous_count > 0 {
            if let Some(etag) = &config.etag {
                request = request.header(IF_NONE_MATCH, etag);
            }
            if let Some(modified) = &config.source_modified_at {
                request = request.header(IF_MODIFIED_SINCE, modified);
            }
        }
        let response = request
            .send()
            .map_err(|e| format!("Could not download IMDb ratings: {e}"))?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED && previous_count > 0 {
            return Ok(None);
        }
        if response.status() != reqwest::StatusCode::OK {
            return Err(format!(
                "IMDb returned HTTP {}. The saved ratings were retained.",
                response.status()
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_DOWNLOAD_BYTES)
        {
            return Err("The IMDb download exceeded its size limit.".into());
        }
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let modified = response
            .headers()
            .get(LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let rows = parse_ratings(GzDecoder::new(CancellableReader {
            reader: response.take(MAX_DOWNLOAD_BYTES + 1),
            generation: &self.generation,
            expected: generation,
        }))?;
        if previous_count > 1_000 && (rows.len() as u64) < previous_count / 2 {
            return Err(
                "The updated IMDb dataset appeared incomplete. The saved ratings were retained."
                    .into(),
            );
        }
        if self.generation.load(Ordering::Acquire) != generation {
            return Err("The IMDb update was canceled.".into());
        }
        let temporary = PendingFile(
            self.root
                .join(format!("ratings-{}.bin.tmp", uuid::Uuid::new_v4())),
        );
        let mut writer = BufWriter::new(File::create(&temporary.0).map_err(|e| e.to_string())?);
        writer.write_all(MAGIC).map_err(|e| e.to_string())?;
        writer
            .write_all(&now_ms().to_le_bytes())
            .map_err(|e| e.to_string())?;
        writer
            .write_all(&(rows.len() as u64).to_le_bytes())
            .map_err(|e| e.to_string())?;
        for (position, (id, rating, votes)) in rows.into_iter().enumerate() {
            if position % 1024 == 0 && self.generation.load(Ordering::Acquire) != generation {
                return Err("The IMDb update was canceled.".into());
            }
            writer
                .write_all(&id.to_le_bytes())
                .and_then(|_| writer.write_all(&rating.to_le_bytes()))
                .and_then(|_| writer.write_all(&votes.to_le_bytes()))
                .map_err(|e| e.to_string())?;
        }
        writer
            .flush()
            .and_then(|_| writer.get_ref().sync_all())
            .map_err(|e| e.to_string())?;
        drop(writer);
        // Validate the completed replacement before it can replace a working index.
        drop(Index::open(&temporary.0)?);
        // Pause lookups for the commit and retain the previous index if replacement fails.
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if self.generation.load(Ordering::Acquire) != generation || !inner.config.enabled {
            return Err("The IMDb update was canceled.".into());
        }
        drop(inner.index.take());
        let committed = replace_file(&temporary.0, &self.root.join("ratings.bin"));
        inner.index = Index::open(&self.root.join("ratings.bin")).ok();
        committed?;
        if inner.index.is_none() {
            return Err("Could not open the updated IMDb ratings index.".into());
        }
        Ok(Some((etag, modified)))
    }

    fn refresh(
        &self,
        force: bool,
        url: &str,
        notify: impl Fn(DatasetStatus),
    ) -> Result<DatasetStatus, String> {
        let (config, previous_count, generation, started) = {
            let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
            if !inner.config.enabled || inner.refreshing || (!force && !inner.due(now_ms())) {
                return Ok(inner.status());
            }
            inner.config.last_attempt_at = Some(now_ms());
            if let Err(error) = self.save_config(&inner.config) {
                inner.error = Some(format!("Could not save IMDb update settings: {error}"));
                inner.revision += 1;
                let status = inner.status();
                drop(inner);
                notify(status.clone());
                return Ok(status);
            }
            inner.refreshing = true;
            inner.error = None;
            inner.revision += 1;
            let result = (
                inner.config.clone(),
                inner.index.as_ref().map_or(0, |index| index.count),
                self.generation.load(Ordering::Acquire),
                inner.status(),
            );
            result
        };
        notify(started);
        let result = self.download(url, &config, previous_count, generation);
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.refreshing = false;
        inner.revision += 1;
        if self.generation.load(Ordering::Acquire) != generation {
            let status = inner.status();
            drop(inner);
            notify(status.clone());
            if status.enabled && !status.ready {
                return self.refresh(false, url, notify);
            }
            return Ok(status);
        }
        match result {
            Ok(update) => {
                if let Some((etag, modified)) = update {
                    inner.config.etag = etag;
                    inner.config.source_modified_at = modified;
                }
                inner.config.last_checked_at = Some(now_ms());
                inner.error = self.save_config(&inner.config).err();
            }
            Err(error) => inner.error = Some(error),
        }
        let status = inner.status();
        drop(inner);
        notify(status.clone());
        Ok(status)
    }

    fn lookup(&self, ids: &[String]) -> Result<HashMap<String, DatasetRating>, String> {
        if ids.len() > 100 {
            return Err("At most 100 IMDb IDs can be looked up at once.".into());
        }
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let mut ratings = HashMap::new();
        if !inner.config.enabled {
            return Ok(ratings);
        }
        let mut lookup_error = None;
        let previous_version = inner
            .index
            .as_ref()
            .map(|index| (index.downloaded_at, index.count));
        if let Some(index) = &mut inner.index {
            for original in ids {
                let normalized = original.trim().to_lowercase();
                if let Some(id) = title_id(&normalized) {
                    match index.lookup(id) {
                        Ok(Some(rating)) => {
                            ratings.insert(normalized, rating);
                        }
                        Ok(None) => {}
                        Err(error) => {
                            lookup_error = Some(error);
                            break;
                        }
                    }
                }
            }
        }
        if let Some(error) = lookup_error {
            drop(inner.index.take());
            inner.config.etag = None;
            inner.config.source_modified_at = None;
            inner.error = Some(error.clone());
            inner.revision += 1;
            return Err(error);
        }
        if inner
            .index
            .as_ref()
            .map(|index| (index.downloaded_at, index.count))
            != previous_version
        {
            inner.revision += 1;
        }
        Ok(ratings)
    }
}

fn refresh_app(app: &AppHandle, force: bool) -> Result<DatasetStatus, String> {
    let dataset = app
        .try_state::<Dataset>()
        .ok_or("The local IMDb dataset is unavailable.")?;
    dataset.refresh(force, SOURCE_URL, |status| {
        let _ = app.emit(CHANGE_EVENT, status);
    })
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("imdb-ratings");
    app.manage(Dataset::open(root));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let current = app.clone();
            let _ =
                tauri::async_runtime::spawn_blocking(move || refresh_app(&current, false)).await;
            tokio::time::sleep(Duration::from_secs(15 * 60)).await;
        }
    });
    Ok(())
}

#[tauri::command]
pub fn get_imdb_dataset_status(app: AppHandle) -> Result<DatasetStatus, String> {
    let dataset = app
        .try_state::<Dataset>()
        .ok_or("The local IMDb dataset is unavailable.")?;
    let status = dataset.inner.lock().map_err(|e| e.to_string())?.status();
    Ok(status)
}

#[tauri::command]
pub fn set_imdb_dataset_enabled(app: AppHandle, enabled: bool) -> Result<DatasetStatus, String> {
    let dataset = app
        .try_state::<Dataset>()
        .ok_or("The local IMDb dataset is unavailable.")?;
    let status = dataset.set_enabled(enabled)?;
    let _ = app.emit(CHANGE_EVENT, status.clone());
    if enabled {
        tauri::async_runtime::spawn_blocking(move || refresh_app(&app, false));
    }
    Ok(status)
}

#[tauri::command]
pub async fn clear_imdb_dataset(app: AppHandle) -> Result<DatasetStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dataset = app
            .try_state::<Dataset>()
            .ok_or("The local IMDb dataset is unavailable.")?;
        let status = dataset.clear()?;
        let _ = app.emit(CHANGE_EVENT, status.clone());
        Ok(status)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn refresh_imdb_dataset(app: AppHandle) -> Result<DatasetStatus, String> {
    tauri::async_runtime::spawn_blocking(move || refresh_app(&app, true))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn lookup_imdb_dataset_ratings(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<HashMap<String, DatasetRating>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dataset = app
            .try_state::<Dataset>()
            .ok_or("The local IMDb dataset is unavailable.")?;
        let previous_revision = dataset.inner.lock().map_err(|e| e.to_string())?.revision;
        let result = dataset.lookup(&ids);
        let status = dataset.inner.lock().map_err(|e| e.to_string())?.status();
        if result.is_err() || status.revision != previous_revision {
            let _ = app.emit(CHANGE_EVENT, status);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::net::TcpListener;
    use std::thread;

    const FIXTURE: &str =
        "tconst\taverageRating\tnumVotes\ntt0000020\t7.5\t12345\ntt0000001\t8.1\t54321\n";

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("streamee-imdb-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn gzip(value: &str) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(value.as_bytes()).unwrap();
        encoder.finish().unwrap()
    }

    fn server(status: &str, body: Vec<u8>) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/ratings", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let status = status.to_string();
        let task = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "dataset request did not arrive"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nETag: \"fixture\"\r\nLast-Modified: Sun, 01 Nov 2026 12:00:00 GMT\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            stream.write_all(&body).unwrap();
            request.to_lowercase()
        });
        (url, task)
    }

    #[test]
    fn validates_and_sorts_ratings_without_accepting_partial_data() {
        let rows = parse_ratings(FIXTURE.as_bytes()).unwrap();
        assert_eq!(rows, vec![(1, 8.1, 54321), (20, 7.5, 12345)]);
        for invalid in [
            "",
            "unexpected header\n",
            "tconst\taverageRating\tnumVotes\ntt1\tNaN\t10\n",
            "tconst\taverageRating\tnumVotes\ntt1\t11\t10\n",
            "tconst\taverageRating\tnumVotes\ntt1\t8\t0\n",
            "tconst\taverageRating\tnumVotes\ntt1\t8\t1\ntt1\t9\t2\n",
        ] {
            assert!(
                parse_ratings(invalid.as_bytes()).is_err(),
                "Accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn opt_in_is_required_and_daily_checks_back_off_after_failure() {
        let directory = TestDirectory::new();
        let dataset = Dataset::open(directory.0.clone());
        assert!(
            !dataset
                .refresh(true, "invalid URL", |_| {})
                .unwrap()
                .enabled
        );
        assert!(!directory.0.join("settings.json").exists());
        dataset.set_enabled(true).unwrap();
        let (url, task) = server("200 OK", gzip(FIXTURE));
        assert!(dataset.refresh(false, &url, |_| {}).unwrap().ready);
        task.join().unwrap();
        let mut inner = dataset.inner.lock().unwrap();
        inner.config.last_checked_at = Some(1_000);
        inner.config.last_attempt_at = Some(1_000);
        assert!(!inner.due(1_000 + DAY_MS - 1));
        assert!(inner.due(1_000 + DAY_MS));
        inner.config.last_attempt_at = Some(1_000 + DAY_MS);
        assert!(!inner.due(1_000 + DAY_MS + RETRY_MS - 1));
        assert!(inner.due(1_000 + DAY_MS + RETRY_MS));
    }

    #[test]
    fn index_survives_restart_and_unchanged_responses_reuse_it() {
        let directory = TestDirectory::new();
        let dataset = Dataset::open(directory.0.clone());
        dataset.set_enabled(true).unwrap();
        let (url, task) = server("200 OK", gzip(FIXTURE));
        let first = dataset.refresh(true, &url, |_| {}).unwrap();
        assert_eq!(first.entry_count, 2);
        assert!(!task.join().unwrap().contains("if-none-match"));
        let bytes = fs::read(directory.0.join("ratings.bin")).unwrap();
        drop(dataset);
        let dataset = Dataset::open(directory.0.clone());
        let ids = vec![
            "tt0000001".into(),
            "tt0000020".into(),
            "tt9999999".into(),
            "invalid".into(),
        ];
        let ratings = dataset.lookup(&ids).unwrap();
        assert_eq!(ratings.len(), 2);
        assert_eq!(ratings["tt0000001"].rating, 8.1);
        assert_eq!(ratings["tt0000020"].votes, 12345);
        let (url, task) = server("304 Not Modified", vec![]);
        let unchanged = dataset.refresh(true, &url, |_| {}).unwrap();
        assert_eq!(unchanged.downloaded_at, first.downloaded_at);
        assert!(task.join().unwrap().contains("if-none-match: \"fixture\""));
        assert_eq!(fs::read(directory.0.join("ratings.bin")).unwrap(), bytes);
        dataset.set_enabled(false).unwrap();
        assert!(dataset.lookup(&ids).unwrap().is_empty());
    }

    #[test]
    fn corrupt_updates_preserve_scores_and_valid_updates_replace_an_open_index() {
        let directory = TestDirectory::new();
        let dataset = Dataset::open(directory.0.clone());
        dataset.set_enabled(true).unwrap();
        let (url, task) = server("200 OK", gzip(FIXTURE));
        let first = dataset.refresh(true, &url, |_| {}).unwrap();
        assert!(first.ready, "{:?}", first.error);
        task.join().unwrap();
        let original = fs::read(directory.0.join("ratings.bin")).unwrap();
        for body in [
            b"invalid gzip".to_vec(),
            gzip("tconst\taverageRating\tnumVotes\ntt1\t8.5\t100\ninvalid\n"),
        ] {
            let (url, task) = server("200 OK", body);
            let failed = dataset.refresh(true, &url, |_| {}).unwrap();
            task.join().unwrap();
            assert!(failed.ready && failed.error.is_some() && !failed.refreshing);
            assert_eq!(fs::read(directory.0.join("ratings.bin")).unwrap(), original);
        }
        let (url, task) = server(
            "200 OK",
            gzip("tconst\taverageRating\tnumVotes\ntt0000001\t9.2\t60000\n"),
        );
        let updated = dataset.refresh(true, &url, |_| {}).unwrap();
        task.join().unwrap();
        assert!(updated.error.is_none(), "{:?}", updated.error);
        assert_eq!(
            dataset.lookup(&["tt0000001".into()]).unwrap()["tt0000001"].rating,
            9.2
        );
    }

    #[test]
    fn disabling_an_active_download_preserves_the_previous_index() {
        let directory = TestDirectory::new();
        let dataset = std::sync::Arc::new(Dataset::open(directory.0.clone()));
        dataset.set_enabled(true).unwrap();
        let (url, task) = server("200 OK", gzip(FIXTURE));
        dataset.refresh(true, &url, |_| {}).unwrap();
        task.join().unwrap();
        let original = fs::read(directory.0.join("ratings.bin")).unwrap();
        let (url, task) = server(
            "200 OK",
            gzip("tconst\taverageRating\tnumVotes\ntt0000001\t9.2\t60000\n"),
        );
        let (started, waiting) = std::sync::mpsc::channel();
        let (resume, paused) = std::sync::mpsc::channel();
        let worker = dataset.clone();
        let refresh = thread::spawn(move || {
            worker.refresh(true, &url, |status| {
                if status.refreshing {
                    started.send(()).unwrap();
                    paused.recv_timeout(Duration::from_secs(5)).unwrap();
                }
            })
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        // Queue the disable on another thread so this also detects notifications holding the lookup lock.
        let worker = dataset.clone();
        let (disabled, received) = std::sync::mpsc::channel();
        let disable = thread::spawn(move || {
            disabled.send(worker.set_enabled(false)).unwrap();
        });
        let immediate = received.recv_timeout(Duration::from_millis(200));
        resume.send(()).unwrap();
        let status = refresh.join().unwrap().unwrap();
        disable.join().unwrap();
        task.join().unwrap();
        assert!(
            immediate.is_ok(),
            "Dataset status notifications held the lookup lock"
        );
        assert!(!status.enabled && status.error.is_none());
        assert_eq!(fs::read(directory.0.join("ratings.bin")).unwrap(), original);
    }

    #[test]
    fn failed_refresh_settings_write_is_visible_in_status() {
        let directory = TestDirectory::new();
        let dataset = Dataset::open(directory.0.clone());
        dataset.set_enabled(true).unwrap();
        fs::remove_file(directory.0.join("settings.json")).unwrap();
        fs::create_dir(directory.0.join("settings.json")).unwrap();
        let status = dataset
            .refresh(true, "invalid URL", |_| {})
            .expect("A background save failure must be reported in dataset status");
        assert!(status.error.is_some() && !status.refreshing);
    }

    #[test]
    fn malformed_saved_index_reports_a_recovery_error() {
        let directory = TestDirectory::new();
        fs::write(directory.0.join("ratings.bin"), b"incomplete index").unwrap();
        let dataset = Dataset::open(directory.0.clone());
        let status = dataset.inner.lock().unwrap().status();
        assert!(!status.ready && status.error.is_some());
    }

    #[test]
    fn clearing_during_download_deletes_the_copy_without_recreating_it() {
        let directory = TestDirectory::new();
        let dataset = std::sync::Arc::new(Dataset::open(directory.0.clone()));
        dataset.set_enabled(true).unwrap();
        let (url, task) = server("200 OK", gzip(FIXTURE));
        dataset.refresh(true, &url, |_| {}).unwrap();
        task.join().unwrap();
        let (url, task) = server("200 OK", gzip(FIXTURE));
        let (started, waiting) = std::sync::mpsc::channel();
        let (resume, paused) = std::sync::mpsc::channel();
        let worker = dataset.clone();
        let refresh = thread::spawn(move || {
            worker.refresh(true, &url, |status| {
                if status.refreshing {
                    started.send(()).unwrap();
                    paused.recv_timeout(Duration::from_secs(5)).unwrap();
                }
            })
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        fs::write(
            directory.0.join("ratings-abandoned.bin.tmp"),
            b"interrupted update",
        )
        .unwrap();
        fs::write(
            directory.0.join("settings-abandoned.json.tmp"),
            b"interrupted settings",
        )
        .unwrap();
        let cleared = dataset.clear().unwrap();
        assert!(!cleared.enabled && !cleared.ready && cleared.error.is_none());
        resume.send(()).unwrap();
        let status = refresh.join().unwrap().unwrap();
        task.join().unwrap();
        assert!(!status.enabled && !status.ready && status.error.is_none());
        assert!(!directory.0.join("ratings.bin").exists());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        assert!(
            !Dataset::open(directory.0.clone())
                .inner
                .lock()
                .unwrap()
                .config
                .enabled
        );
    }

    #[test]
    fn corrupted_rating_records_are_rejected_and_can_be_replaced() {
        let directory = TestDirectory::new();
        let dataset = Dataset::open(directory.0.clone());
        dataset.set_enabled(true).unwrap();
        let (url, task) = server("200 OK", gzip(FIXTURE));
        dataset.refresh(true, &url, |_| {}).unwrap();
        task.join().unwrap();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .open(directory.0.join("ratings.bin"))
            .unwrap();
        file.seek(SeekFrom::Start(HEADER_BYTES + RECORD_BYTES + 8))
            .unwrap();
        file.write_all(&f64::NAN.to_le_bytes()).unwrap();
        drop(file);
        assert!(dataset.lookup(&["tt0000020".into()]).is_err());
        assert!(!dataset.inner.lock().unwrap().status().ready);
        let (url, task) = server("200 OK", gzip(FIXTURE));
        assert!(dataset.refresh(true, &url, |_| {}).unwrap().ready);
        let request = task.join().unwrap();
        assert!(!request.contains("if-none-match"));
        assert_eq!(
            dataset.lookup(&["tt0000020".into()]).unwrap()["tt0000020"].rating,
            7.5
        );
    }

    #[test]
    fn oversized_rows_are_rejected_before_unbounded_line_allocation() {
        let invalid = format!(
            "tconst\taverageRating\tnumVotes\ntt{}\t8.1\t12\n",
            "1".repeat(10000)
        );
        assert!(parse_ratings(invalid.as_bytes())
            .unwrap_err()
            .contains("row exceeded"));
        assert!(parse_ratings(FIXTURE.replace('\n', "\r\n").as_bytes()).is_ok());
    }

    #[test]
    fn another_instance_can_replace_the_index_and_existing_readers_see_the_new_copy() {
        let directory = TestDirectory::new();
        let first = Dataset::open(directory.0.clone());
        first.set_enabled(true).unwrap();
        let (url, task) = server("200 OK", gzip(FIXTURE));
        first.refresh(true, &url, |_| {}).unwrap();
        task.join().unwrap();
        let second = Dataset::open(directory.0.clone());
        let (url, task) = server(
            "200 OK",
            gzip("tconst\taverageRating\tnumVotes\ntt0000001\t9.2\t60000\n"),
        );
        let status = second.refresh(true, &url, |_| {}).unwrap();
        task.join().unwrap();
        assert!(status.error.is_none(), "{:?}", status.error);
        assert_eq!(
            first.lookup(&["tt0000001".into()]).unwrap()["tt0000001"].rating,
            9.2
        );
        assert_eq!(first.inner.lock().unwrap().status().entry_count, 1);
    }

    #[test]
    #[ignore = "Downloads IMDb's current ratings into an isolated temporary directory"]
    fn live_dataset_download() {
        let directory = TestDirectory::new();
        let dataset = Dataset::open(directory.0.clone());
        dataset.set_enabled(true).unwrap();
        let first = dataset.refresh(true, SOURCE_URL, |_| {}).unwrap();
        assert!(first.error.is_none(), "{:?}", first.error);
        assert!(first.entry_count > 1_000_000);
        assert!(dataset
            .lookup(&["tt0133093".into()])
            .unwrap()
            .contains_key("tt0133093"));
        let second = dataset.refresh(true, SOURCE_URL, |_| {}).unwrap();
        assert!(second.error.is_none(), "{:?}", second.error);
        assert_eq!(second.downloaded_at, first.downloaded_at);
        println!(
            "Validated {} current ratings, local lookup, and conditional daily refresh.",
            first.entry_count
        );
    }
}
