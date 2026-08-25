#[cfg(target_os = "windows")]
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, DisplayConfigSetDeviceInfo, GetDisplayConfigBufferSizes,
    QueryDisplayConfig, DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_HEADER,
    DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE, DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO,
    DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE,
    DISPLAYCONFIG_SOURCE_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{ERROR_SUCCESS, HWND, LUID};
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
};

#[derive(Debug, Clone, Copy)]
pub(crate) struct HdrState {
    pub supported: bool,
    pub enabled: bool,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
pub(crate) struct HdrTarget {
    adapter_id: LUID,
    target_id: u32,
}

#[cfg(target_os = "windows")]
fn utf16_string(value: &[u16]) -> String {
    let end = value.iter().position(|ch| *ch == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end])
}

#[cfg(target_os = "windows")]
fn playback_display_name(hwnd: HWND) -> Result<String, String> {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.0.is_null() {
        return Err("MPV window is not associated with a monitor".to_string());
    }

    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    let ok = unsafe {
        GetMonitorInfoW(
            monitor,
            (&mut info as *mut MONITORINFOEXW).cast::<MONITORINFO>(),
        )
    };
    if !ok.as_bool() {
        return Err("GetMonitorInfoW failed for MPV monitor".to_string());
    }
    Ok(utf16_string(&info.szDevice))
}

#[cfg(target_os = "windows")]
pub(crate) fn target_for_window(hwnd: HWND) -> Result<HdrTarget, String> {
    let display_name = playback_display_name(hwnd)?;
    let mut path_count = 0u32;
    let mut mode_count = 0u32;
    let status = unsafe {
        GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
    };
    if status != ERROR_SUCCESS {
        return Err(format!("GetDisplayConfigBufferSizes failed: {}", status.0));
    }

    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
    let mut modes = vec![Default::default(); mode_count as usize];
    let status = unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut path_count,
            paths.as_mut_ptr(),
            &mut mode_count,
            modes.as_mut_ptr(),
            None,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("QueryDisplayConfig failed: {}", status.0));
    }

    for path in paths.into_iter().take(path_count as usize) {
        let mut source_name = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
        source_name.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
            size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
            adapterId: path.sourceInfo.adapterId,
            id: path.sourceInfo.id,
        };
        let result = unsafe { DisplayConfigGetDeviceInfo(&mut source_name.header) };
        if result == 0
            && utf16_string(&source_name.viewGdiDeviceName).eq_ignore_ascii_case(&display_name)
        {
            return Ok(HdrTarget {
                adapter_id: path.targetInfo.adapterId,
                target_id: path.targetInfo.id,
            });
        }
    }

    Err(format!("No active display target matched {display_name}"))
}

#[cfg(target_os = "windows")]
pub(crate) fn get_for_target(target: HdrTarget) -> Result<HdrState, String> {
    let mut info = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO::default();
    info.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
        r#type: DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
        size: std::mem::size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>() as u32,
        adapterId: target.adapter_id,
        id: target.target_id,
    };
    let result = unsafe { DisplayConfigGetDeviceInfo(&mut info.header) };
    if result != 0 {
        return Err(format!("Could not read HDR state: Windows error {result}"));
    }
    let flags = unsafe { info.Anonymous.value };
    Ok(HdrState {
        supported: flags & 0x1 != 0,
        enabled: flags & 0x2 != 0,
    })
}

#[cfg(target_os = "windows")]
pub(crate) fn get_for_window(hwnd: HWND) -> Result<HdrState, String> {
    get_for_target(target_for_window(hwnd)?)
}

#[cfg(target_os = "windows")]
pub(crate) fn toggle_for_window(hwnd: HWND) -> Result<HdrState, String> {
    let target = target_for_window(hwnd)?;
    let current = get_for_target(target)?;
    if !current.supported {
        return Ok(current);
    }

    let mut request = DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE::default();
    request.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
        r#type: DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE,
        size: std::mem::size_of::<DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE>() as u32,
        adapterId: target.adapter_id,
        id: target.target_id,
    };
    request.Anonymous.value = u32::from(!current.enabled);
    let result = unsafe { DisplayConfigSetDeviceInfo(&request.header) };
    if result != 0 {
        return Err(format!(
            "Could not change HDR state: Windows error {result}"
        ));
    }

    get_for_target(target)
}

#[cfg(target_os = "windows")]
pub(crate) fn set_for_target(target: HdrTarget, enabled: bool) -> Result<HdrState, String> {
    let current = get_for_target(target)?;
    if !current.supported || current.enabled == enabled {
        return Ok(current);
    }

    let mut request = DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE::default();
    request.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
        r#type: DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE,
        size: std::mem::size_of::<DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE>() as u32,
        adapterId: target.adapter_id,
        id: target.target_id,
    };
    request.Anonymous.value = u32::from(enabled);
    let result = unsafe { DisplayConfigSetDeviceInfo(&request.header) };
    if result != 0 {
        return Err(format!(
            "Could not change HDR state: Windows error {result}"
        ));
    }
    get_for_target(target)
}
