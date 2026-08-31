import React, { useState, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { FiCheck, FiX, FiFolder, FiRefreshCw, FiFileText, FiDownload, FiCpu, FiVolume2, FiTrash2, FiMonitor, FiDatabase, FiKey, FiPlayCircle, FiZap, FiRadio, FiHardDrive, FiInfo, FiWifi, FiCopy, FiExternalLink, FiSearch, FiPackage, FiChevronDown } from 'react-icons/fi';
import { loadInstalledAddons, uninstallAddon } from '../../services/installed-addons';
import { getTraktRateLimitRetryAt, isAuthenticated as checkTraktAuth } from '../../services/trakt';
import { detectSystemTmdbWatchRegion } from '../../services/tmdb';
import { setOmdbSettings } from '../../services/omdb';
import { clearApiKeys, getApiKey } from '../../services/api-keys';
import { syncToTrakt, syncFromTrakt } from '../../services/trakt-sync';
import {
  announceDiscoveryContentModeChange,
  getDiscoveryContentMode,
  normalizeDiscoveryContentMode,
  type DiscoveryContentMode,
} from '../../services/discovery-content';
import {
  normalizeIntroDbSkipMode,
  type IntroDbSkipMode,
} from '../../services/introdb';
import {
  SEGMENT_FEEDBACK_PATTERN_STORAGE_KEY,
  SEGMENT_FEEDBACK_STORAGE_KEY,
} from '../../services/segment-feedback';
import {
  clearXrelReleaseCache,
  getXrelQualitySnapshot,
  refreshSrrdbReleaseQualities,
  refreshXrelReleaseQualities,
  setXrelBadgeDisplayMode,
  setXrelBackgroundLookupsPaused,
  setXrelQualityBadgesEnabled,
  setXrelLanguagePreference,
  subscribeXrelQualitySnapshot,
} from '../../services/xrel';
import type { RifeCacheInfo, RifePlaybackStatus, RifeRuntimeInfo, WhisperRuntimeInfo } from '../../services/tauri';
import { useStore } from '../../store';
import TraktConnect from '../trakt/TraktConnect';
import AddonSettings from './AddonSettings';
import LegalDocuments from './LegalDocuments';
import { openAudioNormalizerWindow } from '../../services/audio-normalizer-window';
import {
  checkForUpdates,
  downloadUpdate,
  getUpdaterSnapshot,
  installUpdate,
  subscribeUpdater,
} from '../../services/updater';
import './Settings.css';

const OMDB_API_URL = 'https://www.omdbapi.com/apikey.aspx';
const OMDB_LICENSE_URL = 'https://creativecommons.org/licenses/by-nc/4.0/';
const TMDB_HOME_URL = 'https://www.themoviedb.org/';
const JUSTWATCH_HOME_URL = 'https://www.justwatch.com/';
const TRAKT_REGISTRATION_URL = 'https://trakt.tv/signin';
const DEFAULT_SVP_EXECUTABLE_PATH = 'C:\\Program Files (x86)\\SVP 4\\SVPManager.exe';
const DEFAULT_REMOTE_CONTROL_PORT = 8585;

const SETTINGS_CATEGORIES = [
  {
    id: 'providers',
    label: 'Providers & Accounts',
    description: 'Metadata, sync, and streaming source connections.',
    icon: <FiRadio />,
  },
  {
    id: 'streamee-addon',
    label: 'Streamee Addon',
    description: 'Install, prioritize, and manage your configured source add-ons.',
    icon: <FiPackage />,
  },
  {
    id: 'playback',
    label: 'Playback',
    description: 'Audio, video, and player behavior.',
    icon: <FiPlayCircle />,
  },
  {
    id: 'subtitles',
    label: 'Subtitles',
    description: 'Automatic subtitle generation and WhisperLive.',
    icon: <FiFileText />,
  },
  {
    id: 'network-storage',
    label: 'Network & Storage',
    description: 'Remote access, stream caching, and connection settings.',
    icon: <FiHardDrive />,
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'SVP and optional external playback tools.',
    icon: <FiZap />,
  },
  {
    id: 'data-about',
    label: 'Data & About',
    description: 'Local data controls and application details.',
    icon: <FiDatabase />,
  },
] as const;

type SettingsCategoryId = typeof SETTINGS_CATEGORIES[number]['id'];

type SettingsSearchEntry = {
  id: string;
  label: string;
  category: string;
  categoryId: SettingsCategoryId;
  searchText: string;
};

type TorrentPortTestResult = {
  port: number;
  dht_enabled: boolean;
  tcp_bind_ok: boolean;
  udp_bind_ok: boolean;
  tcp_error?: string | null;
  udp_error?: string | null;
};

type WhisperDeviceMode = 'auto' | 'cpu' | 'cuda';
type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'turbo' | 'large-v3';
type VideoUpscaler = 'rtx-vsr' | 'ssim-superres' | 'fsr';
type RifeModel = '4.6' | '4.9' | '4.16-lite' | '4.18' | '4.25';
type RifeMultiplier = 2 | 3;
type RifeGpuStreams = 1 | 2;
type RifeConcurrentFrames = 'auto' | '1' | '2' | '4' | '6' | '8' | '12';
type RifeProcessingResolution = 'auto' | 'native' | '1080' | '720';
type RifeScale = 'auto' | '0.2' | '0.25' | '0.4' | '0.5' | '1.0';
type RifePreparationResolution = '2160' | '1080' | '720';
type SharpenPreset = 'auto' | 'standard' | 'adaptive' | 'ultra' | 'ultra-custom';
type DenoiseStrength = 'low' | 'medium' | 'high';
type SmartUltrawideFillMode = 'off' | 'efficient' | 'dynamic';
type PreferredMediaLanguage = 'original' | 'en' | 'ms' | 'id' | 'zh' | 'ja' | 'ko' | 'es' | 'fr' | 'de' | 'pt' | 'it' | 'th' | 'vi';

type RemoteControlInfo = {
  enabled: boolean;
  running: boolean;
  port: number;
  local_url: string;
  lan_url: string;
};

const normalizeWhisperDeviceMode = (value: unknown): WhisperDeviceMode => {
  return value === 'cpu' || value === 'cuda' ? value : 'auto';
};

const normalizeWhisperModel = (value: unknown): WhisperModel => {
  return value === 'tiny' || value === 'base' || value === 'small' || value === 'medium' || value === 'turbo' || value === 'large-v3'
    ? value
    : 'small';
};

const normalizeVideoUpscaler = (value: unknown): VideoUpscaler => {
  return value === 'ssim-superres' || value === 'fsr' || value === 'rtx-vsr'
    ? value
    : 'rtx-vsr';
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
};

const openExternalLink = (url: string) => {
  void window.electronAPI.openExternal(url);
};

const normalizeRifeConcurrentFrames = (value: unknown): RifeConcurrentFrames => {
  const normalized = String(value ?? 'auto');
  return ['1', '2', '4', '6', '8', '12'].includes(normalized)
    ? normalized as RifeConcurrentFrames
    : 'auto';
};

const normalizeSharpenPreset = (value: unknown): SharpenPreset => {
  return value === 'standard' || value === 'adaptive' || value === 'ultra' || value === 'ultra-custom'
    ? value
    : 'auto';
};

const normalizeDenoiseStrength = (value: unknown): DenoiseStrength => {
  return value === 'low' || value === 'high' ? value : 'medium';
};

const normalizeSmartUltrawideFillMode = (value: unknown): SmartUltrawideFillMode => {
  return value === 'efficient' || value === 'dynamic' ? value : 'off';
};

const whisperRuntimeIsReady = (runtime: WhisperRuntimeInfo): boolean => (
  runtime.whisper_live_installed &&
  runtime.websocket_client_installed &&
  runtime.ffmpeg_available &&
  (!runtime.deep_tested || runtime.model_load_ok)
);

const formatRuntimeSize = (bytes: number): string => {
  const gibibytes = bytes / (1024 ** 3);
  return gibibytes >= 1 ? `${gibibytes.toFixed(1)} GB` : `${Math.ceil(bytes / (1024 ** 2))} MB`;
};

const RIFE_PREPARATION_PROFILE_LABELS: Record<RifePreparationResolution, string> = {
  '2160': '3840×2160',
  '1080': '1920×1080',
  '720': '1280×720',
};

type RuntimeInstallerPanelProps = {
  title: string;
  description: string;
  detail?: string;
  message?: string | null;
  ready: boolean;
  installing: boolean;
  error: boolean;
  progress?: number;
  progressLabel?: string;
  busyLabel?: string;
  children: React.ReactNode;
};

const RuntimeInstallerPanel: React.FC<RuntimeInstallerPanelProps> = ({
  title,
  description,
  detail,
  message,
  ready,
  installing,
  error,
  progress,
  progressLabel,
  busyLabel = 'Installing',
  children,
}) => {
  const determinateProgress = typeof progress === 'number';
  const tone = error ? 'error' : installing ? 'installing' : ready ? 'ready' : 'idle';

  return (
    <div className={`settings-runtime-installer is-${tone}`}>
      <div className="settings-runtime-copy">
        <div className="settings-runtime-heading">
          <span>{title}</span>
          <span className="settings-runtime-badge">
            {error ? 'Needs attention' : installing ? busyLabel : ready ? 'Ready' : 'Optional'}
          </span>
        </div>
        <span className="settings-runtime-description">{description}</span>
        {detail && <span className="settings-runtime-detail">{detail}</span>}
      </div>

      <div className="settings-runtime-control">
        <div className="settings-runtime-actions">{children}</div>
        {message && (
          <div className="settings-runtime-status" role={error ? 'alert' : 'status'}>
            {error ? <FiX /> : ready && !installing ? <FiCheck /> : <FiInfo />}
            <span>{message}</span>
          </div>
        )}
        {installing && (
          <div className="settings-runtime-progress">
            <div
              className={`settings-runtime-progress-track${determinateProgress ? '' : ' is-indeterminate'}`}
              role="progressbar"
              aria-label={`${title} progress`}
              aria-valuemin={determinateProgress ? 0 : undefined}
              aria-valuemax={determinateProgress ? 100 : undefined}
              aria-valuenow={determinateProgress ? progress : undefined}
            >
              <span style={determinateProgress ? { width: `${progress}%` } : undefined} />
            </div>
            <span className="settings-runtime-progress-label">
              {progressLabel || (determinateProgress ? `${progress}%` : 'Installing...')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

const SYNC_DATA_LOCAL_STORAGE_KEYS = [
  'streamee-last-source-meta',
  'streamee-last-sources',
  'streamee-last-magnets',
  'streamee-torrent-action-state',
];

const removeLocalStorageKeys = (predicate: (key: string) => boolean) => {
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => !!key && predicate(key));

  keys.forEach((key) => localStorage.removeItem(key));
};

const resetNativeSettings = async () => {
  await Promise.all([
    window.electronAPI.settings.setSetting('subtitleAutoFallback', 'true'),
    window.electronAPI.settings.setSetting('subtitleAlwaysUseWhisper', 'false'),
    window.electronAPI.settings.setSetting('preferredSubtitleLanguage', 'en'),
    window.electronAPI.settings.setSetting('preferredAudioLanguage', 'en'),
    window.electronAPI.settings.setSetting('preferSrtSubtitles', 'false'),
    window.electronAPI.settings.setSetting('preferSdhSubtitles', 'false'),
    window.electronAPI.settings.setSetting('whisperDeviceMode', 'auto'),
    window.electronAPI.settings.setSetting('whisperModel', 'small'),
    window.electronAPI.settings.setSetting('mpvUpscaler', 'rtx-vsr'),
    window.electronAPI.settings.setSetting('mpvVsrBeforeSvp', 'true'),
    window.electronAPI.settings.setSetting('mpvSharpenEnabled', 'true'),
    window.electronAPI.settings.setSetting('mpvSharpenPreset', 'auto'),
    window.electronAPI.settings.setSetting('mpvDenoiseEnabled', 'true'),
    window.electronAPI.settings.setSetting('mpvDenoiseStrength', 'medium'),
    window.electronAPI.settings.setSetting('mpvDebandEnabled', 'true'),
    window.electronAPI.settings.setSetting('mpvSmartUltrawideFillMode', 'off'),
    window.electronAPI.settings.setSetting('mpvBlackBarLightingEnabled', 'true'),
    window.electronAPI.settings.setSetting('mpvSeekPreviewEnabled', 'false'),
    window.electronAPI.settings.setSetting('mpvForceStereoEnabled', 'true'),
    window.electronAPI.settings.setSetting('mpvRtxHdrEnabled', 'false'),
    window.electronAPI.settings.setSetting('mpvHdrContrastBoostEnabled', 'false'),
    window.electronAPI.settings.setSetting('mpvAutoHdrEnabled', 'false'),
    window.electronAPI.settings.setSetting('mpvAutoHdrOffOnExit', 'true'),
    window.electronAPI.settings.setSetting('mpvCacheWholeFileEnabled', 'false'),
    window.electronAPI.settings.setSetting('streamCachePersistentEnabled', 'false'),
    window.electronAPI.settings.setSetting('streamCachePersistentLimitGb', '50'),
    window.electronAPI.settings.setSetting('introDbIntroMode', 'always-watch'),
    window.electronAPI.settings.setSetting('introDbRecapMode', 'always-watch'),
    window.electronAPI.settings.setSetting('introDbAutoNextAtOutro', 'false'),
    window.electronAPI.settings.setSetting('introSkipperEnabled', 'false'),
    window.electronAPI.settings.setSetting('smartNextAutoloadEnabled', 'false'),
    window.electronAPI.settings.setSetting('discordPresenceEnabled', 'false'),
    window.electronAPI.discordPresence.setEnabled(false),
    window.electronAPI.settings.setSetting('svpAutoStartEnabled', 'false'),
    window.electronAPI.settings.setSetting('svpExecutablePath', DEFAULT_SVP_EXECUTABLE_PATH),
    window.electronAPI.settings.setSetting('svpAutoRestartOnPlaylistChange', 'false'),
    window.electronAPI.settings.setSetting('svpAutoCloseOnMpvClose', 'false'),
    window.electronAPI.settings.setSetting('mpvRifeEnabled', 'false'),
    window.electronAPI.settings.setSetting('mpvRifeModel', '4.6'),
    window.electronAPI.settings.setSetting('mpvRifeMultiplier', '2'),
    window.electronAPI.settings.setSetting('mpvRifeGpuStreams', '2'),
    window.electronAPI.settings.setSetting('mpvRifeConcurrentFrames', 'auto'),
    window.electronAPI.settings.setSetting('mpvRifeProcessingResolution', 'auto'),
    window.electronAPI.settings.setSetting('mpvRifeScale', 'auto'),
    window.electronAPI.settings.setSetting('mpvRifeBeforeUpscaling', 'true'),
    window.electronAPI.settings.setSetting('remoteControlEnabled', 'false'),
    window.electronAPI.settings.setSetting('remoteControlPort', String(DEFAULT_REMOTE_CONTROL_PORT)),
    invoke<RemoteControlInfo>('configure_remote_control', {
      enabled: false,
      port: DEFAULT_REMOTE_CONTROL_PORT,
    }),
  ]);
};

const clearSyncState = () => {
  removeLocalStorageKeys((key) => (
    SYNC_DATA_LOCAL_STORAGE_KEYS.includes(key) ||
    key.startsWith('streamee-last-magnet-')
  ));

  useStore.setState({
    watchlist: [],
    watched: [],
    continueWatching: [],
    continueWatchingView: [],
    watchedEpisodes: {},
    pendingTraktHistory: [],
    pendingTraktWatchlist: [],
    traktLastSync: null,
  });
};

const NORMALIZER_PRESET_OPTIONS = [
  { value: 'light', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'High' },
  { value: 'custom', label: 'Custom' },
];

const PREFERRED_MEDIA_LANGUAGE_OPTIONS: Array<{ value: PreferredMediaLanguage; label: string }> = [
  { value: 'original', label: 'Original' },
  { value: 'en', label: 'English' },
  { value: 'ms', label: 'Bahasa Melayu' },
  { value: 'id', label: 'Indonesian' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'it', label: 'Italian' },
  { value: 'th', label: 'Thai' },
  { value: 'vi', label: 'Vietnamese' },
];

const normalizePreferredMediaLanguage = (value: unknown): PreferredMediaLanguage => {
  return PREFERRED_MEDIA_LANGUAGE_OPTIONS.some((option) => option.value === value)
    ? value as PreferredMediaLanguage
    : 'en';
};

const Settings: React.FC = () => {
  const {
    audioNormalizerEnabled,
    audioNormalizerPreset,
    setAudioNormalizerEnabled,
    setAudioNormalizerPreset,
  } = useStore();
  const [watchRegion, setWatchRegion] = useState('');
  const [omdbApiKey, setOmdbApiKey] = useState('');
  const detectedWatchRegion = useMemo(() => detectSystemTmdbWatchRegion(), []);
  const [discoveryContentMode, setDiscoveryContentMode] = useState<DiscoveryContentMode>('all');
  const [torrentPort, setTorrentPort] = useState(6881);
  const [subtitleAutoFallback, setSubtitleAutoFallback] = useState(true);
  const [subtitleAlwaysUseWhisper, setSubtitleAlwaysUseWhisper] = useState(false);
  const [preferredSubtitleLanguage, setPreferredSubtitleLanguage] = useState<PreferredMediaLanguage>('en');
  const [preferredAudioLanguage, setPreferredAudioLanguage] = useState<PreferredMediaLanguage>('en');
  const [preferSrtSubtitles, setPreferSrtSubtitles] = useState(false);
  const [preferSdhSubtitles, setPreferSdhSubtitles] = useState(false);
  const [whisperDeviceMode, setWhisperDeviceMode] = useState<WhisperDeviceMode>('auto');
  const [whisperModel, setWhisperModel] = useState<WhisperModel>('small');
  const [videoUpscaler, setVideoUpscaler] = useState<VideoUpscaler>('rtx-vsr');
  const [mpvVsrBeforeSvp, setMpvVsrBeforeSvp] = useState(true);
  const [mpvSharpenEnabled, setMpvSharpenEnabled] = useState(true);
  const [mpvSharpenPreset, setMpvSharpenPreset] = useState<SharpenPreset>('auto');
  const [mpvDenoiseEnabled, setMpvDenoiseEnabled] = useState(true);
  const [mpvDenoiseStrength, setMpvDenoiseStrength] = useState<DenoiseStrength>('medium');
  const [mpvDebandEnabled, setMpvDebandEnabled] = useState(true);
  const [mpvSmartUltrawideFillMode, setMpvSmartUltrawideFillMode] = useState<SmartUltrawideFillMode>('off');
  const [mpvBlackBarLightingEnabled, setMpvBlackBarLightingEnabled] = useState(true);
  const [mpvSeekPreviewEnabled, setMpvSeekPreviewEnabled] = useState(false);
  const [mpvForceStereoEnabled, setMpvForceStereoEnabled] = useState(true);
  const [mpvRtxHdrEnabled, setMpvRtxHdrEnabled] = useState(false);
  const [mpvHdrContrastBoostEnabled, setMpvHdrContrastBoostEnabled] = useState(false);
  const [mpvAutoHdrEnabled, setMpvAutoHdrEnabled] = useState(false);
  const [mpvAutoHdrOffOnExit, setMpvAutoHdrOffOnExit] = useState(true);
  const [mpvCacheWholeFileEnabled, setMpvCacheWholeFileEnabled] = useState(false);
  const [streamCachePersistentEnabled, setStreamCachePersistentEnabled] = useState(false);
  const [streamCachePersistentLimitGb, setStreamCachePersistentLimitGb] = useState(50);
  const [introDbIntroMode, setIntroDbIntroMode] = useState<IntroDbSkipMode>('always-watch');
  const [introDbRecapMode, setIntroDbRecapMode] = useState<IntroDbSkipMode>('always-watch');
  const [introDbAutoNextAtOutro, setIntroDbAutoNextAtOutro] = useState(false);
  const [introSkipperEnabled, setIntroSkipperEnabled] = useState(false);
  const [smartNextAutoloadEnabled, setSmartNextAutoloadEnabled] = useState(false);
  const [discordPresenceEnabled, setDiscordPresenceEnabled] = useState(false);
  const [svpAutoStartEnabled, setSvpAutoStartEnabled] = useState(false);
  const [svpExecutablePath, setSvpExecutablePath] = useState(DEFAULT_SVP_EXECUTABLE_PATH);
  const [svpAutoRestartOnPlaylistChange, setSvpAutoRestartOnPlaylistChange] = useState(false);
  const [svpAutoCloseOnMpvClose, setSvpAutoCloseOnMpvClose] = useState(false);
  const [mpvRifeEnabled, setMpvRifeEnabled] = useState(false);
  const [mpvRifeModel, setMpvRifeModel] = useState<RifeModel>('4.6');
  const [mpvRifeMultiplier, setMpvRifeMultiplier] = useState<RifeMultiplier>(2);
  const [mpvRifeGpuStreams, setMpvRifeGpuStreams] = useState<RifeGpuStreams>(2);
  const [mpvRifeConcurrentFrames, setMpvRifeConcurrentFrames] = useState<RifeConcurrentFrames>('auto');
  const [mpvRifeProcessingResolution, setMpvRifeProcessingResolution] = useState<RifeProcessingResolution>('auto');
  const [mpvRifeScale, setMpvRifeScale] = useState<RifeScale>('auto');
  const [mpvRifeBeforeUpscaling, setMpvRifeBeforeUpscaling] = useState(true);
  const [rifeRuntimeInfo, setRifeRuntimeInfo] = useState<RifeRuntimeInfo | null>(null);
  const [rifeInstallStatus, setRifeInstallStatus] = useState<'idle' | 'installing' | 'success' | 'error'>('idle');
  const [rifeInstallPhase, setRifeInstallPhase] = useState<'downloading' | 'extracting' | 'complete'>('downloading');
  const [rifeInstallMessage, setRifeInstallMessage] = useState('Checking RIFE Runtime...');
  const [rifeInstallProgress, setRifeInstallProgress] = useState(0);
  const [rifePreparationResolution, setRifePreparationResolution] = useState<RifePreparationResolution>('2160');
  const [rifePreparationStatus, setRifePreparationStatus] = useState<'idle' | 'preparing' | 'success' | 'error'>('idle');
  const [rifePreparationMessage, setRifePreparationMessage] = useState<string | null>(null);
  const [rifeCacheInfo, setRifeCacheInfo] = useState<RifeCacheInfo | null>(null);
  const [rifeCacheStatus, setRifeCacheStatus] = useState<'idle' | 'clearing' | 'success' | 'error'>('idle');
  const [rifeCacheMessage, setRifeCacheMessage] = useState<string | null>(null);
  const [rifePlaybackStatus, setRifePlaybackStatus] = useState<RifePlaybackStatus | null>(null);
  const [remoteControlEnabled, setRemoteControlEnabled] = useState(false);
  const [remoteControlPort, setRemoteControlPort] = useState(DEFAULT_REMOTE_CONTROL_PORT);
  const [remoteControlInfo, setRemoteControlInfo] = useState<RemoteControlInfo | null>(null);
  const [remoteControlStatus, setRemoteControlStatus] = useState<'idle' | 'starting' | 'success' | 'error'>('idle');
  const [remoteControlMessage, setRemoteControlMessage] = useState<string | null>(null);
  const [pipIndexUrl, setPipIndexUrl] = useState('');
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [whisperInstallStatus, setWhisperInstallStatus] = useState<'idle' | 'installing' | 'success' | 'error'>('idle');
  const [whisperInstallMessage, setWhisperInstallMessage] = useState<string | null>(null);
  const [whisperRuntimeStatus, setWhisperRuntimeStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [whisperRuntimeMessage, setWhisperRuntimeMessage] = useState<string | null>(null);
  const [whisperRuntimeReady, setWhisperRuntimeReady] = useState<boolean | null>(null);
  const [audioNormalizerInstallStatus, setAudioNormalizerInstallStatus] = useState<'idle' | 'installing' | 'success' | 'error'>('idle');
  const [audioNormalizerInstallMessage, setAudioNormalizerInstallMessage] = useState<string | null>(null);
  const [torrentPortTestStatus, setTorrentPortTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [torrentPortTestResult, setTorrentPortTestResult] = useState<TorrentPortTestResult | null>(null);
  const [torrentPortTestError, setTorrentPortTestError] = useState<string | null>(null);
  const [clearLocalDataStatus, setClearLocalDataStatus] = useState<'idle' | 'clearing' | 'success' | 'error'>('idle');
  const [clearLocalDataMessage, setClearLocalDataMessage] = useState<string | null>(null);
  const [clearSyncDataStatus, setClearSyncDataStatus] = useState<'idle' | 'clearing' | 'success' | 'error'>('idle');
  const [clearSyncDataMessage, setClearSyncDataMessage] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<SettingsCategoryId>('providers');
  const [settingsSearchQuery, setSettingsSearchQuery] = useState('');
  const [settingsSearchFocused, setSettingsSearchFocused] = useState(false);
  const [settingsSearchEntries, setSettingsSearchEntries] = useState<SettingsSearchEntry[]>([]);
  const xrelSnapshot = useSyncExternalStore(
    subscribeXrelQualitySnapshot,
    getXrelQualitySnapshot,
    getXrelQualitySnapshot,
  );
  const updaterSnapshot = useSyncExternalStore(
    subscribeUpdater,
    getUpdaterSnapshot,
    getUpdaterSnapshot,
  );
  const hasLoadedSettingsRef = useRef(false);
  const settingsRootRef = useRef<HTMLDivElement>(null);
  const settingsSearchTargetsRef = useRef(new Map<string, HTMLElement>());

  const activeCategory = SETTINGS_CATEGORIES.find((category) => category.id === activeCategoryId)
    ?? SETTINGS_CATEGORIES[0];

  const normalizedSettingsSearchQuery = settingsSearchQuery.trim().toLocaleLowerCase();
  const matchingSettingsSearchEntries = normalizedSettingsSearchQuery
    ? settingsSearchEntries
      .filter((entry) => entry.searchText.includes(normalizedSettingsSearchQuery))
      .slice(0, 8)
    : [];

  const updaterActionLabel = (() => {
    switch (updaterSnapshot.status) {
      case 'checking': return 'Checking...';
      case 'available': return `Download v${updaterSnapshot.version}`;
      case 'downloading': {
        if (!updaterSnapshot.totalBytes) return 'Downloading...';
        const percent = Math.min(100, Math.round(
          (updaterSnapshot.downloadedBytes / updaterSnapshot.totalBytes) * 100,
        ));
        return `Downloading ${percent}%`;
      }
      case 'ready': return 'Install and restart';
      case 'installing': return 'Installing...';
      default: return 'Check for updates';
    }
  })();

  const updaterMessage = (() => {
    switch (updaterSnapshot.status) {
      case 'checking': return 'Checking the latest signed GitHub release.';
      case 'up-to-date': return 'Streamee is up to date.';
      case 'available': return `Streamee v${updaterSnapshot.version} is available.`;
      case 'downloading': return 'Downloading and verifying the signed installer.';
      case 'ready': return 'The signed installer is ready. Streamee will close while Windows installs it.';
      case 'installing': return 'Starting the Windows installer.';
      case 'error': return updaterSnapshot.error || 'The update operation failed.';
      default: return 'Updates are checked quietly when Streamee starts.';
    }
  })();
  const updaterNotes = updaterSnapshot.notes?.trim() || null;
  const showUpdaterNotes = !!updaterNotes
    && updaterSnapshot.status !== 'idle'
    && updaterNotes.toLocaleLowerCase() !== `streamee v${updaterSnapshot.version}`.toLocaleLowerCase();

  const handleUpdaterAction = () => {
    if (updaterSnapshot.status === 'available') {
      void downloadUpdate();
    } else if (updaterSnapshot.status === 'ready') {
      void installUpdate();
    } else {
      void checkForUpdates(true);
    }
  };

  const scrollSettingsContainerTo = (targetTop: number, behavior: ScrollBehavior = 'smooth') => {
    const scrollContainer = settingsRootRef.current?.closest<HTMLElement>('.main-content');
    scrollContainer?.scrollTo({ top: targetTop, behavior });
  };

  const handleCategoryClick = (categoryId: SettingsCategoryId) => {
    setActiveCategoryId(categoryId);
    scrollSettingsContainerTo(0);
  };

  const handleSettingsSearchResultClick = (entry: SettingsSearchEntry) => {
    const target = settingsSearchTargetsRef.current.get(entry.id);
    if (!target) return;

    setSettingsSearchFocused(false);
    setActiveCategoryId(entry.categoryId);
    target.closest<HTMLDetailsElement>('details')?.setAttribute('open', '');
    target.classList.remove('settings-search-target');
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const scrollContainer = settingsRootRef.current?.closest<HTMLElement>('.main-content');
        if (!scrollContainer) return;

        const targetTop = target.getBoundingClientRect().top
          - scrollContainer.getBoundingClientRect().top
          + scrollContainer.scrollTop
          - 24;

        void target.offsetWidth;
        target.classList.add('settings-search-target');
        scrollSettingsContainerTo(Math.max(0, targetTop));
        window.setTimeout(() => target.classList.remove('settings-search-target'), 1600);
      });
    });
  };

  useEffect(() => {
    const root = settingsRootRef.current;
    if (!root) return;

    const targets = new Map<string, HTMLElement>();
    const entries: SettingsSearchEntry[] = [];

    root.querySelectorAll<HTMLElement>('.settings-section[data-settings-page]').forEach((section) => {
      const categoryId = section.dataset.settingsPage as SettingsCategoryId | undefined;
      const category = SETTINGS_CATEGORIES.find((entry) => entry.id === categoryId);
      if (!category) return;

      const labels = section.querySelectorAll<HTMLElement>(
        ':scope > h2, h3, .settings-field > label, .settings-toggle-info > label, select[aria-label]',
      );

      labels.forEach((labelElement, index) => {
        const label = labelElement.getAttribute('aria-label')
          ?? labelElement.textContent?.replace(/\s+/g, ' ').trim();
        if (!label) return;

        const target = labelElement.closest<HTMLElement>(
          '.settings-api-block, .settings-toggle, .settings-combined-setting, .settings-field, .settings-data-card, .settings-item',
        ) ?? labelElement;
        const id = `${section.id}-${index}`;
        targets.set(id, target);
        entries.push({
          id,
          label,
          category: category.label,
          categoryId: category.id,
          searchText: `${label} ${category.label} ${target.textContent ?? ''}`.toLocaleLowerCase(),
        });
      });
    });

    settingsSearchTargetsRef.current = targets;
    setSettingsSearchEntries(entries);
  }, []);

  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch((error) => console.error('Failed to read app version:', error));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      const storedOmdbApiKey = await getApiKey('omdb');
      if (cancelled) return;
      setOmdbApiKey(storedOmdbApiKey);

      const settingsStored = localStorage.getItem('streamee-settings');
      if (settingsStored) {
        try {
          const settings = JSON.parse(settingsStored);
          setDiscoveryContentMode(normalizeDiscoveryContentMode(settings.discoveryContentMode));
          setWatchRegion(
            typeof settings.watchRegion === 'string' && /^[A-Z]{2}$/i.test(settings.watchRegion.trim())
              ? settings.watchRegion.trim().toUpperCase()
              : '',
          );
          setTorrentPort(settings.torrentPort || 6881);
          setSubtitleAutoFallback(!!settings.subtitleAutoFallback);
          setSubtitleAlwaysUseWhisper(!!settings.subtitleAlwaysUseWhisper);
          setPreferredSubtitleLanguage(normalizePreferredMediaLanguage(settings.preferredSubtitleLanguage));
          setPreferredAudioLanguage(normalizePreferredMediaLanguage(settings.preferredAudioLanguage));
          setPreferSrtSubtitles(!!settings.preferSrtSubtitles);
          setPreferSdhSubtitles(!!settings.preferSdhSubtitles);
          setWhisperDeviceMode(normalizeWhisperDeviceMode(settings.whisperDeviceMode));
          setWhisperModel(normalizeWhisperModel(settings.whisperModel));
          setVideoUpscaler(normalizeVideoUpscaler(settings.videoUpscaler));
          setMpvVsrBeforeSvp(settings.mpvVsrBeforeSvp !== false);
          setMpvSharpenEnabled(settings.mpvSharpenEnabled !== false);
          setMpvSharpenPreset(normalizeSharpenPreset(settings.mpvSharpenPreset));
          setMpvDenoiseEnabled(settings.mpvDenoiseEnabled !== false);
          setMpvDenoiseStrength(normalizeDenoiseStrength(settings.mpvDenoiseStrength));
          setMpvDebandEnabled(settings.mpvDebandEnabled !== false);
          setMpvSmartUltrawideFillMode(normalizeSmartUltrawideFillMode(settings.mpvSmartUltrawideFillMode));
          setMpvBlackBarLightingEnabled(settings.mpvBlackBarLightingEnabled !== false);
          setMpvSeekPreviewEnabled(!!settings.mpvSeekPreviewEnabled);
          setMpvForceStereoEnabled(settings.mpvForceStereoEnabled !== false);
          setMpvRtxHdrEnabled(!!settings.mpvRtxHdrEnabled);
          setMpvHdrContrastBoostEnabled(!!settings.mpvHdrContrastBoostEnabled);
          setMpvAutoHdrEnabled(!!settings.mpvAutoHdrEnabled);
          setMpvAutoHdrOffOnExit(settings.mpvAutoHdrOffOnExit !== false);
          setMpvCacheWholeFileEnabled(!!settings.mpvCacheWholeFileEnabled);
          setStreamCachePersistentEnabled(settings.streamCachePersistentEnabled === true);
          setStreamCachePersistentLimitGb(
            Math.min(2000, Math.max(1, Number(settings.streamCachePersistentLimitGb) || 50)),
          );
          setIntroDbIntroMode(normalizeIntroDbSkipMode(settings.introDbIntroMode));
          setIntroDbRecapMode(normalizeIntroDbSkipMode(settings.introDbRecapMode));
          setIntroDbAutoNextAtOutro(settings.introDbAutoNextAtOutro === true);
          setIntroSkipperEnabled(settings.introSkipperEnabled === true);
          setSmartNextAutoloadEnabled(settings.smartNextAutoloadEnabled === true);
          setDiscordPresenceEnabled(!!settings.discordPresenceEnabled);
          setSvpAutoStartEnabled(!!settings.svpAutoStartEnabled);
          setSvpExecutablePath(settings.svpExecutablePath || DEFAULT_SVP_EXECUTABLE_PATH);
          setSvpAutoRestartOnPlaylistChange(!!settings.svpAutoRestartOnPlaylistChange);
          setSvpAutoCloseOnMpvClose(!!settings.svpAutoCloseOnMpvClose);
          setMpvRifeEnabled(settings.mpvRifeEnabled === true);
          setMpvRifeModel(
            ['4.6', '4.9', '4.16-lite', '4.18', '4.25'].includes(settings.mpvRifeModel)
              ? settings.mpvRifeModel
              : '4.6',
          );
          setMpvRifeMultiplier(settings.mpvRifeMultiplier === 3 ? 3 : 2);
          setMpvRifeGpuStreams(settings.mpvRifeGpuStreams === 1 ? 1 : 2);
          setMpvRifeConcurrentFrames(normalizeRifeConcurrentFrames(settings.mpvRifeConcurrentFrames));
          setMpvRifeProcessingResolution(
            settings.mpvRifeProcessingResolution === 'native'
              || settings.mpvRifeProcessingResolution === '1080'
              || settings.mpvRifeProcessingResolution === '720'
              ? settings.mpvRifeProcessingResolution
              : 'auto',
          );
          setMpvRifeScale(
            ['0.2', '0.25', '0.4', '0.5', '1.0'].includes(settings.mpvRifeScale)
              ? settings.mpvRifeScale
              : 'auto',
          );
          setMpvRifeBeforeUpscaling(settings.mpvRifeBeforeUpscaling !== false);
          setRemoteControlEnabled(!!settings.remoteControlEnabled);
          setRemoteControlPort(Number(settings.remoteControlPort) || DEFAULT_REMOTE_CONTROL_PORT);
          setPipIndexUrl(settings.pipIndexUrl || '');
        } catch (e) {
          console.error('Failed to load settings:', e);
        }
      } else {
        try {
          const [
            fallback,
            alwaysUse,
            preferredLanguage,
            preferredAudioLanguageSetting,
            preferSrt,
            preferSdh,
            deviceMode,
            model,
            upscaler,
            vsrBeforeSvp,
            sharpenEnabled,
            sharpenPreset,
            denoiseEnabled,
            denoiseStrength,
            debandEnabled,
            smartUltrawideFillMode,
            blackBarLightingEnabled,
            seekPreviewEnabled,
            forceStereoEnabled,
            rtxHdrEnabled,
            hdrContrastBoostEnabled,
            autoHdrEnabled,
            autoHdrOffOnExit,
            cacheWholeFileEnabled,
            persistentStreamCacheEnabled,
            persistentStreamCacheLimitGb,
            introMode,
            recapMode,
            autoNextAtOutro,
            localIntroSkipper,
            smartNextAutoload,
            discordPresence,
            svpAutoStart,
            svpPath,
            svpAutoRestart,
            svpAutoClose,
            rifeEnabled,
            rifeModel,
            rifeMultiplier,
            rifeGpuStreams,
            rifeConcurrentFrames,
            rifeProcessingResolution,
            rifeScale,
            rifeBeforeUpscaling,
            remoteEnabled,
            remotePort,
          ] = await Promise.all([
            window.electronAPI.settings.getSetting('subtitleAutoFallback'),
            window.electronAPI.settings.getSetting('subtitleAlwaysUseWhisper'),
            window.electronAPI.settings.getSetting('preferredSubtitleLanguage'),
            window.electronAPI.settings.getSetting('preferredAudioLanguage'),
            window.electronAPI.settings.getSetting('preferSrtSubtitles'),
            window.electronAPI.settings.getSetting('preferSdhSubtitles'),
            window.electronAPI.settings.getSetting('whisperDeviceMode'),
            window.electronAPI.settings.getSetting('whisperModel'),
            window.electronAPI.settings.getSetting('mpvUpscaler'),
            window.electronAPI.settings.getSetting('mpvVsrBeforeSvp'),
            window.electronAPI.settings.getSetting('mpvSharpenEnabled'),
            window.electronAPI.settings.getSetting('mpvSharpenPreset'),
            window.electronAPI.settings.getSetting('mpvDenoiseEnabled'),
            window.electronAPI.settings.getSetting('mpvDenoiseStrength'),
            window.electronAPI.settings.getSetting('mpvDebandEnabled'),
            window.electronAPI.settings.getSetting('mpvSmartUltrawideFillMode'),
            window.electronAPI.settings.getSetting('mpvBlackBarLightingEnabled'),
            window.electronAPI.settings.getSetting('mpvSeekPreviewEnabled'),
            window.electronAPI.settings.getSetting('mpvForceStereoEnabled'),
            window.electronAPI.settings.getSetting('mpvRtxHdrEnabled'),
            window.electronAPI.settings.getSetting('mpvHdrContrastBoostEnabled'),
            window.electronAPI.settings.getSetting('mpvAutoHdrEnabled'),
            window.electronAPI.settings.getSetting('mpvAutoHdrOffOnExit'),
            window.electronAPI.settings.getSetting('mpvCacheWholeFileEnabled'),
            window.electronAPI.settings.getSetting('streamCachePersistentEnabled'),
            window.electronAPI.settings.getSetting('streamCachePersistentLimitGb'),
            window.electronAPI.settings.getSetting('introDbIntroMode'),
            window.electronAPI.settings.getSetting('introDbRecapMode'),
            window.electronAPI.settings.getSetting('introDbAutoNextAtOutro'),
            window.electronAPI.settings.getSetting('introSkipperEnabled'),
            window.electronAPI.settings.getSetting('smartNextAutoloadEnabled'),
            window.electronAPI.settings.getSetting('discordPresenceEnabled'),
            window.electronAPI.settings.getSetting('svpAutoStartEnabled'),
            window.electronAPI.settings.getSetting('svpExecutablePath'),
            window.electronAPI.settings.getSetting('svpAutoRestartOnPlaylistChange'),
            window.electronAPI.settings.getSetting('svpAutoCloseOnMpvClose'),
            window.electronAPI.settings.getSetting('mpvRifeEnabled'),
            window.electronAPI.settings.getSetting('mpvRifeModel'),
            window.electronAPI.settings.getSetting('mpvRifeMultiplier'),
            window.electronAPI.settings.getSetting('mpvRifeGpuStreams'),
            window.electronAPI.settings.getSetting('mpvRifeConcurrentFrames'),
            window.electronAPI.settings.getSetting('mpvRifeProcessingResolution'),
            window.electronAPI.settings.getSetting('mpvRifeScale'),
            window.electronAPI.settings.getSetting('mpvRifeBeforeUpscaling'),
            window.electronAPI.settings.getSetting('remoteControlEnabled'),
            window.electronAPI.settings.getSetting('remoteControlPort'),
          ]);
          if (cancelled) return;
          setSubtitleAutoFallback(fallback === 'true');
          setSubtitleAlwaysUseWhisper(alwaysUse === 'true');
          setPreferredSubtitleLanguage(normalizePreferredMediaLanguage(preferredLanguage));
          setPreferredAudioLanguage(normalizePreferredMediaLanguage(preferredAudioLanguageSetting));
          setPreferSrtSubtitles(preferSrt === 'true');
          setPreferSdhSubtitles(preferSdh === 'true');
          setWhisperDeviceMode(normalizeWhisperDeviceMode(deviceMode));
          setWhisperModel(normalizeWhisperModel(model));
          setVideoUpscaler(normalizeVideoUpscaler(upscaler));
          setMpvVsrBeforeSvp(vsrBeforeSvp !== 'false');
          setMpvSharpenEnabled(sharpenEnabled !== 'false');
          setMpvSharpenPreset(normalizeSharpenPreset(sharpenPreset));
          setMpvDenoiseEnabled(denoiseEnabled !== 'false');
          setMpvDenoiseStrength(normalizeDenoiseStrength(denoiseStrength));
          setMpvDebandEnabled(debandEnabled !== 'false');
          setMpvSmartUltrawideFillMode(normalizeSmartUltrawideFillMode(smartUltrawideFillMode));
          setMpvBlackBarLightingEnabled(blackBarLightingEnabled !== 'false');
          setMpvSeekPreviewEnabled(seekPreviewEnabled === 'true');
          setMpvForceStereoEnabled(forceStereoEnabled !== 'false');
          setMpvRtxHdrEnabled(rtxHdrEnabled === 'true');
          setMpvHdrContrastBoostEnabled(hdrContrastBoostEnabled === 'true');
          setMpvAutoHdrEnabled(autoHdrEnabled === 'true');
          setMpvAutoHdrOffOnExit(autoHdrOffOnExit !== 'false');
          setMpvCacheWholeFileEnabled(cacheWholeFileEnabled === 'true');
          setStreamCachePersistentEnabled(persistentStreamCacheEnabled === 'true');
          setStreamCachePersistentLimitGb(
            Math.min(2000, Math.max(1, Number(persistentStreamCacheLimitGb) || 50)),
          );
          setIntroDbIntroMode(normalizeIntroDbSkipMode(introMode));
          setIntroDbRecapMode(normalizeIntroDbSkipMode(recapMode));
          setIntroDbAutoNextAtOutro(autoNextAtOutro === 'true');
          setIntroSkipperEnabled(localIntroSkipper === 'true');
          setSmartNextAutoloadEnabled(smartNextAutoload === 'true');
          setDiscordPresenceEnabled(discordPresence === 'true');
          setSvpAutoStartEnabled(svpAutoStart === 'true');
          setSvpExecutablePath(svpPath || DEFAULT_SVP_EXECUTABLE_PATH);
          setSvpAutoRestartOnPlaylistChange(svpAutoRestart === 'true');
          setSvpAutoCloseOnMpvClose(svpAutoClose === 'true');
          setMpvRifeEnabled(rifeEnabled === 'true');
          setMpvRifeModel(
            rifeModel === '4.6' || rifeModel === '4.9' || rifeModel === '4.16-lite' || rifeModel === '4.18' || rifeModel === '4.25'
              ? rifeModel
              : '4.6',
          );
          setMpvRifeMultiplier(rifeMultiplier === '3' ? 3 : 2);
          setMpvRifeGpuStreams(rifeGpuStreams === '1' ? 1 : 2);
          setMpvRifeConcurrentFrames(normalizeRifeConcurrentFrames(rifeConcurrentFrames));
          setMpvRifeProcessingResolution(
            rifeProcessingResolution === 'native'
              || rifeProcessingResolution === '1080'
              || rifeProcessingResolution === '720'
              ? rifeProcessingResolution
              : 'auto',
          );
          setMpvRifeScale(
            rifeScale === '0.2' || rifeScale === '0.25' || rifeScale === '0.4'
              || rifeScale === '0.5' || rifeScale === '1.0'
              ? rifeScale
              : 'auto',
          );
          setMpvRifeBeforeUpscaling(rifeBeforeUpscaling !== 'false');
          setRemoteControlEnabled(remoteEnabled === 'true');
          setRemoteControlPort(Number(remotePort) || DEFAULT_REMOTE_CONTROL_PORT);
        } catch (e) {
          console.error('Failed to load subtitle settings:', e);
        }
      }

      try {
        const normalizerConfig = await window.electronAPI.audioNormalizer.getConfig();
        if (cancelled) return;
        setAudioNormalizerEnabled(normalizerConfig.enabled);
      } catch (e) {
        console.error('Failed to load audio normalizer config:', e);
      }

      try {
        const info = await invoke<RemoteControlInfo>('get_remote_control_info');
        if (!cancelled) setRemoteControlInfo(info);
      } catch (e) {
        console.error('Failed to load remote control status:', e);
      }

      hasLoadedSettingsRef.current = true;
    };

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectSvpExecutable = async () => {
    const executable = await window.electronAPI.selectSvpExecutable();
    if (executable) {
      setSvpExecutablePath(executable);
    }
  };

  const handleClearSyncData = () => {
    const confirmed = window.confirm(
      'Delete local sync data? This clears local watchlist, watched history, episode progress, continue watching, pending Trakt sync queues, and resume/source caches. API keys and app settings will stay.'
    );

    if (!confirmed) {
      return;
    }

    setClearSyncDataStatus('clearing');
    setClearSyncDataMessage('Clearing local sync data...');

    try {
      clearSyncState();
      setClearSyncDataStatus('success');
      setClearSyncDataMessage('Local sync data cleared.');
    } catch (error) {
      setClearSyncDataStatus('error');
      setClearSyncDataMessage(`Clear sync data failed: ${errorMessage(error)}`);
    }

    setTimeout(() => {
      setClearSyncDataStatus('idle');
      setClearSyncDataMessage(null);
    }, 5000);
  };

  const handleClearAllLocalData = async () => {
    const confirmed = window.confirm(
      'Delete all local Streamee data? This clears API keys, app settings, Trakt login, watchlist, watched history, continue watching, source caches, and sync queues. The app will reload afterward.'
    );

    if (!confirmed) {
      return;
    }

    hasLoadedSettingsRef.current = false;
    setClearLocalDataStatus('clearing');
    setClearLocalDataMessage('Clearing all local Streamee data...');

    try {
      clearSyncState();
      removeLocalStorageKeys((key) => key.startsWith('streamee-'));
      await clearApiKeys();
      await Promise.all(loadInstalledAddons().map((addon) => uninstallAddon(addon.installationId)));
      await resetNativeSettings();
      useStore.setState({
        watchlist: [],
        watched: [],
        continueWatching: [],
        continueWatchingView: [],
        traktConnected: false,
        traktToken: null,
        traktLastSync: null,
        watchedEpisodes: {},
        pendingTraktHistory: [],
        pendingTraktWatchlist: [],
        audioNormalizerEnabled: false,
        audioNormalizerPreset: 'medium',
      });
      removeLocalStorageKeys((key) => key.startsWith('streamee-'));
      setClearLocalDataStatus('success');
      setClearLocalDataMessage('Local data cleared. Reloading...');
      window.setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      setClearLocalDataStatus('error');
      setClearLocalDataMessage(`Clear local data failed: ${errorMessage(error)}`);
      hasLoadedSettingsRef.current = true;
    }
  };

  const persistSettings = async () => {
    const previousDiscoveryContentMode = getDiscoveryContentMode();
    await setOmdbSettings({ apiKey: omdbApiKey });
    localStorage.removeItem('streamee-tastedive');
    localStorage.setItem('streamee-settings', JSON.stringify({
      discoveryContentMode,
      watchRegion,
      torrentPort,
      subtitleAutoFallback,
      subtitleAlwaysUseWhisper,
      preferredSubtitleLanguage,
      preferredAudioLanguage,
      preferSrtSubtitles,
      preferSdhSubtitles,
      whisperDeviceMode,
      whisperModel,
      videoUpscaler,
      mpvVsrBeforeSvp,
      mpvSharpenEnabled,
      mpvSharpenPreset,
      mpvDenoiseEnabled,
      mpvDenoiseStrength,
      mpvDebandEnabled,
      mpvSmartUltrawideFillMode,
      mpvBlackBarLightingEnabled,
      mpvSeekPreviewEnabled,
      mpvForceStereoEnabled,
      mpvRtxHdrEnabled,
      mpvHdrContrastBoostEnabled,
      mpvAutoHdrEnabled,
      mpvAutoHdrOffOnExit,
      mpvCacheWholeFileEnabled,
      streamCachePersistentEnabled,
      streamCachePersistentLimitGb,
      introDbIntroMode,
      introDbRecapMode,
      introDbAutoNextAtOutro,
      introSkipperEnabled,
      smartNextAutoloadEnabled,
      discordPresenceEnabled,
      svpAutoStartEnabled,
      svpExecutablePath,
      svpAutoRestartOnPlaylistChange,
      svpAutoCloseOnMpvClose,
      mpvRifeEnabled,
      mpvRifeModel,
      mpvRifeMultiplier,
      mpvRifeGpuStreams,
      mpvRifeConcurrentFrames,
      mpvRifeProcessingResolution,
      mpvRifeScale,
      mpvRifeBeforeUpscaling,
      remoteControlEnabled,
      remoteControlPort,
      pipIndexUrl,
    }));
    if (previousDiscoveryContentMode !== discoveryContentMode) {
      announceDiscoveryContentModeChange(discoveryContentMode);
    }
    await window.electronAPI.settings.setSetting('subtitleAutoFallback', String(subtitleAutoFallback));
    await window.electronAPI.settings.setSetting('subtitleAlwaysUseWhisper', String(subtitleAlwaysUseWhisper));
    await window.electronAPI.settings.setSetting('preferredSubtitleLanguage', preferredSubtitleLanguage);
    await window.electronAPI.settings.setSetting('preferredAudioLanguage', preferredAudioLanguage);
    await window.electronAPI.settings.setSetting('preferSrtSubtitles', String(preferSrtSubtitles));
    await window.electronAPI.settings.setSetting('preferSdhSubtitles', String(preferSdhSubtitles));
    await window.electronAPI.settings.setSetting('whisperDeviceMode', whisperDeviceMode);
    await window.electronAPI.settings.setSetting('whisperModel', whisperModel);
    await window.electronAPI.settings.setSetting('mpvUpscaler', videoUpscaler);
    await window.electronAPI.settings.setSetting('mpvVsrBeforeSvp', String(mpvVsrBeforeSvp));
    await window.electronAPI.settings.setSetting('mpvSharpenEnabled', String(mpvSharpenEnabled));
    await window.electronAPI.settings.setSetting('mpvSharpenPreset', mpvSharpenPreset);
    await window.electronAPI.settings.setSetting('mpvDenoiseEnabled', String(mpvDenoiseEnabled));
    await window.electronAPI.settings.setSetting('mpvDenoiseStrength', mpvDenoiseStrength);
    await window.electronAPI.settings.setSetting('mpvDebandEnabled', String(mpvDebandEnabled));
    await window.electronAPI.settings.setSetting('mpvSmartUltrawideFillMode', mpvSmartUltrawideFillMode);
    await window.electronAPI.settings.setSetting('mpvBlackBarLightingEnabled', String(mpvBlackBarLightingEnabled));
    await window.electronAPI.settings.setSetting('mpvSeekPreviewEnabled', String(mpvSeekPreviewEnabled));
    await window.electronAPI.settings.setSetting('mpvForceStereoEnabled', String(mpvForceStereoEnabled));
    await window.electronAPI.settings.setSetting('mpvRtxHdrEnabled', String(mpvRtxHdrEnabled));
    await window.electronAPI.settings.setSetting('mpvHdrContrastBoostEnabled', String(mpvHdrContrastBoostEnabled));
    await window.electronAPI.settings.setSetting('mpvAutoHdrEnabled', String(mpvAutoHdrEnabled));
    await window.electronAPI.settings.setSetting('mpvAutoHdrOffOnExit', String(mpvAutoHdrOffOnExit));
    await window.electronAPI.settings.setSetting('mpvCacheWholeFileEnabled', String(mpvCacheWholeFileEnabled));
    await window.electronAPI.settings.setSetting('streamCachePersistentEnabled', String(streamCachePersistentEnabled));
    await window.electronAPI.settings.setSetting('streamCachePersistentLimitGb', String(streamCachePersistentLimitGb));
    await window.electronAPI.settings.setSetting('introDbIntroMode', introDbIntroMode);
    await window.electronAPI.settings.setSetting('introDbRecapMode', introDbRecapMode);
    await window.electronAPI.settings.setSetting('introDbAutoNextAtOutro', String(introDbAutoNextAtOutro));
    await window.electronAPI.settings.setSetting('introSkipperEnabled', String(introSkipperEnabled));
    await window.electronAPI.settings.setSetting('smartNextAutoloadEnabled', String(smartNextAutoloadEnabled));
    await window.electronAPI.settings.setSetting('discordPresenceEnabled', String(discordPresenceEnabled));
    await window.electronAPI.discordPresence.setEnabled(discordPresenceEnabled);
    await window.electronAPI.settings.setSetting('svpAutoStartEnabled', String(svpAutoStartEnabled));
    await window.electronAPI.settings.setSetting('svpExecutablePath', svpExecutablePath || DEFAULT_SVP_EXECUTABLE_PATH);
    await window.electronAPI.settings.setSetting('svpAutoRestartOnPlaylistChange', String(svpAutoRestartOnPlaylistChange));
    await window.electronAPI.settings.setSetting('svpAutoCloseOnMpvClose', String(svpAutoCloseOnMpvClose));
    await window.electronAPI.settings.setSetting('mpvRifeEnabled', String(mpvRifeEnabled));
    await window.electronAPI.settings.setSetting('mpvRifeModel', mpvRifeModel);
    await window.electronAPI.settings.setSetting('mpvRifeMultiplier', String(mpvRifeMultiplier));
    await window.electronAPI.settings.setSetting('mpvRifeGpuStreams', String(mpvRifeGpuStreams));
    await window.electronAPI.settings.setSetting('mpvRifeConcurrentFrames', mpvRifeConcurrentFrames);
    await window.electronAPI.settings.setSetting('mpvRifeProcessingResolution', mpvRifeProcessingResolution);
    await window.electronAPI.settings.setSetting('mpvRifeScale', mpvRifeScale);
    await window.electronAPI.settings.setSetting('mpvRifeBeforeUpscaling', String(mpvRifeBeforeUpscaling));
    await window.electronAPI.settings.setSetting('remoteControlEnabled', String(remoteControlEnabled));
    await window.electronAPI.settings.setSetting('remoteControlPort', String(remoteControlPort));
    setRemoteControlStatus('starting');
    setRemoteControlMessage(remoteControlEnabled ? 'Starting remote control...' : 'Stopping remote control...');
    try {
      const info = await invoke<RemoteControlInfo>('configure_remote_control', {
        enabled: remoteControlEnabled,
        port: remoteControlPort,
      });
      setRemoteControlInfo(info);
      setRemoteControlStatus('success');
      setRemoteControlMessage(info.running ? `Remote available at ${info.lan_url}` : 'Remote control off');
    } catch (error) {
      setRemoteControlStatus('error');
      setRemoteControlMessage(`Remote control failed: ${errorMessage(error)}`);
    }
    
  };

  useEffect(() => {
    if (!hasLoadedSettingsRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void persistSettings().catch((error) => {
        console.error('[Settings] Automatic save failed:', error);
      });
    }, 400);

    return () => window.clearTimeout(timeoutId);
  }, [
    watchRegion,
    omdbApiKey,
    discoveryContentMode,
    torrentPort,
    subtitleAutoFallback,
    subtitleAlwaysUseWhisper,
    preferredSubtitleLanguage,
    preferredAudioLanguage,
    preferSrtSubtitles,
    preferSdhSubtitles,
    whisperDeviceMode,
    whisperModel,
    videoUpscaler,
    mpvVsrBeforeSvp,
    mpvSharpenEnabled,
    mpvSharpenPreset,
    mpvDenoiseEnabled,
    mpvDenoiseStrength,
    mpvDebandEnabled,
    mpvSmartUltrawideFillMode,
    mpvBlackBarLightingEnabled,
    mpvSeekPreviewEnabled,
    mpvForceStereoEnabled,
    mpvRtxHdrEnabled,
    mpvHdrContrastBoostEnabled,
    mpvAutoHdrEnabled,
    mpvAutoHdrOffOnExit,
    mpvCacheWholeFileEnabled,
    streamCachePersistentEnabled,
    streamCachePersistentLimitGb,
    introDbIntroMode,
    introDbRecapMode,
    introDbAutoNextAtOutro,
    introSkipperEnabled,
    smartNextAutoloadEnabled,
    discordPresenceEnabled,
    svpAutoStartEnabled,
    svpExecutablePath,
    svpAutoRestartOnPlaylistChange,
    svpAutoCloseOnMpvClose,
    mpvRifeEnabled,
    mpvRifeModel,
    mpvRifeMultiplier,
    mpvRifeGpuStreams,
    mpvRifeConcurrentFrames,
    mpvRifeProcessingResolution,
    mpvRifeScale,
    mpvRifeBeforeUpscaling,
    remoteControlEnabled,
    remoteControlPort,
    pipIndexUrl
  ]);

  useEffect(() => {
    let cancelled = false;
    let unlistenInstall: (() => void) | null = null;
    let unlistenPreparation: (() => void) | null = null;
    let unlistenPlaybackStatus: (() => void) | null = null;
    let unlistenPlayerClosed: (() => void) | null = null;
    setRifeInstallMessage('Checking RIFE Runtime...');
    setRifePlaybackStatus(null);

    void window.electronAPI.rife.onInstallProgress((progress) => {
      if (cancelled) return;
      setRifeInstallPhase(progress.phase);
      setRifeInstallMessage(progress.message);
      setRifeInstallProgress(
        progress.totalBytes > 0
          ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
          : 0,
      );
    }).then((dispose) => {
      if (cancelled) {
        dispose();
      } else {
        unlistenInstall = dispose;
      }
    }).catch((error) => {
      if (!cancelled) {
        console.warn('[Settings][RIFE] Install progress listener unavailable:', error);
      }
    });

    void window.electronAPI.rife.onPlaybackStatus((status) => {
      if (!cancelled) {
        setRifePlaybackStatus(status);
      }
    }).then(async (dispose) => {
      if (cancelled) {
        dispose();
      } else {
        unlistenPlaybackStatus = dispose;
        const currentStatus = await window.electronAPI.rife.getPlaybackStatus();
        if (!cancelled) {
          setRifePlaybackStatus(currentStatus);
        }
      }
    }).catch((error) => {
      if (!cancelled) {
        console.warn('[Settings][RIFE] Playback status listener unavailable:', error);
      }
    });

    void window.electronAPI.playerEvents.onClosed(() => {
      if (!cancelled) {
        setRifePlaybackStatus(null);
      }
    }).then((dispose) => {
      if (cancelled) {
        dispose();
      } else {
        unlistenPlayerClosed = dispose;
      }
    }).catch((error) => {
      if (!cancelled) {
        console.warn('[Settings][RIFE] Player close listener unavailable:', error);
      }
    });

    void window.electronAPI.rife.onEnginePreparationProgress((progress) => {
      if (cancelled) return;
      setRifePreparationStatus(
        progress.phase === 'complete'
          ? 'success'
          : progress.phase === 'error'
            ? 'error'
            : progress.phase === 'cancelled'
              ? 'idle'
              : 'preparing',
      );
      setRifePreparationMessage(progress.message);
    }).then((dispose) => {
      if (cancelled) {
        dispose();
      } else {
        unlistenPreparation = dispose;
      }
    }).catch((error) => {
      if (!cancelled) {
        console.warn('[Settings][RIFE] Engine preparation listener unavailable:', error);
      }
    });

    void window.electronAPI.rife.getRuntimeInfo(mpvRifeModel)
      .then((runtime) => {
        if (cancelled) return;
        setRifeRuntimeInfo(runtime);
        setRifeInstallMessage(runtime.message);
      })
      .catch((error) => {
        if (cancelled) return;
        setRifeRuntimeInfo(null);
        setRifeInstallStatus('error');
        setRifeInstallMessage(`Could not check RIFE Runtime: ${errorMessage(error)}`);
      });

    void window.electronAPI.rife.getCacheInfo()
      .then((cache) => {
        if (cancelled) return;
        setRifeCacheInfo(cache);
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn('[Settings][RIFE] Cache information unavailable:', error);
        }
      });

    return () => {
      cancelled = true;
      unlistenInstall?.();
      unlistenPreparation?.();
      unlistenPlaybackStatus?.();
      unlistenPlayerClosed?.();
    };
  }, [mpvRifeModel]);

  const handleInstallRife = async () => {
    setRifeInstallStatus('installing');
    setRifeInstallPhase('downloading');
    setRifeInstallProgress(0);
    setRifeInstallMessage(
      rifeRuntimeInfo?.installed
        ? `Installing RIFE ${mpvRifeModel} model...`
        : 'Preparing RIFE Runtime download...',
    );

    try {
      const runtime = await window.electronAPI.rife.install(mpvRifeModel);
      setRifeRuntimeInfo(runtime);
      setRifeInstallProgress(100);
      setRifeInstallStatus('success');
      setRifeInstallMessage(runtime.message);
    } catch (error) {
      setRifeInstallStatus('error');
      setRifeInstallMessage(`RIFE installation failed: ${errorMessage(error)}`);
    }
  };

  const handlePrepareRifeEngine = async () => {
    const profileLabel = RIFE_PREPARATION_PROFILE_LABELS[rifePreparationResolution];
    setRifePreparationStatus('preparing');
    setRifePreparationMessage(
      `Preparing RIFE ${mpvRifeModel} for exact ${profileLabel} source frames...`,
    );

    try {
      const result = await window.electronAPI.rife.prepareEngine({
        model: mpvRifeModel,
        multiplier: mpvRifeMultiplier,
        gpuStreams: mpvRifeGpuStreams,
        processingMode: mpvRifeProcessingResolution,
        scale: mpvRifeScale,
        sourceResolution: rifePreparationResolution,
      });
      setRifePreparationStatus('success');
      setRifePreparationMessage(result.message);
    } catch (error) {
      const message = errorMessage(error);
      if (message.toLowerCase().includes('cancelled')) {
        setRifePreparationStatus('idle');
        setRifePreparationMessage('RIFE engine preparation was cancelled.');
      } else {
        setRifePreparationStatus('error');
        setRifePreparationMessage(`RIFE engine preparation failed: ${message}`);
      }
    }
  };

  const handleCancelRifePreparation = async () => {
    try {
      await window.electronAPI.rife.cancelEnginePreparation();
      setRifePreparationMessage('Cancelling RIFE engine preparation...');
    } catch (error) {
      setRifePreparationStatus('error');
      setRifePreparationMessage(`Could not cancel RIFE engine preparation: ${errorMessage(error)}`);
    }
  };

  const handleClearRifeCache = async () => {
    if (!window.confirm('Clear every compiled RIFE engine? Engines will compile again when needed.')) {
      return;
    }
    setRifeCacheStatus('clearing');
    setRifeCacheMessage('Clearing compiled RIFE engines...');
    try {
      const cache = await window.electronAPI.rife.clearCache();
      setRifeCacheInfo(cache);
      setRifeCacheStatus('success');
      setRifeCacheMessage('Compiled RIFE engines cleared.');
    } catch (error) {
      setRifeCacheStatus('error');
      setRifeCacheMessage(`Could not clear RIFE engines: ${errorMessage(error)}`);
    }
  };

  const applyRuntimeResult = (runtime: WhisperRuntimeInfo) => {
    const ready = whisperRuntimeIsReady(runtime);
    setWhisperRuntimeReady(ready);
    setWhisperRuntimeStatus(ready ? 'success' : 'error');
    setWhisperRuntimeMessage(runtime.message || (ready ? 'Whisper is ready' : 'Whisper needs attention'));
  };

  useEffect(() => {
    let cancelled = false;
    setWhisperRuntimeStatus('testing');
    setWhisperRuntimeMessage('Checking Whisper runtime...');

    void window.electronAPI.subtitles.testRuntime()
      .then((runtime) => {
        if (cancelled) return;
        const ready = whisperRuntimeIsReady(runtime);
        setWhisperRuntimeReady(ready);
        setWhisperRuntimeStatus(ready ? 'success' : 'error');
        setWhisperRuntimeMessage(runtime.message || (ready ? 'Whisper is ready' : 'Whisper needs attention'));
      })
      .catch((error) => {
        if (cancelled) return;
        setWhisperRuntimeReady(false);
        setWhisperRuntimeStatus('error');
        setWhisperRuntimeMessage(`Whisper needs attention: ${errorMessage(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleInstallWhisper = async () => {
    setWhisperInstallStatus('installing');
    setWhisperInstallMessage(whisperRuntimeReady ? 'Repairing Whisper setup...' : 'Checking Whisper setup...');
    console.log('[Settings][WhisperLive] Starting installation...');

    try {
      if (!whisperRuntimeReady) {
        try {
          const runtime = await window.electronAPI.subtitles.testRuntime();
          const whisperReady = whisperRuntimeIsReady(runtime);

          if (whisperReady) {
            console.log('[Settings][WhisperLive] Whisper already installed:', runtime);
            setWhisperInstallStatus('success');
            setWhisperInstallMessage('Whisper is already installed');
            applyRuntimeResult(runtime);
            setTimeout(() => {
              setWhisperInstallStatus('idle');
              setWhisperInstallMessage(null);
            }, 5000);
            return;
          }

          console.log('[Settings][WhisperLive] Whisper runtime needs installation:', runtime);
        } catch (precheckError) {
          console.warn('[Settings][WhisperLive] Precheck failed, continuing with install:', precheckError);
        }
      }

      const output = await window.electronAPI.subtitles.installWhisperLive(pipIndexUrl || undefined);
      console.log('[Settings][WhisperLive] Installation finished:', output);
      setWhisperInstallStatus('success');
      setWhisperInstallMessage('Verifying install...');

      try {
        const runtime = await window.electronAPI.subtitles.testRuntime(true);
        console.log('[Settings][WhisperLive] Post-install verify:', runtime);
        applyRuntimeResult(runtime);
        setWhisperInstallMessage(
          runtime.whisper_live_installed && runtime.websocket_client_installed && runtime.ffmpeg_available
            ? 'Whisper is ready'
            : 'Installed, but some packages may not be importable yet'
        );
      } catch (verifyError) {
        console.warn('[Settings][WhisperLive] Post-install verify failed:', verifyError);
        setWhisperRuntimeReady(false);
        setWhisperRuntimeStatus('error');
        setWhisperRuntimeMessage(`Could not verify install: ${errorMessage(verifyError)}`);
        setWhisperInstallMessage('Installed — restart the app if Whisper does not work');
      }
    } catch (error) {
      console.error('[Settings][WhisperLive] Installation failed:', error);
      setWhisperInstallStatus('error');
      setWhisperInstallMessage(`Whisper needs attention: ${errorMessage(error)}`);
    }

    setTimeout(() => {
      setWhisperInstallStatus('idle');
      setWhisperInstallMessage(null);
    }, 5000);
  };

  const handleTestWhisperRuntime = async () => {
    setWhisperRuntimeStatus('testing');
    setWhisperRuntimeMessage('Checking Whisper runtime...');
    console.log('[Settings][WhisperLive] Testing runtime...');

    try {
      const runtime = await window.electronAPI.subtitles.testRuntime(true);
      console.log('[Settings][WhisperLive] Runtime test result:', runtime);
      applyRuntimeResult(runtime);
    } catch (error) {
      console.error('[Settings][WhisperLive] Runtime test failed:', error);
      setWhisperRuntimeReady(false);
      setWhisperRuntimeStatus('error');
      setWhisperRuntimeMessage(`Whisper needs attention: ${errorMessage(error)}`);
    }
  };

  const handleSync = async () => {
    const activeCooldown = getTraktRateLimitRetryAt();
    if (activeCooldown) {
      setSyncMessage(`Trakt asked Streamee to wait. Try again after ${new Date(activeCooldown).toLocaleTimeString()}.`);
      setSyncStatus('error');
      return;
    }

    if (!checkTraktAuth()) {
      setSyncMessage('Not connected to Trakt');
      setSyncStatus('error');
      return;
    }

    setSyncStatus('syncing');
    setSyncMessage('Syncing...');

    try {
      console.log('[Settings] Push: Starting sync to Trakt...');
      const pushResult = await syncToTrakt();
      if (pushResult.success) {
        console.log('[Settings] Push: Completed');
      } else {
        console.warn('[Settings] Push: Some items failed; skipping pull');
        const retryMessage = pushResult.retryAt
          ? `Trakt asked Streamee to wait. Try again after ${new Date(pushResult.retryAt).toLocaleTimeString()}.`
          : pushResult.warnings[0] || 'Push failed. Local changes were kept for the next retry.';
        setSyncMessage(retryMessage);
        setSyncStatus('error');
      }

      if (pushResult.success) {
        console.log('[Settings] Pull: Starting incremental sync from Trakt...');
        const pullResult = await syncFromTrakt(undefined, { fullHistory: false });
        if (pullResult.success) {
          console.log('[Settings] Pull: Completed');
          setSyncMessage('Sync completed successfully!');
          setSyncStatus('success');
        } else {
          console.warn('[Settings] Pull: Failed');
          const retryMessage = pullResult.retryAt
            ? `Trakt asked Streamee to wait. Try again after ${new Date(pullResult.retryAt).toLocaleTimeString()}.`
            : pullResult.warnings[0] || 'Pull failed. Local data was left unchanged.';
          setSyncMessage(retryMessage);
          setSyncStatus('error');
        }
      }
    } catch (e) {
      console.error('[Settings] Sync error:', e);
      setSyncMessage('Sync failed: ' + (e as Error).message);
      setSyncStatus('error');
    }

    setTimeout(() => {
      setSyncStatus('idle');
      setSyncMessage(null);
    }, 8000);
  };

  const handleToggleAudioNormalizer = async () => {
    const nextEnabled = !audioNormalizerEnabled;
    try {
      await window.electronAPI.audioNormalizer.setEnabled(nextEnabled);
      setAudioNormalizerEnabled(nextEnabled);
    } catch (error) {
      console.error('Failed to toggle audio normalizer:', error);
    }
  };

  const handleInstallAudioNormalizer = async () => {
    setAudioNormalizerInstallStatus('installing');
    setAudioNormalizerInstallMessage('Preparing audio normalizer...');

    try {
      const message = await window.electronAPI.audioNormalizer.install();
      setAudioNormalizerEnabled(true);
      setAudioNormalizerInstallStatus('success');
      setAudioNormalizerInstallMessage(message);
    } catch (error) {
      console.error('Failed to install audio normalizer:', error);
      setAudioNormalizerInstallStatus('error');
      setAudioNormalizerInstallMessage(`Audio normalizer needs attention: ${errorMessage(error)}`);
    }

    setTimeout(() => {
      setAudioNormalizerInstallStatus('idle');
      setAudioNormalizerInstallMessage(null);
    }, 5000);
  };

  const handleAudioNormalizerPresetChange = async (preset: string) => {
    try {
      await window.electronAPI.audioNormalizer.setPreset(preset);
      const updatedConfig = await window.electronAPI.audioNormalizer.getConfig();
      setAudioNormalizerPreset(preset);
      setAudioNormalizerEnabled(updatedConfig.enabled);
    } catch (error) {
      console.error('Failed to change audio normalizer preset:', error);
    }
  };

  const handleTestTorrentPort = async () => {
    setTorrentPortTestStatus('testing');
    setTorrentPortTestError(null);

    try {
      const result = await window.electronAPI.torrent.testPort(torrentPort);
      setTorrentPortTestResult(result);
      setTorrentPortTestStatus(result.tcp_bind_ok && result.udp_bind_ok ? 'success' : 'error');
      if (!result.tcp_bind_ok || !result.udp_bind_ok) {
        setTorrentPortTestError('One or more transport binds failed on this port.');
      }
    } catch (error) {
      setTorrentPortTestResult(null);
      setTorrentPortTestStatus('error');
      setTorrentPortTestError((error as Error).message || String(error));
    }
  };

  return (
    <div className="settings" ref={settingsRootRef}>
      <header className="settings-header">
        <div className="settings-title">
          <h1>Settings</h1>
          <p>Configure Streamee your way.</p>
        </div>
        <div className={`settings-search${settingsSearchFocused ? ' is-focused' : ''}`}>
          <FiSearch aria-hidden="true" />
          <input
            type="search"
            value={settingsSearchQuery}
            onChange={(event) => setSettingsSearchQuery(event.target.value)}
            onFocus={() => setSettingsSearchFocused(true)}
            onBlur={() => setSettingsSearchFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSettingsSearchQuery('');
                event.currentTarget.blur();
              } else if (event.key === 'Enter' && matchingSettingsSearchEntries[0]) {
                event.preventDefault();
                handleSettingsSearchResultClick(matchingSettingsSearchEntries[0]);
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            aria-expanded={settingsSearchFocused && !!normalizedSettingsSearchQuery}
            aria-controls="settings-search-results"
          />
          {settingsSearchQuery && (
            <button
              className="settings-search-clear"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setSettingsSearchQuery('')}
              type="button"
              aria-label="Clear settings search"
            >
              <FiX />
            </button>
          )}

          {settingsSearchFocused && normalizedSettingsSearchQuery && (
            <div className="settings-search-results" id="settings-search-results" role="listbox">
              {matchingSettingsSearchEntries.length > 0 ? matchingSettingsSearchEntries.map((entry) => (
                <button
                  className="settings-search-result"
                  key={entry.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSettingsSearchResultClick(entry)}
                  type="button"
                  role="option"
                  aria-selected="false"
                >
                  <span>{entry.label}</span>
                  <small>{entry.category}</small>
                </button>
              )) : (
                <div className="settings-search-empty">No matching settings</div>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="settings-layout">
        <aside className="settings-category-nav" aria-label="Settings categories">
          <span className="settings-category-nav-label">Categories</span>
          {SETTINGS_CATEGORIES.map((category) => (
            <button
              className={`settings-category-link${activeCategoryId === category.id ? ' active' : ''}`}
              key={category.id}
              onClick={() => handleCategoryClick(category.id)}
              type="button"
              aria-current={activeCategoryId === category.id ? 'page' : undefined}
            >
              {category.icon}
              <span>{category.label}</span>
            </button>
          ))}
        </aside>

        <div className="settings-content">
          <div className="settings-page-heading">
            <div>
              <h2>{activeCategory.label}</h2>
              <p>{activeCategory.description}</p>
            </div>
            <span><FiCheck /> Changes save automatically</span>
          </div>
      <section
        className={`settings-section${activeCategoryId === 'providers' ? ' is-visible' : ''}`}
        data-settings-page="providers"
        id="api-integrations"
      >
        <h2><FiKey /> API Integrations</h2>
        <p className="settings-description">
          Configure metadata and sync providers used throughout Streamee.
        </p>

        <div className="settings-form settings-api-form">
          <div className="settings-api-block">
            <div className="settings-api-copy">
              <h3>TMDB</h3>
              <p>
                Powers the board, catalog, artwork, release dates, cast, and core metadata throughout Streamee.
              </p>
              <p>Access is managed by Streamee; no personal TMDB key is required.</p>
            </div>

            <div className="settings-api-controls">
              <div className="settings-field">
                <label>Streaming Region</label>
                <input
                  type="text"
                  value={watchRegion}
                  onChange={(event) => setWatchRegion(
                    event.target.value.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase(),
                  )}
                  maxLength={2}
                  placeholder={`Automatic (${detectedWatchRegion})`}
                  aria-label="Streaming availability region"
                  title={`Two-letter country code. Leave blank to use the system region (${detectedWatchRegion}).`}
                />
              </div>
            </div>
          </div>

          <div className="settings-api-separator" />

          <div className="settings-api-block">
            <div className="settings-api-copy">
              <h3>OMDb</h3>
              <p>
                Fills in IMDb ratings and extra metadata details that complement TMDB results in Meta Details.
              </p>
            </div>

            <div className="settings-field">
              <label>OMDb API Key</label>
              <input
                type="password"
                value={omdbApiKey}
                onChange={(e) => setOmdbApiKey(e.target.value)}
                placeholder="Enter your OMDb API key"
              />
              <span className="settings-hint">
                Your personal key is stored in Windows Credential Manager and sent only to OMDb. Get a key at{' '}
                <button
                  className="settings-inline-link"
                  onClick={() => openExternalLink(OMDB_API_URL)}
                  type="button"
                >
                  {OMDB_API_URL}
                </button>
              </span>
            </div>
          </div>

          <div className="settings-api-separator" />

          <div className="settings-api-block">
            <div className="settings-api-copy">
              <h3>Trakt</h3>
              <p>
                Handles watch history, watchlist sync, continue watching, board rows, and related recommendations.
              </p>
              <p>
                Registration page:{' '}
                <button
                  className="settings-inline-link"
                  onClick={() => openExternalLink(TRAKT_REGISTRATION_URL)}
                  type="button"
                >
                  {TRAKT_REGISTRATION_URL}
                </button>
              </p>
            </div>

            <div className="settings-field settings-trakt-field">
              <TraktConnect
                onResync={handleSync}
                syncStatus={syncStatus}
                syncMessage={syncMessage}
              />
            </div>
          </div>
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'providers' ? ' is-visible' : ''}`}
        data-settings-page="providers"
        id="content-discovery"
      >
        <h2><FiRadio /> Content Discovery</h2>
        <p className="settings-description">
          Control which titles appear on the Board, in catalogs, and in title search results.
        </p>

        <div className="settings-form">
          <div className="settings-field">
            <label htmlFor="discovery-content-mode">Discovery content</label>
            <select
              id="discovery-content-mode"
              className="settings-select"
              value={discoveryContentMode}
              onChange={(event) => setDiscoveryContentMode(
                normalizeDiscoveryContentMode(event.target.value)
              )}
            >
              <option value="all">All titles</option>
              <option value="anime-only">Anime only</option>
              <option value="exclude-anime">Exclude anime</option>
            </select>
            <span className="settings-hint">
              Anime means Japanese-language animation. Watchlist, Continue Watching, and watched history remain visible.
            </span>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Release-quality badges</label>
              <span className="settings-toggle-desc">
                Shows the highest quality found by xREL, srrDB, or your configured add-ons on movie and series posters.
              </span>
            </div>
            <button
              className={`toggle-btn ${xrelSnapshot.enabled ? 'active' : ''}`}
              onClick={() => setXrelQualityBadgesEnabled(!xrelSnapshot.enabled)}
              aria-label="Toggle release-quality badges"
              aria-pressed={xrelSnapshot.enabled}
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          {xrelSnapshot.enabled && (
            <>
              <div className="settings-field">
                <label htmlFor="xrel-release-language">Release language</label>
                <select
                  id="xrel-release-language"
                  className="settings-select"
                  value={xrelSnapshot.language}
                  onChange={(event) => setXrelLanguagePreference(
                    event.target.value === 'english'
                      ? 'english'
                      : event.target.value === 'german'
                        ? 'german'
                        : 'any',
                  )}
                >
                  <option value="any">Any language</option>
                  <option value="english">English-tagged only</option>
                  <option value="german">German-tagged only</option>
                </select>
                <span className="settings-hint">
                  Language tags come from each provider and the release name. Any language also includes releases without a reliable tag.
                </span>
              </div>

              <div className="settings-field">
                <label htmlFor="xrel-badge-display-mode">Badge detail</label>
                <select
                  id="xrel-badge-display-mode"
                  className="settings-select"
                  value={xrelSnapshot.displayMode}
                  onChange={(event) => setXrelBadgeDisplayMode(
                    event.target.value === 'minimal' ? 'minimal' : 'all',
                  )}
                >
                  <option value="all">Show every recognized quality</option>
                  <option value="minimal">Only notable releases</option>
                </select>
                <span className="settings-hint">
                  Minimal mode shows early copies, WEB releases, HDR/Dolby Vision, and 4K tiers while hiding routine SD, 720p, and 1080p badges.
                </span>
              </div>

              <div className="xrel-status-card">
                <div className="xrel-status-header">
                  <div className="xrel-status-heading">
                    <span className="xrel-status-title">Release index</span>
                    <span className="xrel-status-subtitle">Cached locally and refreshed in the background</span>
                  </div>
                  <span className={`settings-port-test-badge ${xrelSnapshot.online && !xrelSnapshot.lastError ? 'ok' : 'fail'}`}>
                    {!xrelSnapshot.online
                      ? 'Offline'
                      : xrelSnapshot.isRefreshing
                        ? 'Refreshing'
                        : xrelSnapshot.isLookingUp
                          ? 'Looking up title'
                          : xrelSnapshot.lastError
                            ? 'Issue'
                            : 'Ready'}
                  </span>
                </div>
                <div className="xrel-status-metrics">
                  <div className="xrel-status-metric">
                    <span>Sources</span>
                    <strong>xREL + srrDB + add-ons</strong>
                  </div>
                  <div className="xrel-status-metric">
                    <span>Titles with release matches</span>
                    <strong>{xrelSnapshot.indexedTitles.toLocaleString()}</strong>
                    <small>{xrelSnapshot.preciseTitles.toLocaleString()} precisely verified</small>
                  </div>
                  <div className="xrel-status-metric">
                    <span>Last xREL feed refresh</span>
                    <strong>{xrelSnapshot.fetchedAt ? new Date(xrelSnapshot.fetchedAt).toLocaleString() : 'Not yet'}</strong>
                  </div>
                  <div className="xrel-status-metric">
                    <span>xREL quota</span>
                    <strong>
                      {xrelSnapshot.rateRemaining !== null && xrelSnapshot.rateLimit !== null
                        ? `${xrelSnapshot.rateRemaining} / ${xrelSnapshot.rateLimit}`
                        : 'Available after first request'}
                    </strong>
                    <small>{xrelSnapshot.xrelRequestsThisHour} Streamee calls in this window</small>
                  </div>
                </div>
                <div className="xrel-queue-row">
                  <div className="xrel-queue-heading">
                    <span>Poster queue</span>
                    <small>Visible uncached posters are filled gradually</small>
                  </div>
                  <div className="xrel-queue-stats">
                    <span className="xrel-queue-chip">
                      <strong>{xrelSnapshot.backgroundQueued}</strong> queued
                    </span>
                    <span className={`xrel-queue-chip ${xrelSnapshot.backgroundProcessing ? 'is-active' : ''}`}>
                      {xrelSnapshot.backgroundPaused
                        ? 'Paused'
                        : xrelSnapshot.backgroundProcessing
                          ? 'Processing'
                          : 'Idle'}
                    </span>
                    <span className="xrel-queue-chip">
                      <strong>{xrelSnapshot.backgroundCompletedThisHour}</strong> completed this hour
                    </span>
                    <span className="xrel-queue-chip">
                      <strong>{xrelSnapshot.backgroundRequestsThisHour} / {xrelSnapshot.backgroundHourlyLimit}</strong> hourly budget
                    </span>
                    <span className="xrel-queue-chip">
                      <strong>{Math.ceil(xrelSnapshot.backgroundNextDelayMs / 1000)}s</strong> cadence
                    </span>
                  </div>
                  <button
                    className="settings-btn xrel-queue-toggle"
                    onClick={() => setXrelBackgroundLookupsPaused(!xrelSnapshot.backgroundPaused)}
                    type="button"
                  >
                    {xrelSnapshot.backgroundPaused ? 'Resume queue' : 'Pause queue'}
                  </button>
                </div>
                <div className="xrel-queue-row">
                  <div className="xrel-queue-heading">
                    <span>srrDB enrichment</span>
                    <small>Prioritizes library titles, weak matches, and recent upgrades</small>
                  </div>
                  <div className="xrel-queue-stats">
                    <span className="xrel-queue-chip">
                      <strong>{xrelSnapshot.srrdbBackgroundQueued}</strong> queued
                    </span>
                    <span className={`xrel-queue-chip ${xrelSnapshot.srrdbBackgroundProcessing ? 'is-active' : ''}`}>
                      {xrelSnapshot.backgroundPaused
                        ? 'Paused'
                        : xrelSnapshot.srrdbCooldownUntil > Date.now()
                          ? 'Cooling down'
                          : xrelSnapshot.srrdbBackgroundProcessing
                            ? 'Processing'
                            : 'Idle'}
                    </span>
                    <span className="xrel-queue-chip">
                      <strong>{xrelSnapshot.srrdbCompletedThisHour}</strong> completed this hour
                    </span>
                    <span className="xrel-queue-chip">
                      <strong>{xrelSnapshot.srrdbRequestsThisHour} / {xrelSnapshot.srrdbHourlyLimit}</strong> hourly budget
                    </span>
                    <span className="xrel-queue-chip">
                      <strong>5s</strong> cadence
                    </span>
                  </div>
                </div>
                {xrelSnapshot.rateResetAt && xrelSnapshot.rateRemaining === 0 && (
                  <span className="xrel-status-notice">
                    Resets {new Date(xrelSnapshot.rateResetAt).toLocaleString()}.
                  </span>
                )}
                {xrelSnapshot.lastError && (
                  <span className="settings-test-error">{xrelSnapshot.lastError}</span>
                )}
                {xrelSnapshot.srrdbLastError && (
                  <span className="xrel-status-notice is-warning">
                    srrDB enrichment is temporarily unavailable; xREL remains active.
                    {xrelSnapshot.srrdbCooldownUntil > Date.now()
                      ? ` Retrying after ${new Date(xrelSnapshot.srrdbCooldownUntil).toLocaleTimeString()}.`
                      : ''}
                  </span>
                )}
                <div className="xrel-status-footer">
                  <span>
                    xREL discovers poster matches. srrDB selectively improves weak matches and checks recent releases every 30 minutes. Configured add-ons rotate through unique Trending and Popular titles when their saved check is stale; titles already at 4K or better are skipped. xREL poster lookups preserve {xrelSnapshot.backgroundQuotaReserve} requests.
                  </span>
                  <div className="xrel-status-actions">
                    <button
                      className="settings-btn settings-btn-test"
                      onClick={() => {
                        void refreshXrelReleaseQualities(true);
                        void refreshSrrdbReleaseQualities(true);
                      }}
                      disabled={!xrelSnapshot.online || xrelSnapshot.isRefreshing}
                      type="button"
                    >
                      {xrelSnapshot.isRefreshing ? 'Refreshing...' : 'Refresh feeds'}
                    </button>
                    <button
                      className="settings-btn"
                      onClick={() => clearXrelReleaseCache(true)}
                      disabled={!xrelSnapshot.online || xrelSnapshot.isRefreshing}
                      type="button"
                    >
                      Clear &amp; rebuild
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'subtitles' ? ' is-visible' : ''}`}
        data-settings-page="subtitles"
        id="subtitle-assist"
      >
        <h2><FiFileText /> Subtitle Assist</h2>
        <p className="settings-description">
          WhisperLive streams audio to a local transcription server in real time, generating subtitles as playback progresses — no need to wait for the full file to download.
        </p>

        <div className="settings-form">
          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Auto-generate subtitles when none are available</label>
              <span className="settings-toggle-desc">
                When enabled, Streamee will transcribe the current stream with WhisperLive if MPV cannot find a subtitle track.
              </span>
            </div>
            <button
              className={`toggle-btn ${subtitleAutoFallback ? 'active' : ''}`}
              onClick={() => setSubtitleAutoFallback((prev) => !prev)}
              aria-label="Toggle automatic subtitle generation"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-field">
            <label>Preferred subtitle language</label>
            <select
              className="settings-select"
              value={preferredSubtitleLanguage}
              onChange={(e) => setPreferredSubtitleLanguage(e.target.value as PreferredMediaLanguage)}
            >
              {PREFERRED_MEDIA_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="settings-hint">
              MPV will prefer this language when choosing embedded or nearby subtitle tracks. Original follows the movie or show's TMDB language.
            </span>
          </div>

          <div className="settings-field">
            <label>Preferred audio language</label>
            <select
              className="settings-select"
              value={preferredAudioLanguage}
              onChange={(e) => setPreferredAudioLanguage(e.target.value as PreferredMediaLanguage)}
            >
              {PREFERRED_MEDIA_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="settings-hint">
              MPV will prefer this language when choosing an audio track. Original follows the movie or show's TMDB language.
            </span>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Prefer .SRT subtitles</label>
              <span className="settings-toggle-desc">
                Chooses a matching-language SRT track first. With SDH preference also enabled, an SRT track marked SDH has top priority.
              </span>
            </div>
            <button
              className={`toggle-btn ${preferSrtSubtitles ? 'active' : ''}`}
              onClick={() => setPreferSrtSubtitles((prev) => !prev)}
              aria-label="Toggle SRT subtitle preference"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Prefer SDH subtitles</label>
              <span className="settings-toggle-desc">
                Chooses subtitles marked for deaf or hard-of-hearing viewers when a matching language track is available.
              </span>
            </div>
            <button
              className={`toggle-btn ${preferSdhSubtitles ? 'active' : ''}`}
              onClick={() => setPreferSdhSubtitles((prev) => !prev)}
              aria-label="Toggle SDH subtitle preference"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-advanced-grid settings-always-visible">
          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Always use WhisperLive even when subtitles exist</label>
              <span className="settings-toggle-desc">
                Force transcription for every playback, even when embedded subtitles are present.
              </span>
            </div>
            <button
              className={`toggle-btn ${subtitleAlwaysUseWhisper ? 'active' : ''}`}
              onClick={() => setSubtitleAlwaysUseWhisper((prev) => !prev)}
              aria-label="Toggle always use WhisperLive"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-field">
            <label>Whisper device mode</label>
            <select
              className="settings-select"
              value={whisperDeviceMode}
              onChange={(e) => setWhisperDeviceMode(e.target.value as WhisperDeviceMode)}
            >
              <option value="auto">Auto detect GPU (recommended)</option>
              <option value="cpu">CPU only</option>
              <option value="cuda">CUDA / GPU</option>
            </select>
            <span className="settings-hint">
              Auto will use CUDA when a compatible GPU is available, otherwise it falls back to CPU.
            </span>
          </div>

          <div className="settings-field">
            <label>Whisper model</label>
            <select
              className="settings-select"
              value={whisperModel}
              onChange={(e) => setWhisperModel(e.target.value as WhisperModel)}
            >
              <option value="tiny">tiny</option>
              <option value="base">base</option>
              <option value="small">small</option>
              <option value="medium">medium</option>
              <option value="turbo">Turbo — recommended for live subtitles</option>
              <option value="large-v3">Large v3 — highest local accuracy</option>
            </select>
            <span className="settings-hint">
              Turbo gives near-Large-v3 accuracy with substantially lower subtitle delay. Large v3 remains available when maximum accuracy matters more than latency.
            </span>
          </div>

          <div className="settings-field">
            <label>pip mirror URL (optional)</label>
            <input
              type="text"
              value={pipIndexUrl}
              onChange={(e) => setPipIndexUrl(e.target.value)}
              placeholder="e.g. https://pypi.tuna.tsinghua.edu.cn/simple"
            />
            <span className="settings-hint">
              Used with <code>pip install -i &lt;url&gt;</code>. Leave empty to use the default PyPI index.
            </span>
          </div>

          <RuntimeInstallerPanel
            title="Whisper Runtime"
            description="Local speech-to-text components for live subtitle generation."
            detail="Requires ffmpeg on PATH. The selected model loads on first use."
            message={whisperInstallMessage || whisperRuntimeMessage}
            ready={whisperRuntimeReady === true}
            installing={whisperInstallStatus === 'installing' || whisperRuntimeStatus === 'testing'}
            error={whisperInstallStatus === 'error' || whisperRuntimeStatus === 'error'}
            busyLabel={whisperRuntimeStatus === 'testing' ? 'Checking' : 'Installing'}
            progressLabel={whisperRuntimeStatus === 'testing' ? 'Verifying runtime...' : whisperInstallMessage || 'Installing components...'}
          >
            <button
              className="settings-btn settings-btn-test"
              onClick={handleInstallWhisper}
              disabled={whisperInstallStatus === 'installing'}
              type="button"
            >
              {whisperInstallStatus === 'installing' && 'Installing...'}
              {whisperInstallStatus !== 'installing' && whisperRuntimeReady && <><FiRefreshCw /> Repair Whisper</>}
              {whisperInstallStatus !== 'installing' && !whisperRuntimeReady && <><FiDownload /> Install Whisper</>}
            </button>
            <button
              className="settings-btn settings-btn-test"
              onClick={handleTestWhisperRuntime}
              disabled={whisperRuntimeStatus === 'testing' || whisperInstallStatus === 'installing'}
              type="button"
            >
              {whisperRuntimeStatus === 'testing' ? 'Testing...' : <><FiCpu /> Test runtime</>}
            </button>
          </RuntimeInstallerPanel>
            </div>
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'network-storage' ? ' is-visible' : ''}`}
        data-settings-page="network-storage"
        id="remote-control"
      >
        <h2><FiWifi /> Remote Control</h2>
        <p className="settings-description">
          Control the active MPV session from a phone on the same local network. The remote can be saved to the phone&apos;s Home Screen for quick access.
        </p>

        <div className="settings-form">
          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Enable phone remote</label>
              <span className="settings-toggle-desc">
                Starts a small local web server for playback, MPV and Windows volume, HDR, SVP, and Audio Normalizer controls.
              </span>
              <span className="settings-hint">
                Only enable this on a trusted home network. Devices on the same network can control playback while it is on.
              </span>
              <span className="settings-hint">
                If Windows Firewall asks, allow Streamee on private networks so your phone can connect.
              </span>
            </div>
            <button
              className={`toggle-btn ${remoteControlEnabled ? 'active' : ''}`}
              onClick={() => {
                setRemoteControlStatus('starting');
                setRemoteControlEnabled((previous) => !previous);
              }}
              aria-label="Toggle phone remote"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-field">
            <label>Remote port</label>
            <input
              type="number"
              min="1024"
              max="65535"
              step="1"
              value={remoteControlPort}
              onChange={(event) => {
                const value = Number(event.target.value);
                setRemoteControlPort(Number.isFinite(value) ? Math.min(65535, Math.max(1024, value)) : DEFAULT_REMOTE_CONTROL_PORT);
              }}
            />
            <span className="settings-hint">
              Default: {DEFAULT_REMOTE_CONTROL_PORT}. Change this if another local service already uses the port.
            </span>
          </div>

          <div className="settings-field">
            <label>Phone URL</label>
            <div className="settings-folder-input">
              <input
                type="text"
                value={remoteControlInfo?.lan_url || `http://your-pc:${remoteControlPort}`}
                readOnly
                aria-label="Phone remote URL"
              />
              <button
                className="settings-btn-folder"
                onClick={() => {
                  const url = remoteControlInfo?.lan_url;
                  if (!url) return;
                  void navigator.clipboard.writeText(url).then(() => {
                    setRemoteControlMessage('Remote URL copied.');
                    setRemoteControlStatus('success');
                  }).catch((error) => {
                    setRemoteControlMessage(`Could not copy URL: ${errorMessage(error)}`);
                    setRemoteControlStatus('error');
                  });
                }}
                disabled={!remoteControlInfo?.running}
                type="button"
                aria-label="Copy phone remote URL"
                title="Copy phone remote URL"
              >
                <FiCopy />
              </button>
            </div>
            <span className="settings-hint">
              Open this URL on your phone, then use the browser&apos;s Add to Home Screen action. The browser bar remains because a local HTTP address cannot be installed as a trusted standalone PWA.
            </span>
          </div>

          <div className="settings-actions settings-actions-wrap">
            <button
              className={`settings-btn settings-btn-test ${remoteControlStatus}`}
              onClick={() => remoteControlInfo?.lan_url && openExternalLink(remoteControlInfo.lan_url)}
              disabled={!remoteControlInfo?.running}
              type="button"
            >
              <FiExternalLink /> Open Remote
            </button>
            {remoteControlMessage && (
              <span className="settings-sync-message">{remoteControlMessage}</span>
            )}
          </div>
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'playback' ? ' is-visible' : ''}`}
        data-settings-page="playback"
        id="audio-normalizer"
      >
        <h2><FiVolume2 /> Audio Normalizer</h2>
        <p className="settings-description">
          Enable the realtime loudness rider, switch presets quickly, and open the full debug panel for live telemetry and tuning.
        </p>

        <div className="settings-form">
          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Realtime audio normalizer</label>
              <span className="settings-toggle-desc">
                Uses MPV loudness telemetry to apply a separate rider gain without touching the player volume control.
              </span>
              <span className="settings-hint">
                {audioNormalizerEnabled ? 'Normalizer on' : 'Normalizer off'}
              </span>
            </div>
            <button
              className={`toggle-btn ${audioNormalizerEnabled ? 'active' : ''}`}
              onClick={handleToggleAudioNormalizer}
              aria-label="Toggle audio normalizer"
              type="button"
            >
              <span className="toggle-slider" />
              </button>
            </div>

          <div className="settings-field">
            <label>Strength</label>
            <div className="settings-control-row">
              <select
                className="settings-select"
                value={audioNormalizerPreset}
                onChange={(e) => void handleAudioNormalizerPresetChange(e.target.value)}
              >
                {NORMALIZER_PRESET_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                className="settings-btn settings-btn-test"
                onClick={() => {
                  void openAudioNormalizerWindow().catch((error) => {
                    console.error('[AudioNormalizer] Failed to open tuner window:', error);
                  });
                }}
                type="button"
              >
                Open tuner
              </button>
            </div>
            <span className="settings-hint">
              How aggressively Streamee balances quiet and loud scenes.
            </span>
          </div>

          <div className="settings-advanced-grid settings-always-visible">
              <div className="settings-actions settings-actions-wrap">
                <button
                  className={`settings-btn settings-btn-test ${audioNormalizerInstallStatus}`}
                  onClick={handleInstallAudioNormalizer}
                  disabled={audioNormalizerInstallStatus === 'installing'}
                  type="button"
                >
                  {audioNormalizerInstallStatus === 'installing' && 'Preparing...'}
                  {audioNormalizerInstallStatus === 'success' && <><FiCheck /> Enabled</>}
                  {audioNormalizerInstallStatus === 'error' && <><FiX /> Failed</>}
                  {audioNormalizerInstallStatus === 'idle' && <><FiDownload /> Enable Audio Normalizer</>}
                </button>
                {audioNormalizerInstallMessage && (
                  <span className="settings-sync-message">{audioNormalizerInstallMessage}</span>
                )}
              </div>
            </div>
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'playback' ? ' is-visible' : ''}`}
        data-settings-page="playback"
        id="video-processing"
      >
        <h2><FiMonitor /> Video Processing</h2>
        <p className="settings-description">
          Choose how Streamee scales, sharpens, cleans, and maps video when a new MPV session starts.
        </p>

        <div className="settings-form">
          <div className="video-processing-group">
            <div className="video-processing-group-header">
              <span>
                <strong>Scale &amp; interpolate</strong>
                <small>{videoUpscaler === 'rtx-vsr' ? 'RTX VSR' : videoUpscaler === 'ssim-superres' ? 'SSimSuperRes' : 'FSR'} · playback pipeline</small>
              </span>
            </div>
            <div className="settings-advanced-grid">
          <div className="settings-field">
            <label>Upscaler</label>
            <select
              className="settings-select"
              value={videoUpscaler}
              onChange={(e) => setVideoUpscaler(e.target.value as VideoUpscaler)}
            >
              <option value="rtx-vsr">RTX VSR</option>
              <option value="ssim-superres">SSimSuperRes</option>
              <option value="fsr">FSR</option>
            </select>
            <span className="settings-hint">
              Choose the primary scaling method for new MPV sessions.
            </span>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Run RTX VSR before SVP</label>
              <span className="settings-toggle-desc">
                For 1440p-or-lower sources, upscales the original frames before interpolation, reducing VSR frame processing but increasing SVP resolution and load. Applies from the next playback session.
              </span>
            </div>
            <button
              className={`toggle-btn ${videoUpscaler === 'rtx-vsr' && mpvVsrBeforeSvp ? 'active' : ''}`}
              onClick={() => setMpvVsrBeforeSvp((prev) => !prev)}
              aria-label="Toggle RTX VSR before SVP"
              disabled={videoUpscaler !== 'rtx-vsr'}
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>
            </div>
          </div>

          <div className="video-processing-group">
            <div className="video-processing-group-header">
              <span>
                <strong>HDR</strong>
                <small>{mpvAutoHdrEnabled ? 'Automatic display HDR' : 'Display HDR stays unchanged'} · {mpvRtxHdrEnabled ? 'SDR conversion on' : 'SDR conversion off'}</small>
              </span>
            </div>
            <div className="settings-advanced-grid">
          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Auto-enable Windows HDR for HDR or Dolby Vision</label>
              <span className="settings-toggle-desc">
                Detects HDR/DV release tags before MPV starts, then enables HDR only on the playback monitor.
              </span>
            </div>
            <button
              className={`toggle-btn ${mpvAutoHdrEnabled ? 'active' : ''}`}
              onClick={() => setMpvAutoHdrEnabled((prev) => !prev)}
              aria-label="Toggle automatic Windows HDR for HDR content"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Turn off Windows HDR when MPV exits</label>
              <span className="settings-toggle-desc">
                Applies to Auto HDR and the Plex HDR button, including when Windows HDR was already enabled before playback.
              </span>
            </div>
            <button
              className={`toggle-btn ${mpvAutoHdrOffOnExit ? 'active' : ''}`}
              onClick={() => setMpvAutoHdrOffOnExit((prev) => !prev)}
              aria-label="Toggle HDR restoration when MPV exits"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Enable RTX Video HDR for MPV</label>
              <span className="settings-toggle-desc">
                Converts SDR video to HDR with NVIDIA RTX Video when Windows HDR and an HDR display are active.
              </span>
            </div>
            <button
              className={`toggle-btn ${mpvRtxHdrEnabled ? 'active' : ''}`}
              onClick={() => setMpvRtxHdrEnabled((prev) => !prev)}
              aria-label="Toggle RTX Video HDR for MPV"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Set MPV contrast to 15% for HDR</label>
              <span className="settings-toggle-desc">
                Applies MPV contrast 15 only when RTX Video HDR for MPV is enabled, leaving normal SDR playback unchanged.
              </span>
            </div>
            <button
              className={`toggle-btn ${mpvHdrContrastBoostEnabled ? 'active' : ''}`}
              onClick={() => setMpvHdrContrastBoostEnabled((prev) => !prev)}
              aria-label="Toggle MPV HDR contrast boost"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>
            </div>
          </div>

          <div className="video-processing-group">
            <div className="video-processing-group-header">
              <span>
                <strong>Picture cleanup</strong>
                <small>{[mpvSharpenEnabled, mpvDenoiseEnabled, mpvDebandEnabled].filter(Boolean).length} of 3 enhancements enabled</small>
              </span>
            </div>
            <div className="settings-advanced-grid">
          <div className="settings-combined-setting">
            <div className="settings-toggle-info">
              <label>Enable sharpener by default</label>
              <span className="settings-toggle-desc">
                Starts each new season with the selected sharpener. Player menu changes carry through the remaining episodes in that season.
              </span>
            </div>
            <div className="settings-control-row">
              <button
                className={`toggle-btn ${mpvSharpenEnabled ? 'active' : ''}`}
                onClick={() => setMpvSharpenEnabled((prev) => !prev)}
                aria-label="Toggle default MPV sharpener"
                type="button"
              >
                <span className="toggle-slider" />
              </button>
              <select
                className="settings-select"
                value={mpvSharpenPreset}
                onChange={(e) => setMpvSharpenPreset(e.target.value as SharpenPreset)}
                disabled={!mpvSharpenEnabled}
                aria-label="Default sharpener preset"
              >
                <option value="auto">Auto (Standard / Ultra by source)</option>
                <option value="standard">Standard</option>
                <option value="adaptive">Adaptive</option>
                <option value="ultra">Ultra</option>
                <option value="ultra-custom">UltraCustom</option>
              </select>
            </div>
          </div>

          <div className="settings-combined-setting">
            <div className="settings-toggle-info">
              <label>Enable denoiser by default</label>
              <span className="settings-toggle-desc">
                Starts each new season with Streamee&apos;s bilateral denoiser. Player menu changes carry through the remaining episodes in that season.
              </span>
            </div>
            <div className="settings-control-row">
              <button
                className={`toggle-btn ${mpvDenoiseEnabled ? 'active' : ''}`}
                onClick={() => setMpvDenoiseEnabled((prev) => !prev)}
                aria-label="Toggle default MPV denoiser"
                type="button"
              >
                <span className="toggle-slider" />
              </button>
              <select
                className="settings-select"
                value={mpvDenoiseStrength}
                onChange={(e) => setMpvDenoiseStrength(e.target.value as DenoiseStrength)}
                disabled={!mpvDenoiseEnabled}
                aria-label="Default denoiser strength"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Enable debanding by default</label>
              <span className="settings-toggle-desc">
                Reduces visible color banding with MPV&apos;s deband pass. Applies from the next playback session.
              </span>
            </div>
            <button
              className={`toggle-btn ${mpvDebandEnabled ? 'active' : ''}`}
              onClick={() => setMpvDebandEnabled((prev) => !prev)}
              aria-label="Toggle default MPV debanding"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>
            </div>
          </div>

          <div className="video-processing-group">
            <div className="video-processing-group-header">
              <span>
                <strong>Screen fit</strong>
                <small>{mpvSmartUltrawideFillMode === 'off' ? 'Black bar fill off' : mpvSmartUltrawideFillMode === 'efficient' ? 'Efficient black bar fill' : 'Dynamic black bar fill'} · {mpvBlackBarLightingEnabled ? 'lighting on' : 'lighting off'}</small>
              </span>
            </div>
            <div className="settings-advanced-grid">
          <div className="settings-field">
            <label>Smart Black Bar Fill</label>
            <select
              className="settings-select"
              value={mpvSmartUltrawideFillMode}
              onChange={(e) => setMpvSmartUltrawideFillMode(e.target.value as SmartUltrawideFillMode)}
              aria-label="Default Smart Black Bar Fill mode"
            >
              <option value="off">Off</option>
              <option value="efficient">Efficient (recommended)</option>
              <option value="dynamic">Dynamic (continuous detection)</option>
            </select>
            <span className="settings-hint">
              Detects embedded black bars and fits the active picture to your display. Efficient checks periodically; Dynamic continuously follows aspect-ratio changes and uses more processing power. Player menu changes apply to the current title.
            </span>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Black bar lighting</label>
              <span className="settings-toggle-desc">
                Independently extends colours from the active picture into unused screen space, even when Smart Black Bar Fill is off. Applies from the next playback session.
              </span>
            </div>
            <button
              className={`toggle-btn ${mpvBlackBarLightingEnabled ? 'active' : ''}`}
              onClick={() => setMpvBlackBarLightingEnabled((previous) => !previous)}
              aria-label="Toggle black bar lighting"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>
            </div>
          </div>
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'playback' ? ' is-visible' : ''}`}
        data-settings-page="playback"
        id="introdb-segment-skipping"
      >
        <h2><FiPlayCircle /> Intros, Recaps & Outros</h2>
        <p className="settings-description">
          Uses duration-matched TheIntroDB timestamps first, then verified IntroDB submissions. If both sources disagree, Streamee leaves the segment alone.
        </p>

        <div className="settings-form">
          <div className="settings-field">
            <label>Intro behavior</label>
            <select
              className="settings-select"
              value={introDbIntroMode}
              onChange={(event) => setIntroDbIntroMode(event.target.value as IntroDbSkipMode)}
            >
              <option value="always-watch">Always watch</option>
              <option value="watch-once">Watch once per series session</option>
              <option value="always-skip">Always skip</option>
            </select>
            <span className="settings-hint">
              Watch once shows the first verified intro for each series until Streamee restarts, then skips later intros.
            </span>
          </div>

          <div className="settings-field">
            <label>Recap behavior</label>
            <select
              className="settings-select"
              value={introDbRecapMode}
              onChange={(event) => setIntroDbRecapMode(event.target.value as IntroDbSkipMode)}
            >
              <option value="always-watch">Always watch</option>
              <option value="watch-once">Watch once per series session</option>
              <option value="always-skip">Always skip</option>
            </select>
            <span className="settings-hint">
              Watch once follows the same per-series session rule for verified recaps.
            </span>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Local Intro Skipper fallback</label>
              <span className="settings-toggle-desc">
                When community data is missing, use named chapters first. Otherwise fingerprint only verified local-cache bytes as playback fills the intro and outro analysis windows. Future queued episodes are never opened.
              </span>
              <span className="settings-hint">
                Plausible near-misses can ask for confirmation in the player. Two matching Yes answers enable a cancellable learned action on later episodes; cancelling or undoing pauses that pattern.
              </span>
            </div>
            <button
              className={`toggle-btn ${introSkipperEnabled ? 'active' : ''}`}
              onClick={() => setIntroSkipperEnabled((previous) => !previous)}
              aria-label="Toggle local Intro Skipper fallback"
              aria-pressed={introSkipperEnabled}
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Play next episode at outro</label>
              <span className="settings-toggle-desc">
                Advances an already queued episode first, otherwise uses Smart Next. If no next source is ready, the credits keep playing.
              </span>
              <span className="settings-hint">
                Community data: TheIntroDB and IntroDB. Local chapter, audio, and visual fallbacks remain conservative.
              </span>
            </div>
            <button
              className={`toggle-btn ${introDbAutoNextAtOutro ? 'active' : ''}`}
              onClick={() => setIntroDbAutoNextAtOutro((previous) => !previous)}
              aria-label="Toggle automatic Smart Next at outro"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-field">
            <label>Segment confirmation history</label>
            <button
              className="settings-btn"
              onClick={() => {
                if (!window.confirm('Clear locally saved Intro and Outro confirmation answers?')) return;
                window.localStorage.removeItem(SEGMENT_FEEDBACK_STORAGE_KEY);
                window.localStorage.removeItem(SEGMENT_FEEDBACK_PATTERN_STORAGE_KEY);
              }}
              type="button"
            >
              Clear Confirmation History
            </button>
            <span className="settings-hint">
              Clears Yes, No, and Not sure answers together with learned-pattern suspension state.
            </span>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Autoload Smart Next</label>
              <span className="settings-toggle-desc">
                At 70% playback, find the next aired episode and warm its opening for a faster transition.
              </span>
              <span className="settings-hint">
                Preloads at most the first 10% of the episode, capped at 1 GB. Manual Smart Next remains available when this is off.
              </span>
            </div>
            <button
              className={`toggle-btn ${smartNextAutoloadEnabled ? 'active' : ''}`}
              onClick={() => setSmartNextAutoloadEnabled((previous) => !previous)}
              aria-label="Toggle Smart Next autoload"
              aria-pressed={smartNextAutoloadEnabled}
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'playback' ? ' is-visible' : ''}`}
        data-settings-page="playback"
        id="playback-behavior"
      >
        <h2><FiPlayCircle /> Playback Behavior</h2>
        <p className="settings-description">
          Control MPV playback helpers, streaming cache behavior, and what Streamee shares while playback is active.
        </p>

        <div className="settings-form">
          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Enable MPV seekbar preview thumbnails</label>
              <span className="settings-toggle-desc">
                Generates hover previews only from video bytes already present in Streamee's local cache. Missing areas stay blank and never trigger another upstream transfer.
              </span>
            </div>
            <button
              className={`toggle-btn ${mpvSeekPreviewEnabled ? 'active' : ''}`}
              onClick={() => setMpvSeekPreviewEnabled((prev) => !prev)}
              aria-label="Toggle MPV seekbar preview thumbnails"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-advanced-grid settings-always-visible">
          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Force MPV stereo audio output</label>
              <span className="settings-toggle-desc">
                Downmixes surround tracks to stereo so headphones and earbuds do not receive a misdetected 5.1 or 7.1 layout.
              </span>
            </div>
            <button
              className={`toggle-btn ${mpvForceStereoEnabled ? 'active' : ''}`}
              onClick={() => setMpvForceStereoEnabled((prev) => !prev)}
              aria-label="Toggle MPV stereo audio output"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Cache full streamed file in MPV</label>
              <span className="settings-toggle-desc">
                Lets MPV keep reading ahead toward the end of the current streamed video and stores the cache on disk instead of stopping after about a minute.
              </span>
            </div>
            <button
              className={`toggle-btn ${mpvCacheWholeFileEnabled ? 'active' : ''}`}
              onClick={() => setMpvCacheWholeFileEnabled((prev) => !prev)}
              aria-label="Toggle full streamed file cache in MPV"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Show Discord Presence</label>
              <span className="settings-toggle-desc">
                Shares clean movie or episode titles with Discord while MPV is playing. Source filenames are not sent.
              </span>
            </div>
            <button
              className={`toggle-btn ${discordPresenceEnabled ? 'active' : ''}`}
              onClick={() => setDiscordPresenceEnabled((prev) => !prev)}
              aria-label="Toggle Discord Presence"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>
            </div>
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'integrations' ? ' is-visible' : ''}`}
        data-settings-page="integrations"
        id="rife-frame-generation"
      >
        <h2><FiCpu /> RIFE Frame Generation</h2>
        <p className="settings-description">
          GPU frame generation built into Streamee&apos;s MPV playback. No SVP required.
        </p>

        <div className="settings-form">
          <RuntimeInstallerPanel
            title="RIFE Runtime"
            description={rifeRuntimeInfo?.installed
              ? `${rifeRuntimeInfo.version} managed locally · RIFE ${mpvRifeModel}`
              : `Optional ${formatRuntimeSize(rifeRuntimeInfo?.downloadBytes || 2_811_293_455)} download · ${formatRuntimeSize(rifeRuntimeInfo?.requiredFreeBytes || 6_500_000_000)} free space required`}
            detail="Downloads are verified and resumable. Prepare an engine here to avoid compiling during playback."
            message={rifePreparationMessage || rifeInstallMessage}
            ready={rifeRuntimeInfo?.ready === true}
            installing={rifeInstallStatus === 'installing' || rifePreparationStatus === 'preparing'}
            error={rifeInstallStatus === 'error' || rifePreparationStatus === 'error'}
            progress={rifeInstallStatus === 'installing' && rifeInstallPhase === 'downloading' ? rifeInstallProgress : undefined}
            progressLabel={
              rifePreparationStatus === 'preparing'
                ? 'Preparing TensorRT engine...'
                : rifeInstallPhase === 'downloading'
                ? `Downloading · ${rifeInstallProgress}%`
                : rifeInstallPhase === 'extracting'
                  ? 'Extracting runtime...'
                  : 'Finishing installation...'
            }
            busyLabel={rifePreparationStatus === 'preparing' ? 'Preparing' : 'Installing'}
          >
              {rifeRuntimeInfo?.ready && (
                <button
                  className="settings-btn settings-btn-test"
                  onClick={rifePreparationStatus === 'preparing'
                    ? handleCancelRifePreparation
                    : handlePrepareRifeEngine}
                  disabled={rifeInstallStatus === 'installing'}
                  type="button"
                >
                  {rifePreparationStatus === 'preparing'
                    ? <><FiX /> Cancel preparation</>
                    : <><FiZap /> Prepare {RIFE_PREPARATION_PROFILE_LABELS[rifePreparationResolution]} engine</>}
                </button>
              )}
              {!rifeRuntimeInfo?.ready && (
              <button
                className="settings-btn settings-btn-test"
                onClick={handleInstallRife}
                disabled={rifeInstallStatus === 'installing' || rifePreparationStatus === 'preparing'}
                type="button"
              >
                {rifeInstallStatus === 'installing' && rifeInstallPhase === 'downloading' && `Downloading... ${rifeInstallProgress}%`}
                {rifeInstallStatus === 'installing' && rifeInstallPhase === 'extracting' && 'Extracting runtime...'}
                {rifeInstallStatus === 'installing' && rifeInstallPhase === 'complete' && <><FiCheck /> Finishing...</>}
                {rifeInstallStatus !== 'installing' && !rifeRuntimeInfo?.installed && <><FiDownload /> Install RIFE Runtime</>}
                {rifeInstallStatus !== 'installing' && rifeRuntimeInfo?.installed && !rifeRuntimeInfo.selectedModelInstalled && <><FiDownload /> Install RIFE {mpvRifeModel}</>}
              </button>
              )}
          </RuntimeInstallerPanel>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Enable Streamee RIFE</label>
              <span className="settings-toggle-desc">
                Generates intermediate frames using the selected TensorRT profile.
              </span>
            </div>
            <button
              className={`toggle-btn ${mpvRifeEnabled ? 'active' : ''}`}
              onClick={() => {
                const enabled = !mpvRifeEnabled;
                setMpvRifeEnabled(enabled);
                if (enabled) {
                  setSvpAutoStartEnabled(false);
                  setSvpAutoRestartOnPlaylistChange(false);
                  void window.electronAPI.stopSvp(svpExecutablePath).catch((error) => {
                    console.warn('[Settings][RIFE] Could not stop SVP while enabling RIFE:', error);
                  });
                }
              }}
              aria-label="Toggle Streamee RIFE frame generation"
              disabled={(!mpvRifeEnabled && !rifeRuntimeInfo?.ready) || rifeInstallStatus === 'installing' || rifePreparationStatus === 'preparing'}
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>
          {rifePlaybackStatus && (
            <div
              className={`settings-runtime-status rife-playback-status is-${rifePlaybackStatus.status}`}
              role={rifePlaybackStatus.status === 'failed' ? 'alert' : 'status'}
            >
              {rifePlaybackStatus.status === 'active' ? <FiCheck /> : rifePlaybackStatus.status === 'failed' ? <FiX /> : <FiInfo />}
              <span>{rifePlaybackStatus.message}</span>
            </div>
          )}

          <details className="settings-advanced rife-advanced-settings">
            <summary>
              <span>
                Advanced tuning
                <small>{`RIFE ${mpvRifeModel} · ${mpvRifeProcessingResolution === 'auto' ? 'Auto' : `${mpvRifeProcessingResolution}p`} · ${mpvRifeMultiplier}x · ${mpvRifeGpuStreams} streams · ${mpvRifeConcurrentFrames === 'auto' ? 'Auto queue' : `${mpvRifeConcurrentFrames} concurrent`}`}</small>
              </span>
              <FiChevronDown />
            </summary>
            <div className="settings-advanced-grid">
            <div className="settings-toggle">
              <div className="settings-toggle-info">
                <label>Run before upscaling</label>
                <span className="settings-toggle-desc">
                  Recommended for lower GPU load. With RTX VSR, turn this off to compare upscaling first.
                </span>
              </div>
              <button
                className={`toggle-btn ${mpvRifeEnabled && mpvRifeBeforeUpscaling ? 'active' : ''}`}
                onClick={() => setMpvRifeBeforeUpscaling((previous) => !previous)}
                aria-label="Toggle RIFE before upscaling"
                disabled={!mpvRifeEnabled || videoUpscaler !== 'rtx-vsr'}
                type="button"
              >
                <span className="toggle-slider" />
              </button>
            </div>

            <div className="settings-field">
              <label>Engine preparation source</label>
              <select
                className="settings-select"
                value={rifePreparationResolution}
                onChange={(event) => {
                  setRifePreparationResolution(event.target.value as RifePreparationResolution);
                  setRifePreparationStatus('idle');
                  setRifePreparationMessage(null);
                }}
                disabled={!rifeRuntimeInfo?.ready || rifePreparationStatus === 'preparing'}
              >
                <option value="2160">3840×2160 (16:9 4K)</option>
                <option value="1080">1920×1080 (16:9 Full HD)</option>
                <option value="720">1280×720 (16:9 HD)</option>
              </select>
              <span className="settings-hint">
                TensorRT engines are exact-shape profiles. Cropped cinema frames such as 3840×1600 compile their own engine on first playback. Preparation is unavailable while MPV is active.
              </span>
            </div>

            <div className="settings-field">
              <label>RIFE model</label>
              <select
                className="settings-select"
                value={mpvRifeModel}
                onChange={(event) => {
                  setRifeRuntimeInfo(null);
                  setRifePreparationStatus('idle');
                  setRifePreparationMessage(null);
                  setMpvRifeModel(event.target.value as RifeModel);
                }}
                disabled={rifeInstallStatus === 'installing' || rifePreparationStatus === 'preparing'}
              >
                <option value="4.6">4.6 (recommended for 4K half-scale)</option>
                <option value="4.9">4.9 (balanced)</option>
                <option value="4.16-lite">4.16 Lite</option>
                <option value="4.18">4.18</option>
                <option value="4.25">4.25</option>
              </select>
              <span className="settings-hint">Different models trade temporal stability, detail, and processing time. Model changes apply to the next playback.</span>
            </div>

            <div className="settings-field">
              <label>RIFE processing resolution</label>
              <select
                className="settings-select"
                value={mpvRifeProcessingResolution}
                onChange={(event) => {
                  setMpvRifeProcessingResolution(event.target.value as RifeProcessingResolution);
                  setRifePreparationStatus('idle');
                  setRifePreparationMessage(null);
                }}
                disabled={!mpvRifeEnabled || rifePreparationStatus === 'preparing'}
              >
                <option value="auto">Auto (RIFE 4.6 half-scale for 4K)</option>
                <option value="native">Native source resolution</option>
                <option value="1080">1080p analysis</option>
                <option value="720">720p analysis</option>
              </select>
              <span className="settings-hint">
                Auto keeps full-resolution frames and uses RIFE 4.6&apos;s internal half-scale motion estimation for 4K. Fixed 1080p and 720p are external comparison modes; Native performs full-scale inference.
              </span>
            </div>

            <div className="settings-field">
              <label>Frame-rate multiplier</label>
              <select
                className="settings-select"
                value={mpvRifeMultiplier}
                onChange={(event) => {
                  setMpvRifeMultiplier(Number(event.target.value) as RifeMultiplier);
                  setRifePreparationStatus('idle');
                  setRifePreparationMessage(null);
                }}
                disabled={!mpvRifeEnabled || rifePreparationStatus === 'preparing'}
              >
                <option value={2}>2x</option>
                <option value={3}>3x</option>
              </select>
              <span className="settings-hint">2x is the safer real-time starting point; 3x creates two frames between each source frame.</span>
            </div>

            <div className="settings-field">
              <label>RIFE motion-analysis scale</label>
              <select
                className="settings-select"
                value={mpvRifeScale}
                onChange={(event) => {
                  setMpvRifeScale(event.target.value as RifeScale);
                  setRifePreparationStatus('idle');
                  setRifePreparationMessage(null);
                }}
                disabled={!mpvRifeEnabled || mpvRifeModel !== '4.6' || rifePreparationStatus === 'preparing'}
              >
                <option value="auto">Auto (0.5 for 4K, 1.0 otherwise)</option>
                <option value="0.5">0.5 (recommended for 4K)</option>
                <option value="1.0">1.0 (maximum motion detail)</option>
                <optgroup label="Experimental — lower quality">
                  <option value="0.4">0.4</option>
                  <option value="0.25">0.25</option>
                  <option value="0.2">0.2</option>
                </optgroup>
              </select>
              <span className="settings-hint">
                Controls internal motion estimation while retaining full-resolution input and output frames. Sub-0.5 values are experimental: they reduce motion detail and may not reduce total GPU power. Values below 1 are supported by RIFE 4.6 only.
              </span>
            </div>

            <div className="settings-field">
              <label>TensorRT GPU streams</label>
              <select
                className="settings-select"
                value={mpvRifeGpuStreams}
                onChange={(event) => {
                  setMpvRifeGpuStreams(Number(event.target.value) as RifeGpuStreams);
                  setRifePreparationStatus('idle');
                  setRifePreparationMessage(null);
                }}
                disabled={!mpvRifeEnabled || rifePreparationStatus === 'preparing'}
              >
                <option value={1}>1 (lower VRAM)</option>
                <option value={2}>2 (higher throughput)</option>
              </select>
              <span className="settings-hint">Two streams favor throughput on high-end GPUs; use one when testing memory pressure or efficiency.</span>
            </div>

            <div className="settings-field">
              <label>Concurrent frames</label>
              <select
                className="settings-select"
                value={mpvRifeConcurrentFrames}
                onChange={(event) => setMpvRifeConcurrentFrames(
                  normalizeRifeConcurrentFrames(event.target.value),
                )}
                disabled={!mpvRifeEnabled || rifePreparationStatus === 'preparing'}
              >
                <option value="auto">Auto (recommended)</option>
                <option value="1">1 (minimum load)</option>
                <option value="2">2</option>
                <option value="4">4</option>
                <option value="6">6</option>
                <option value="8">8</option>
                <option value="12">12 (maximum throughput)</option>
              </select>
              <span className="settings-hint">
                Controls how many frames VapourSynth can process at once. Lower values may reduce VRAM and GPU activity but can cause stutter; changes apply to the next playback.
              </span>
            </div>
            {rifeRuntimeInfo?.ready && (
              <div className="settings-actions rife-runtime-maintenance">
                <button
                  className="settings-btn settings-btn-test"
                  onClick={handleInstallRife}
                  disabled={rifeInstallStatus === 'installing' || rifePreparationStatus === 'preparing'}
                  type="button"
                >
                  <FiRefreshCw /> Repair or reinstall RIFE {mpvRifeModel}
                </button>
                <button
                  className="settings-btn settings-btn-danger"
                  onClick={handleClearRifeCache}
                  disabled={rifeInstallStatus === 'installing' || rifePreparationStatus === 'preparing' || rifeCacheStatus === 'clearing'}
                  type="button"
                >
                  <FiTrash2 /> {rifeCacheStatus === 'clearing' ? 'Clearing engines...' : 'Clear compiled engines'}
                </button>
                <span className="settings-hint">
                  {rifeCacheInfo
                    ? `${rifeCacheInfo.engineCount} compiled ${rifeCacheInfo.engineCount === 1 ? 'engine' : 'engines'} · ${formatRuntimeSize(rifeCacheInfo.bytes)}`
                    : 'Compiled engine cache size unavailable'}
                  {rifeCacheMessage ? ` · ${rifeCacheMessage}` : ''}
                </span>
              </div>
            )}
            </div>
          </details>

        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'integrations' ? ' is-visible' : ''}`}
        data-settings-page="integrations"
        id="svp-integration"
      >
        <h2><FiZap /> SVP Integration</h2>
        <p className="settings-description">
          Manage SmoothVideo Project startup and cleanup when Streamee launches or changes MPV playback.
        </p>

        <div className="settings-form">
          <div className="settings-field">
            <label>SVP executable</label>
            <div className="settings-folder-input">
              <input
                type="text"
                value={svpExecutablePath}
                onChange={(e) => setSvpExecutablePath(e.target.value)}
                placeholder={DEFAULT_SVP_EXECUTABLE_PATH}
              />
              <button
                className="settings-btn-folder"
                onClick={handleSelectSvpExecutable}
                type="button"
                aria-label="Select SVP executable"
                title="Select SVP executable"
              >
                <FiFolder />
              </button>
            </div>
            <span className="settings-hint">
              Default: {DEFAULT_SVP_EXECUTABLE_PATH}
            </span>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Start SVP with MPV</label>
              <span className="settings-toggle-desc">
                {mpvRifeEnabled
                  ? 'Disabled while Streamee RIFE is enabled to prevent two interpolation systems running together.'
                  : 'Starts the selected SVP manager whenever Streamee launches MPV.'}
              </span>
            </div>
            <button
              className={`toggle-btn ${svpAutoStartEnabled ? 'active' : ''}`}
              onClick={() => setSvpAutoStartEnabled((prev) => !prev)}
              aria-label="Toggle SVP startup with MPV"
              disabled={mpvRifeEnabled}
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-advanced-grid settings-always-visible">
          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Restart SVP on playlist changes</label>
              <span className="settings-toggle-desc">
                {mpvRifeEnabled
                  ? 'Disabled while Streamee RIFE is enabled.'
                  : 'Restarts SVP after MPV moves to a different playlist item.'}
              </span>
            </div>
            <button
              className={`toggle-btn ${svpAutoRestartOnPlaylistChange ? 'active' : ''}`}
              onClick={() => setSvpAutoRestartOnPlaylistChange((prev) => !prev)}
              aria-label="Toggle SVP restart on playlist changes"
              disabled={mpvRifeEnabled}
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Close SVP when MPV closes</label>
              <span className="settings-toggle-desc">
                Stops the selected SVP manager when the current MPV session ends.
              </span>
            </div>
            <button
              className={`toggle-btn ${svpAutoCloseOnMpvClose ? 'active' : ''}`}
              onClick={() => setSvpAutoCloseOnMpvClose((prev) => !prev)}
              aria-label="Toggle closing SVP with MPV"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>
            </div>
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'streamee-addon' ? ' is-visible' : ''}`}
        data-settings-page="streamee-addon"
        id="streamee-addon"
      >
        <h2><FiPackage /> Add-on Library</h2>
        <p className="settings-description">
          Add source services from their configured manifest URLs and control the order Streamee uses them.
        </p>

        <div className="settings-form">
          <AddonSettings />
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'network-storage' ? ' is-visible' : ''}`}
        data-settings-page="network-storage"
        id="torrent-settings"
      >
        <h2><FiHardDrive /> Streaming Cache &amp; Network</h2>
        <p className="settings-description">
          Control reusable streamed data and configure the local source transport. With persistence off, every streaming cache remains disposable and is removed automatically.
        </p>

        <div className="settings-form">
          <div className="settings-toggle">
            <div className="settings-toggle-info">
              <label>Keep streamed media cache</label>
              <span className="settings-toggle-desc">
                Reuses cached remote-stream data across playback sessions. Oldest inactive titles are removed automatically when the size limit is reached.
              </span>
            </div>
            <button
              className={`toggle-btn ${streamCachePersistentEnabled ? 'active' : ''}`}
              onClick={() => setStreamCachePersistentEnabled((previous) => !previous)}
              aria-label="Toggle persistent streaming cache"
              type="button"
            >
              <span className="toggle-slider" />
            </button>
          </div>

          {streamCachePersistentEnabled && (
            <div className="settings-field">
              <label>Persistent Cache Limit (GB)</label>
              <input
                type="number"
                value={streamCachePersistentLimitGb}
                onChange={(event) => setStreamCachePersistentLimitGb(
                  Math.min(2000, Math.max(1, Number.parseInt(event.target.value, 10) || 1)),
                )}
                min="1"
                max="2000"
                step="1"
              />
              <span className="settings-hint">
                Default: 50 GB. A single stream may exceed this limit; it replaces older cached items and is kept until another cache is created.
              </span>
            </div>
          )}

          <div className="settings-field">
            <label>Listening Port</label>
            <input
              type="number"
              value={torrentPort}
              onChange={(e) => setTorrentPort(parseInt(e.target.value) || 6881)}
              placeholder="6881"
              min="1024"
              max="65535"
            />
            <span className="settings-hint">
              Local source-transport listening port (1024-65535). Restart the app for changes to take effect.
            </span>
          </div>

          <div className="settings-actions">
            <button
              className={`settings-btn settings-btn-test ${torrentPortTestStatus}`}
              onClick={handleTestTorrentPort}
              disabled={torrentPortTestStatus === 'testing'}
              type="button"
            >
              {torrentPortTestStatus === 'testing' && 'Testing Port...'}
              {torrentPortTestStatus === 'success' && <><FiCheck /> Port OK</>}
              {torrentPortTestStatus === 'error' && <><FiX /> Port Issue</>}
              {torrentPortTestStatus === 'idle' && 'Test Port'}
            </button>

            {torrentPortTestError && <span className="settings-test-error">{torrentPortTestError}</span>}
          </div>

          <div className="settings-port-test">
            <div className="settings-port-test-row">
              <span className="settings-port-test-label">Discovery</span>
              <span className={`settings-port-test-badge ${(torrentPortTestResult?.dht_enabled ?? true) ? 'ok' : 'fail'}`}>
                {(torrentPortTestResult?.dht_enabled ?? true) ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <div className="settings-port-test-row">
              <span className="settings-port-test-label">TCP Bind</span>
              <span className={`settings-port-test-badge ${torrentPortTestResult?.tcp_bind_ok ? 'ok' : 'fail'}`}>
                {torrentPortTestResult ? (torrentPortTestResult.tcp_bind_ok ? 'OK' : 'Failed') : 'Not tested'}
              </span>
            </div>
            {torrentPortTestResult?.tcp_error && (
              <span className="settings-port-test-detail">{torrentPortTestResult.tcp_error}</span>
            )}
            <div className="settings-port-test-row">
              <span className="settings-port-test-label">UDP Bind</span>
              <span className={`settings-port-test-badge ${torrentPortTestResult?.udp_bind_ok ? 'ok' : 'fail'}`}>
                {torrentPortTestResult ? (torrentPortTestResult.udp_bind_ok ? 'OK' : 'Failed') : 'Not tested'}
              </span>
            </div>
            {torrentPortTestResult?.udp_error && (
              <span className="settings-port-test-detail">{torrentPortTestResult.udp_error}</span>
            )}
            <span className="settings-hint">
              This checks whether Streamee can bind the chosen port locally. It does not confirm router port forwarding or internet reachability.
            </span>
          </div>
        </div>
      </section>

      <section
        className={`settings-section settings-section-danger${activeCategoryId === 'data-about' ? ' is-visible' : ''}`}
        data-settings-page="data-about"
        id="data-management"
      >
        <h2><FiDatabase /> Data Management</h2>
        <p className="settings-description">
          Clear local Streamee data stored on this device. These actions do not delete anything from remote Trakt servers.
        </p>

        <div className="settings-data-actions">
          <div className="settings-data-card">
            <div>
              <h3>Delete sync data only</h3>
              <p>
                Clears local watchlist, watched history, episode progress, continue watching, pending Trakt sync queues, and resume/source caches. App settings and API keys stay.
              </p>
              {clearSyncDataMessage && (
                <span className="settings-sync-message">{clearSyncDataMessage}</span>
              )}
            </div>
            <button
              className={`settings-btn settings-btn-danger ${clearSyncDataStatus}`}
              onClick={handleClearSyncData}
              disabled={clearSyncDataStatus === 'clearing'}
              type="button"
            >
              {clearSyncDataStatus === 'clearing' && 'Clearing...'}
              {clearSyncDataStatus === 'success' && <><FiCheck /> Cleared</>}
              {clearSyncDataStatus === 'error' && <><FiX /> Failed</>}
              {clearSyncDataStatus === 'idle' && <><FiTrash2 /> Delete Sync Data</>}
            </button>
          </div>

          <div className="settings-advanced-grid settings-always-visible settings-always-visible-danger">
              <div className="settings-data-card settings-data-card-critical">
                <div>
                  <h3>Delete all local data</h3>
                  <p>
                    Clears all Streamee settings, provider keys, Trakt login, sync data, watch state, playback resume data, and local Streamee cache metadata. The app reloads afterward.
                  </p>
                  {clearLocalDataMessage && (
                    <span className="settings-sync-message">{clearLocalDataMessage}</span>
                  )}
                </div>
                <button
                  className={`settings-btn settings-btn-danger ${clearLocalDataStatus}`}
                  onClick={() => void handleClearAllLocalData()}
                  disabled={clearLocalDataStatus === 'clearing'}
                  type="button"
                >
                  {clearLocalDataStatus === 'clearing' && 'Clearing...'}
                  {clearLocalDataStatus === 'success' && <><FiCheck /> Cleared</>}
                  {clearLocalDataStatus === 'error' && <><FiX /> Failed</>}
                  {clearLocalDataStatus === 'idle' && <><FiTrash2 /> Delete All Local Data</>}
                </button>
              </div>
            </div>
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'integrations' ? ' is-visible' : ''}`}
        data-settings-page="integrations"
        id="external-players"
      >
        <h2><FiPlayCircle /> External Players</h2>
        <p className="settings-description">
          Configure external players for playback. Make sure the players are installed on your system.
        </p>

        <div className="settings-list">
          <div className="settings-item">
            <div className="settings-item-info">
              <h3>VLC Media Player</h3>
              <p>Protocol: vlc://</p>
            </div>
            <span className="settings-item-status">Supported</span>
          </div>

          <div className="settings-item">
            <div className="settings-item-info">
              <h3>MPC-HC</h3>
              <p>Protocol: mpc-hc://</p>
            </div>
            <span className="settings-item-status">Supported</span>
          </div>

          <div className="settings-item">
            <div className="settings-item-info">
              <h3>MPC-BE</h3>
              <p>Protocol: mpc-be://</p>
            </div>
            <span className="settings-item-status">Supported</span>
          </div>
        </div>
      </section>

      <section
        className={`settings-section${activeCategoryId === 'data-about' ? ' is-visible' : ''}`}
        data-settings-page="data-about"
        id="about"
      >
        <h2><FiInfo /> About</h2>
        <div className="settings-data-actions">
          <div className="settings-data-card">
            <div>
              <h3>Application updates</h3>
              <p>{updaterMessage}</p>
              {showUpdaterNotes && (
                <p>{updaterNotes}</p>
              )}
            </div>
            <button
              className="settings-btn settings-btn-test"
              type="button"
              onClick={handleUpdaterAction}
              disabled={
                updaterSnapshot.status === 'checking'
                || updaterSnapshot.status === 'downloading'
                || updaterSnapshot.status === 'installing'
              }
            >
              <FiDownload /> {updaterActionLabel}
            </button>
          </div>
        </div>
        <div className="settings-about">
          <p><strong>Streamee</strong> {appVersion ? `v${appVersion}` : 'v—'}</p>
          <p>A media application powered by MPV and user-configured source providers.</p>
          <div className="settings-attribution">
            <button
              type="button"
              className="settings-attribution-logo"
              onClick={() => openExternalLink(TMDB_HOME_URL)}
              aria-label="Open The Movie Database"
            >
              <img src={new URL('../../assets/tmdb-logo.svg', import.meta.url).href} alt="TMDB" />
            </button>
            <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
          </div>
          <p>
            Streaming availability data by{' '}
            <button type="button" className="settings-inline-link" onClick={() => openExternalLink(JUSTWATCH_HOME_URL)}>
              JustWatch
            </button>.
          </p>
          <p>
            OMDb content is licensed under{' '}
            <button type="button" className="settings-inline-link" onClick={() => openExternalLink(OMDB_LICENSE_URL)}>
              CC BY-NC 4.0
            </button>.
          </p>
        </div>
        <LegalDocuments onOpenExternal={openExternalLink} />
      </section>
        </div>
      </div>
    </div>
  );
};

export default Settings;
