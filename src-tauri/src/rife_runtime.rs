use reqwest::blocking::{Client, Response};
use reqwest::header::RANGE;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
#[cfg(windows)]
use windows::{core::HSTRING, Win32::Storage::FileSystem::GetDiskFreeSpaceExW};

const RUNTIME_VERSION: &str = "v15.16";
const RUNTIME_DOWNLOAD_BYTES: u64 = 2_612_456_071;
const RUNTIME_REQUIRED_FREE_BYTES: u64 = 6_500_000_000;
const RIFE_OPERATION_IDLE: u8 = 0;
const RIFE_OPERATION_INSTALLING: u8 = 1;
const RIFE_OPERATION_PREPARING: u8 = 2;
const RIFE_OPERATION_CLEARING_CACHE: u8 = 3;
const ENGINE_PREPARATION_TIMEOUT: Duration = Duration::from_secs(20 * 60);
static RIFE_RUNTIME_OPERATION: AtomicU8 = AtomicU8::new(RIFE_OPERATION_IDLE);
static ENGINE_PREPARATION_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy)]
struct Asset {
    name: &'static str,
    url: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const CUDA_PART_ONE: Asset = Asset {
    name: "vsmlrt-cuda.v15.16.7z.001",
    url: concat!(
        "https://github.com/AmusementClub/vs-mlrt/releases/download/v15.16/",
        "vsmlrt-cuda.v15.16.7z.001"
    ),
    bytes: 2_147_483_647,
    sha256: "4792727ddb54b3b647496f2932663592ae6cc18f89cd6a95fa51a25b22cd62b5",
};

const CUDA_PART_TWO: Asset = Asset {
    name: "vsmlrt-cuda.v15.16.7z.002",
    url: concat!(
        "https://github.com/AmusementClub/vs-mlrt/releases/download/v15.16/",
        "vsmlrt-cuda.v15.16.7z.002"
    ),
    bytes: 464_467_988,
    sha256: "d2ab31feba5c165e9a3bdf02e1455d1232263ffe96bd83ad892aca01029e1495",
};

const VSTRT_PLUGIN: Asset = Asset {
    name: "VSTRT-Windows-x64.v15.16.7z",
    url: concat!(
        "https://github.com/AmusementClub/vs-mlrt/releases/download/v15.16/",
        "VSTRT-Windows-x64.v15.16.7z"
    ),
    bytes: 486_704,
    sha256: "c4e64e69e87553bf15a7acd29d76debd006954e39ee07ef0e6d526947c5d34b1",
};

const VSMLRT_SCRIPTS: Asset = Asset {
    name: "scripts.v15.16.7z",
    url: concat!(
        "https://github.com/AmusementClub/vs-mlrt/releases/download/v15.16/",
        "scripts.v15.16.7z"
    ),
    bytes: 17_732,
    sha256: "d07dae0a00cb8dbf4f00358f640f630ff5d933de44d27050e7acce4f31cc3560",
};

#[derive(Clone, Copy)]
struct ModelAsset {
    setting: &'static str,
    asset: Asset,
    archive_path: &'static str,
    installed_name: &'static str,
    installed_bytes: u64,
}

const MODEL_ASSETS: &[ModelAsset] = &[
    ModelAsset {
        setting: "4.6",
        asset: Asset {
            name: "rife_v8.7z",
            url: concat!(
                "https://github.com/AmusementClub/vs-mlrt/releases/download/model-20220923/",
                "rife_v8.7z"
            ),
            bytes: 195_245_748,
            sha256: "1a18614e72164c61d60861199fc8be6b0003110f747646b3dafb9acd632f6ef7",
        },
        archive_path: "rife/rife_v4.6.onnx",
        installed_name: "rife_v4.6.onnx",
        installed_bytes: 21_255_682,
    },
    ModelAsset {
        setting: "4.9",
        asset: Asset {
            name: "rife_v4.9.7z",
            url: concat!(
                "https://github.com/AmusementClub/vs-mlrt/releases/download/external-models/",
                "rife_v4.9.7z"
            ),
            bytes: 19_733_904,
            sha256: "805ad66cd45f89cecffddb1bd4b854099e3513cb1f4336ac43a9d17e8f377fe4",
        },
        archive_path: "rife/rife_v4.9.onnx",
        installed_name: "rife_v4.9.onnx",
        installed_bytes: 21_347_875,
    },
    ModelAsset {
        setting: "4.16-lite",
        asset: Asset {
            name: "rife_v4.16_lite.7z",
            url: concat!(
                "https://github.com/AmusementClub/vs-mlrt/releases/download/external-models/",
                "rife_v4.16_lite.7z"
            ),
            bytes: 9_704_395,
            sha256: "7e8a2b84c3479e0d1ae51354e7fa227f76b9cb93ecdee153ee1e9621ca8bc9ef",
        },
        archive_path: "rife/rife_v4.16_lite.onnx",
        installed_name: "rife_v4.16_lite.onnx",
        installed_bytes: 10_514_618,
    },
    ModelAsset {
        setting: "4.18",
        asset: Asset {
            name: "rife_v4.18.7z",
            url: concat!(
                "https://github.com/AmusementClub/vs-mlrt/releases/download/external-models/",
                "rife_v4.18.7z"
            ),
            bytes: 19_914_699,
            sha256: "66c22b9a2fa059a73c68c2747d256f23a4dbdf37f669bb950e8e9501137f144f",
        },
        archive_path: "rife/rife_v4.18.onnx",
        installed_name: "rife_v4.18.onnx",
        installed_bytes: 21_506_011,
    },
    ModelAsset {
        setting: "4.25",
        asset: Asset {
            name: "rife_v4.25.7z",
            url: concat!(
                "https://github.com/AmusementClub/vs-mlrt/releases/download/external-models/",
                "rife_v4.25.7z"
            ),
            bytes: 21_026_388,
            sha256: "172fe975c1775134bb87108e4ec6d1a89e861cc5d3be2ac23bf08afe5ed626b8",
        },
        archive_path: "rife/rife_v4.25.onnx",
        installed_name: "rife_v4.25.onnx",
        installed_bytes: 22_719_799,
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RifeRuntimeInfo {
    pub installed: bool,
    pub ready: bool,
    pub version: String,
    pub path: String,
    pub selected_model: String,
    pub selected_model_installed: bool,
    pub installed_models: Vec<String>,
    pub missing_files: Vec<String>,
    pub download_bytes: u64,
    pub required_free_bytes: u64,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RifeCacheInfo {
    pub path: String,
    pub bytes: u64,
    pub file_count: u64,
    pub engine_count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    phase: &'static str,
    message: String,
    downloaded_bytes: u64,
    total_bytes: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RifeEnginePreparationRequest {
    pub model: String,
    pub multiplier: u32,
    pub gpu_streams: u32,
    pub processing_mode: String,
    pub scale: String,
    pub source_resolution: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RifeEnginePreparationResult {
    pub model: String,
    pub scale: String,
    pub source_resolution: String,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnginePreparationProgress {
    phase: &'static str,
    message: String,
}

struct RifeOperationGuard {
    operation: u8,
}

impl Drop for RifeOperationGuard {
    fn drop(&mut self) {
        let _ = RIFE_RUNTIME_OPERATION.compare_exchange(
            self.operation,
            RIFE_OPERATION_IDLE,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }
}

fn begin_runtime_operation(operation: u8, description: &str) -> Result<RifeOperationGuard, String> {
    RIFE_RUNTIME_OPERATION
        .compare_exchange(
            RIFE_OPERATION_IDLE,
            operation,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .map_err(|active| {
            let active_description = match active {
                RIFE_OPERATION_INSTALLING => "installing or repairing the RIFE Runtime",
                RIFE_OPERATION_PREPARING => "preparing a RIFE engine",
                RIFE_OPERATION_CLEARING_CACHE => "clearing the RIFE engine cache",
                _ => "performing another RIFE operation",
            };
            format!("Cannot {description} while Streamee is {active_description}")
        })?;
    Ok(RifeOperationGuard { operation })
}

pub fn cancel_engine_preparation() -> Result<(), String> {
    if RIFE_RUNTIME_OPERATION.load(Ordering::SeqCst) != RIFE_OPERATION_PREPARING {
        return Err("No RIFE engine preparation is currently running".to_string());
    }
    ENGINE_PREPARATION_CANCELLED.store(true, Ordering::SeqCst);
    Ok(())
}

fn terminate_preparation_process(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn runtime_root() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join("Streamee").join("rife-runtime"))
        .ok_or_else(|| "Could not resolve the local application data folder".to_string())
}

fn engine_cache_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join("Streamee").join("rife-cache"))
        .ok_or_else(|| "Could not resolve the local application data folder".to_string())
}

fn visit_cache_files(
    directory: &Path,
    visitor: &mut impl FnMut(&Path, &fs::Metadata) -> Result<(), String>,
) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| {
            format!(
                "Could not inspect an entry in {}: {error}",
                directory.display()
            )
        })?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if metadata.is_dir() {
            visit_cache_files(&path, visitor)?;
        } else if metadata.is_file() {
            visitor(&path, &metadata)?;
        }
    }
    Ok(())
}

fn remove_invalid_cache_artifacts(cache_dir: &Path) -> Result<u64, String> {
    let mut invalid = Vec::new();
    visit_cache_files(cache_dir, &mut |path, metadata| {
        let is_engine_artifact =
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.ends_with(".engine")
                        || name.ends_with(".engine.cache")
                        || name.ends_with(".engine.cache.lock")
                });
        if is_engine_artifact && metadata.len() == 0 {
            invalid.push(path.to_path_buf());
        }
        Ok(())
    })?;
    let mut removed = 0;
    for path in invalid {
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

pub fn cache_info() -> Result<RifeCacheInfo, String> {
    let path = engine_cache_dir()?;
    let mut bytes = 0_u64;
    let mut file_count = 0_u64;
    let mut engine_count = 0_u64;
    visit_cache_files(&path, &mut |file, metadata| {
        bytes = bytes.saturating_add(metadata.len());
        file_count += 1;
        if file
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".engine"))
        {
            engine_count += 1;
        }
        Ok(())
    })?;
    Ok(RifeCacheInfo {
        path: path.to_string_lossy().into_owned(),
        bytes,
        file_count,
        engine_count,
    })
}

pub fn clear_cache() -> Result<RifeCacheInfo, String> {
    let _guard = begin_runtime_operation(RIFE_OPERATION_CLEARING_CACHE, "clear the RIFE cache")?;
    let path = engine_cache_dir()?;
    if path.exists() {
        fs::remove_dir_all(&path)
            .map_err(|error| format!("Could not clear {}: {error}", path.display()))?;
    }
    cache_info()
}

#[cfg(windows)]
fn ensure_install_prerequisites(runtime_root: &Path, base_ready: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let system_nvidia_smi = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .map(|path| path.join("System32").join("nvidia-smi.exe"));
    let nvidia_smi = system_nvidia_smi
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("nvidia-smi.exe"));
    let gpu_check = std::process::Command::new(nvidia_smi)
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| "RIFE currently requires a supported NVIDIA GPU and driver".to_string())?;
    if !gpu_check.status.success() || gpu_check.stdout.is_empty() {
        return Err("RIFE currently requires a supported NVIDIA GPU and driver".to_string());
    }

    fs::create_dir_all(runtime_root)
        .map_err(|error| format!("Could not create {}: {error}", runtime_root.display()))?;
    let root = HSTRING::from(runtime_root.to_string_lossy().as_ref());
    let mut available = 0_u64;
    unsafe {
        GetDiskFreeSpaceExW(&root, Some(&mut available), None, None)
            .map_err(|error| format!("Could not check free disk space: {error}"))?;
    }
    let required = if base_ready {
        1_000_000_000
    } else {
        RUNTIME_REQUIRED_FREE_BYTES
    };
    if available < required {
        return Err(format!(
            "RIFE needs at least {:.1} GB free while installing; only {:.1} GB is available",
            required as f64 / 1_000_000_000.0,
            available as f64 / 1_000_000_000.0
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_install_prerequisites(_runtime_root: &Path, _base_ready: bool) -> Result<(), String> {
    Err("The RIFE Runtime installer currently supports Windows only".to_string())
}

pub fn managed_runtime_dir() -> Result<PathBuf, String> {
    Ok(runtime_root()?.join(RUNTIME_VERSION))
}

fn model_asset(setting: &str) -> Result<&'static ModelAsset, String> {
    MODEL_ASSETS
        .iter()
        .find(|model| model.setting == setting)
        .ok_or_else(|| format!("Unsupported RIFE model: {setting}"))
}

fn required_runtime_paths(runtime_dir: &Path) -> [PathBuf; 4] {
    [
        runtime_dir.join("vstrt.dll"),
        runtime_dir.join("vsmlrt.py"),
        runtime_dir.join("vsmlrt-cuda").join("trtexec.exe"),
        runtime_dir.join("vsmlrt-cuda").join("nvinfer_10.dll"),
    ]
}

pub fn runtime_info(selected_model: &str) -> Result<RifeRuntimeInfo, String> {
    let selected = model_asset(selected_model)?;
    let runtime_dir = managed_runtime_dir()?;
    let missing_files = required_runtime_paths(&runtime_dir)
        .into_iter()
        .filter(|path| !path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let installed = missing_files.is_empty();
    let model_dir = runtime_dir.join("models").join("rife");
    let mut installed_models = MODEL_ASSETS
        .iter()
        .filter(|model| {
            model_dir
                .join(model.installed_name)
                .metadata()
                .map(|metadata| metadata.is_file() && metadata.len() == model.installed_bytes)
                .unwrap_or(false)
        })
        .map(|model| model.setting.to_string())
        .collect::<Vec<_>>();
    installed_models.sort();
    let selected_model_installed = installed_models.iter().any(|model| model == selected_model);
    let ready = installed && selected_model_installed;
    let message = if ready {
        format!("RIFE {selected_model} is ready")
    } else if installed {
        format!("Install the RIFE {selected_model} model to use this selection")
    } else {
        "RIFE Runtime is not installed".to_string()
    };

    Ok(RifeRuntimeInfo {
        installed,
        ready,
        version: RUNTIME_VERSION.to_string(),
        path: runtime_dir.to_string_lossy().into_owned(),
        selected_model: selected_model.to_string(),
        selected_model_installed,
        installed_models,
        missing_files,
        download_bytes: RUNTIME_DOWNLOAD_BYTES + selected.asset.bytes,
        required_free_bytes: RUNTIME_REQUIRED_FREE_BYTES,
        message,
    })
}

fn emit_progress(
    app: &AppHandle,
    phase: &'static str,
    message: impl Into<String>,
    downloaded_bytes: u64,
    total_bytes: u64,
) {
    let _ = app.emit(
        "rife://install-progress",
        InstallProgress {
            phase,
            message: message.into(),
            downloaded_bytes,
            total_bytes,
        },
    );
}

fn emit_engine_preparation_progress(
    app: &AppHandle,
    phase: &'static str,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "rife://engine-preparation-progress",
        EnginePreparationProgress {
            phase,
            message: message.into(),
        },
    );
}

fn preparation_source_size(source_resolution: &str) -> Result<(u32, u32), String> {
    match source_resolution {
        "2160" => Ok((3840, 2160)),
        "1080" => Ok((1920, 1080)),
        "720" => Ok((1280, 720)),
        _ => Err(format!(
            "Unsupported RIFE engine preparation resolution: {source_resolution}"
        )),
    }
}

fn validate_engine_preparation_request(
    request: &RifeEnginePreparationRequest,
) -> Result<(u32, u32), String> {
    model_asset(&request.model)?;
    if !matches!(request.multiplier, 2 | 3) {
        return Err("RIFE frame-rate multiplier must be 2 or 3".to_string());
    }
    if !matches!(request.gpu_streams, 1 | 2) {
        return Err("RIFE GPU streams must be 1 or 2".to_string());
    }
    if !matches!(
        request.processing_mode.as_str(),
        "auto" | "native" | "1080" | "720"
    ) {
        return Err(format!(
            "Unsupported RIFE processing mode: {}",
            request.processing_mode
        ));
    }
    if !matches!(
        request.scale.as_str(),
        "auto" | "0.2" | "0.25" | "0.4" | "0.5" | "1.0"
    ) {
        return Err(format!("Unsupported RIFE scale: {}", request.scale));
    }
    preparation_source_size(&request.source_resolution)
}

fn normalized_mpv_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    value
        .strip_prefix(r"\\?\")
        .or_else(|| value.strip_prefix("//?/"))
        .unwrap_or(&value)
        .replace('\\', "/")
}

fn prepare_engine_blocking(
    app: AppHandle,
    mpv_path: PathBuf,
    script_path: PathBuf,
    request: RifeEnginePreparationRequest,
) -> Result<RifeEnginePreparationResult, String> {
    let _guard = begin_runtime_operation(RIFE_OPERATION_PREPARING, "prepare a RIFE engine")?;
    ENGINE_PREPARATION_CANCELLED.store(false, Ordering::SeqCst);
    let _ = remove_invalid_cache_artifacts(&engine_cache_dir()?);
    let (width, height) = validate_engine_preparation_request(&request)?;
    let runtime = runtime_info(&request.model)?;
    if !runtime.ready {
        return Err(runtime.message);
    }
    if !mpv_path.is_file() {
        return Err(format!("MPV was not found at {}", mpv_path.display()));
    }
    if !script_path.is_file() {
        return Err(format!(
            "The Streamee RIFE script was not found at {}",
            script_path.display()
        ));
    }

    let resolution_label = format!("{width}×{height}");
    let scale_label = if request.model == "4.6" {
        request.scale.as_str()
    } else {
        "1.0"
    };
    emit_engine_preparation_progress(
        &app,
        "preparing",
        format!(
            "Preparing RIFE {} · {} · scale {}",
            request.model, resolution_label, scale_label
        ),
    );

    let script = normalized_mpv_path(&script_path);
    let filter_concurrency = if request.gpu_streams == 2 && request.model == "4.6" {
        8
    } else {
        4
    };
    let filter = format!(
        "vapoursynth=file=%{}%{}:buffered-frames={}:concurrent-frames={}",
        script.len(),
        script,
        filter_concurrency,
        filter_concurrency
    );
    let source = format!("av://lavfi:color=c=black:s={width}x{height}:r=24000/1001:d=1");
    let log_path = runtime_root()?.join("engine-preparation.log");

    emit_engine_preparation_progress(
        &app,
        "compiling",
        "Compiling and validating the TensorRT engine. This can take several minutes the first time.",
    );

    let mut command = std::process::Command::new(&mpv_path);
    command.args([
        "--no-config",
        "--load-scripts=no",
        "--vo=null",
        "--ao=null",
        "--no-audio",
        "--frames=1",
        "--no-terminal",
        &format!("--log-file={}", log_path.display()),
        "--msg-level=all=info",
        &format!("--vf={filter}"),
        &source,
    ]);
    command
        .env("STREAMEE_RIFE_RUNTIME", &runtime.path)
        .env("STREAMEE_RIFE_MODEL", &request.model)
        .env("STREAMEE_RIFE_MULTIPLIER", request.multiplier.to_string())
        .env("STREAMEE_RIFE_GPU_STREAMS", request.gpu_streams.to_string())
        .env("STREAMEE_RIFE_PROCESSING_MODE", &request.processing_mode)
        .env("STREAMEE_RIFE_SCALE", &request.scale);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start RIFE engine preparation: {error}"))?;
    let started = Instant::now();
    let status = loop {
        if ENGINE_PREPARATION_CANCELLED.load(Ordering::SeqCst) {
            terminate_preparation_process(&mut child);
            let message = "RIFE engine preparation was cancelled".to_string();
            emit_engine_preparation_progress(&app, "cancelled", &message);
            return Err(message);
        }
        if started.elapsed() >= ENGINE_PREPARATION_TIMEOUT {
            terminate_preparation_process(&mut child);
            let message = format!(
                "RIFE engine preparation timed out after {} minutes. Details were written to {}",
                ENGINE_PREPARATION_TIMEOUT.as_secs() / 60,
                log_path.display()
            );
            emit_engine_preparation_progress(&app, "error", &message);
            return Err(message);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(error) => {
                terminate_preparation_process(&mut child);
                let message = format!("Could not monitor RIFE engine preparation: {error}");
                emit_engine_preparation_progress(&app, "error", &message);
                return Err(message);
            }
        }
    };
    if !status.success() {
        let message = format!(
            "RIFE engine preparation failed (exit code {}). Details were written to {}",
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            log_path.display()
        );
        emit_engine_preparation_progress(&app, "error", &message);
        return Err(message);
    }

    let message = format!(
        "RIFE {} engine is ready for exact {} source frames at scale {}",
        request.model, resolution_label, scale_label
    );
    emit_engine_preparation_progress(&app, "complete", &message);
    Ok(RifeEnginePreparationResult {
        model: request.model,
        scale: scale_label.to_string(),
        source_resolution: request.source_resolution,
        message,
    })
}

pub async fn prepare_engine(
    app: AppHandle,
    mpv_path: PathBuf,
    script_path: PathBuf,
    request: RifeEnginePreparationRequest,
) -> Result<RifeEnginePreparationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_engine_blocking(app, mpv_path, script_path, request)
    })
    .await
    .map_err(|error| format!("RIFE engine preparation task failed: {error}"))?
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn response_for_download(client: &Client, asset: Asset, offset: u64) -> Result<Response, String> {
    let mut request = client.get(asset.url);
    if offset > 0 {
        request = request.header(RANGE, format!("bytes={offset}-"));
    }
    request
        .send()
        .and_then(Response::error_for_status)
        .map_err(|error| format!("Could not download {}: {error}", asset.name))
}

