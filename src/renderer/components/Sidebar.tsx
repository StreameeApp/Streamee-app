import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FiBarChart2, FiChevronDown, FiChevronUp, FiHome, FiSearch, FiHeart, FiClock, FiCalendar, FiSettings, FiPlay, FiX } from 'react-icons/fi';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import type { AddonTransferProgressEvent } from '../services/tauri';
import './Sidebar.css';

interface SidebarProps {
  currentView: string;
  onNavigate: (view: 'board' | 'search' | 'watchlist' | 'settings' | 'meta' | 'player' | 'calendar' | 'history' | 'statistics' | 'audio-normalizer') => void;
}

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatSpeed = (bytesPerSec: number): string => {
  if (bytesPerSec === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatWhisperPosition = (seconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const SIDEBAR_BITFIELD_COLS = 48;
const AUDIO_GAIN_GRAPH_SAMPLES = 32;

const AudioGainMiniGraph: React.FC<{ samples: number[]; currentGainDb: number }> = ({ samples, currentGainDb }) => {
  const points = useMemo(() => {
    if (samples.length < 2) return '';
    const maxMagnitude = Math.max(6, ...samples.map((sample) => Math.abs(sample)));
    return samples.map((sample, index) => {
      const x = (index / (samples.length - 1)) * 100;
      const y = 12 - (sample / maxMagnitude) * 10;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
  }, [samples]);

  const gainLabel = `${currentGainDb >= 0 ? '+' : ''}${currentGainDb.toFixed(1)} dB`;

  return (
    <div className="audio-gain-mini" title={`Current audio gain: ${gainLabel}`}>
      <svg className="audio-gain-mini-graph" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
        <line className="audio-gain-mini-zero" x1="0" y1="12" x2="100" y2="12" />
        {points && <polyline className="audio-gain-mini-line" points={points} />}
      </svg>
      <span className="audio-gain-mini-value">{gainLabel}</span>
    </div>
  );
};

const BitfieldMini: React.FC<{ bitfield: number[]; totalPieces: number }> = ({ bitfield, totalPieces }) => {
  const segments = useMemo(() => {
    if (!bitfield.length || totalPieces <= 0) return [];
    const cols = SIDEBAR_BITFIELD_COLS;
    const result: number[] = new Array(cols).fill(0);
    const piecesPerSegment = totalPieces / cols;

    for (let seg = 0; seg < cols; seg++) {
      const start = Math.floor(seg * piecesPerSegment);
      const end = Math.floor((seg + 1) * piecesPerSegment);
      let done = 0;
      for (let i = start; i < end && i < totalPieces; i++) {
        const byteIndex = i >> 3;
        const bit = 7 - (i % 8);
        if (byteIndex < bitfield.length && ((bitfield[byteIndex] >> bit) & 1) === 1) {
          done++;
        }
      }
      result[seg] = end > start ? done / (end - start) : 0;
    }
    return result;
  }, [bitfield, totalPieces]);

  if (segments.length === 0) return null;

  return (
    <div className="bitfield-mini">
      {segments.map((fill, i) => (
        <div
          key={i}
          className="bitfield-mini-segment"
          style={{ opacity: 0.15 + fill * 0.85 }}
        />
      ))}
    </div>
  );
};

const Sidebar: React.FC<SidebarProps> = ({ currentView, onNavigate }) => {
  const [addonTransfer, setAddonTransfer] = useState<AddonTransferProgressEvent | null>(null);
  const [audioGainSamples, setAudioGainSamples] = useState<number[]>([]);
  const [currentAudioGainDb, setCurrentAudioGainDb] = useState(0);
  const [silenceGateLufs, setSilenceGateLufs] = useState<number | null>(null);
  const [adaptiveSilenceGateEnabled, setAdaptiveSilenceGateEnabled] = useState(false);
  const [subtitleAssistEnabled, setSubtitleAssistEnabled] = useState(false);
  const [silenceGateUpdating, setSilenceGateUpdating] = useState(false);
  const addonIdleTimerRef = useRef<number | null>(null);
  const lastAudioGainRenderAtRef = useRef(0);
  const {
    downloadStats,
    selectedStream,
    addonTransferSessionId,
    subtitleAssist,
    audioNormalizerReason,
    retryWhisperAction,
    retryAudioNormalizerAction,
    playlistActive,
    playlistFiles,
    playlistCurrentIndex,
    playlistTotalFiles,
    playlistEpisodeInfo,
    playerProgress,
    currentPlayingTitle,
    whisperProcessedSeconds,
    audioNormalizerConnected,
    audioNormalizerEnabled,
  } = useStore(useShallow((state) => ({
    downloadStats: state.downloadStats,
    selectedStream: state.selectedStream,
    addonTransferSessionId: state.addonTransferSessionId,
    subtitleAssist: state.subtitleAssist,
    audioNormalizerReason: state.audioNormalizerReason,
    retryWhisperAction: state.retryWhisperAction,
    retryAudioNormalizerAction: state.retryAudioNormalizerAction,
    playlistActive: state.playlistActive,
    playlistFiles: state.playlistFiles,
    playlistCurrentIndex: state.playlistCurrentIndex,
    playlistTotalFiles: state.playlistTotalFiles,
    playlistEpisodeInfo: state.playlistEpisodeInfo,
    playerProgress: state.playerProgress,
    currentPlayingTitle: state.currentPlayingTitle,
    whisperProcessedSeconds: state.whisperProcessedSeconds,
    audioNormalizerConnected: state.audioNormalizerConnected,
    audioNormalizerEnabled: state.audioNormalizerEnabled,
  })));

  const navItems = [
    { id: 'board', icon: FiHome, label: 'Board' },
    { id: 'search', icon: FiSearch, label: 'Discover' },
    { id: 'watchlist', icon: FiHeart, label: 'Watchlist' },
    { id: 'history', icon: FiClock, label: 'History' },
    { id: 'calendar', icon: FiCalendar, label: 'Calendar' },
    { id: 'statistics', icon: FiBarChart2, label: 'Statistics' },
    { id: 'settings', icon: FiSettings, label: 'Settings' }
  ];

  const isDownloading = downloadStats.status === 'downloading';
  const hasActivePlayback = !!selectedStream || playlistActive || !!currentPlayingTitle;
  const hasActivity = hasActivePlayback || isDownloading;
  const progressPercent = Math.min(Math.max(downloadStats.progress, 0), 100);
  const addonTransferPercent = addonTransfer?.total_bytes
    ? Math.min(100, (addonTransfer.covered_bytes / addonTransfer.total_bytes) * 100)
    : null;
  const showUseWhisper = hasActivePlayback && !!retryWhisperAction;
  const showAudioNormalizerRetry = audioNormalizerEnabled;
  const showWhisperStatus = !['idle', 'ready', 'generated', 'embedded', 'disabled']
    .includes(subtitleAssist.status);
  const sourceLabel = selectedStream?.sourceType === 'addon'
      ? selectedStream.torrent.addonName || 'Add-on'
      : selectedStream?.sourceType === 'qbittorrent'
        ? 'External playback service'
        : selectedStream?.sourceType === 'local'
          ? 'Local'
          : 'Remote source';
  const whisperStatusLabel = subtitleAssist.status === 'ready' || subtitleAssist.status === 'generated' || subtitleAssist.status === 'embedded'
    ? 'Ready'
    : subtitleAssist.status === 'error'
      ? 'Issue'
      : subtitleAssist.status === 'disabled'
        ? 'Off'
        : subtitleAssist.status === 'waiting'
          ? 'Waiting'
          : subtitleAssist.status === 'connecting'
            ? 'Starting'
            : subtitleAssist.status === 'pending' || subtitleAssist.status === 'extracting' || subtitleAssist.status === 'transcribing' || subtitleAssist.status === 'finalizing'
              ? 'Working'
              : 'Working';
  const whisperPulse = subtitleAssist.status === 'pending'
    || subtitleAssist.status === 'downloading'
    || subtitleAssist.status === 'waiting'
    || subtitleAssist.status === 'extracting'
    || subtitleAssist.status === 'transcribing'
    || subtitleAssist.status === 'finalizing';
  const whisperShowPosition = whisperProcessedSeconds != null
    && !['idle', 'ready', 'generated', 'embedded', 'disabled', 'error'].includes(subtitleAssist.status);
  const whisperStatusText = whisperShowPosition
    ? `Whisper ${whisperStatusLabel}(${formatWhisperPosition(whisperProcessedSeconds)})`
    : `Whisper ${whisperStatusLabel}`;
  const audioNormalizerStatusLabel = audioNormalizerReason === 'no_data'
    ? 'Off'
    : audioNormalizerReason === 'manual_mode'
      ? 'Manual'
      : audioNormalizerReason === 'gated'
        ? 'Gated'
        : audioNormalizerReason === 'peak_limited'
          ? 'Limited'
          : 'Working';
  const audioNormalizerStatusText = audioNormalizerReason === 'no_data'
    ? 'Audio Normalizer Off'
    : `Audio Normalizer ${audioNormalizerStatusLabel}`;

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    void window.electronAPI.addonEvents.onTransferProgress((progress) => {
      if (
        !active
        || useStore.getState().selectedStream?.sourceType !== 'addon'
        || progress.session_id !== useStore.getState().addonTransferSessionId
        || !Number.isFinite(progress.downloaded_bytes)
      ) return;
      setAddonTransfer((current) =>
        current?.session_id === progress.session_id && current.sequence >= progress.sequence
          ? current
          : progress
      );
      if (addonIdleTimerRef.current != null) {
        window.clearTimeout(addonIdleTimerRef.current);
      }
      addonIdleTimerRef.current = window.setTimeout(() => {
        setAddonTransfer((current) => current
          ? { ...current, bytes_per_second: 0 }
          : null);
        addonIdleTimerRef.current = null;
      }, 1800);
    }).then((removeListener) => {
      if (active) {
        unlisten = removeListener;
      } else {
        removeListener();
      }
    }).catch((error) => {
      console.error('[Sidebar] Failed to listen for Addon transfer progress:', error);
    });

    return () => {
      active = false;
      unlisten?.();
      if (addonIdleTimerRef.current != null) {
        window.clearTimeout(addonIdleTimerRef.current);
        addonIdleTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setAddonTransfer(null);
    if (addonIdleTimerRef.current != null) {
      window.clearTimeout(addonIdleTimerRef.current);
      addonIdleTimerRef.current = null;
    }
  }, [addonTransferSessionId]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    void window.electronAPI.audioNormalizer.getConfig().then((config) => {
      if (active) {
        setSilenceGateLufs(config.gate_threshold_lufs);
        setAdaptiveSilenceGateEnabled(config.adaptive_gate_enabled);
        setSubtitleAssistEnabled(config.subtitle_assist_enabled);
      }
    }).catch((error) => {
      console.error('[Sidebar] Failed to load Silence Gate config:', error);
    });

    void window.electronAPI.audioNormalizer.onTelemetry((telemetry) => {
      if (!active || !Number.isFinite(telemetry.current_gain_db)) return;
      const now = performance.now();
      if (now - lastAudioGainRenderAtRef.current < 500) return;
      lastAudioGainRenderAtRef.current = now;
      setCurrentAudioGainDb(telemetry.current_gain_db);
      setAudioGainSamples((samples) => [
        ...samples.slice(-(AUDIO_GAIN_GRAPH_SAMPLES - 1)),
        telemetry.current_gain_db,
      ]);
    }).then((removeListener) => {
      if (active) unlisten = removeListener;
      else removeListener();
    }).catch((error) => {
      console.error('[Sidebar] Failed to listen for audio gain telemetry:', error);
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const adjustSilenceGate = async (delta: number) => {
    if (silenceGateUpdating) return;
    setSilenceGateUpdating(true);
    try {
      const config = await window.electronAPI.audioNormalizer.getConfig();
      const gateThreshold = Math.min(0, Math.max(-90, config.gate_threshold_lufs + delta));
      await window.electronAPI.audioNormalizer.saveCustomPreset({
        ...config,
        gate_threshold_lufs: gateThreshold,
      });
      useStore.getState().setAudioNormalizerPreset('custom');
      setSilenceGateLufs(gateThreshold);
    } catch (error) {
      console.error('[Sidebar] Failed to adjust Silence Gate:', error);
    } finally {
      setSilenceGateUpdating(false);
    }
  };

  const toggleAdaptiveSilenceGate = async () => {
    if (silenceGateUpdating) return;
    setSilenceGateUpdating(true);
    try {
      const config = await window.electronAPI.audioNormalizer.getConfig();
      const adaptiveEnabled = !config.adaptive_gate_enabled;
      await window.electronAPI.audioNormalizer.saveCustomPreset({
        ...config,
        adaptive_gate_enabled: adaptiveEnabled,
      });
      useStore.getState().setAudioNormalizerPreset('custom');
      setAdaptiveSilenceGateEnabled(adaptiveEnabled);
    } catch (error) {
      console.error('[Sidebar] Failed to toggle adaptive Silence Gate:', error);
    } finally {
      setSilenceGateUpdating(false);
    }
  };

  const toggleSubtitleAssist = async () => {
    if (silenceGateUpdating) return;
    setSilenceGateUpdating(true);
    try {
      const config = await window.electronAPI.audioNormalizer.getConfig();
      const subtitleAssistEnabled = !config.subtitle_assist_enabled;
      await window.electronAPI.audioNormalizer.saveCustomPreset({
        ...config,
        subtitle_assist_enabled: subtitleAssistEnabled,
      });
      useStore.getState().setAudioNormalizerPreset('custom');
      setSubtitleAssistEnabled(subtitleAssistEnabled);
    } catch (error) {
      console.error('[Sidebar] Failed to toggle Subtitle Assist:', error);
    } finally {
      setSilenceGateUpdating(false);
    }
  };

  const handleForceStop = async () => {
    const store = useStore.getState();
    const stopTasks = [
      window.electronAPI.player.stop(),
      window.electronAPI.torrent.remove(),
      window.electronAPI.subtitles.stopServer(),
      window.electronAPI.audioNormalizer.stopAudioNormalizerRuntime(),
    ];

    await Promise.allSettled(stopTasks);

    store.setRetryWhisperAction(null);
    store.setRetryAudioNormalizerAction(null);
    store.setSelectedStream(null);
    store.setAudioNormalizerActive(false);
    store.setAudioNormalizerConnected(false);
    store.setAudioNormalizerReason('no_data');
    store.resetDownloadStats();
    store.clearSubtitleAssist();
  };

  const handleNavigate = async (view: 'board' | 'search' | 'watchlist' | 'settings' | 'meta' | 'player' | 'calendar' | 'history' | 'statistics' | 'audio-normalizer') => {
    if (currentView === 'player' && view !== 'player') {
      await handleForceStop();
    }

    onNavigate(view);
  };

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <div className="sidebar-logo">
            <div className="sidebar-logo-mark" aria-hidden="true">
              <span className="sidebar-logo-frame" />
              <span className="sidebar-logo-play" />
            </div>
          </div>
          <div className="sidebar-brand-copy">
            <span className="sidebar-title">Streamee</span>
          </div>
        </div>
      </div>
      
      <div className="sidebar-nav">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isCurrentActive = currentView === item.id;
          return (
            <button
              key={item.id}
              className={`sidebar-item ${isCurrentActive ? 'active' : ''}`}
              onClick={() => { void handleNavigate(item.id as 'board' | 'search' | 'watchlist' | 'history' | 'calendar' | 'statistics' | 'audio-normalizer' | 'settings'); }}
            >
              <div className="sidebar-item-icon">
                <Icon />
              </div>
              <span className="sidebar-item-label">{item.label}</span>
              {isCurrentActive && <div className="sidebar-item-indicator" />}
            </button>
          );
        })}
      </div>
      
      <div className={`sidebar-activity ${hasActivity ? 'active' : 'idle'}`}>
        <div className="activity-header">
          <div className="playlist-header">
            {hasActivity ? <FiPlay className="playlist-icon" /> : <span className="status-dot" />}
            <span className="playlist-title">{hasActivity ? 'Now Playing' : 'Standby'}</span>
          </div>
          {hasActivity && <span className="activity-source">{sourceLabel}</span>}
        </div>

        {hasActivity ? (
          <>
            {playlistActive && playlistEpisodeInfo && (
              <div className="playlist-episode">
                S{playlistEpisodeInfo.season.toString().padStart(2, '0')}E{playlistEpisodeInfo.episode.toString().padStart(2, '0')}
              </div>
            )}

            <div
              className="playlist-current-file"
              title={playlistEpisodeInfo?.title || currentPlayingTitle || downloadStats.torrentName || ''}
            >
              {playlistEpisodeInfo?.title || currentPlayingTitle || downloadStats.torrentName || 'Preparing playback…'}
            </div>

            <div className="activity-metrics">
              <span>
                {Math.round(playerProgress)}% played
                {playlistActive && playlistTotalFiles > 0
                  ? ` • ${playlistCurrentIndex + 1} of ${playlistTotalFiles}`
                  : ''}
              </span>
              <span className="activity-throughput">
                {selectedStream?.sourceType === 'addon'
                    ? addonTransfer?.bytes_per_second
                      ? formatSpeed(addonTransfer.bytes_per_second)
                      : 'Remote stream'
                  : isDownloading
                    ? formatSpeed(downloadStats.downloadSpeed)
                    : sourceLabel}
              </span>
            </div>

            <div className="playlist-bar activity-playback-bar">
              <div
                className="playlist-bar-fill"
                style={{ width: `${Math.min(Math.max(playerProgress, 0), 100)}%` }}
              />
            </div>

            {selectedStream?.sourceType === 'addon' && addonTransfer ? (
              <div className="activity-transfer-detail">
                <span>
                  {formatSize(addonTransfer.downloaded_bytes)} transferred
                  {addonTransfer.total_bytes && addonTransferPercent != null
                    ? ` • ${Math.round(addonTransferPercent)}% covered of ${formatSize(addonTransfer.total_bytes)}`
                    : ''}
                </span>
              </div>
            ) : isDownloading && (
              <div className="activity-transfer-detail">
                {downloadStats.bitfield.length > 0 && downloadStats.pieces.total > 0 && (
                  <BitfieldMini bitfield={downloadStats.bitfield} totalPieces={downloadStats.pieces.total} />
                )}
                <span>
                  {Math.round(progressPercent)}% cached • {formatSize(downloadStats.downloaded)} of {formatSize(downloadStats.total)}
                  {' • '}{downloadStats.peers.connected} connections
                </span>
              </div>
            )}

            {playlistActive && playlistCurrentIndex < playlistTotalFiles - 1 && (
              <div className="playlist-up-next" title={playlistFiles[playlistCurrentIndex + 1]?.name}>
                Up Next: {playlistFiles[playlistCurrentIndex + 1]?.name}
              </div>
            )}
          </>
        ) : (
          <div className="activity-idle-copy">No active playback</div>
        )}
        
        {showWhisperStatus && (
          <div className="sidebar-subtitle-status">
            <div className="sidebar-subtitle-status-row">
              <span
                className={`status-dot ${whisperPulse ? 'pulse' : ''}`}
              />
              <span className="sidebar-subtitle-status-inline">{whisperStatusText}</span>
            </div>
          </div>
        )}

        {audioNormalizerReason !== 'no_data' && (
          <div className="sidebar-subtitle-status">
            <div className="sidebar-subtitle-status-row">
              <span className="status-dot" />
              <span className="sidebar-subtitle-status-inline">
                {audioNormalizerConnected
                  ? audioNormalizerStatusText
                  : 'Audio Normalizer Disconnected'}
              </span>
            </div>
            {audioNormalizerConnected && audioGainSamples.length > 0 && (
              <AudioGainMiniGraph samples={audioGainSamples} currentGainDb={currentAudioGainDb} />
            )}
            {audioNormalizerConnected && silenceGateLufs != null && (
              <div className="silence-gate-mini">
                <span className="silence-gate-mini-label">Silence Gate</span>
                {!adaptiveSilenceGateEnabled && (
                  <span className="silence-gate-mini-value">{silenceGateLufs.toFixed(0)} LUFS</span>
                )}
                <div className="silence-gate-mini-controls">
                  <button
                    type="button"
                    className={`silence-gate-mini-adaptive ${adaptiveSilenceGateEnabled ? 'active' : ''}`}
                    onClick={() => { void toggleAdaptiveSilenceGate(); }}
                    disabled={silenceGateUpdating}
                    title={`Adaptive Silence Gate: ${adaptiveSilenceGateEnabled ? 'On' : 'Off'}`}
                    aria-label={`${adaptiveSilenceGateEnabled ? 'Disable' : 'Enable'} adaptive Silence Gate`}
                    aria-pressed={adaptiveSilenceGateEnabled}
                  >
                    A
                  </button>
                  {adaptiveSilenceGateEnabled ? (
                    <button
                      type="button"
                      className={`silence-gate-mini-subtitle-assist ${subtitleAssistEnabled ? 'active' : ''}`}
                      onClick={() => { void toggleSubtitleAssist(); }}
                      disabled={silenceGateUpdating}
                      title={`Subtitle Assist: ${subtitleAssistEnabled ? 'On' : 'Off'}`}
                      aria-label={`${subtitleAssistEnabled ? 'Disable' : 'Enable'} Subtitle Assist`}
                      aria-pressed={subtitleAssistEnabled}
                    >
                      Sub Assist
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => { void adjustSilenceGate(1); }}
                        disabled={silenceGateUpdating || silenceGateLufs >= 0}
                        title="Raise Silence Gate by 1 LUFS (more gating)"
                        aria-label="Raise Silence Gate by 1 LUFS"
                      >
                        <FiChevronUp />
                      </button>
                      <button
                        type="button"
                        onClick={() => { void adjustSilenceGate(-1); }}
                        disabled={silenceGateUpdating || silenceGateLufs <= -90}
                        title="Lower Silence Gate by 1 LUFS (less gating)"
                        aria-label="Lower Silence Gate by 1 LUFS"
                      >
                        <FiChevronDown />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {hasActivity && <div className="sidebar-action-row">
          {showUseWhisper && (
            <button
              className="download-action-btn download-action-btn-secondary"
              onClick={async () => {
                if (!retryWhisperAction) return;
                try {
                  await retryWhisperAction();
                } catch (error) {
                  console.error('[Whisper] Force-use request failed:', error);
                }
              }}
              title="Replace current subtitles with live Whisper subtitles"
              type="button"
            >
              <span>Use Whisper</span>
            </button>
          )}

          {showAudioNormalizerRetry && (
            <button
              className="download-action-btn download-action-btn-secondary"
              onClick={async () => {
                if (!retryAudioNormalizerAction) return;
                try {
                  await retryAudioNormalizerAction();
                } catch (error) {
                  console.error('[Normalizer] Manual retry failed:', error);
                }
              }}
              title="Retry Audio Normalizer"
              type="button"
              disabled={!retryAudioNormalizerAction}
            >
              <span>Retry Normalizer</span>
            </button>
          )}

          <button
            className="download-action-btn download-stop-btn"
            onClick={() => { void handleForceStop(); }}
            title="Stop playback"
            type="button"
          >
            <FiX size={14} />
            <span>Stop</span>
          </button>
        </div>}
      </div>
    </nav>
  );
};

export default Sidebar;
