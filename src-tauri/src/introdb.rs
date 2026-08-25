use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::{info, warn};

const INTRODB_SEGMENTS_URL: &str = "https://api.introdb.app/segments";
const THEINTRODB_MEDIA_URL: &str = "https://api.theintrodb.org/v3/media";
const POSITIVE_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const EMPTY_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const PROVIDER_RETRY_DELAYS_MS: [u64; 2] = [350, 1_000];

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IntroDbSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub start_sec: f64,
    pub end_sec: f64,
    pub confidence: Option<f64>,
    pub submission_count: Option<u32>,
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IntroDbSegments {
    pub imdb_id: Option<String>,
    pub tmdb_id: u64,
    pub season: u32,
    pub episode: u32,
    pub intro: Option<IntroDbSegment>,
    pub recap: Option<IntroDbSegment>,
    pub outro: Option<IntroDbSegment>,
}

impl IntroDbSegments {
    fn has_any_segment(&self) -> bool {
        self.intro.is_some() || self.recap.is_some() || self.outro.is_some()
    }
}

#[derive(Clone, Debug, Deserialize)]
struct IntroDbApiSegment {
    start_ms: u64,
    end_ms: u64,
    start_sec: f64,
    end_sec: f64,
    confidence: f64,
    submission_count: u32,
}

#[derive(Clone, Debug, Deserialize)]
struct IntroDbApiResponse {
    imdb_id: String,
    season: u32,
    episode: u32,
    intro: Option<IntroDbApiSegment>,
    recap: Option<IntroDbApiSegment>,
    outro: Option<IntroDbApiSegment>,
}

#[derive(Clone, Debug, Deserialize)]
struct TheIntroDbApiSegment {
    start_ms: u64,
    end_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
struct TheIntroDbApiResponse {
    tmdb_id: Option<u64>,
    season: Option<u32>,
    episode: Option<u32>,
    #[serde(default)]
    intro: Vec<TheIntroDbApiSegment>,
    #[serde(default)]
    recap: Vec<TheIntroDbApiSegment>,
    #[serde(default)]
    credits: Vec<TheIntroDbApiSegment>,
}

#[derive(Clone)]
struct CachedSegments {
    stored_at: Instant,
    value: Option<IntroDbSegments>,
}

static SEGMENT_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .user_agent("Streamee/EpisodeSegments")
        .build()
        .expect("episode segment HTTP client should build")
});