fn download_asset(
    app: &AppHandle,
    client: &Client,
    asset: Asset,
    download_dir: &Path,
    completed_before: u64,
    total_bytes: u64,
) -> Result<PathBuf, String> {
    fs::create_dir_all(download_dir)
        .map_err(|error| format!("Could not create {}: {error}", download_dir.display()))?;
    let final_path = download_dir.join(asset.name);
    if final_path.is_file()
        && final_path.metadata().map(|value| value.len()).unwrap_or(0) == asset.bytes
        && sha256_file(&final_path)?.eq_ignore_ascii_case(asset.sha256)
    {
        emit_progress(
            app,
            "downloading",
            format!("Verified cached {}", asset.name),
            completed_before + asset.bytes,
            total_bytes,
        );
        return Ok(final_path);
    }

    let part_path = download_dir.join(format!("{}.part", asset.name));
    let mut offset = part_path.metadata().map(|value| value.len()).unwrap_or(0);
    if offset > asset.bytes {
        File::create(&part_path)
            .map_err(|error| format!("Could not reset {}: {error}", part_path.display()))?;
        offset = 0;
    }

    let mut response = response_for_download(client, asset, offset)?;
    let resumed = offset > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if offset > 0 && !resumed {
        offset = 0;
    }
    let mut output = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(!resumed)
        .open(&part_path)
        .map_err(|error| format!("Could not write {}: {error}", part_path.display()))?;
    output
        .seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Could not seek {}: {error}", part_path.display()))?;

    let mut downloaded = offset;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Download interrupted for {}: {error}", asset.name))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("Could not write {}: {error}", part_path.display()))?;
        downloaded += read as u64;
        emit_progress(
            app,
            "downloading",
            format!("Downloading {}", asset.name),
            completed_before + downloaded,
            total_bytes,
        );
    }
    output
        .sync_all()
        .map_err(|error| format!("Could not finish {}: {error}", part_path.display()))?;

    if downloaded != asset.bytes {
        return Err(format!(
            "{} has an unexpected size (expected {}, received {})",
            asset.name, asset.bytes, downloaded
        ));
    }
    let actual_hash = sha256_file(&part_path)?;
    if !actual_hash.eq_ignore_ascii_case(asset.sha256) {
        return Err(format!("SHA-256 verification failed for {}", asset.name));
    }
    if final_path.exists() {
        fs::remove_file(&final_path)
            .map_err(|error| format!("Could not replace {}: {error}", final_path.display()))?;
    }
    fs::rename(&part_path, &final_path)
        .map_err(|error| format!("Could not finalize {}: {error}", final_path.display()))?;
    Ok(final_path)
}

