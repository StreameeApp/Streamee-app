use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    bundle_node_runtime();
    tauri_build::build()
}

fn bundle_node_runtime() {
    println!("cargo:rerun-if-env-changed=STREAMEE_NODE_EXE");

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let target_dir = manifest_dir.join("target").join("node-runtime");
    let destination = target_dir.join("streameenode.exe");

    let source = std::env::var("STREAMEE_NODE_EXE")
        .ok()
        .map(PathBuf::from)
        .or_else(find_node_exe);

    let Some(source) = source else {
        eprintln!("[streamee build] Could not locate node.exe for bundling");
        return;
    };

    match read_node_major_version(&source) {
        Ok(version) if version >= 16 => {}
        Ok(version) => {
            panic!(
                "[streamee build] node.exe at {:?} is v{} but webtorrent@2.x requires Node 16+",
                source, version
            );
        }
        Err(err) => {
            panic!(
                "[streamee build] Failed to validate node.exe at {:?}: {}",
                source, err
            );
        }
    }

    if let Err(err) = fs::create_dir_all(&target_dir) {
        eprintln!(
            "[streamee build] Failed to create {:?}: {}",
            target_dir, err
        );
        return;
    }

    if let Err(err) = fs::copy(&source, &destination) {
        eprintln!(
            "[streamee build] Failed to copy node runtime from {:?} to {:?}: {}",
            source, destination, err
        );
        return;
    }

    println!("cargo:warning=Bundled Node runtime from {:?}", source);
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

fn read_node_major_version(node_path: &PathBuf) -> Result<u32, String> {
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

    let stdout = String::from_utf8(output.stdout).map_err(|err| err.to_string())?;
    let version = stdout.trim();
    let major = version
        .trim_start_matches('v')
        .split('.')
        .next()
        .ok_or_else(|| format!("unexpected Node version output: {version}"))?
        .parse::<u32>()
        .map_err(|err| err.to_string())?;

    Ok(major)
}
