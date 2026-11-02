#[path = "../bundle_runtime.rs"]
mod bundle_runtime;

use std::fs;
use std::io::Read;
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
        "Lib/site-packages/pip-26.1.2.dist-info/licenses/LICENSE",
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
    let archived = [
        "pip/__init__.py",
        "pip/_vendor/certifi/cacert.pem",
        "pip/_vendor/distlib/t64.exe",
    ];
    for relative in archived {
        fixture.write(&format!("mpv/Lib/site-packages/{relative}"));
    }
    let pth = "python312.zip\n.\nLib\\site-packages\n# Keep embedding config\nimport site\n";
    fs::write(source.join("python312._pth"), pth).unwrap();
    fixture.write("target/mpv-runtime/removed-runtime.dll");
    fixture.write("target/mpv-runtime/Lib/site-packages/onnx/test/stale.py");

    let count = bundle_runtime::stage_media_runtime(&source, &staged).unwrap();
    assert_eq!(count, retained.len() as u64 + 2);
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
    assert!(!staged.join("Lib/site-packages/pip").exists());
    let archive_path = staged.join("pip-runtime.zip");
    let first_archive = fs::read(&archive_path).unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(&archive_path).unwrap()).unwrap();
    assert_eq!(archive.len(), archived.len());
    for relative in archived {
        let mut data = Vec::new();
        archive
            .by_name(relative)
            .unwrap()
            .read_to_end(&mut data)
            .unwrap();
        assert_eq!(
            data,
            fs::read(source.join("Lib/site-packages").join(relative)).unwrap()
        );
    }
    drop(archive);
    assert_eq!(
        fs::read_to_string(staged.join("python312._pth")).unwrap(),
        format!("pip-runtime.zip\n{pth}")
    );
    assert_eq!(
        fs::read_to_string(source.join("python312._pth")).unwrap(),
        pth
    );
    bundle_runtime::stage_media_runtime(&source, &staged).unwrap();
    assert_eq!(fs::read(archive_path).unwrap(), first_archive);
}

#[test]
fn pip_packaging_fails_if_the_archive_cannot_be_on_the_embedded_python_path() {
    let fixture = Fixture::new();
    fixture.write("mpv/Lib/site-packages/pip/__init__.py");
    let error = bundle_runtime::stage_media_runtime(
        &fixture.0.join("mpv"),
        &fixture.0.join("target/mpv-runtime"),
    )
    .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(fixture
        .0
        .join("mpv/Lib/site-packages/pip/__init__.py")
        .exists());
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

#[test]
fn sidecar_staging_keeps_native_code_licenses_and_data_for_the_target() {
    let fixture = Fixture::new();
    let source = fixture.0.join("node_modules");
    let staged = fixture.0.join("target/node_modules");
    let retained = [
        "bufferutil/package.json",
        "bufferutil/index.js",
        "bufferutil/prebuilds/win32-x64/bufferutil.node",
        "bufferutil/prebuilds/LICENSE",
        "bufferutil/LICENSE",
        "webtorrent/index.js",
        "webtorrent/dist/sw.min.js",
        "xml2js/lib/xml2js.js",
        "other/assets/navigation.map",
    ];
    let excluded = [
        "bufferutil/prebuilds/win32-arm64/bufferutil.node",
        "bufferutil/prebuilds/darwin-x64/bufferutil.node",
        "bufferutil/prebuilds/linux-x64/bufferutil.node",
        "webtorrent/dist/webtorrent.min.js",
        "webtorrent/dist/webtorrent.chromeapp.js",
        "webtorrent/dist/webtorrent.min.js.map",
        "other/types.d.ts",
        "other/types.d.mts",
        "other/types.d.cts",
        "other/types.d.ts.map",
        "xml2js/lib/xml2js.bc.js",
    ];
    for relative in retained.iter().chain(excluded.iter()) {
        fixture.write(&format!("node_modules/{relative}"));
    }
    fixture.write("target/node_modules/removed-package/index.js");
    let copied = bundle_runtime::stage_sidecar_runtime(&source, &staged, "win32-x64").unwrap();
    assert_eq!(copied, retained.len() as u64);
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
    assert!(!staged.join("removed-package").exists());

    bundle_runtime::stage_sidecar_runtime(&source, &staged, "win32-arm64").unwrap();
    assert!(staged
        .join("bufferutil/prebuilds/win32-arm64/bufferutil.node")
        .exists());
    assert!(!staged.join("bufferutil/prebuilds/win32-x64").exists());
}
