import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// Using external player - downloads to local file and opens with system default

interface TorrentStats {
  status: string;
  downloaded: number;
  total: number;
  downloadSpeed: number;
  uploadSpeed: number;
  uploaded: number;
  progress: number;
  pieces: { ready: number; total: number };
  peers: { total: number; seeders: number; leechers: number };
  peerList: Array<{
    ip: string;
    protocol: string;
    downloadSpeed: number;
    uploadSpeed: number;
  }>;
  trackers: Array<{
    url: string;
    status: string;
    peers: number;
  }>;
}

// Audio Normalizer types
export interface AudioNormalizerConfig {
  enabled: boolean;
  slow_enabled: boolean;
  fast_enabled: boolean;
  transient_enabled: boolean;
  peak_ceiling_enabled: boolean;
  limiter_enabled: boolean;
  target_lufs: number;
  max_gain_db: number;
  max_cut_db: number;
  attack_ms: number;
  release_ms: number;
  slow_control_mode: 'momentary' | 'short_term' | 'blended';
  response_mode: 'time_based' | 'db_per_sec';
  attack_db_per_sec: number;
  release_db_per_sec: number;
  transient_threshold_lu: number;
  max_transient_cut_db: number;
  fast_threshold_lu: number;
  fast_max_cut_db: number;
  fast_attack_ms: number;
  fast_release_ms: number;
  fast_detector_mode: 'momentary_delta' | 'true_peak';
  fast_true_peak_threshold_db: number;
  peak_ceiling_threshold_db: number;
  limiter_limit_db: number;
  limiter_attack_ms: number;
  limiter_release_ms: number;
  adaptive_gate_enabled: boolean;
  adaptive_gate_mode: 'direct' | 'stable';
  adaptive_max_gain_enabled: boolean;
  adaptive_max_gain_limit_db: number;
  subtitle_assist_enabled: boolean;
  gate_detector_mode: 'momentary' | 'short_term';
  gate_observation_window_secs: number;
  gate_threshold_lufs: number;
  hold_ms: number;
  refresh_interval_ms: number;
}

export type PeakTelemetrySource = 'true_peak' | 'sample_peak' | 'unknown';
export type GatePhase = 'learning' | 'open' | 'closing_hold' | 'gated' | 'reopening' | 'subtitle' | 'disconnected';
export type GateModelState = 'fixed' | 'direct' | 'learning' | 'stable' | 'held' | 'adapting' | 'degraded' | 'disconnected';

export interface AudioNormalizerState {
  current_gain_db: number;
  momentary_lufs: number;
  short_term_lufs: number;
  integrated_lufs: number;
  true_peak_db: number;
  true_peak_source: PeakTelemetrySource;
  limiter_input_peak_db: number;
  limiter_input_peak_source: PeakTelemetrySource;
  output_peak_db: number;
  output_peak_source: PeakTelemetrySource;
  limiter_reduction_db: number;
  smoothed_lufs: number;
  desired_gain_db: number;
  slow_gain_db: number;
  fast_gain_db: number;
  transient_cut_db: number;
  effective_max_gain_db: number;
  adaptive_gain_extra_db: number;
  adaptive_gain_state: string;
  gate_signal_lufs: number;
  gate_threshold_lufs: number;
  gate_normalization_offset_db: number;
  gate_ambient_floor_lufs: number;
  gate_foreground_lufs: number;
  gate_open_threshold_lufs: number;
  gate_close_threshold_lufs: number;
  gate_observed_range_lu: number;
  gate_observed_secs: number;
  gate_observation_window_secs: number;
  gate_confidence: number;
  gate_detector_ready: boolean;
  gate_model_state: GateModelState;
  gate_model_age_secs: number;
  gate_phase: GatePhase;
  adaptive_gate_enabled: boolean;
  adaptive_gate_mode: AudioNormalizerConfig['adaptive_gate_mode'];
  subtitle_assist_enabled: boolean;
  subtitle_assist_active: boolean;
  gate_detector_mode: AudioNormalizerConfig['gate_detector_mode'];
  gate_acquiring: boolean;
  is_gated: boolean;
  connected: boolean;
  paused: boolean;
  manual_mode: boolean;
}

export interface NormalizerTelemetry extends AudioNormalizerState {
  timestamp_ms: number;
  reason: string;
}

export interface NormalizerEventLog {
  timestamp_ms: number;
  event_type: string;
  message: string;
}

export interface AudioNormalizerDebugInfo {
  connected: boolean;
  manual_mode: boolean;
  filters: unknown;
  filename: string | null;
  probes: Array<{
    property: string;
    value: string | null;
  }>;
  metadata_roots: Array<{
    property: string;
    value: string | null;
  }>;
}

interface Track {
  id: number;
  type: 'audio' | 'sub';
  title: string;
  lang: string;
  codec?: string;
  selected: boolean;
  hearing_impaired?: boolean;
}

export interface SubtitleProgressEvent {
  session_id: number;
  phase: 'starting' | 'connecting' | 'transcribing' | 'complete' | 'waiting_for_media' | 'error';
  progress: number;
  message: string;
  reason?: string;
  downloaded?: number;
  total?: number;
  title?: string;
}

export interface SubtitleSegment {
  session_id: number;
  start: number;
  end: number;
  text: string;
  completed: boolean;
}

export interface WhisperRuntimeInfo {
  python_available: boolean;
  python_version?: string | null;
  whisper_live_installed: boolean;
  websocket_client_installed: boolean;
  cuda_available: boolean;
  ffmpeg_available: boolean;
  deep_tested: boolean;
  model_load_ok: boolean;
  requested_mode: string;
  resolved_mode: string;
  message: string;
}

interface DownloadFile {
  name: string;
  size: number;
  path: string;
  index?: number;
  downloaded?: number;
  progress?: number;
}

interface LocalVideoFile {
  name: string;
  path: string;
  size: number;
}

interface FileProgress {
  file_index: number;
  downloaded: number;
  total: number;
  progress: number;
  ready: boolean;
}