static SEGMENT_CACHE: Lazy<Mutex<HashMap<String, CachedSegments>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn is_valid_imdb_id(value: &str) -> bool {
    let digits = value.strip_prefix("tt").unwrap_or_default();
    matches!(digits.len(), 7 | 8) && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn segment_is_valid(segment: &IntroDbSegment) -> bool {
    segment.start_sec.is_finite()
        && segment.end_sec.is_finite()
        && segment.start_sec >= 0.0
        && segment.end_sec > segment.start_sec
        && segment.end_ms > segment.start_ms
        && segment
            .confidence
            .is_none_or(|value| value.is_finite() && (0.0..=1.0).contains(&value))
}

fn provider_status_is_retryable(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

async fn send_provider_request(
    provider: &str,
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let total_attempts = PROVIDER_RETRY_DELAYS_MS.len() + 1;

    for attempt in 0..total_attempts {
        let request = request
            .try_clone()
            .ok_or_else(|| format!("{provider} request could not be retried"))?;

        match request.send().await {
            Ok(response)
                if provider_status_is_retryable(response.status())
                    && attempt < PROVIDER_RETRY_DELAYS_MS.len() =>
            {
                let delay_ms = PROVIDER_RETRY_DELAYS_MS[attempt];
                warn!(
                    "{provider} returned HTTP {}; retrying attempt {}/{} in {}ms",
                    response.status(),
                    attempt + 2,
                    total_attempts,
                    delay_ms
                );
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            Ok(response) => return Ok(response),
            Err(error)
                if (error.is_timeout() || error.is_connect())
                    && attempt < PROVIDER_RETRY_DELAYS_MS.len() =>
            {
                let delay_ms = PROVIDER_RETRY_DELAYS_MS[attempt];
                warn!(
                    "{provider} request failed: {error}; retrying attempt {}/{} in {}ms",
                    attempt + 2,
                    total_attempts,
                    delay_ms
                );
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            Err(error) => {
                return Err(format!(
                    "{provider} request failed after {}/{} attempts: {error}",
                    attempt + 1,
                    total_attempts
                ));
            }
        }
    }

    unreachable!("provider retry loop always returns on its final attempt")
}

fn resolve_segment(
    primary: Option<IntroDbSegment>,
    fallback: Option<IntroDbSegment>,
) -> Option<IntroDbSegment> {
    let primary = primary.filter(segment_is_valid);
    let fallback = fallback.filter(segment_is_valid);

    match (primary, fallback) {
        (Some(primary), _) => Some(primary),
        (None, Some(fallback)) => Some(fallback),
        (None, None) => None,
    }
}

fn filter_remote_segment_for_playback(
    segment_type: &str,
    segment: Option<IntroDbSegment>,
    duration_seconds: f64,
) -> Option<IntroDbSegment> {
    let mut segment = segment?;
    if segment.end_sec > duration_seconds {
        info!(
            "[Segment Detection][Remote] Segment end normalized to playback duration: type={}, source={}, provider_end={:.3}, video_duration={:.3}",
            segment_type, segment.source, segment.end_sec, duration_seconds
        );
        segment.end_sec = duration_seconds;
        segment.end_ms = (duration_seconds * 1_000.0).round() as u64;
    }
    let segment_duration = segment.end_sec - segment.start_sec;
    let placement_is_valid = match segment_type {
        "intro" => {
            segment_duration >= 5.0
                && segment_duration <= 4.0 * 60.0
                && segment.start_sec <= (duration_seconds * 0.5).min(30.0 * 60.0)
        }
        "recap" => {
            segment_duration >= 5.0
                && segment_duration <= 8.0 * 60.0
                && segment.start_sec <= (duration_seconds * 0.4).min(20.0 * 60.0)
        }
        "outro" => {
            segment_duration >= 4.0
                && segment_duration <= 15.0 * 60.0
                && segment.start_sec >= duration_seconds * 0.55
        }
        _ => false,
    };
    let timing_is_valid = segment.end_sec <= duration_seconds + 2.0;
    if placement_is_valid && timing_is_valid {
        return Some(segment);
    }

    warn!(
        "[Segment Detection][Remote] Segment rejected by playback validation: type={}, source={}, start={:.3}, end={:.3}, segment_duration={:.3}, video_duration={:.3}",
        segment_type,
        segment.source,
        segment.start_sec,
        segment.end_sec,
        segment_duration,
        duration_seconds
    );
    None
}

fn cache_key(
    imdb_id: Option<&str>,
    tmdb_id: u64,
    season: u32,
    episode: u32,
    duration_ms: u64,
) -> String {
    format!(
        "{}:{tmdb_id}:{season}:{episode}:{duration_ms}",
        imdb_id.unwrap_or_default()
    )
}

fn get_cached(key: &str) -> Option<Option<IntroDbSegments>> {
    let mut cache = SEGMENT_CACHE.lock();
    let entry = cache.get(key)?;
    let ttl = if entry.value.is_some() {
        POSITIVE_CACHE_TTL
    } else {
        EMPTY_CACHE_TTL
    };

    if entry.stored_at.elapsed() < ttl {
        return Some(entry.value.clone());
    }

    cache.remove(key);
    None
}

fn store_cached(key: String, value: Option<IntroDbSegments>) {
    SEGMENT_CACHE.lock().insert(
        key,
        CachedSegments {
            stored_at: Instant::now(),
            value,
        },
    );
}

fn from_introdb_segment(segment: IntroDbApiSegment) -> IntroDbSegment {
    IntroDbSegment {
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        start_sec: segment.start_sec,
        end_sec: segment.end_sec,
        confidence: Some(segment.confidence),
        submission_count: Some(segment.submission_count),
        source: "introdb".to_string(),
    }
}

fn from_theintrodb_segment(
    segment: TheIntroDbApiSegment,
    duration_ms: u64,
) -> Option<IntroDbSegment> {
    let end_ms = segment
        .end_ms
        .or((duration_ms > 0).then_some(duration_ms))?;
    let converted = IntroDbSegment {
        start_ms: segment.start_ms,
        end_ms,
        start_sec: segment.start_ms as f64 / 1_000.0,
        end_sec: end_ms as f64 / 1_000.0,
        confidence: None,
        submission_count: None,
        source: "theintrodb".to_string(),
    };
    segment_is_valid(&converted).then_some(converted)
}

async fn fetch_introdb(
    imdb_id: Option<&str>,
    season: u32,
    episode: u32,
) -> Result<Option<IntroDbApiResponse>, String> {
    let Some(imdb_id) = imdb_id else {
        return Ok(None);
    };

    let response = send_provider_request(
        "IntroDB",
        SEGMENT_CLIENT.get(INTRODB_SEGMENTS_URL).query(&[
            ("imdb_id", imdb_id.to_string()),
            ("season", season.to_string()),
            ("episode", episode.to_string()),
        ]),
    )
    .await?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("IntroDB returned HTTP {}", response.status()));
    }

    let response = response
        .json::<IntroDbApiResponse>()
        .await
        .map_err(|error| format!("Invalid IntroDB response: {error}"))?;
    if response.imdb_id != imdb_id || response.season != season || response.episode != episode {
        return Err("IntroDB returned a different episode identity".to_string());
    }
    Ok(Some(response))
}

async fn fetch_theintrodb(
    tmdb_id: u64,
    season: u32,
    episode: u32,
    duration_ms: u64,
) -> Result<Option<TheIntroDbApiResponse>, String> {
    let mut query = vec![
        ("tmdb_id", tmdb_id.to_string()),
        ("season", season.to_string()),
        ("episode", episode.to_string()),
    ];
    if duration_ms > 0 {
        query.push(("duration_ms", duration_ms.to_string()));
    }

    let response = send_provider_request(
        "TheIntroDB",
        SEGMENT_CLIENT.get(THEINTRODB_MEDIA_URL).query(&query),
    )
    .await?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("TheIntroDB returned HTTP {}", response.status()));
    }

    let response = response
        .json::<TheIntroDbApiResponse>()
        .await
        .map_err(|error| format!("Invalid TheIntroDB response: {error}"))?;
    if response.tmdb_id != Some(tmdb_id)
        || response.season != Some(season)
        || response.episode != Some(episode)
    {
        return Err("TheIntroDB returned a different episode identity".to_string());
    }
    Ok(Some(response))
}

