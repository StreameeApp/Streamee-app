use std::fs;
use std::io;
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Prepare installer resources without modifying the development runtime.
pub fn stage_media_runtime(source: &Path, destination: &Path) -> io::Result<u64> {
    let copied = stage_runtime(source, destination, &exclude_media_asset)?;
    let pip = destination.join("Lib/site-packages/pip");
    if !pip.is_dir() {
        return Ok(copied);
    }

    let pth_files: Vec<_> = fs::read_dir(destination)?
        .collect::<io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("python") && name.ends_with("._pth")
        })
        .collect();
    if pth_files.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Bundled pip requires an embedded Python ._pth configuration",
        ));
    }

    let archive_path = destination.join("pip-runtime.zip");
    let archive_existed = archive_path.exists();
    let mut archive = ZipWriter::new(fs::File::create(&archive_path)?);
    let archived = archive_directory(pip.parent().unwrap(), &pip, &mut archive)?;
    archive.finish()?.sync_all()?;
    for pth in pth_files {
        let current = fs::read_to_string(pth.path())?;
        let mut lines = vec!["pip-runtime.zip".to_string()];
        lines.extend(
            current
                .lines()
                .filter(|line| !line.trim().eq_ignore_ascii_case("pip-runtime.zip"))
                .map(str::to_owned),
        );
        fs::write(pth.path(), lines.join("\n") + "\n")?;
    }
    fs::remove_dir_all(pip)?;
    Ok(copied - archived + u64::from(!archive_existed))
}

fn archive_directory(
    root: &Path,
    directory: &Path,
    archive: &mut ZipWriter<fs::File>,
) -> io::Result<u64> {
    let mut entries = fs::read_dir(directory)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6))
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644);
    let mut copied = 0;
    for entry in entries {
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            copied += archive_directory(root, &path, archive)?;
        } else {
            let relative = path.strip_prefix(root).unwrap();
            archive.start_file(relative.to_string_lossy().replace('\\', "/"), options)?;
            io::copy(&mut fs::File::open(path)?, archive)?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// Keep only the production assets needed by the target Node platform.
pub fn stage_sidecar_runtime(
    source: &Path,
    destination: &Path,
    native_target: &str,
) -> io::Result<u64> {
    stage_runtime(source, destination, &|relative| {
        let normalized = relative.to_string_lossy().replace('\\', "/");
        if [
            ".js.map", ".mjs.map", ".cjs.map", ".ts.map", ".mts.map", ".cts.map",
        ]
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
            || [".d.ts", ".d.mts", ".d.cts"]
                .iter()
                .any(|suffix| normalized.ends_with(suffix))
            || matches!(
                normalized.as_str(),
                "webtorrent/dist/webtorrent.chromeapp.js"
                    | "webtorrent/dist/webtorrent.min.js"
                    | "xml2js/lib/xml2js.bc.js"
            )
        {
            return true;
        }
        let components: Vec<_> = normalized.split('/').collect();
        components.windows(2).any(|pair| {
            pair[0] == "prebuilds"
                && pair[1] != native_target
                && matches!(
                    pair[1].split('-').next(),
                    Some("android" | "darwin" | "ios" | "linux" | "win32" | "freebsd")
                )
        })
    })
}

fn stage_runtime(
    source: &Path,
    destination: &Path,
    excluded: &impl Fn(&Path) -> bool,
) -> io::Result<u64> {
    if !source.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Runtime directory not found: {}", source.display()),
        ));
    }
    if destination.exists() {
        fs::remove_dir_all(destination)?;
    }
    copy_runtime(source, source, destination, excluded)
}

fn exclude_media_asset(relative: &Path) -> bool {
    relative.starts_with("Lib/site-packages/onnx/backend/test")
        || relative.starts_with("Lib/site-packages/onnx/test")
        || relative
            .file_name()
            .is_some_and(|name| name == "__pycache__")
        || matches!(
            relative
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("pyc" | "pyo")
        )
}

fn copy_runtime(
    root: &Path,
    source: &Path,
    destination: &Path,
    excluded: &impl Fn(&Path) -> bool,
) -> io::Result<u64> {
    fs::create_dir_all(destination)?;
    let mut copied = 0;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let relative = source_path.strip_prefix(root).unwrap();
        if excluded(relative) {
            continue;
        }

        let target = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copied += copy_runtime(root, &source_path, &target, excluded)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target)?;
            copied += 1;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unsupported media runtime entry: {}", source_path.display()),
            ));
        }
    }
    Ok(copied)
}