interface PieceInfo {
  total_pieces: number;
  downloaded_pieces: number;
  piece_size: number;
  bitfield: number[];
}

interface TorrentReadyEvent {
  session_id: number;
  files: DownloadFile[];
}

interface TorrentProgressEvent {
  session_id: number;
  status: string;
  downloaded: number;
  received_delta: number;
  total: number;
  download_speed: number;
  progress: number;
  files: DownloadFile[];
  pieces: number;
  downloaded_pieces: number;
  peers: number;
  connected_peers?: number;
  tracker_peers?: number;
  seeders: number;
  leechers: number;
  bitfield: number[];
  metadata_ready: boolean;
  file_count: number;
}

export interface TorrentStartupState {
  session_id: number;
  attempt: number;
  phase: string;
  message: string;
  retry_in_ms?: number | null;
  error_code?: string | null;
}

interface TorrentHealth {
  session_id: number;
  attempt: number;
  phase: string;
  sidecar_running: boolean;
  has_torrent: boolean;
  metadata_ready: boolean;
  port?: number | null;
  file_count: number;
  last_error?: string | null;
}

interface TorrentPortTestResult {
  port: number;
  dht_enabled: boolean;
  tcp_bind_ok: boolean;
  udp_bind_ok: boolean;
  tcp_error?: string | null;
  udp_error?: string | null;
}

export interface StreamLaunchResult {
  session_id: number;
  pid: number;
  file_url: string;
  ready_bytes: number;
  total_bytes: number;
  playlist_file_urls: string[];
  playlist_files: StreamPlaylistItem[];
}

export interface StreamPlaylistItem {
  url: string;
  name: string;
  size: number;
  season?: number | null;
  episode?: number | null;
}

interface MpvPrelaunchResult {
  pid: number;
}

interface PreparedStreamResult {
  session_id: number;
  file_url: string;
  ready_bytes: number;
  total_bytes: number;
}

export interface PreparedQbittorrentStreamResult {
  file_url: string;
  file_name: string;
  ready_bytes: number;
  total_bytes: number;
  playlist_file_urls: string[];
  playlist_files: StreamPlaylistItem[];
  torrent_hash: string;
  downloaded_bytes: number;
}

export interface PlayerPlaylistChangedPayload {
  playlist_pos: number;
  filename: string;
  path: string;
  media_title: string;
}

export interface PlayerSmartNextRequestedPayload {
  request_id: number;
  mpv_pid: number;
  direction: 'next' | 'previous';
  filename: string;
  playlist_pos: number;
}

export interface PlayerDetectedSegment {
  kind: 'intro' | 'recap' | 'outro';
  start_sec: number;
  end_sec: number;
  source?: string;
}

export interface IntroDbSegment {
  start_ms: number;
  end_ms: number;
  start_sec: number;
  end_sec: number;
  confidence: number | null;
  submission_count: number | null;
  source: 'theintrodb' | 'introdb' | 'intro-skipper' | 'intro-skipper-outro' | 'chapter';
}

export interface IntroDbSegments {
  imdb_id: string | null;
  tmdb_id: number;
  season: number;
  episode: number;
  intro: IntroDbSegment | null;
  recap: IntroDbSegment | null;
  outro: IntroDbSegment | null;
}

export interface SegmentFeedbackCandidate {
  kind: 'intro' | 'outro';
  start_sec: number;
  end_sec: number;
  source: 'intro-skipper' | 'intro-skipper-outro' | 'chapter';
  reason: string;
  score: number | null;
}

export interface PlayerSegmentFeedbackPayload {
  request_id: number;
  response: 'yes' | 'no' | 'not-sure' | 'dismissed' | 'automatic';
  filename: string;
  playlist_pos?: number;
}

export interface PlayerChapterSegments {
  intro: IntroDbSegment | null;
  recap: IntroDbSegment | null;
  outro: IntroDbSegment | null;
  candidate: SegmentFeedbackCandidate | null;
  chapter_count: number;
}

export interface IntroSkipperDetectionResult {
  segment: IntroDbSegment | null;
  candidate: SegmentFeedbackCandidate | null;
  status:
    | 'waiting-for-buffer'
    | 'waiting-for-local-cache'
    | 'waiting-for-tail-cache'
    | 'learned'
    | 'no-match'
    | 'detected';
  reference_episode: number | null;
  reference_end_sec: number | null;
  cached_episode_count: number;
  buffered_seconds: number;
  required_buffer_seconds: number;
}

interface StatisticsTransferEvent {
  source_type: 'webtorrent' | 'qbittorrent' | 'addon' | 'local';
  source_id?: string | null;
  source_name?: string | null;
  bytes: number;
}

export interface AddonTransferProgressEvent {
  session_id: string;
  sequence: number;
  downloaded_bytes: number;
  covered_bytes: number;
  total_bytes: number | null;
  bytes_per_second: number;
  complete: boolean;
}

interface AddonStreamErrorEvent {
  session_id: string;
  message: string;
}

export interface RifeRuntimeInfo {
  installed: boolean;
  ready: boolean;
  version: string;
  path: string;
  selectedModel: string;
  selectedModelInstalled: boolean;
  installedModels: string[];
  missingFiles: string[];
  downloadBytes: number;
  requiredFreeBytes: number;
  message: string;
}

export interface RifeInstallProgress {
  phase: 'downloading' | 'extracting' | 'complete';
  message: string;
  downloadedBytes: number;
  totalBytes: number;
}

export interface RifeEnginePreparationRequest {
  model: string;
  multiplier: number;
  gpuStreams: number;
  processingMode: string;
  scale: string;
  sourceResolution: '2160' | '1080' | '720';
}

export interface RifeEnginePreparationResult {
  model: string;
  scale: string;
  sourceResolution: string;
  message: string;
}

export interface RifeEnginePreparationProgress {
  phase: 'preparing' | 'compiling' | 'complete' | 'cancelled' | 'error';
  message: string;
}