#[tauri::command]
pub async fn fetch_introdb_segments(
    imdb_id: Option<String>,
    tmdb_id: u64,
    season: u32,
    episode: u32,
    duration_seconds: f64,
) -> Result<Option<IntroDbSegments>, String> {
    let imdb_id = imdb_id
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    if imdb_id
        .as_deref()
        .is_some_and(|value| !is_valid_imdb_id(value))
        || tmdb_id == 0
        || season == 0
        || episode == 0
        || !duration_seconds.is_finite()
        || duration_seconds <= 0.0
    {
        return Err("Invalid episode segment identity".to_string());
    }

    let duration_ms = (duration_seconds * 1_000.0).round() as u64;
    let key = cache_key(imdb_id.as_deref(), tmdb_id, season, episode, duration_ms);
    info!(
        "[Segment Detection][Remote] Lookup started: tmdb_id={}, season={}, episode={}, duration_ms={}",
        tmdb_id, season, episode, duration_ms
    );
    if let Some(cached) = get_cached(&key) {
        info!(
            "[Segment Detection][Remote] Cache hit: intro={}, recap={}, outro={}",
            cached.as_ref().is_some_and(|value| value.intro.is_some()),
            cached.as_ref().is_some_and(|value| value.recap.is_some()),
            cached.as_ref().is_some_and(|value| value.outro.is_some())
        );
        return Ok(cached);
    }

    let (theintrodb_result, introdb_result) = tokio::join!(
        fetch_theintrodb(tmdb_id, season, episode, duration_ms),
        fetch_introdb(imdb_id.as_deref(), season, episode),
    );

    if let Err(error) = &theintrodb_result {
        warn!("{error}");
    }
    if let Err(error) = &introdb_result {
        warn!("{error}");
    }
    if let (Err(theintrodb_error), Err(introdb_error)) = (&theintrodb_result, &introdb_result) {
        return Err(format!(
            "Episode segment providers unavailable: {}; {}",
            theintrodb_error, introdb_error
        ));
    }

    let all_providers_succeeded = theintrodb_result.is_ok() && introdb_result.is_ok();
    let theintrodb = theintrodb_result.ok().flatten();
    let introdb = introdb_result.ok().flatten();
    let primary_intro = theintrodb
        .as_ref()
        .and_then(|value| value.intro.first().cloned())
        .and_then(|value| from_theintrodb_segment(value, duration_ms));
    let primary_recap = theintrodb
        .as_ref()
        .and_then(|value| value.recap.first().cloned())
        .and_then(|value| from_theintrodb_segment(value, duration_ms));
    let primary_outro = theintrodb
        .as_ref()
        .and_then(|value| value.credits.first().cloned())
        .and_then(|value| from_theintrodb_segment(value, duration_ms));
    let fallback_intro = introdb
        .as_ref()
        .and_then(|value| value.intro.clone())
        .map(from_introdb_segment);
    let fallback_recap = introdb
        .as_ref()
        .and_then(|value| value.recap.clone())
        .map(from_introdb_segment);
    let fallback_outro = introdb
        .as_ref()
        .and_then(|value| value.outro.clone())
        .map(from_introdb_segment);

    let segments = IntroDbSegments {
        imdb_id,
        tmdb_id,
        season,
        episode,
        intro: filter_remote_segment_for_playback(
            "intro",
            resolve_segment(primary_intro, fallback_intro),
            duration_seconds,
        ),
        recap: filter_remote_segment_for_playback(
            "recap",
            resolve_segment(primary_recap, fallback_recap),
            duration_seconds,
        ),
        outro: filter_remote_segment_for_playback(
            "outro",
            resolve_segment(primary_outro, fallback_outro),
            duration_seconds,
        ),
    };
    let segments = segments.has_any_segment().then_some(segments);
    info!(
        "[Segment Detection][Remote] Lookup complete: intro={}, recap={}, outro={}",
        segments
            .as_ref()
            .and_then(|value| value.intro.as_ref())
            .map(|segment| segment.source.as_str())
            .unwrap_or("none"),
        segments
            .as_ref()
            .and_then(|value| value.recap.as_ref())
            .map(|segment| segment.source.as_str())
            .unwrap_or("none"),
        segments
            .as_ref()
            .and_then(|value| value.outro.as_ref())
            .map(|segment| segment.source.as_str())
            .unwrap_or("none")
    );
    if segments.is_some() || all_providers_succeeded {
        store_cached(key, segments.clone());
    } else {
        warn!("Remote segment result was empty after a provider failure; skipping empty cache");
    }
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(source: &str, start_sec: f64, end_sec: f64) -> IntroDbSegment {
        IntroDbSegment {
            start_ms: (start_sec * 1_000.0) as u64,
            end_ms: (end_sec * 1_000.0) as u64,
            start_sec,
            end_sec,
            confidence: (source == "introdb").then_some(0.95),
            submission_count: (source == "introdb").then_some(3),
            source: source.to_string(),
        }
    }

    #[test]
    fn retries_only_transient_provider_statuses() {
        assert!(provider_status_is_retryable(
            reqwest::StatusCode::REQUEST_TIMEOUT
        ));
        assert!(provider_status_is_retryable(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(provider_status_is_retryable(
            reqwest::StatusCode::BAD_GATEWAY
        ));
        assert!(!provider_status_is_retryable(
            reqwest::StatusCode::NOT_FOUND
        ));
        assert!(!provider_status_is_retryable(
            reqwest::StatusCode::BAD_REQUEST
        ));
    }

    #[test]
    fn validates_imdb_series_ids() {
        assert!(is_valid_imdb_id("tt0944947"));
        assert!(is_valid_imdb_id("tt12345678"));
        assert!(!is_valid_imdb_id("0944947"));
        assert!(!is_valid_imdb_id("tt123"));
        assert!(!is_valid_imdb_id("tt123456x"));
    }

    #[test]
    fn chooses_primary_when_both_providers_exist() {
        let resolved = resolve_segment(
            Some(segment("theintrodb", 61.0, 118.0)),
            Some(segment("introdb", 63.0, 120.0)),
        )
        .expect("agreeing providers should resolve");
        assert_eq!(resolved.source, "theintrodb");
        assert_eq!(resolved.start_sec, 61.0);
    }

    #[test]
    fn keeps_primary_when_providers_disagree() {
        let resolved = resolve_segment(
            Some(segment("theintrodb", 61.0, 118.0)),
            Some(segment("introdb", 90.0, 150.0)),
        )
        .expect("primary provider should remain authoritative");
        assert_eq!(resolved.source, "theintrodb");
        assert_eq!(resolved.start_sec, 61.0);
    }

    #[test]
    fn accepts_low_confidence_introdb_fallback() {
        let mut fallback = segment("introdb", 90.0, 150.0);
        fallback.confidence = Some(0.1);
        fallback.submission_count = Some(0);
        let resolved = resolve_segment(None, Some(fallback))
            .expect("structurally valid IntroDB fallback should be accepted");
        assert_eq!(resolved.source, "introdb");
    }

    #[test]
    fn accepts_single_submission_introdb_segments() {
        let mut fallback = segment("introdb", 90.0, 150.0);
        fallback.confidence = Some(1.0);
        fallback.submission_count = Some(1);
        let resolved = resolve_segment(None, Some(fallback))
            .expect("one high-confidence IntroDB submission should be eligible");
        assert_eq!(resolved.source, "introdb");
        assert_eq!(resolved.submission_count, Some(1));
    }

    #[test]
    fn parses_theintrodb_credits_with_open_ended_duration() {
        let response = serde_json::from_str::<TheIntroDbApiResponse>(
            r#"{"tmdb_id":1399,"season":1,"episode":1,"intro":[{"start_ms":437018,"end_ms":536972}],"credits":[{"start_ms":3632730,"end_ms":null}]}"#,
        )
        .expect("TheIntroDB fixture should parse");
        let credits = from_theintrodb_segment(response.credits[0].clone(), 3_720_000)
            .expect("duration should close an open-ended credits segment");
        assert_eq!(credits.start_ms, 3_632_730);
        assert_eq!(credits.end_ms, 3_720_000);
    }

    #[test]
    fn accepts_four_second_remote_outros() {
        let accepted = filter_remote_segment_for_playback(
            "outro",
            Some(segment("theintrodb", 1_262.0, 1_266.766)),
            1_266.766,
        );
        assert!(accepted.is_some());

        let rejected = filter_remote_segment_for_playback(
            "outro",
            Some(segment("theintrodb", 1_263.0, 1_266.766)),
            1_266.766,
        );
        assert!(rejected.is_none());

        assert!(filter_remote_segment_for_playback(
            "outro",
            Some(segment("introdb", 1_262.0, 1_266.766)),
            1_266.766,
        )
        .is_some());
    }

    #[test]
    fn normalizes_remote_outro_end_to_playback_duration() {
        let accepted = filter_remote_segment_for_playback(
            "outro",
            Some(segment("introdb", 2_852.0, 3_150.0)),
            3_076.160,
        )
        .expect("remote outro should be normalized to the active release");
        assert_eq!(accepted.start_sec, 2_852.0);
        assert_eq!(accepted.end_sec, 3_076.160);
        assert_eq!(accepted.end_ms, 3_076_160);
    }
}
