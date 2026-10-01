use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const KEY: &str = "mpvOptiflowClockControl";

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClockSettings {
    pub enabled: bool,
    pub minimum_mhz: u32,
    pub maximum_mhz: u32,
}

impl ClockSettings {
    fn validate(&self) -> Result<(), String> {
        if self.enabled && !(300..=5000).contains(&self.minimum_mhz) {
            return Err("Minimum graphics clock must be between 300 and 5000 MHz".into());
        }
        if self.enabled && (self.maximum_mhz < self.minimum_mhz || self.maximum_mhz > 5000) {
            return Err(
                "Maximum graphics clock must be at least the minimum and at most 5000 MHz".into(),
            );
        }
        Ok(())
    }
}

#[tauri::command]
pub fn get_optiflow_clock_settings(app: AppHandle) -> ClockSettings {
    read(&app)
}

#[tauri::command]
pub fn save_optiflow_clock_settings(app: AppHandle, settings: ClockSettings) -> Result<(), String> {
    settings.validate()?;
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set(
        KEY,
        serde_json::Value::String(serde_json::to_string(&settings).map_err(|e| e.to_string())?),
    );
    store.save().map_err(|e| e.to_string())
}

pub fn read(app: &AppHandle) -> ClockSettings {
    crate::get_store_setting(app, KEY)
        .and_then(|value| serde_json::from_str::<ClockSettings>(&value).ok())
        .filter(|settings| settings.validate().is_ok())
        .unwrap_or_default()
}

// A changed range is picked up only by a new player. Disabling is immediate.
static SESSION: std::sync::Mutex<Option<(u32, ClockSettings)>> = std::sync::Mutex::new(None);

pub fn allowed(app: &AppHandle, pid: u32) -> bool {
    let current = read(app);
    current.enabled
        && crate::get_bool_setting(app, "mpvOptiflowEnabled")
        && SESSION.lock().ok().and_then(|s| s.clone()).as_ref() == Some(&(pid, current))
}

#[cfg(windows)]
pub fn start(app: &AppHandle, pid: u32, optiflow_enabled: bool) {
    let settings = read(app);
    if let Ok(mut session) = SESSION.lock() {
        *session = None;
    }
    if !optiflow_enabled || !settings.enabled {
        return;
    }
    if let Ok(mut session) = SESSION.lock() {
        *session = Some((pid, settings.clone()));
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = elevate(pid, &settings) {
            tracing::warn!("Advanced OptiFlow GPU clock control unavailable: {error}");
            if let Ok(mut session) = SESSION.lock() {
                if session
                    .as_ref()
                    .is_some_and(|(current_pid, _)| *current_pid == pid)
                {
                    *session = None;
                }
            }
            use tauri::Emitter;
            let _ = app.emit("optiflow-clock-error", error);
        }
    });
}

#[cfg(not(windows))]
pub fn start(_app: &AppHandle, _pid: u32, _optiflow_enabled: bool) {}

#[cfg(windows)]
fn elevate(pid: u32, settings: &ClockSettings) -> Result<(), String> {
    use base64::Engine;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
    settings.validate()?;
    let mut directory = [0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(Some(&mut directory)) } as usize;
    if length == 0 || length >= directory.len() {
        return Err("Cannot locate Windows system directory".into());
    }
    let system = String::from_utf16_lossy(&directory[..length]);
    let executable = format!("{system}\\WindowsPowerShell\\v1.0\\powershell.exe");
    let script = format!(
        "$ParentId={};$PlayerId={pid};$MinimumMHz={};$MaximumMHz={};\n{}",
        std::process::id(),
        settings.minimum_mhz,
        settings.maximum_mhz,
        include_str!("optiflow_clock_guard.ps1")
    );
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let args = format!("-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {encoded}");
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let verb = wide("runas");
    let exe = wide(&executable);
    let args = wide(&args);
    let cwd = wide(&system);
    let result = unsafe {
        ShellExecuteW(
            Some(HWND::default()),
            PCWSTR(verb.as_ptr()),
            PCWSTR(exe.as_ptr()),
            PCWSTR(args.as_ptr()),
            PCWSTR(cwd.as_ptr()),
            SW_HIDE,
        )
    };
    if result.0 as isize <= 32 {
        return Err("Administrator approval was declined or the clock helper could not start; playback continues with automatic clocks".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn advanced_clocks_are_opt_in_and_ranges_are_validated() {
        assert!(!ClockSettings::default().enabled);
        for (minimum_mhz, maximum_mhz, valid) in [
            (300, 300, true),
            (1500, 2550, true),
            (0, 2550, false),
            (2600, 2500, false),
            (1500, 5001, false),
        ] {
            assert_eq!(
                ClockSettings {
                    enabled: true,
                    minimum_mhz,
                    maximum_mhz
                }
                .validate()
                .is_ok(),
                valid
            );
        }
    }
}