export interface RifeCacheInfo {
  path: string;
  bytes: number;
  fileCount: number;
  engineCount: number;
}

export interface RifePlaybackStatus {
  status: 'pending' | 'active' | 'failed';
  pid: number;
  multiplier: number;
  filename?: string;
  containerFps?: number | null;
  outputFps?: number | null;
  sustaining?: boolean | null;
  inputVideo?: Record<string, unknown> | null;
  outputVideo?: Record<string, unknown> | null;
  message: string;
}

interface PreparedAddonStreamUrl {
  url: string;
  session_id: string;
}

export interface SmartNextWarmupResult {
  provider: 'addon' | 'qbittorrent';
  requested_bytes: number;
  cached_bytes: number;
  total_bytes: number;
}

let onReadyUnlisten: UnlistenFn | null = null;
let onProgressUnlisten: UnlistenFn | null = null;
let onErrorUnlisten: UnlistenFn | null = null;
const torrentProgressListeners = new Set<(progress: TorrentProgressEvent) => void>();

const ensureTorrentProgressListener = async () => {
  if (onProgressUnlisten) {
    return;
  }

  onProgressUnlisten = await listen<TorrentProgressEvent>('torrent://progress', (event) => {
    const payload = event.payload;
    for (const listener of Array.from(torrentProgressListeners)) {
      try {
        void Promise.resolve(listener(payload)).catch((error) => {
          console.error('%c[Torrent]%c Progress listener failed:', 'color: #60a5fa; font-weight: bold', 'color: inherit', error);
        });
      } catch (error) {
        console.error('%c[Torrent]%c Progress listener threw:', 'color: #60a5fa; font-weight: bold', 'color: inherit', error);
      }
    }
  });
};
let onStartupStateUnlisten: UnlistenFn | null = null;

let onSubtitleProgressUnlisten: UnlistenFn | null = null;
let onSubtitleSegmentUnlisten: UnlistenFn | null = null;

