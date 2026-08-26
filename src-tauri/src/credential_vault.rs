const CREDENTIAL_USERNAME: &str = "Streamee";

#[cfg(windows)]
pub fn write(target: &str, value: &str) -> Result<(), String> {
    use windows::core::PWSTR;
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let mut target = target
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut username = CREDENTIAL_USERNAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut blob = value.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(username.as_mut_ptr()),
        ..Default::default()
    };

    unsafe { CredWriteW(&credential, 0) }
        .map_err(|error| format!("Windows Credential Manager rejected the secret: {error}"))
}

#[cfg(windows)]
pub fn read(target: &str) -> Result<Option<String>, String> {
    use std::ptr::null_mut;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target = target
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut credential: *mut CREDENTIALW = null_mut();
    let result = unsafe {
        CredReadW(
            PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            None,
            &mut credential,
        )
    };
    if let Err(error) = result {
        if error.code() == ERROR_NOT_FOUND.to_hresult() {
            return Ok(None);
        }
        return Err(format!(
            "Windows Credential Manager could not read the secret: {error}"
        ));
    }
    if credential.is_null() {
        return Ok(None);
    }

    let value = unsafe {
        let record = &*credential;
        let bytes =
            std::slice::from_raw_parts(record.CredentialBlob, record.CredentialBlobSize as usize);
        let value = String::from_utf8(bytes.to_vec())
            .map_err(|_| "The stored secret is not valid UTF-8".to_string());
        CredFree(credential.cast());
        value
    }?;
    Ok(Some(value))
}

#[cfg(windows)]
pub fn delete(target: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    let target = target
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ERROR_NOT_FOUND.to_hresult() => Ok(()),
        Err(error) => Err(format!(
            "Windows Credential Manager could not delete the secret: {error}"
        )),
    }
}

#[cfg(not(windows))]
pub fn write(_target: &str, _value: &str) -> Result<(), String> {
    Err("Secure credential storage is available only on Windows".to_string())
}

#[cfg(not(windows))]
pub fn read(_target: &str) -> Result<Option<String>, String> {
    Err("Secure credential storage is available only on Windows".to_string())
}

#[cfg(not(windows))]
pub fn delete(_target: &str) -> Result<(), String> {
    Err("Secure credential storage is available only on Windows".to_string())
}
