use crate::credential_vault;

fn credential_target(provider: &str) -> Result<&'static str, String> {
    match provider {
        "tmdb" => Ok("Streamee/api/tmdb/key"),
        "omdb" => Ok("Streamee/api/omdb/key"),
        _ => Err("Unsupported API-key provider".to_string()),
    }
}

#[tauri::command]
pub fn get_api_key(provider: String) -> Result<Option<String>, String> {
    credential_vault::read(credential_target(&provider)?)
}

#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool, String> {
    Ok(credential_vault::read(credential_target(&provider)?)?
        .is_some_and(|value| !value.trim().is_empty()))
}

#[tauri::command]
pub fn set_api_key(provider: String, api_key: String) -> Result<(), String> {
    let target = credential_target(&provider)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        credential_vault::delete(target)
    } else {
        credential_vault::write(target, api_key)
    }
}

#[tauri::command]
pub fn clear_api_keys() -> Result<(), String> {
    credential_vault::delete(credential_target("tmdb")?)?;
    credential_vault::delete(credential_target("omdb")?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_provider_ids_only() {
        assert_eq!(credential_target("tmdb").unwrap(), "Streamee/api/tmdb/key");
        assert_eq!(credential_target("omdb").unwrap(), "Streamee/api/omdb/key");
        assert!(credential_target("other").is_err());
    }
}