const tauriAPI = {
  torrent: {
    add: async (magnetUri: string, expectedSize?: number) => {
      try {
        const result = await invoke<string>('start_torrent', {
          magnetUri,
          files: [],
          expectedSize: expectedSize ?? null,
        });
        return result;
      } catch (e) {
        console.error('%c[Torrent]%c Failed to start:', 'color: #60a5fa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
    remove: async () => {
      await invoke('stop_torrent');
    },
    getStats: async () => {
      try {
        const stats = await invoke<TorrentStats | null>('get_torrent_stats');
        return stats;
      } catch (e) {
        console.error('%c[Torrent]%c Failed to get stats:', 'color: #60a5fa; font-weight: bold', 'color: inherit', e);
        return null;
      }
    },
    getFiles: async () => {
      try {
        const files = await invoke<DownloadFile[]>('get_torrent_files');
        return files.map((f, idx) => ({ ...f, index: idx }));
      } catch (e) {
        console.error('%c[Torrent]%c Failed to get files:', 'color: #60a5fa; font-weight: bold', 'color: inherit', e);
        return [];
      }
    },
    getFileProgress: async (fileIndex: number) => {
      try {
        const progress = await invoke<FileProgress>('get_file_progress', { fileIndex });
        return progress;
      } catch (e) {
        console.error('%c[Torrent]%c Failed to get file progress:', 'color: #60a5fa; font-weight: bold', 'color: inherit', e);
        return null;
      }
    },
    getStreamUrl: async (fileIndex: number) => {
      try {
        const url = await invoke<string>('get_stream_url', { fileIndex });
        return url;
      } catch (e) {
        console.error('%c[Torrent]%c Failed to get stream URL:', 'color: #60a5fa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
    getWhisperStreamUrl: async (fileIndex: number) => {
      try {
        const url = await invoke<string>('get_whisper_stream_url', { fileIndex });
        return url;
      } catch (e) {
        console.error('%c[Torrent]%c Failed to get whisper stream URL:', 'color: #60a5fa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
    getHealth: async () => {
      try {
        return await invoke<TorrentHealth>('get_torrent_health');
      } catch (e) {
        console.error('%c[Torrent]%c Failed to get health:', 'color: #60a5fa; font-weight: bold', 'color: inherit', e);
        return null;
      }
    },
    testPort: async (port: number) => {
      try {
        return await invoke<TorrentPortTestResult>('test_torrent_port', { port });
      } catch (e) {
        console.error('%c[Torrent]%c Failed to test torrent port:', 'color: #60a5fa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
    getPieces: async () => {
      try {
        const pieces = await invoke<PieceInfo>('get_pieces');
        return pieces;
      } catch (e) {
        console.error('%c[Torrent]%c Failed to get pieces:', 'color: #60a5fa; font-weight: bold', 'color: inherit', e);
        return null;
      }
    },
    getFilePath: async (filename: string) => {
      try {
        const path = await invoke<string>('get_file_path', { filename });
        return path;
      } catch (e) {
        console.error('%c[Torrent]%c Failed to get file path:', 'color: #60a5fa; font-weight: bold', 'color: inherit', e);
        return null;
      }
    },
    pause: async () => {
      await invoke('pause_torrent');
    },
    resume: async () => {
      await invoke('resume_torrent');
    },
    onReady: async (callback: (event: TorrentReadyEvent) => void) => {
      if (onReadyUnlisten) {
        onReadyUnlisten();
      }
      onReadyUnlisten = await listen<TorrentReadyEvent>('torrent://ready', (event) => {
        callback(event.payload);
      });
      return () => {
        if (onReadyUnlisten) {
          onReadyUnlisten();
          onReadyUnlisten = null;
        }
      };
    },
    onProgress: async (callback: (progress: TorrentProgressEvent) => void) => {
      torrentProgressListeners.add(callback);
      await ensureTorrentProgressListener();
      return () => {
        torrentProgressListeners.delete(callback);
        if (torrentProgressListeners.size === 0 && onProgressUnlisten) {
          onProgressUnlisten();
          onProgressUnlisten = null;
        }
      };
    },
    onError: async (callback: (error: string) => void) => {
      if (onErrorUnlisten) {
        onErrorUnlisten();
      }
      onErrorUnlisten = await listen<string>('torrent://error', (event) => {
        console.error('%c[Torrent]%c Error event received:', 'color: #60a5fa; font-weight: bold', 'color: inherit', event.payload);
        callback(event.payload);
      });
      return () => {
        if (onErrorUnlisten) {
          onErrorUnlisten();
          onErrorUnlisten = null;
        }
      };
    },
    onStartupState: async (callback: (state: TorrentStartupState) => void) => {
      if (onStartupStateUnlisten) {
        onStartupStateUnlisten();
      }
      onStartupStateUnlisten = await listen<TorrentStartupState>('torrent://startup-state', (event) => {
        callback(event.payload);
      });
      return () => {
        if (onStartupStateUnlisten) {
          onStartupStateUnlisten();
          onStartupStateUnlisten = null;
        }
      };
    },
  },
  player: {
    stop: async () => {
      try {
        await invoke('stop_player');
      } catch (e) {
        console.error('%c[Player]%c Failed to stop:', 'color: #a78bfa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
    seekTime: async (position: number, expectedFilename: string) => {
      await invoke('seek_player_time', { position, expectedFilename });
    },
    setDetectedSegments: async (
      segments: PlayerDetectedSegment[],
      expectedFilename: string,
    ) => {
      await invoke('set_player_detected_segments', { segments, expectedFilename });
    },
    getTracks: async () => {
      try {
        return await invoke<Track[]>('get_player_tracks');
      } catch (e) {
        console.error('%c[Player]%c Failed to get tracks:', 'color: #a78bfa; font-weight: bold', 'color: inherit', e);
        return [];
      }
    },
    setTrack: async (trackType: string, trackId: number) => {
      try {
        await invoke('set_player_track', { trackType, trackId });
      } catch (e) {
        console.error('%c[Player]%c Failed to set track:', 'color: #a78bfa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
    setMediaTitle: async (title: string) => {
      try {
        await invoke('set_player_media_title', { title });
      } catch (e) {
        console.error('%c[Player]%c Failed to set media title:', 'color: #a78bfa; font-weight: bold', 'color: inherit', e);
      }
    },
    playlistAdd: async (url: string, title?: string) => {
      try {
        await invoke('playlist_add', { url, title });
      } catch (e) {
        console.error('%c[Player]%c Failed to add to playlist:', 'color: #a78bfa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
    playlistNext: async () => {
      try {
        await invoke('playlist_next');
      } catch (e) {
        console.error('%c[Player]%c Failed to play next:', 'color: #a78bfa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
    playlistPrev: async () => {
      try {
        await invoke('playlist_prev');
      } catch (e) {
        console.error('%c[Player]%c Failed to play previous:', 'color: #a78bfa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
    setSmartNextAvailable: async (available: boolean) => {
      await invoke('set_smart_next_available', { available });
    },
    restoreSmartNextWindowState: async (
      pid: number,
      fullscreen: boolean | null,
    ) => {
      await invoke('restore_smart_next_window_state', { pid, fullscreen });
    },
    getPendingSmartNextRequest: async () => {
      return await invoke<Pick<PlayerSmartNextRequestedPayload, 'request_id' | 'mpv_pid' | 'direction'> | null>('get_pending_smart_next_request');
    },
    ackSmartNextRequest: async (requestId: number, mpvPid: number) => {
      return await invoke<boolean>('ack_smart_next_request', { requestId, mpvPid });
    },
    showMessage: async (message: string, durationMs = 2500) => {
      await invoke('show_player_message', { message, durationMs });
    },
    showSegmentFeedbackPrompt: async (
      requestId: number,
      kind: 'intro' | 'outro',
      source: string,
      automatic = false,
      countdownSeconds = 4,
    ) => {
      await invoke('show_segment_feedback_prompt', {
        requestId,
        kind,
        source,
        automatic,
        countdownSeconds,
      });
    },
    loadSubtitle: async (path: string) => {
      try {
        await invoke('load_subtitle', { path });
      } catch (e) {
        console.error('%c[Player]%c Failed to load subtitle:', 'color: #a78bfa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
    getPlaylistInfo: async () => {
      try {
        return await invoke<any[]>('get_playlist_info');
      } catch (e) {
        console.error('%c[Player]%c Failed to get playlist info:', 'color: #a78bfa; font-weight: bold', 'color: inherit', e);
        throw e;
      }
    },
  },
  settings: {
    setSetting: (key: string, value: string) => invoke<void>('set_setting', { key, value }),
    getSetting: (key: string) => invoke<string | null>('get_setting', { key }),
  },
  introDb: {
    getSegments: async (
      imdbId: string | null,
      tmdbId: number,
      season: number,
      episode: number,
      durationSeconds: number,
    ) => {
      return await invoke<IntroDbSegments | null>('fetch_introdb_segments', {
        imdbId,
        tmdbId,
        season,
        episode,
        durationSeconds,
      });
    },
    detectChapters: async (durationSeconds: number) => (
      invoke<PlayerChapterSegments>('detect_player_chapter_segments', { durationSeconds })
    ),
    detectLocalIntro: async (
      seriesKey: string,
      sourceIdentity: string,
      season: number,
      episode: number,
      currentUrl: string,
      durationSeconds: number,
      analysisPart: 1 | 2,
    ) => invoke<IntroSkipperDetectionResult>('detect_intro_skipper_segment', {
      seriesKey,
      sourceIdentity,
      season,
      episode,
      currentUrl,
      durationSeconds,
      analysisPart,
    }),
    detectLocalOutro: async (
      seriesKey: string,
      sourceIdentity: string,
      season: number,
      episode: number,
      currentUrl: string,
      durationSeconds: number,
    ) => invoke<IntroSkipperDetectionResult>('detect_intro_skipper_outro_segment', {
      seriesKey,
      sourceIdentity,
      season,
      episode,
      currentUrl,
      durationSeconds,
    }),
  },
  discordPresence: {
    setEnabled: (enabled: boolean) => invoke<void>('set_discord_presence_enabled', { enabled }),
    update: (payload: {
      enabled: boolean;
      title: string;
      subtitle?: string | null;
      paused: boolean;
      playback_time?: number | null;
      duration?: number | null;
      imdb_url?: string | null;
      poster_url?: string | null;
    }) => invoke<void>('update_discord_presence', { payload }),
    clear: () => invoke<void>('clear_discord_presence'),
  },
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  fetchKinoCheckTrailer: (mediaType: 'movie' | 'series', tmdbId: number) =>
    invoke<{
      id?: string;
      youtube_video_id?: string;
      title?: string;
      url?: string;
      language?: string;
      categories?: string[];
      published?: string;
    } | null>('fetch_kinocheck_trailer', { mediaType, tmdbId }),
  prelaunchMpv: (
    position?: { x: number; y: number; width?: number; height?: number },
    displayTitle?: string,
    upscalerMode?: string,
    seekPreviewEnabled?: boolean,
    forceStereoEnabled?: boolean,
    rtxHdrEnabled?: boolean,
    hdrContrastBoostEnabled?: boolean,
    cacheWholeFileEnabled?: boolean,
    preferredSubtitleLanguage?: string,
    preferredAudioLanguage?: string,
    preferSdhSubtitles?: boolean,
  ) =>
    invoke<MpvPrelaunchResult>('prelaunch_mpv', {
      displayTitle,
      positionX: position?.x,
      positionY: position?.y,
      width: position?.width,
      height: position?.height,
      upscaler: upscalerMode ?? null,
      seekPreviewEnabled: seekPreviewEnabled ?? null,
      forceStereoEnabled: forceStereoEnabled ?? null,
      rtxHdrEnabled: rtxHdrEnabled ?? null,
      hdrContrastBoostEnabled: hdrContrastBoostEnabled ?? null,
      cacheWholeFileEnabled: cacheWholeFileEnabled ?? null,
      preferredSubtitleLanguage: preferredSubtitleLanguage ?? null,
      preferredAudioLanguage: preferredAudioLanguage ?? null,
      preferSdhSubtitles: preferSdhSubtitles ?? null,
    }),
  prepareAndOpenStream: (
    fileIndex: number,
    position?: { x: number; y: number; width?: number; height?: number },
    startPosition?: number,
    displayTitle?: string,
    upscalerMode?: string,
    seekPreviewEnabled?: boolean,
    forceStereoEnabled?: boolean,
    rtxHdrEnabled?: boolean,
    hdrContrastBoostEnabled?: boolean,
    cacheWholeFileEnabled?: boolean,
    preferredSubtitleLanguage?: string,
    preferredAudioLanguage?: string,
    preferSdhSubtitles?: boolean,
  ) =>
    invoke<StreamLaunchResult>('prepare_and_open_stream', {
      fileIndex,
      displayTitle,
      positionX: position?.x,
      positionY: position?.y,
      width: position?.width,
      height: position?.height,
      startPosition,
      upscaler: upscalerMode ?? null,
      seekPreviewEnabled: seekPreviewEnabled ?? null,
      forceStereoEnabled: forceStereoEnabled ?? null,
      rtxHdrEnabled: rtxHdrEnabled ?? null,
      hdrContrastBoostEnabled: hdrContrastBoostEnabled ?? null,
      cacheWholeFileEnabled: cacheWholeFileEnabled ?? null,
      preferredSubtitleLanguage: preferredSubtitleLanguage ?? null,
      preferredAudioLanguage: preferredAudioLanguage ?? null,
      preferSdhSubtitles: preferSdhSubtitles ?? null,
    }),
  prepareAndLoadStream: (
    fileIndex: number,
    pid: number,
    startPosition?: number,
    displayTitle?: string,
    cacheWholeFileEnabled?: boolean,
  ) =>
    invoke<StreamLaunchResult>('prepare_and_load_stream', {
      fileIndex,
      pid,
      startPosition,
      displayTitle: displayTitle ?? null,
      cacheWholeFileEnabled: cacheWholeFileEnabled ?? null,
    }),
  prepareAndOpenQbittorrentStream: (
    magnetUri: string,
    infoHash?: string,
    position?: { x: number; y: number; width?: number; height?: number },
    startPosition?: number,
    displayTitle?: string,
    preferredSeason?: number,
    preferredEpisode?: number,
    preferredSourceFilename?: string,
    upscalerMode?: string,
    seekPreviewEnabled?: boolean,
    forceStereoEnabled?: boolean,
    rtxHdrEnabled?: boolean,
    hdrContrastBoostEnabled?: boolean,
    cacheWholeFileEnabled?: boolean,
    preferredSubtitleLanguage?: string,
    preferredAudioLanguage?: string,
    preferSdhSubtitles?: boolean,
  ) =>
    invoke<StreamLaunchResult>('prepare_and_open_qbittorrent_stream', {
      magnetUri,
      infoHash: infoHash ?? null,
      displayTitle,
      preferredSeason: preferredSeason ?? null,
      preferredEpisode: preferredEpisode ?? null,
      preferredSourceFilename: preferredSourceFilename ?? null,
      positionX: position?.x,
      positionY: position?.y,
      width: position?.width,
      height: position?.height,
      startPosition,
      upscaler: upscalerMode ?? null,
      seekPreviewEnabled: seekPreviewEnabled ?? null,
      forceStereoEnabled: forceStereoEnabled ?? null,
      rtxHdrEnabled: rtxHdrEnabled ?? null,
      hdrContrastBoostEnabled: hdrContrastBoostEnabled ?? null,
      cacheWholeFileEnabled: cacheWholeFileEnabled ?? null,
      preferredSubtitleLanguage: preferredSubtitleLanguage ?? null,
      preferredAudioLanguage: preferredAudioLanguage ?? null,
      preferSdhSubtitles: preferSdhSubtitles ?? null,
    }),
  prepareQbittorrentStream: (
    magnetUri: string,
    infoHash?: string,
    preferredSeason?: number,
    preferredEpisode?: number,
    preferredSourceFilename?: string,
  ) =>
    invoke<PreparedQbittorrentStreamResult>('prepare_qbittorrent_stream', {
      magnetUri,
      infoHash: infoHash ?? null,
      preferredSeason: preferredSeason ?? null,
      preferredEpisode: preferredEpisode ?? null,
      preferredSourceFilename: preferredSourceFilename ?? null,
    }),
  prepareAddonStreamUrl: (
    sourceUrl: string,
    totalSize: number,
    displayName?: string,
    addonInstallationId?: string,
    addonName?: string,
    cacheIdentity?: string,
    cacheWholeFileEnabled = false,
    whisperDeduplicationEnabled = false,
  ) =>
    invoke<PreparedAddonStreamUrl>('prepare_addon_stream_url', {
      sourceUrl,
      streamHandle: null,
      totalSize,
      displayName: displayName ?? null,
      addonInstallationId: addonInstallationId ?? null,
      addonName: addonName ?? null,
      cacheIdentity: cacheIdentity ?? null,
      cacheWholeFileEnabled,
      whisperDeduplicationEnabled,
    }),
  prepareDirectStreamHandle: (
    streamHandle: string,
    totalSize: number,
    displayName?: string,
    addonInstallationId?: string,
    addonName?: string,
    cacheIdentity?: string,
    cacheWholeFileEnabled = false,
    whisperDeduplicationEnabled = false,
  ) =>
    invoke<PreparedAddonStreamUrl>('prepare_addon_stream_url', {
      sourceUrl: null,
      streamHandle,
      totalSize,
      displayName: displayName ?? null,
      addonInstallationId: addonInstallationId ?? null,
      addonName: addonName ?? null,
      cacheIdentity: cacheIdentity ?? null,
      cacheWholeFileEnabled,
      whisperDeduplicationEnabled,
    }),
  releaseAddonStream: (sessionId: string) =>
    invoke<void>('release_addon_stream', { sessionId }),
  warmSmartNextStream: (streamUrl: string) =>
    invoke<SmartNextWarmupResult>('warm_smart_next_stream', { streamUrl }),
  cancelSmartNextWarmup: () =>
    invoke<void>('cancel_smart_next_warmup'),
  activateSmartNextStream: (streamUrl: string) =>
    invoke<void>('activate_smart_next_stream', { streamUrl }),
  prepareSmartNextQbittorrent: (
    magnetUri: string,
    infoHash?: string,
    preferredSeason?: number,
    preferredEpisode?: number,
    preferredSourceFilename?: string,
  ) => invoke<PreparedQbittorrentStreamResult>('prepare_smart_next_qbittorrent', {
    magnetUri,
    infoHash: infoHash ?? null,
    preferredSeason: preferredSeason ?? null,
    preferredEpisode: preferredEpisode ?? null,
    preferredSourceFilename: preferredSourceFilename ?? null,
  }),
  resumeSmartNextQbittorrent: (torrentHash: string) =>
    invoke<void>('resume_smart_next_qbittorrent', { torrentHash }),
  pauseSmartNextQbittorrent: (torrentHash: string) =>
    invoke<void>('pause_smart_next_qbittorrent', { torrentHash }),
  loadPreparedMpvStream: (
    pid: number,
    fileUrl: string,
    startPosition?: number,
    readyBytes?: number,
    totalBytes?: number,
    playlistFileUrls?: string[],
    playlistFiles?: StreamPlaylistItem[],
    displayTitle?: string,
  ) =>
    invoke<StreamLaunchResult>('load_prepared_mpv_stream', {
      pid,
      fileUrl,
      startPosition,
      readyBytes: readyBytes ?? 0,
      totalBytes: totalBytes ?? 0,
      playlistFileUrls: playlistFileUrls ?? [],
      playlistFiles: playlistFiles ?? null,
      displayTitle: displayTitle ?? null,
    }),
  prepareAndOpenLocalStream: (
    filePath: string,
    playlistFileUrls: string[],
    position?: { x: number; y: number; width?: number; height?: number },
    startPosition?: number,
    displayTitle?: string,
    upscalerMode?: string,
    seekPreviewEnabled?: boolean,
    forceStereoEnabled?: boolean,
    rtxHdrEnabled?: boolean,
    hdrContrastBoostEnabled?: boolean,
    cacheWholeFileEnabled?: boolean,
    preferredSubtitleLanguage?: string,
    preferredAudioLanguage?: string,
    preferSdhSubtitles?: boolean,
  ) =>
    invoke<StreamLaunchResult>('prepare_and_open_local_stream', {
      filePath,
      playlistFileUrls,
      displayTitle,
      positionX: position?.x,
      positionY: position?.y,
      width: position?.width,
      height: position?.height,
      startPosition,
      upscaler: upscalerMode ?? null,
      seekPreviewEnabled: seekPreviewEnabled ?? null,
      forceStereoEnabled: forceStereoEnabled ?? null,
      rtxHdrEnabled: rtxHdrEnabled ?? null,
      hdrContrastBoostEnabled: hdrContrastBoostEnabled ?? null,
      cacheWholeFileEnabled: cacheWholeFileEnabled ?? null,
      preferredSubtitleLanguage: preferredSubtitleLanguage ?? null,
      preferredAudioLanguage: preferredAudioLanguage ?? null,
      preferSdhSubtitles: preferSdhSubtitles ?? null,
    }),
  sendToQbittorrent: (sourceUri: string, infoHash?: string) =>
    invoke<void>('send_to_qbittorrent', {
      sourceUri,
      infoHash: infoHash ?? null,
    }),
  prepareStreamUrl: (fileIndex: number) =>
    invoke<PreparedStreamResult>('prepare_stream_url', {
      fileIndex,
    }),
  moveMpvWindow: (pid: number, x: number, y: number, width?: number, height?: number) => 
    invoke<void>('move_mpv_window', { pid, x, y, width: width ?? 1280, height: height ?? 720 }),
  stopMpvProcess: (pid: number) => invoke<void>('stop_mpv_process', { pid }),
  getMpvWindowPos: () => invoke<[number, number, number, number]>('get_mpv_window_pos'),
  openMagnet: (magnetUri: string) => invoke<void>('open_magnet', { magnetUri }),
  selectSvpExecutable: () => invoke<string | null>('select_svp_executable'),
  restartSvp: (executablePath?: string) => invoke<void>('restart_svp', { executablePath: executablePath ?? null }),
  stopSvp: (executablePath?: string) => invoke<void>('stop_svp', { executablePath: executablePath ?? null }),
  selectLocalVideoFiles: () => invoke<LocalVideoFile[] | null>('select_local_video_files'),
  selectLocalVideoFolder: () => invoke<LocalVideoFile[] | null>('select_local_video_folder'),
  startPlayerObserving: (() => {
    let isRunning = false;
    return async () => {
      if (isRunning) {
        console.log('[Player] Observer already running, skipping');
        return 'already running';
      }
      isRunning = true;
      try {
        return await invoke<string>('start_player_observing');
      } finally {
        isRunning = false;
      }
    };
  })(),
  stopPlayerObserving: () => invoke<string>('stop_player_observing'),
  getPlayerInfo: () => invoke<{
    connected: boolean;
    mpv_pid: number | null;
    fullscreen: boolean | null;
    paused: boolean | null;
    percent_pos: number | null;
    playback_time: number | null;
    duration: number | null;
    filename: string | null;
    playlist_pos: number | null;
  }>('get_player_info'),
  playerEvents: {
    onPlay: async (callback: (data: { percent_pos: number; playback_time: number; duration?: number; filename: string; playlist_pos?: number }) => void) => {
      const unlisten = await listen<any>('player://play', (event) => {
        callback(event.payload);
      });
      return () => {
        unlisten();
      };
    },
    onPause: async (callback: (data: { percent_pos: number; playback_time: number; duration?: number; filename: string; playlist_pos?: number }) => void) => {
      const unlisten = await listen<any>('player://pause', (event) => {
        callback(event.payload);
      });
      return () => {
        unlisten();
      };
    },
    onStop: async (callback: (data: { percent_pos: number; playback_time: number; duration?: number; filename: string; playlist_pos?: number }) => void) => {
      const unlisten = await listen<any>('player://stop', (event) => {
        callback(event.payload);
      });
      return () => {
        unlisten();
      };
    },
    onProgress: async (callback: (data: { percent_pos: number; playback_time: number; duration: number; filename: string; playlist_pos?: number }) => void) => {
      const unlisten = await listen<any>('player://progress', (event) => {
        callback(event.payload);
      });
      return () => {
        unlisten();
      };
    },
    onSeek: async (callback: (data: { percent_pos: number; playback_time: number; duration: number; filename: string; playlist_pos?: number }) => void) => {
      const unlisten = await listen<any>('player://seek', (event) => {
        callback(event.payload);
      });
      return () => {
        unlisten();
      };
    },
    onPlaylistChanged: async (callback: (data: PlayerPlaylistChangedPayload) => void) => {
      return await listen<any>('player://playlist_changed', (event) => {
        callback(event.payload);
      });
    },
    onSmartNextRequested: async (callback: (data: PlayerSmartNextRequestedPayload) => void) => {
      return await listen<PlayerSmartNextRequestedPayload>('player://smart-next-requested', (event) => {
        callback(event.payload);
      });
    },
    onSegmentFeedback: async (callback: (data: PlayerSegmentFeedbackPayload) => void) => {
      return await listen<PlayerSegmentFeedbackPayload>('player://segment-feedback', (event) => {
        callback(event.payload);
      });
    },
    onAudioTrackChanged: async (callback: (data: { track_id: number | null }) => void) => {
      return await listen<{ track_id: number | null }>('player://audio-track-changed', (event) => {
        callback(event.payload);
      });
    },
    onClosed: async (callback: (data: { percent_pos: number; playback_time: number; duration: number; filename: string; playlist_pos?: number }) => void) => {
      const unlisten = await listen<any>('player://closed', (event) => {
        callback(event.payload);
      });
      return () => {
        unlisten();
      };
    },
    onEof: async (callback: (data: { percent_pos: number; playback_time: number; duration: number; filename: string; playlist_pos?: number }) => void) => {
      const unlisten = await listen<any>('player://eof', (event) => {
        callback(event.payload);
      });
      return unlisten;
    },
    onReconnected: async (callback: () => void) => {
      return await listen<any>('player://reconnected', () => {
        callback();
      });
    },
    onHdrRestartRequired: async (callback: (data: {
      pid: number;
      enabled: boolean;
      percent_pos: number;
      playback_time: number;
      duration: number;
      filename: string;
      playlist_pos?: number;
    }) => void) => {
      return await listen<any>('player://hdr-restart-required', (event) => {
        callback(event.payload);
      });
    },
  },
  subtitles: {
    onProgress: async (callback: (data: SubtitleProgressEvent) => void) => {
      if (onSubtitleProgressUnlisten) {
        onSubtitleProgressUnlisten();
      }
      onSubtitleProgressUnlisten = await listen<SubtitleProgressEvent>('subtitle://progress', (event) => {
        callback(event.payload);
      });
      return () => {
        if (onSubtitleProgressUnlisten) {
          onSubtitleProgressUnlisten();
          onSubtitleProgressUnlisten = null;
        }
      };
    },
    onSegment: async (callback: (data: SubtitleSegment) => void) => {
      if (onSubtitleSegmentUnlisten) {
        onSubtitleSegmentUnlisten();
      }
      onSubtitleSegmentUnlisten = await listen<SubtitleSegment>('subtitle://segment', (event) => {
        callback(event.payload);
      });
      return () => {
        if (onSubtitleSegmentUnlisten) {
          onSubtitleSegmentUnlisten();
          onSubtitleSegmentUnlisten = null;
        }
      };
    },
    transcribeWithWhisperLive: async (sourceUrl: string, title?: string, language?: string, sessionId?: number, startSeconds?: number) => {
      return await invoke<void>('transcribe_with_whisperlive', {
        sourceUrl,
        title,
        language,
        sessionId,
        startSeconds,
      });
    },
    installWhisperLive: async (pipIndexUrl?: string) => {
      return await invoke<string>('install_whisperlive', { pipIndexUrl: pipIndexUrl ?? null });
    },
    testRuntime: async (deep = false) => {
      return await invoke<WhisperRuntimeInfo>('test_whisperlive_runtime', { deep });
    },
    stopServer: async () => {
      return await invoke<void>('stop_whisperlive_server');
    },
    stopClient: async () => {
      return await invoke<void>('stop_whisperlive_client');
    },
  },
  rife: {
    getRuntimeInfo: async (model: string) => {
      return await invoke<RifeRuntimeInfo>('get_rife_runtime_info', { model });
    },
    getPlaybackStatus: async () => {
      return await invoke<RifePlaybackStatus | null>('get_rife_playback_status');
    },
    getCacheInfo: async () => {
      return await invoke<RifeCacheInfo>('get_rife_cache_info');
    },
    clearCache: async () => {
      return await invoke<RifeCacheInfo>('clear_rife_cache');
    },
    install: async (model: string) => {
      return await invoke<RifeRuntimeInfo>('install_rife_runtime', { model });
    },
    prepareEngine: async (request: RifeEnginePreparationRequest) => {
      return await invoke<RifeEnginePreparationResult>('prepare_rife_engine', { request });
    },
    cancelEnginePreparation: async () => {
      return await invoke<void>('cancel_rife_engine_preparation');
    },
    onInstallProgress: async (
      callback: (data: RifeInstallProgress) => void
    ): Promise<UnlistenFn> => {
      return await listen<RifeInstallProgress>('rife://install-progress', (event) => {
        callback(event.payload);
      });
    },
    onEnginePreparationProgress: async (
      callback: (data: RifeEnginePreparationProgress) => void
    ): Promise<UnlistenFn> => {
      return await listen<RifeEnginePreparationProgress>('rife://engine-preparation-progress', (event) => {
        callback(event.payload);
      });
    },
    onPlaybackStatus: async (
      callback: (data: RifePlaybackStatus) => void
    ): Promise<UnlistenFn> => {
      return await listen<RifePlaybackStatus>('rife://playback-status', (event) => {
        callback(event.payload);
      });
    },
  },
  audioNormalizer: {
    install: async () => {
      return await invoke<string>('install_audio_normalizer');
    },
    setEnabled: async (enabled: boolean) => {
      return await invoke<void>('set_audio_normalizer_enabled', { enabled });
    },
    setConfig: async (config: AudioNormalizerConfig) => {
      return await invoke<void>('set_audio_normalizer_config', { config });
    },
    getConfig: async () => {
      return await invoke<AudioNormalizerConfig>('get_audio_normalizer_config');
    },
    getState: async () => {
      return await invoke<AudioNormalizerState>('get_audio_normalizer_state');
    },
    setPreset: async (preset: string) => {
      return await invoke<void>('set_audio_normalizer_preset', { preset });
    },
    stopAudioNormalizerRuntime: async () => {
      return await invoke<void>('stop_audio_normalizer_runtime');
    },
    resetState: async () => {
      return await invoke<void>('reset_audio_normalizer_state');
    },
    setManualGain: async (gainDb: number) => {
      return await invoke<void>('set_audio_normalizer_manual_gain', { gainDb });
    },
    setManualMode: async (enabled: boolean) => {
      return await invoke<void>('set_audio_normalizer_manual_mode', { enabled });
    },
    getDebugInfo: async () => {
      return await invoke<AudioNormalizerDebugInfo>('get_audio_normalizer_debug_info');
    },
    saveCustomPreset: async (config: AudioNormalizerConfig) => {
      return await invoke<void>('save_audio_normalizer_custom_preset', { config });
    },
    onTelemetry: async (callback: (data: NormalizerTelemetry) => void): Promise<UnlistenFn> => {
      return await listen<NormalizerTelemetry>('audio-normalizer://telemetry', (event) => {
        callback(event.payload);
      });
    },
    onEventLog: async (callback: (data: NormalizerEventLog) => void): Promise<UnlistenFn> => {
      return await listen<NormalizerEventLog>('audio-normalizer://event-log', (event) => {
        callback(event.payload);
      });
    },
  },
  statisticsEvents: {
    onTransfer: async (
      callback: (data: StatisticsTransferEvent) => void
    ): Promise<UnlistenFn> => {
      return await listen<StatisticsTransferEvent>('statistics://transfer', (event) => {
        callback(event.payload);
      });
    },
  },
  addonEvents: {
    onTransferProgress: async (
      callback: (data: AddonTransferProgressEvent) => void
    ): Promise<UnlistenFn> => {
      return await listen<AddonTransferProgressEvent>('addon://transfer-progress', (event) => {
        callback(event.payload);
      });
    },
    onStreamError: async (
      callback: (data: AddonStreamErrorEvent) => void
    ): Promise<UnlistenFn> => {
      return await listen<AddonStreamErrorEvent>('addon://stream-error', (event) => {
        callback(event.payload);
      });
    },
  },
  remoteControlEvents: {
    onUseWhisper: async (callback: () => void | Promise<void>): Promise<UnlistenFn> => {
      return await listen('remote://use-whisper', () => {
        void callback();
      });
    },
  },
};

declare global {
  interface Window {
    electronAPI: typeof tauriAPI;
  }
}

if (typeof window !== 'undefined') {
  (window as any).electronAPI = tauriAPI;
}
