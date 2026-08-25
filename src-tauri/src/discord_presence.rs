use discord_rich_presence::activity::{
    Activity, ActivityType, Assets, Button, StatusDisplayType, Timestamps,
};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

const DISCORD_CLIENT_ID: &str = "1522958528879263835";
const LARGE_IMAGE_KEY: &str = "streamee";

static PRESENCE: Lazy<Mutex<DiscordPresenceState>> =
    Lazy::new(|| Mutex::new(DiscordPresenceState::default()));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordPresencePayload {
    pub enabled: bool,
    pub title: String,
    pub subtitle: Option<String>,
    pub paused: bool,
    pub playback_time: Option<f64>,
    pub duration: Option<f64>,
    pub imdb_url: Option<String>,
    pub poster_url: Option<String>,
}

#[derive(Default)]
struct DiscordPresenceState {
    enabled: bool,
    connected: bool,
    client: Option<DiscordIpcClient>,
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let mut state = PRESENCE.lock();
    state.enabled = enabled;

    if !enabled {
        clear_locked(&mut state);
    }

    Ok(())
}

pub fn update(payload: DiscordPresencePayload) -> Result<(), String> {
    let mut state = PRESENCE.lock();
    state.enabled = payload.enabled;

    if !state.enabled {
        clear_locked(&mut state);
        return Ok(());
    }

    if payload.title.trim().is_empty() {
        clear_locked(&mut state);
        return Ok(());
    }

    ensure_connected(&mut state)?;

    let activity = build_activity(&payload);
    match state
        .client
        .as_mut()
        .ok_or_else(|| "Discord Presence client unavailable".to_string())?
        .set_activity(activity)
    {
        Ok(()) => Ok(()),
        Err(err) => {
            state.connected = false;
            state.client = None;
            Err(format!("Failed to update Discord Presence: {err}"))
        }
    }
}

pub fn clear() -> Result<(), String> {
    let mut state = PRESENCE.lock();
    clear_locked(&mut state);
    Ok(())
}

fn ensure_connected(state: &mut DiscordPresenceState) -> Result<(), String> {
    if state.connected && state.client.is_some() {
        return Ok(());
    }

    let mut client = DiscordIpcClient::new(DISCORD_CLIENT_ID);
    client
        .connect()
        .map_err(|err| format!("Failed to connect to Discord Presence: {err}"))?;

    state.connected = true;
    state.client = Some(client);
    info!("Discord Presence connected");
    Ok(())
}

fn clear_locked(state: &mut DiscordPresenceState) {
    if let Some(client) = state.client.as_mut() {
        if let Err(err) = client.clear_activity() {
            warn!("Failed to clear Discord Presence activity: {}", err);
        }
        if let Err(err) = client.close() {
            warn!("Failed to close Discord Presence client: {}", err);
        }
    }

    state.connected = false;
    state.client = None;
}

fn build_activity(payload: &DiscordPresencePayload) -> Activity<'static> {
    let title = truncate_activity_text(payload.title.trim(), 128);
    let subtitle = payload
        .subtitle
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_activity_text(value, 128));

    let state_text = if payload.paused {
        match subtitle.as_deref() {
            Some(subtitle) => format!("Paused - {subtitle}"),
            None => "Paused".to_string(),
        }
    } else {
        subtitle.unwrap_or_else(|| "Watching now".to_string())
    };
    let poster_url = payload
        .poster_url
        .as_deref()
        .map(str::trim)
        .filter(|value| is_valid_external_image_url(value));
    let assets = match poster_url {
        Some(poster_url) => Assets::new()
            .large_image(poster_url.to_string())
            .large_text(title.clone())
            .small_image(LARGE_IMAGE_KEY)
            .small_text("Streamee"),
        None => Assets::new()
            .large_image(LARGE_IMAGE_KEY)
            .large_text("Streamee"),
    };

    let mut activity = Activity::new()
        .activity_type(ActivityType::Watching)
        .status_display_type(StatusDisplayType::Details)
        .details(title)
        .state(truncate_activity_text(&state_text, 128))
        .assets(assets);

    if let Some(imdb_url) = payload
        .imdb_url
        .as_deref()
        .map(str::trim)
        .filter(|value| is_valid_imdb_title_url(value))
    {
        activity = activity.buttons(vec![Button::new("View on IMDb", imdb_url.to_string())]);
    }

    if !payload.paused {
        activity = activity.timestamps(build_timestamps(payload));
    }

    activity
}

fn build_timestamps(payload: &DiscordPresencePayload) -> Timestamps {
    let now_ms = current_time_millis();
    let playback_ms = payload
        .playback_time
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| (value * 1000.0) as i64)
        .unwrap_or(0);
    let mut timestamps = Timestamps::new().start(now_ms.saturating_sub(playback_ms));

    if let Some(duration) = payload
        .duration
        .filter(|value| value.is_finite() && *value > 0.0)
    {
        let remaining_ms =
            ((duration - payload.playback_time.unwrap_or(0.0)).max(0.0) * 1000.0) as i64;
        timestamps = timestamps.end(now_ms.saturating_add(remaining_ms));
    }

    timestamps
}

fn current_time_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn truncate_activity_text(value: &str, max_chars: usize) -> String {
    let mut output = value.chars().take(max_chars).collect::<String>();
    if output.len() < value.len() {
        output.push_str("...");
    }
    output
}

fn is_valid_imdb_title_url(value: &str) -> bool {
    value
        .strip_prefix("https://www.imdb.com/title/tt")
        .and_then(|rest| rest.strip_suffix('/'))
        .map(|id| id.chars().all(|ch| ch.is_ascii_digit()))
        .unwrap_or(false)
}

fn is_valid_external_image_url(value: &str) -> bool {
    if value.len() > 2048
        || !value.starts_with("https://")
        || value.chars().any(char::is_whitespace)
    {
        return false;
    }

    let authority = value["https://".len()..]
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();

    !authority.is_empty() && !authority.contains('@')
}

#[cfg(test)]
mod tests {
    use super::is_valid_external_image_url;

    #[test]
    fn accepts_public_https_image_urls() {
        assert!(is_valid_external_image_url(
            "https://image.tmdb.org/t/p/w500/example.jpg"
        ));
    }

    #[test]
    fn rejects_non_https_or_credentialed_image_urls() {
        assert!(!is_valid_external_image_url(
            "http://image.tmdb.org/t/p/w500/example.jpg"
        ));
        assert!(!is_valid_external_image_url(
            "https://user:password@example.com/poster.jpg"
        ));
    }
}
