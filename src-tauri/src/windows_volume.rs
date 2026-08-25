#[cfg(target_os = "windows")]
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
#[cfg(target_os = "windows")]
use windows::Win32::Media::Audio::{eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

#[cfg(target_os = "windows")]
struct ComGuard(bool);

#[cfg(target_os = "windows")]
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn endpoint_volume() -> Result<(IAudioEndpointVolume, ComGuard), String> {
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    let guard = ComGuard(initialized);

    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|error| format!("Could not create Windows audio device enumerator: {error}"))?
    };
    let device = unsafe {
        enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(|error| format!("Could not get the default Windows audio output: {error}"))?
    };
    let endpoint = unsafe {
        device
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(|error| format!("Could not open Windows master volume: {error}"))?
    };

    Ok((endpoint, guard))
}

pub(crate) fn get_master_volume() -> Result<f64, String> {
    #[cfg(target_os = "windows")]
    {
        let (endpoint, _guard) = endpoint_volume()?;
        let scalar = unsafe {
            endpoint
                .GetMasterVolumeLevelScalar()
                .map_err(|error| format!("Could not read Windows master volume: {error}"))?
        };
        return Ok((f64::from(scalar) * 100.0).clamp(0.0, 100.0));
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Windows master volume is only available on Windows".to_string())
    }
}

pub(crate) fn set_master_volume(volume: f64) -> Result<f64, String> {
    #[cfg(target_os = "windows")]
    {
        let requested = volume.clamp(0.0, 100.0);
        let (endpoint, _guard) = endpoint_volume()?;
        unsafe {
            endpoint
                .SetMasterVolumeLevelScalar((requested / 100.0) as f32, std::ptr::null())
                .map_err(|error| format!("Could not set Windows master volume: {error}"))?;
        }
        return Ok(requested);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = volume;
        Err("Windows master volume is only available on Windows".to_string())
    }
}

pub(crate) fn step_master_volume(delta: f64) -> Result<f64, String> {
    let current = get_master_volume()?;
    set_master_volume(current + delta.signum())
}
