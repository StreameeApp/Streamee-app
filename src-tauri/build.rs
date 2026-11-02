use std::fs;
use std::path::PathBuf;
use std::process::Command;

mod bundle_runtime;
mod node_runtime;

fn main() {
    bundle_node_runtime();
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let media_source = manifest_dir.join("../mpv");
    let media_destination = manifest_dir.join("target/mpv-runtime");
    println!("cargo:rerun-if-changed={}", media_source.display());
    let copied = bundle_runtime::stage_media_runtime(&media_source, &media_destination)
        .expect("Failed to prepare installer media runtime");
    println!("cargo:warning=Prepared {copied} media runtime files for bundling");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap();
    let node_platform = match target_os.as_str() {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let node_arch = match target_arch.as_str() {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    let sidecar_source = manifest_dir.join("sidecar-runtime/node_modules");
    println!("cargo:rerun-if-changed={}", sidecar_source.display());
    let sidecar_files = bundle_runtime::stage_sidecar_runtime(
        &sidecar_source,
        &manifest_dir.join("target/sidecar-runtime/node_modules"),
        &format!("{node_platform}-{node_arch}"),
    )
    .expect("Failed to prepare installer sidecar runtime");
    println!("cargo:warning=Prepared {sidecar_files} sidecar runtime files for bundling");
    tauri_build::build()
}

fn bundle_node_runtime() {
    println!("cargo:rerun-if-env-changed=STREAMEE_NODE_EXE");
    println!("cargo:rerun-if-env-changed=PATH");

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let target_dir = manifest_dir.join("target").join("node-runtime");
    let destination = target_dir.join("streameenode.exe");

    let source = std::env::var("STREAMEE_NODE_EXE")
        .ok()
        .map(PathBuf::from)
        .or_else(find_node_exe);

    let source = source.expect(
        "[streamee build] Could not locate node.exe; install a patched Node runtime or set STREAMEE_NODE_EXE",
    );
    println!("cargo:rerun-if-changed={}", source.display());
    let version = read_node_version(&source).unwrap_or_else(|err| {
        panic!("[streamee build] Failed to read Node version at {source:?}: {err}")
    });
    node_runtime::validate_node_version(&version).unwrap_or_else(|err| {
        panic!("[streamee build] Refusing to bundle node.exe at {source:?}: {err}")
    });

    if let Err(err) = fs::create_dir_all(&target_dir) {
        panic!(
            "[streamee build] Failed to create {:?}: {}",
            target_dir, err
        );
    }

    if let Err(err) = fs::copy(&source, &destination) {
        panic!(
            "[streamee build] Failed to copy node runtime from {:?} to {:?}: {}",
            source, destination, err
        );
    }

    println!(
        "cargo:warning=Bundled Node {} from {:?}",
        version.trim(),
        source
    );
}

fn find_node_exe() -> Option<PathBuf> {
    let output = Command::new("where").arg("node").output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8(output.stdout).ok()?;
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
}

fn read_node_version(node_path: &PathBuf) -> Result<String, String> {
    let output = Command::new(node_path)
        .arg("-v")
        .output()
        .map_err(|err| err.to_string())?;

    if !output.status.success() {
        return Err(format!(
            "node -v exited with status {:?}",
            output.status.code()
        ));
    }

    String::from_utf8(output.stdout).map_err(|err| err.to_string())
}