fn extract_archive(archive: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create {}: {error}", destination.display()))?;
    sevenz_rust::decompress_file(archive, destination).map_err(|error| {
        format!(
            "Could not extract {} into {}: {error}",
            archive.display(),
            destination.display()
        )
    })
}

fn combine_cuda_archive(part_one: &Path, part_two: &Path, output: &Path) -> Result<(), String> {
    let mut destination = File::create(output)
        .map_err(|error| format!("Could not create {}: {error}", output.display()))?;
    for part in [part_one, part_two] {
        let mut source = File::open(part)
            .map_err(|error| format!("Could not open {}: {error}", part.display()))?;
        std::io::copy(&mut source, &mut destination)
            .map_err(|error| format!("Could not combine {}: {error}", part.display()))?;
    }
    destination
        .sync_all()
        .map_err(|error| format!("Could not finish {}: {error}", output.display()))
}

fn install_model_archive(
    archive: &Path,
    model: &ModelAsset,
    runtime_dir: &Path,
) -> Result<(), String> {
    let staging = runtime_dir.join(format!(".model-staging-{}", std::process::id()));
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("Could not reset {}: {error}", staging.display()))?;
    }
    extract_archive(archive, &staging)?;
    let source = staging.join(model.archive_path);
    let destination_dir = runtime_dir.join("models").join("rife");
    fs::create_dir_all(&destination_dir)
        .map_err(|error| format!("Could not create {}: {error}", destination_dir.display()))?;
    fs::copy(&source, destination_dir.join(model.installed_name)).map_err(|error| {
        format!(
            "Could not install RIFE model from {}: {error}",
            source.display()
        )
    })?;
    fs::remove_dir_all(&staging)
        .map_err(|error| format!("Could not clean {}: {error}", staging.display()))
}

