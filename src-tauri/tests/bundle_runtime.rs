#[path = "../bundle_runtime.rs"]
mod bundle_runtime;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "streamee-runtime-packaging-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn write(&self, relative: &str) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, relative).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn packaging_preserves_runtime_and_licenses_without_tests_or_bytecode() {
    let fixture = Fixture::new();
    let source = fixture.0.join("mpv");
    let staged = fixture.0.join("target/mpv-runtime");
    let retained = [
        "mpv.exe",
        "scripts/playback.lua",
        "Lib/site-packages/onnx/__init__.py",
        "Lib/site-packages/onnx/onnx_cpp2py_export.pyd",
        "Lib/site-packages/onnx/backend/base.py",
        "Lib/site-packages/onnx-1.22.0.dist-info/licenses/LICENSE",
        "Lib/site-packages/pip/__init__.py",
    ];
    let excluded = [
        "Lib/site-packages/onnx/backend/test/data/node/model.onnx",
        "Lib/site-packages/onnx/test/checker_test.py",
        "Lib/site-packages/onnx/__pycache__/__init__.cpython-312.pyc",
        "scripts/legacy.pyc",
        "scripts/legacy.pyo",
    ];
    for relative in retained.iter().chain(excluded.iter()) {
        fixture.write(&format!("mpv/{relative}"));
    }
    fixture.write("target/mpv-runtime/removed-runtime.dll");
    fixture.write("target/mpv-runtime/Lib/site-packages/onnx/test/stale.py");

    let count = bundle_runtime::stage_media_runtime(&source, &staged).unwrap();
    assert_eq!(count, retained.len() as u64);
    for relative in retained {
        assert_eq!(
            fs::read(staged.join(relative)).unwrap(),
            fs::read(source.join(relative)).unwrap()
        );
    }
    for relative in excluded {
        assert!(!staged.join(relative).exists(), "Bundled {relative}");
        assert!(source.join(relative).exists(), "Modified source {relative}");
    }
    assert!(!staged.join("removed-runtime.dll").exists());
    assert!(!staged.join("Lib/site-packages/onnx/test").exists());
}

#[test]
fn missing_runtime_fails_without_removing_the_previous_stage() {
    let fixture = Fixture::new();
    fixture.write("target/mpv-runtime/mpv.exe");
    let staged = fixture.0.join("target/mpv-runtime");
    let error =
        bundle_runtime::stage_media_runtime(&fixture.0.join("missing"), &staged).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert!(Path::new(&staged).join("mpv.exe").exists());
}
