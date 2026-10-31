use std::fs;
use std::io;
use std::path::Path;

/// Prepare installer resources without modifying the development runtime.
pub fn stage_media_runtime(source: &Path, destination: &Path) -> io::Result<u64> {
    if !source.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Media runtime directory not found: {}", source.display()),
        ));
    }
    if destination.exists() {
        fs::remove_dir_all(destination)?;
    }
    copy_runtime(source, source, destination)
}

fn copy_runtime(root: &Path, source: &Path, destination: &Path) -> io::Result<u64> {
    fs::create_dir_all(destination)?;
    let mut copied = 0;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let relative = source_path.strip_prefix(root).unwrap();
        if relative.starts_with("Lib/site-packages/onnx/backend/test")
            || relative.starts_with("Lib/site-packages/onnx/test")
            || entry.file_name() == "__pycache__"
            || matches!(
                source_path
                    .extension()
                    .and_then(|extension| extension.to_str()),
                Some("pyc" | "pyo")
            )
        {
            continue;
        }

        let target = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copied += copy_runtime(root, &source_path, &target)?;
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
