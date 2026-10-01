//! Driver-only OptiFlow preflight. The decoder-device capability probe runs in MPV.
use serde::Serialize;
use std::path::Path;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptiflowRuntimeInfo {
    pub ready: bool,
    pub driver_api_version: Option<u32>,
    pub message: String,
}

pub fn runtime_info(assets: Option<(&Path, &Path)>) -> OptiflowRuntimeInfo {
    let assets_present =
        assets.is_some_and(|(player, bridge)| player.is_file() && bridge.is_file());
    // Missing assets do not require opening the driver library.
    preflight(
        assets_present,
        assets_present.then(driver_api_version).flatten(),
    )
}

fn preflight(assets_present: bool, version: Option<u32>) -> OptiflowRuntimeInfo {
    let ready = assets_present && version.is_some_and(|v| v >= 0x50);
    let message = if !assets_present {
        "The custom OptiFlow player or bridge is missing. Ordinary playback remains available."
    } else if !version.is_some_and(|v| v >= 0x50) {
        "A compatible NVIDIA optical-flow driver API was not found."
    } else {
        "Driver API and custom player available. GPU and format capabilities are checked on the decoder device when playback starts."
    };
    OptiflowRuntimeInfo {
        ready,
        driver_api_version: version,
        message: message.into(),
    }
}

#[cfg(windows)]
fn driver_api_version() -> Option<u32> {
    use std::ffi::{c_char, c_void};
    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(name: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
        fn FreeLibrary(module: *mut c_void) -> i32;
    }
    struct Module(*mut c_void);
    impl Drop for Module {
        fn drop(&mut self) {
            unsafe {
                FreeLibrary(self.0);
            }
        }
    }
    let name: Vec<u16> = "nvofapi64.dll\0".encode_utf16().collect();
    unsafe {
        // LOAD_LIBRARY_SEARCH_SYSTEM32: never load a driver DLL from the working directory.
        let module = Module(LoadLibraryExW(name.as_ptr(), std::ptr::null_mut(), 0x800));
        if module.0.is_null() {
            return None;
        }
        let address = GetProcAddress(module.0, c"NvOFGetMaxSupportedApiVersion".as_ptr());
        if address.is_null() {
            return None;
        }
        let query: unsafe extern "system" fn(*mut u32) -> i32 = std::mem::transmute(address);
        let mut version = 0;
        (query(&mut version) == 0).then_some(version)
    }
}

#[cfg(not(windows))]
fn driver_api_version() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn absent_assets_never_report_ready() {
        let info = super::runtime_info(None);
        assert!(!info.ready);
        assert!(info.message.contains("missing"));
    }

    #[test]
    fn preflight_distinguishes_assets_driver_and_decoder_capabilities() {
        for version in [None, Some(0x40), Some(0x50), Some(0x60)] {
            let missing = super::preflight(false, version);
            assert!(!missing.ready);
            assert!(missing.message.contains("missing"));
            let present = super::preflight(true, version);
            assert_eq!(present.ready, version.is_some_and(|v| v >= 0x50));
            if present.ready {
                assert!(present.message.contains("checked on the decoder device"));
            } else {
                assert!(present.message.contains("driver API was not found"));
            }
        }
    }

    #[test]
    fn stale_asset_paths_never_claim_the_player_is_available() {
        // Directories are not executable assets; no driver call is needed.
        let directory = std::env::temp_dir();
        let info = super::runtime_info(Some((&directory, &directory)));
        assert!(!info.ready);
        assert_eq!(info.driver_api_version, None);
        assert!(info.message.contains("missing"));
    }
}