fn write_runtime_notices(runtime_dir: &Path) -> Result<(), String> {
    let notice = format!(
        "Streamee optional RIFE Runtime\n\n\
         vs-mlrt {RUNTIME_VERSION}\n\
         Source: https://github.com/AmusementClub/vs-mlrt/tree/{RUNTIME_VERSION}\n\
         License: GPL-3.0\n\n\
         RIFE models\n\
         Source: https://github.com/hzwer/Practical-RIFE\n\
         License: MIT\n\n\
         NVIDIA TensorRT runtime components are subject to the NVIDIA TensorRT SLA:\n\
         https://docs.nvidia.com/deeplearning/tensorrt/latest/reference/sla.html\n"
    );
    fs::write(runtime_dir.join("THIRD_PARTY_NOTICES.txt"), notice)
        .map_err(|error| format!("Could not write RIFE third-party notices: {error}"))
}

fn install_blocking(app: AppHandle, selected_model: String) -> Result<RifeRuntimeInfo, String> {
    let _guard = begin_runtime_operation(RIFE_OPERATION_INSTALLING, "install the RIFE Runtime")?;
    let _ = remove_invalid_cache_artifacts(&engine_cache_dir()?);
    let model = *model_asset(&selected_model)?;
    let runtime_root = runtime_root()?;
    let runtime_dir = managed_runtime_dir()?;
    let download_dir = runtime_root.join("downloads").join(RUNTIME_VERSION);
    let client = Client::builder()
        .user_agent("Streamee-RIFE-Runtime-Installer/1.0")
        .build()
        .map_err(|error| format!("Could not initialize the RIFE downloader: {error}"))?;

    let base_ready = required_runtime_paths(&runtime_dir)
        .into_iter()
        .all(|path| path.is_file());
    ensure_install_prerequisites(&runtime_root, base_ready)?;
    if base_ready {
        let model_archive = download_asset(
            &app,
            &client,
            model.asset,
            &download_dir,
            0,
            model.asset.bytes,
        )?;
        emit_progress(
            &app,
            "extracting",
            "Installing selected RIFE model",
            model.asset.bytes,
            model.asset.bytes,
        );
        install_model_archive(&model_archive, &model, &runtime_dir)?;
        write_runtime_notices(&runtime_dir)?;
        emit_progress(
            &app,
            "complete",
            "RIFE Runtime is ready",
            model.asset.bytes,
            model.asset.bytes,
        );
        return runtime_info(&selected_model);
    }

    let total_bytes = RUNTIME_DOWNLOAD_BYTES + model.asset.bytes;
    let assets = [
        CUDA_PART_ONE,
        CUDA_PART_TWO,
        VSTRT_PLUGIN,
        VSMLRT_SCRIPTS,
        model.asset,
    ];
    let mut completed = 0_u64;
    let mut paths = Vec::with_capacity(assets.len());
    for asset in assets {
        let path = download_asset(&app, &client, asset, &download_dir, completed, total_bytes)?;
        completed += asset.bytes;
        paths.push(path);
    }

    let staging = runtime_root.join(format!(
        "{RUNTIME_VERSION}.installing-{}",
        std::process::id()
    ));
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("Could not reset {}: {error}", staging.display()))?;
    }
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Could not create {}: {error}", staging.display()))?;

    emit_progress(
        &app,
        "extracting",
        "Preparing TensorRT runtime",
        completed,
        total_bytes,
    );
    let combined_cuda = download_dir.join("vsmlrt-cuda.v15.16.7z");
    combine_cuda_archive(&paths[0], &paths[1], &combined_cuda)?;
    extract_archive(&combined_cuda, &staging)?;
    extract_archive(&paths[2], &staging)?;
    extract_archive(&paths[3], &staging)?;
    install_model_archive(&paths[4], &model, &staging)?;
    write_runtime_notices(&staging)?;

    let backup = runtime_root.join(format!("{RUNTIME_VERSION}.previous"));
    if backup.exists() {
        fs::remove_dir_all(&backup)
            .map_err(|error| format!("Could not remove {}: {error}", backup.display()))?;
    }
    if runtime_dir.exists() {
        fs::rename(&runtime_dir, &backup)
            .map_err(|error| format!("Could not preserve {}: {error}", runtime_dir.display()))?;
    }
    if let Err(error) = fs::rename(&staging, &runtime_dir) {
        if backup.exists() {
            let _ = fs::rename(&backup, &runtime_dir);
        }
        return Err(format!("Could not activate the RIFE Runtime: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    let _ = fs::remove_file(&combined_cuda);
    emit_progress(
        &app,
        "complete",
        "RIFE Runtime is ready",
        total_bytes,
        total_bytes,
    );
    runtime_info(&selected_model)
}

pub async fn install(app: AppHandle, selected_model: String) -> Result<RifeRuntimeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || install_blocking(app, selected_model))
        .await
        .map_err(|error| format!("RIFE installer task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_exposed_model_has_a_pinned_asset() {
        for setting in ["4.6", "4.9", "4.16-lite", "4.18", "4.25"] {
            let model = model_asset(setting).expect("model asset");
            assert_eq!(model.asset.sha256.len(), 64);
            assert!(
                model.asset.url.starts_with(
                    "https://github.com/AmusementClub/vs-mlrt/releases/download/external-models"
                ) || model.asset.url.starts_with(
                    "https://github.com/AmusementClub/vs-mlrt/releases/download/model-20220923"
                )
            );
        }
    }

    #[test]
    fn runtime_assets_are_pinned_to_the_selected_release() {
        for asset in [CUDA_PART_ONE, CUDA_PART_TWO, VSTRT_PLUGIN, VSMLRT_SCRIPTS] {
            assert!(asset
                .url
                .starts_with("https://github.com/AmusementClub/vs-mlrt/releases/download/v15.16"));
            assert_eq!(asset.sha256.len(), 64);
        }
    }

    #[test]
    fn engine_preparation_accepts_only_supported_profiles() {
        let valid = RifeEnginePreparationRequest {
            model: "4.6".to_string(),
            multiplier: 2,
            gpu_streams: 2,
            processing_mode: "auto".to_string(),
            scale: "0.5".to_string(),
            source_resolution: "2160".to_string(),
        };
        assert_eq!(
            validate_engine_preparation_request(&valid).unwrap(),
            (3840, 2160)
        );

        let mut invalid_scale = valid.clone();
        invalid_scale.scale = "0.3".to_string();
        assert!(validate_engine_preparation_request(&invalid_scale).is_err());

        let mut invalid_resolution = valid;
        invalid_resolution.source_resolution = "1440".to_string();
        assert!(validate_engine_preparation_request(&invalid_resolution).is_err());
    }
}
