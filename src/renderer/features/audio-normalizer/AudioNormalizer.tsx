import React, { startTransition, useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import {
  AudioNormalizerConfig,
  AudioNormalizerDebugInfo,
  AudioNormalizerState,
  NormalizerEventLog,
  NormalizerTelemetry,
} from '../../services/tauri';
import { useStore } from '../../store';
import './AudioNormalizer.css';

const GRAPH_WINDOW_SECONDS = 60;
const MAX_GRAPH_SAMPLES = 3000;
const ADAPTIVE_GATE_MIN_RANGE_LU = 9;
const DEFAULT_CONFIG: AudioNormalizerConfig = {
  enabled: false,
  slow_enabled: true,
  fast_enabled: false,
  transient_enabled: false,
  peak_ceiling_enabled: false,
  limiter_enabled: true,
  target_lufs: -16,
  max_gain_db: 30,
  max_cut_db: -60,
  attack_ms: 200,
  release_ms: 1500,
  slow_control_mode: 'short_term',
  response_mode: 'db_per_sec',
  attack_db_per_sec: 6,
  release_db_per_sec: 6,
  transient_threshold_lu: 4,
  max_transient_cut_db: 12,
  fast_threshold_lu: 3,
  fast_max_cut_db: 10,
  fast_attack_ms: 80,
  fast_release_ms: 350,
  fast_detector_mode: 'true_peak',
  fast_true_peak_threshold_db: -8,
  peak_ceiling_threshold_db: -1,
  limiter_limit_db: -5,
  limiter_attack_ms: 0.1,
  limiter_release_ms: 1000,
  adaptive_gate_enabled: false,
  adaptive_gate_mode: 'direct',
  adaptive_max_gain_enabled: false,
  adaptive_max_gain_limit_db: 40,
  subtitle_assist_enabled: false,
  gate_detector_mode: 'short_term',
  gate_observation_window_secs: 60,
  gate_threshold_lufs: -40,
  hold_ms: 100,
  refresh_interval_ms: 200,
};

type FormField = keyof AudioNormalizerConfig;
type ResponseMode = AudioNormalizerConfig['response_mode'];
type SlowControlMode = AudioNormalizerConfig['slow_control_mode'];
type AdaptiveGateMode = AudioNormalizerConfig['adaptive_gate_mode'];
type GateDetectorMode = AudioNormalizerConfig['gate_detector_mode'];
type GraphBuffers = {
  times: number[];
  momentary: number[];
  shortTerm: number[];
  target: number[];
  slowGain: number[];
  fastGain: number[];
  currentGain: number[];
  desiredGain: number[];
  gated: boolean[];
};
type GateTimelineSegment = {
  gated: boolean;
  leftPercent: number;
  widthPercent: number;
};

const PRESET_OPTIONS = [
  { value: 'light', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'High' },
  { value: 'custom', label: 'Custom' },
] as const;

const LIMITER_MIN_DB = -24.1;
const DEBUG_INFO_REFRESH_MS = 2000;

const GATE_PARAMETER_FIELDS: Array<{ key: 'gate_threshold_lufs' | 'hold_ms' | 'gate_observation_window_secs'; label: string; step: number; unit: string; min?: number; max?: number }> = [
  { key: 'gate_threshold_lufs', label: 'Ambient Reference', step: 1, unit: 'LUFS' },
  { key: 'hold_ms', label: 'Close Hold', step: 50, unit: 'ms' },
  { key: 'gate_observation_window_secs', label: 'Observed Window', step: 5, unit: 'sec', min: 5, max: 300 },
];

const ADAPTIVE_GAIN_PARAMETER_FIELDS: Array<{ key: 'adaptive_max_gain_limit_db'; label: string; step: number; unit: string; min?: number; max: number }> = [
  { key: 'adaptive_max_gain_limit_db', label: 'Adaptive Hard Max', step: 0.5, unit: 'dB', max: 48 },
];

const TRANSIENT_PARAMETER_FIELDS: Array<{ key: 'transient_threshold_lu' | 'max_transient_cut_db' | 'peak_ceiling_threshold_db'; label: string; step: number; unit: string; min?: number; max?: number }> = [
  { key: 'transient_threshold_lu', label: 'Transient Threshold', step: 0.5, unit: 'LU' },
  { key: 'max_transient_cut_db', label: 'Max Transient Cut', step: 0.5, unit: 'dB' },
  { key: 'peak_ceiling_threshold_db', label: 'Peak Ceiling Threshold', step: 0.5, unit: 'dBTP' },
];

const LIMITER_PARAMETER_FIELDS: Array<{ key: 'limiter_limit_db' | 'limiter_attack_ms' | 'limiter_release_ms'; label: string; step: number; unit: string; min?: number; max?: number }> = [
  { key: 'limiter_limit_db', label: 'Limiter Threshold', step: 0.5, unit: 'dBTP', min: LIMITER_MIN_DB, max: 0 },
  { key: 'limiter_attack_ms', label: 'Limiter Attack', step: 0.5, unit: 'ms' },
  { key: 'limiter_release_ms', label: 'Limiter Release', step: 5, unit: 'ms' },
];

const ENGINE_PARAMETER_FIELDS: Array<{ key: 'refresh_interval_ms'; label: string; step: number; unit: string; min?: number; max?: number }> = [
  { key: 'refresh_interval_ms', label: 'Refresh Rate', step: 25, unit: 'ms' },
];

const SLOW_PARAMETER_FIELDS: Array<{ key: 'target_lufs' | 'max_gain_db' | 'max_cut_db'; label: string; step: number; unit: string; min?: number; max?: number }> = [
  { key: 'target_lufs', label: 'Target Loudness', step: 0.5, unit: 'LUFS' },
  { key: 'max_gain_db', label: 'Max Boost', step: 0.5, unit: 'dB' },
  { key: 'max_cut_db', label: 'Max Cut', step: 0.5, unit: 'dB' },
];

const FAST_PARAMETER_FIELDS: Array<{ key: 'fast_threshold_lu' | 'fast_true_peak_threshold_db' | 'fast_max_cut_db' | 'fast_attack_ms' | 'fast_release_ms'; label: string; step: number; unit: string; min?: number; max?: number }> = [
  { key: 'fast_threshold_lu', label: 'Fast Threshold', step: 0.5, unit: 'LU' },
  { key: 'fast_true_peak_threshold_db', label: 'Peak Threshold', step: 0.5, unit: 'dBTP' },
  { key: 'fast_max_cut_db', label: 'Fast Max Cut', step: 0.5, unit: 'dB' },
  { key: 'fast_attack_ms', label: 'Fast Attack', step: 10, unit: 'ms' },
  { key: 'fast_release_ms', label: 'Fast Release', step: 25, unit: 'ms' },
];

const TIME_RESPONSE_FIELDS: Array<{ key: 'attack_ms' | 'release_ms'; label: string; step: number; unit: string; min?: number; max?: number }> = [
  { key: 'attack_ms', label: 'Attack', step: 25, unit: 'ms' },
  { key: 'release_ms', label: 'Release', step: 50, unit: 'ms' },
];

const DB_PER_SEC_FIELDS: Array<{ key: 'attack_db_per_sec' | 'release_db_per_sec'; label: string; step: number; unit: string; min?: number; max?: number }> = [
  { key: 'attack_db_per_sec', label: 'Attack Rate', step: 0.5, unit: 'dB/sec' },
  { key: 'release_db_per_sec', label: 'Release Rate', step: 0.5, unit: 'dB/sec' },
];

function createEmptyBuffers(): GraphBuffers {
  return {
    times: [],
    momentary: [],
    shortTerm: [],
    target: [],
    slowGain: [],
    fastGain: [],
    currentGain: [],
    desiredGain: [],
    gated: [],
  };
}

function pushGraphSample(buffers: GraphBuffers, telemetry: NormalizerTelemetry, targetLufs: number) {
  const timeSec = telemetry.timestamp_ms / 1000;
  buffers.times.push(timeSec);
  buffers.momentary.push(telemetry.momentary_lufs);
  buffers.shortTerm.push(telemetry.short_term_lufs);
  buffers.target.push(targetLufs);
  buffers.slowGain.push(telemetry.slow_gain_db);
  buffers.fastGain.push(telemetry.fast_gain_db);
  buffers.currentGain.push(telemetry.current_gain_db);
  buffers.desiredGain.push(telemetry.desired_gain_db);
  buffers.gated.push(telemetry.is_gated);

  const oldestAllowedTime = timeSec - GRAPH_WINDOW_SECONDS;
  while (
    buffers.times.length > 1
    && (buffers.times[0] < oldestAllowedTime || buffers.times.length > MAX_GRAPH_SAMPLES)
  ) {
    buffers.times.shift();
    buffers.momentary.shift();
    buffers.shortTerm.shift();
    buffers.target.shift();
    buffers.slowGain.shift();
    buffers.fastGain.shift();
    buffers.currentGain.shift();
    buffers.desiredGain.shift();
    buffers.gated.shift();
  }
}

function buildGateTimelineSegments(times: number[], gateStates: boolean[]): GateTimelineSegment[] {
  if (times.length === 0 || times.length !== gateStates.length) {
    return [];
  }

  const latestTime = times[times.length - 1];
  const windowStart = Math.max(0, latestTime - GRAPH_WINDOW_SECONDS);
  const windowDuration = Math.max(1, latestTime - windowStart);
  const firstVisibleIndex = Math.max(0, times.findIndex((time) => time >= windowStart));
  const segments: GateTimelineSegment[] = [];
  let segmentStart = Math.max(windowStart, times[firstVisibleIndex]);
  let segmentState = gateStates[firstVisibleIndex];

  const appendSegment = (start: number, end: number, gated: boolean) => {
    if (end <= start) {
      return;
    }

    segments.push({
      gated,
      leftPercent: ((start - windowStart) / windowDuration) * 100,
      widthPercent: ((end - start) / windowDuration) * 100,
    });
  };

  for (let index = firstVisibleIndex + 1; index < times.length; index += 1) {
    if (gateStates[index] === segmentState) {
      continue;
    }

    const transitionTime = Math.min(
      latestTime,
      Math.max(segmentStart, (times[index - 1] + times[index]) / 2),
    );
    appendSegment(segmentStart, transitionTime, segmentState);
    segmentStart = transitionTime;
    segmentState = gateStates[index];
  }

  appendSegment(segmentStart, latestTime, segmentState);
  return segments;
}

function syncChartXScale(chart: uPlot, times: number[]) {
  if (times.length === 0) {
    return;
  }

  const max = times[times.length - 1];
  const min = Math.max(0, max - GRAPH_WINDOW_SECONDS);
  chart.setScale('x', { min, max: Math.max(max, min + 1) });
}

function updateCharts(
  buffers: GraphBuffers,
  loudnessChart: uPlot | null,
  gainChart: uPlot | null,
) {
  if (loudnessChart) {
    loudnessChart.setData([
      buffers.times,
      buffers.momentary,
      buffers.shortTerm,
      buffers.target,
    ]);
    syncChartXScale(loudnessChart, buffers.times);
  }

  if (gainChart) {
    gainChart.setData([
      buffers.times,
      buffers.slowGain,
      buffers.fastGain,
      buffers.currentGain,
      buffers.desiredGain,
    ]);
    syncChartXScale(gainChart, buffers.times);
  }
}

function createLoudnessChart(container: HTMLDivElement): uPlot {
  return new uPlot(
    {
      width: container.clientWidth || 640,
      height: 240,
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      scales: {
        x: { time: false },
        y: { auto: false, range: [-100, 0] },
      },
      axes: [
        {
          stroke: 'rgba(255,255,255,0.18)',
          grid: { stroke: 'rgba(255,255,255,0.06)' },
          values: (chart, values) => {
            const latest = chart.data[0].at(-1) ?? 0;
            return values.map((value) => `${Math.round(value - latest)}s`);
          },
        },
        {
          stroke: 'rgba(255,255,255,0.18)',
          grid: { stroke: 'rgba(255,255,255,0.06)' },
          values: (_u, values) => values.map((value) => `${Math.round(value)}`),
        },
      ],
      series: [
        {},
        { label: 'Momentary', stroke: '#7dd3fc', width: 2 },
        { label: 'Short-term', stroke: '#ff6b35', width: 2 },
        { label: 'Target', stroke: '#ffd166', width: 1, dash: [6, 4] },
      ],
    },
    [[], [], [], []],
    container,
  );
}

function createGainChart(container: HTMLDivElement): uPlot {
  return new uPlot(
    {
      width: container.clientWidth || 640,
      height: 220,
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      scales: {
        x: { time: false },
        y: { auto: false, range: [-40, 40] },
      },
      axes: [
        {
          stroke: 'rgba(255,255,255,0.18)',
          grid: { stroke: 'rgba(255,255,255,0.06)' },
          values: (chart, values) => {
            const latest = chart.data[0].at(-1) ?? 0;
            return values.map((value) => `${Math.round(value - latest)}s`);
          },
        },
        {
          stroke: 'rgba(255,255,255,0.18)',
          grid: { stroke: 'rgba(255,255,255,0.06)' },
          values: (_u, values) => values.map((value) => `${value.toFixed(0)} dB`),
        },
      ],
      series: [
        {},
        { label: 'Slow Gain', stroke: '#60a5fa', width: 1.6 },
        { label: 'Fast Gain', stroke: '#f97316', width: 1.6 },
        { label: 'Applied Gain', stroke: '#4ade80', width: 2.1 },
        { label: 'Desired Gain', stroke: '#fb7185', width: 1.4, dash: [4, 4] },
      ],
    },
    [[], [], [], [], []],
    container,
  );
}

function formatSigned(value: number, digits = 1) {
  if (!Number.isFinite(value)) {
    return '--';
  }
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

function formatPlain(value: number, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function formatLogTime(timestampMs: number) {
  if (timestampMs > 86_400_000) {
    return new Date(timestampMs).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  const totalSeconds = Math.max(0, Math.floor(timestampMs / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function appendLogEntry(entry: NormalizerEventLog, setLogs: React.Dispatch<React.SetStateAction<NormalizerEventLog[]>>) {
  startTransition(() => {
    setLogs((current) => [...current, entry].slice(-100));
  });
}

function toTelemetry(state: AudioNormalizerState): NormalizerTelemetry {
  return {
    ...state,
    timestamp_ms: 0,
    reason: state.paused ? 'paused' : state.manual_mode ? 'manual_mode' : state.is_gated ? 'gated' : 'steady',
  };
}

function ChartLegend({
  items,
}: {
  items: Array<{ label: string; tone: 'blue' | 'accent' | 'amber' | 'green' | 'red' }>;
}) {
  return (
    <div className="an-legend">
      {items.map((item) => (
        <span className="an-legend-item" key={item.label}>
          <span className={`an-legend-swatch ${item.tone}`} />
          <span>{item.label}</span>
        </span>
      ))}
    </div>
  );
}

function clampToPercent(value: number, min: number, max: number) {
  const bounded = Math.min(Math.max(value, min), max);
  return ((bounded - min) / (max - min)) * 100;
}

function formatGatePhase(phase: AudioNormalizerState['gate_phase']) {
  return phase.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatGateModelState(state: AudioNormalizerState['gate_model_state']) {
  return state.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatAdaptiveGainState(state: string) {
  return state.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const AudioNormalizer: React.FC = () => {
  const {
    audioNormalizerPreset,
    setAudioNormalizerEnabled,
    setAudioNormalizerPreset,
    setAudioNormalizerActive,
    setAudioNormalizerReason,
  } = useStore();
  const [config, setConfig] = useState<AudioNormalizerConfig>(DEFAULT_CONFIG);
  const [formConfig, setFormConfig] = useState<AudioNormalizerConfig>(DEFAULT_CONFIG);
  const [telemetry, setTelemetry] = useState<NormalizerTelemetry>(toTelemetry({
    current_gain_db: 0,
    momentary_lufs: -70,
    short_term_lufs: -70,
    integrated_lufs: -70,
    true_peak_db: -70,
    true_peak_source: 'unknown',
    limiter_input_peak_db: -70,
    limiter_input_peak_source: 'unknown',
    output_peak_db: -70,
    output_peak_source: 'unknown',
    limiter_reduction_db: 0,
    smoothed_lufs: -70,
    desired_gain_db: 0,
    slow_gain_db: 0,
    fast_gain_db: 0,
    transient_cut_db: 0,
    effective_max_gain_db: 30,
    adaptive_gain_extra_db: 0,
    adaptive_gain_state: 'disabled',
    gate_signal_lufs: -70,
    gate_threshold_lufs: -40,
    gate_normalization_offset_db: 0,
    gate_ambient_floor_lufs: -70,
    gate_foreground_lufs: -70,
    gate_open_threshold_lufs: -40,
    gate_close_threshold_lufs: -40,
    gate_observed_range_lu: 0,
    gate_observed_secs: 0,
    gate_observation_window_secs: 60,
    gate_confidence: 0,
    gate_detector_ready: false,
    gate_model_state: 'fixed',
    gate_model_age_secs: 0,
    gate_phase: 'open',
    adaptive_gate_enabled: false,
    adaptive_gate_mode: 'direct',
    subtitle_assist_enabled: false,
    subtitle_assist_active: false,
    gate_detector_mode: 'short_term',
    gate_acquiring: false,
    is_gated: false,
    connected: false,
    paused: false,
    manual_mode: false,
  }));
  const [logs, setLogs] = useState<NormalizerEventLog[]>([]);
  const [graphsFrozen, setGraphsFrozen] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [debugInfo, setDebugInfo] = useState<AudioNormalizerDebugInfo | null>(null);
  const [tuningOpen, setTuningOpen] = useState(true);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const loudnessContainerRef = useRef<HTMLDivElement | null>(null);
  const gainContainerRef = useRef<HTMLDivElement | null>(null);
  const loudnessChartRef = useRef<uPlot | null>(null);
  const gainChartRef = useRef<uPlot | null>(null);
  const buffersRef = useRef<GraphBuffers>(createEmptyBuffers());
  const frozenRef = useRef(graphsFrozen);
  const targetLufsRef = useRef(config.target_lufs);

  useEffect(() => {
    frozenRef.current = graphsFrozen;
  }, [graphsFrozen]);

  useEffect(() => {
    targetLufsRef.current = config.target_lufs;
  }, [config.target_lufs]);

  useEffect(() => {
    if (loudnessContainerRef.current && !loudnessChartRef.current) {
      loudnessChartRef.current = createLoudnessChart(loudnessContainerRef.current);
    }

    if (gainContainerRef.current && !gainChartRef.current) {
      gainChartRef.current = createGainChart(gainContainerRef.current);
    }

    const handleResize = () => {
      if (loudnessChartRef.current && loudnessContainerRef.current) {
        loudnessChartRef.current.setSize({
          width: loudnessContainerRef.current.clientWidth || 640,
          height: 240,
        });
      }
      if (gainChartRef.current && gainContainerRef.current) {
        gainChartRef.current.setSize({
          width: gainContainerRef.current.clientWidth || 640,
          height: 220,
        });
      }
      updateCharts(buffersRef.current, loudnessChartRef.current, gainChartRef.current);
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    return () => {
      window.removeEventListener('resize', handleResize);
      loudnessChartRef.current?.destroy();
      gainChartRef.current?.destroy();
      loudnessChartRef.current = null;
      gainChartRef.current = null;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlistenTelemetry: (() => void) | null = null;
    let unlistenLog: (() => void) | null = null;

    const load = async () => {
      try {
        const [loadedConfig, loadedState, loadedDebug] = await Promise.all([
          window.electronAPI.audioNormalizer.getConfig(),
          window.electronAPI.audioNormalizer.getState(),
          window.electronAPI.audioNormalizer.getDebugInfo().catch(() => null),
        ]);

        if (disposed) {
          return;
        }

        setConfig(loadedConfig);
        setFormConfig(loadedConfig);
        setAudioNormalizerEnabled(loadedConfig.enabled);
        setDebugInfo(loadedDebug);
        startTransition(() => {
          setTelemetry(toTelemetry(loadedState));
        });
      } catch (error) {
        console.error('Failed to load audio normalizer state:', error);
      }
    };

    const subscribe = async () => {
      const telemetryUnlisten = await window.electronAPI.audioNormalizer.onTelemetry((payload) => {
        if (disposed) {
          return;
        }

        startTransition(() => {
          setTelemetry(payload);
        });

        if (!frozenRef.current && !payload.paused) {
          pushGraphSample(buffersRef.current, payload, targetLufsRef.current);
          updateCharts(buffersRef.current, loudnessChartRef.current, gainChartRef.current);
        }
      });
      if (disposed) {
        telemetryUnlisten();
        return;
      }
      unlistenTelemetry = telemetryUnlisten;

      const logUnlisten = await window.electronAPI.audioNormalizer.onEventLog((entry) => {
        if (!disposed) {
          appendLogEntry(entry, setLogs);
        }
      });
      if (disposed) {
        logUnlisten();
        return;
      }
      unlistenLog = logUnlisten;
    };

    void load();
    void subscribe().catch((error) => {
      if (!disposed) {
        console.error('Failed to subscribe to audio normalizer events:', error);
      }
    });

    const refreshIntervalId = window.setInterval(() => {
      if (disposed) {
        return;
      }

      void window.electronAPI.audioNormalizer.getDebugInfo()
        .then((info) => {
          if (!disposed) {
            setDebugInfo(info);
          }
        })
        .catch(() => {
          if (!disposed) {
            setDebugInfo(null);
          }
        });
    }, DEBUG_INFO_REFRESH_MS);

    return () => {
      disposed = true;
      unlistenTelemetry?.();
      unlistenLog?.();
      window.clearInterval(refreshIntervalId);
    };
  }, [setAudioNormalizerEnabled]);

  const appendLocalLog = (event_type: string, message: string) => {
    appendLogEntry(
      {
        timestamp_ms: Date.now(),
        event_type,
        message,
      },
      setLogs,
    );
  };

  const handleToggleEnabled = async () => {
    const nextEnabled = !config.enabled;
    try {
      await window.electronAPI.audioNormalizer.setEnabled(nextEnabled);
      setConfig((current) => ({ ...current, enabled: nextEnabled }));
      setFormConfig((current) => ({ ...current, enabled: nextEnabled }));
      setAudioNormalizerEnabled(nextEnabled);
      appendLocalLog(nextEnabled ? 'enabled' : 'disabled', `Normalizer ${nextEnabled ? 'enabled' : 'disabled'} from panel`);
    } catch (error) {
      console.error('Failed to toggle audio normalizer:', error);
    }
  };

  const handlePresetChange = async (preset: string) => {
    try {
      await window.electronAPI.audioNormalizer.setPreset(preset);
      const updatedConfig = await window.electronAPI.audioNormalizer.getConfig();
      setConfig(updatedConfig);
      setFormConfig(updatedConfig);
      setAudioNormalizerPreset(preset);
      setAudioNormalizerEnabled(updatedConfig.enabled);
      appendLocalLog('preset', `Applied ${preset} preset`);
    } catch (error) {
      console.error('Failed to set preset:', error);
    }
  };

  const handleResetState = async () => {
    try {
      await window.electronAPI.audioNormalizer.resetState();
      const updatedState = await window.electronAPI.audioNormalizer.getState();
      startTransition(() => {
        setTelemetry((current) => ({
          ...toTelemetry(updatedState),
          timestamp_ms: current.timestamp_ms,
          reason: 'settling',
        }));
      });
      buffersRef.current = createEmptyBuffers();
      updateCharts(buffersRef.current, loudnessChartRef.current, gainChartRef.current);
      appendLocalLog('reset', 'Telemetry and rider gain reset');
    } catch (error) {
      console.error('Failed to reset normalizer state:', error);
    }
  };

  const handleApplyConfig = async () => {
    setIsApplying(true);
    try {
      await window.electronAPI.audioNormalizer.setConfig(formConfig);
      const updatedConfig = await window.electronAPI.audioNormalizer.getConfig();
      setConfig(updatedConfig);
      setFormConfig(updatedConfig);
      setAudioNormalizerEnabled(updatedConfig.enabled);
      appendLocalLog('config', 'Normalizer parameters updated');
    } catch (error) {
      console.error('Failed to apply audio normalizer config:', error);
    } finally {
      setIsApplying(false);
    }
  };

  const handleSaveCustomPreset = async () => {
    try {
      await window.electronAPI.audioNormalizer.saveCustomPreset(formConfig);
      setAudioNormalizerPreset('custom');
      appendLocalLog('preset', 'Saved custom preset');
    } catch (error) {
      console.error('Failed to save custom preset:', error);
    }
  };

  const handleResetToDefaults = () => {
    setFormConfig({
      ...DEFAULT_CONFIG,
      enabled: config.enabled,
    });
    appendLocalLog('config', 'Reset parameter form to defaults');
  };

  const handleToggleManualMode = async () => {
    const nextManualMode = !telemetry.manual_mode;
    try {
      await window.electronAPI.audioNormalizer.setManualMode(nextManualMode);
      startTransition(() => {
        setTelemetry((current) => ({
          ...current,
          manual_mode: nextManualMode,
          reason: nextManualMode ? 'manual_mode' : current.is_gated ? 'gated' : 'steady',
        }));
      });
    } catch (error) {
      console.error('Failed to toggle manual mode:', error);
    }
  };

  const refreshDebugInfo = async () => {
    try {
      const info = await window.electronAPI.audioNormalizer.getDebugInfo();
      setDebugInfo(info);
      appendLocalLog('probe', 'Refreshed MPV metadata probe');
    } catch (error) {
      console.error('Failed to fetch audio normalizer debug info:', error);
    }
  };

  const handleFieldChange = (field: Exclude<FormField, 'enabled'>, value: string) => {
    const nextValue = Number(value);
    setFormConfig((current) => ({
      ...current,
      [field]: Number.isFinite(nextValue) ? nextValue : current[field],
    }));
  };

  const anyLaneEnabled = config.slow_enabled || config.fast_enabled;
  const telemetryUnavailable = telemetry.reason === 'no_data' || telemetry.reason === 'disconnected' || telemetry.reason === 'settling';
  const riderActive = config.enabled && anyLaneEnabled && telemetry.connected && !telemetry.paused && !telemetry.manual_mode && !telemetry.is_gated && !telemetryUnavailable;
  const sourceStatus = telemetry.paused
    ? 'Paused'
    : !telemetry.connected || telemetry.reason === 'disconnected'
      ? 'Disconnected'
      : telemetry.reason === 'no_data'
        ? 'No data'
        : telemetry.reason === 'settling'
          ? 'Settling'
          : 'Connected';
  const controlStatus = telemetry.paused
    ? 'Paused'
    : telemetry.manual_mode
      ? 'Manual'
      : telemetry.reason === 'no_data'
        ? 'No data'
        : telemetry.reason === 'settling'
          ? 'Settling'
          : riderActive
            ? 'Riding'
            : 'Holding';
  const limiterTelemetryAvailable =
    telemetry.limiter_input_peak_source !== 'unknown' && telemetry.output_peak_source !== 'unknown';
  const limiterCut = config.limiter_enabled && limiterTelemetryAvailable ? telemetry.limiter_reduction_db : 0;
  const limiterActive = config.limiter_enabled && limiterTelemetryAvailable && limiterCut > 0.1;
  const samples = buffersRef.current;
  const latestSample = samples.times.at(-1) ?? 0;
  const recentStart = Math.max(0, samples.times.findIndex((time) => time >= latestSample - GRAPH_WINDOW_SECONDS));
  const recentGateStates = samples.gated.slice(recentStart);
  const gateTimelineSegments = buildGateTimelineSegments(samples.times, samples.gated);
  const recentGains = samples.currentGain.slice(recentStart);
  const gatedSamples = recentGateStates.filter(Boolean).length;
  const gatedPercent = recentGateStates.length > 0 ? (gatedSamples / recentGateStates.length) * 100 : 0;
  const openPercent = recentGateStates.length > 0 ? 100 - gatedPercent : 0;
  const gateTransitions = recentGateStates.reduce(
    (count, gated, index) => count + (index > 0 && gated !== recentGateStates[index - 1] ? 1 : 0),
    0,
  );
  const averageGain = recentGains.length > 0
    ? recentGains.reduce((sum, gain) => sum + gain, 0) / recentGains.length
    : 0;
  const gateScaleMin = -70;
  const gateScaleMax = 0;
  const gateRangeHealthy = telemetry.gate_observed_range_lu >= ADAPTIVE_GATE_MIN_RANGE_LU;
  const gateConfidencePercent = clampToPercent(telemetry.gate_confidence, 0, 1);
  const gateModelHealthy = telemetry.gate_model_state === 'direct' || telemetry.gate_model_state === 'stable' || telemetry.gate_model_state === 'adapting';
  const relativeLongTermOffsetDb = config.adaptive_gate_enabled
    && config.adaptive_max_gain_enabled
    && config.limiter_enabled
    && telemetry.integrated_lufs > -69
    ? Math.min(
      Math.max(0, config.target_lufs - telemetry.integrated_lufs),
      Math.max(0, config.adaptive_max_gain_limit_db - config.max_gain_db),
    )
    : 0;

  useEffect(() => {
    setAudioNormalizerActive(riderActive);
    setAudioNormalizerReason(telemetry.reason);
  }, [riderActive, telemetry.reason, setAudioNormalizerActive, setAudioNormalizerReason]);

  return (
    <div className="audio-normalizer">
      <header className="an-monitor-header">
        <div><span className="an-eyebrow">Realtime processing monitor</span><h2>Audio Normalizer</h2></div>
        <div className="an-monitor-actions">
          <button className="an-toggle" onClick={handleToggleEnabled} type="button"><span className={'an-toggle-switch ' + (config.enabled ? 'active' : '')} />{config.enabled ? 'Enabled' : 'Disabled'}</button>
          <select className="an-preset-select" value={audioNormalizerPreset} onChange={(e) => void handlePresetChange(e.target.value)}>{PRESET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <button className={'an-graph-btn ' + (graphsFrozen ? 'active' : '')} onClick={() => setGraphsFrozen((value) => !value)} type="button">{graphsFrozen ? 'Resume' : 'Freeze'}</button>
          <button className="an-btn" onClick={handleResetState} type="button">Reset Gain</button>
        </div>
      </header>

      <section className="an-live-strip">
        <div className="an-live-item"><i className={'an-live-dot ' + (telemetry.paused ? 'paused' : telemetry.connected && !telemetryUnavailable ? 'connected' : '')} /><span>Source</span><strong>{sourceStatus}</strong></div>
        <div className={'an-live-item an-live-decision ' + (telemetry.is_gated ? 'gated' : 'open')}><span>Gate</span><strong>{telemetry.is_gated ? 'GATED' : 'OPEN'}</strong></div>
        <div className="an-live-item"><span>Phase</span><strong>{telemetry.paused ? 'Paused' : formatGatePhase(telemetry.gate_phase)}</strong></div>
        <div className="an-live-item"><span>Gain</span><strong>{formatSigned(telemetry.current_gain_db)} dB</strong></div>
        <div className="an-live-item"><span>Limiter</span><strong className={limiterActive ? 'an-danger' : ''}>{limiterActive ? formatPlain(limiterCut) + ' dB cut' : 'Idle'}</strong></div>
        <div className="an-live-item"><span>Control</span><strong>{controlStatus}</strong></div>
      </section>

      <main className="an-monitor-grid">
        <div className="an-monitor-primary">
          <section className="an-monitor-card an-gate-monitor">
            <div className="an-monitor-card-header"><div><span className="an-section-kicker">Adaptive Silence Gate</span></div><span className={'an-readiness ' + (gateModelHealthy ? 'ready' : '')}>{telemetry.adaptive_gate_enabled ? formatGateModelState(telemetry.gate_model_state) + ' ' + formatPlain(gateConfidencePercent, 0) + '%' : 'Fixed'}</span></div>
            <div className="an-gate-values">
              <div><span>Ambient floor</span><strong>{formatPlain(telemetry.gate_ambient_floor_lufs)} <small>LUFS</small></strong></div>
              <div><span>Close below</span><strong>{formatPlain(telemetry.gate_close_threshold_lufs)} <small>LUFS</small></strong></div>
              <div><span>Open above</span><strong>{formatPlain(telemetry.gate_open_threshold_lufs)} <small>LUFS</small></strong></div>
              <div><span>Foreground</span><strong>{formatPlain(telemetry.gate_foreground_lufs)} <small>LUFS</small></strong></div>
              <div className="current"><span>Current {telemetry.gate_detector_mode === 'momentary' ? 'momentary' : 'short-term'}</span><strong>{formatPlain(telemetry.gate_signal_lufs)} <small>LUFS</small></strong></div>
            </div>
            <div className="an-gate-scale"><div className="an-gate-scale-track">
              <i className="an-gate-region ambient" style={{ width: clampToPercent(telemetry.gate_close_threshold_lufs, gateScaleMin, gateScaleMax) + '%' }} />
              <i className="an-gate-region speech" style={{ left: clampToPercent(telemetry.gate_open_threshold_lufs, gateScaleMin, gateScaleMax) + '%' }} />
              {([['floor', telemetry.gate_ambient_floor_lufs, 'Ambient'], ['close', telemetry.gate_close_threshold_lufs, 'Close'], ['open', telemetry.gate_open_threshold_lufs, 'Open'], ['foreground', telemetry.gate_foreground_lufs, 'Speech'], ['signal', telemetry.gate_signal_lufs, 'Now']] as const).map(([kind, value, label]) => <span key={kind} className={'an-gate-marker ' + kind} style={{ left: clampToPercent(value, gateScaleMin, gateScaleMax) + '%' }}><i /><b>{label}</b></span>)}
            </div><div className="an-gate-scale-labels"><span>-70 LUFS</span><span>-50</span><span>-30</span><span>-10</span><span>0</span></div></div>
            <div className="an-gate-learning-meta"><span>Observed <strong>{formatPlain(telemetry.gate_observed_secs, 0)} / {formatPlain(telemetry.gate_observation_window_secs, 0)}s</strong></span><span>Adaptive mode <strong>{telemetry.adaptive_gate_mode === 'stable' ? 'Stable' : 'Direct'}</strong></span><span>Subtitle Assist <strong>{telemetry.subtitle_assist_active ? 'Active' : telemetry.subtitle_assist_enabled ? 'Watching' : 'Off'}</strong></span><span>Detector <strong>{telemetry.gate_detector_mode === 'momentary' ? 'Momentary' : 'Short-term'}</strong></span><span>Range <strong className={gateRangeHealthy ? '' : 'an-warning'}>{formatPlain(telemetry.gate_observed_range_lu)} LU</strong></span><span>Model age <strong>{formatPlain(telemetry.gate_model_age_secs, 0)}s</strong></span><span>Source offset <strong>{formatSigned(telemetry.gate_normalization_offset_db)} dB</strong></span><span>Reference <strong>{formatPlain(telemetry.gate_threshold_lufs)} LUFS</strong></span><span>Base boost <strong>{formatSigned(config.max_gain_db)} dB</strong></span><span>Long-term offset <strong>{formatSigned(relativeLongTermOffsetDb)} dB</strong></span><span>Boost ceiling <strong>{formatSigned(telemetry.effective_max_gain_db)} dB</strong></span><span>Extra unlocked <strong>{formatSigned(telemetry.adaptive_gain_extra_db)} dB</strong></span><span>Boost state <strong>{formatAdaptiveGainState(telemetry.adaptive_gain_state)}</strong></span></div>
            {telemetry.adaptive_gate_enabled ? <div className="an-confidence"><span>Window confidence</span><div><i style={{ width: gateConfidencePercent + '%' }} /></div><strong>{formatPlain(gateConfidencePercent, 0)}%</strong></div> : null}
          </section>

          <section className="an-monitor-card an-chart-card">
            <div className="an-monitor-card-header compact"><div><span className="an-section-kicker">Loudness</span></div><span className="an-graph-meta">{telemetry.paused ? 'Paused' : graphsFrozen ? 'Frozen' : 'Live'}</span></div>
            <ChartLegend items={[{ label: 'Momentary', tone: 'blue' }, { label: 'Short-term', tone: 'accent' }, { label: 'Target', tone: 'amber' }]} />
            <div className="an-uplot-wrap" ref={loudnessContainerRef} />
            <div className="an-gate-timeline"><span>Gate</span><div className="an-timeline-track" title="60-second gate history">{gateTimelineSegments.length === 0 ? <em>Waiting for samples</em> : gateTimelineSegments.map((segment, index) => <i className={segment.gated ? 'gated' : 'open'} key={`${index}-${segment.gated}`} style={{ left: `${segment.leftPercent}%`, width: `${segment.widthPercent}%` }} />)}</div></div>
          </section>

          <section className="an-monitor-card an-chart-card">
            <div className="an-monitor-card-header compact"><div><span className="an-section-kicker">Gain Rider</span></div><strong>{formatSigned(telemetry.current_gain_db)} dB</strong></div>
            <ChartLegend items={[{ label: 'Slow', tone: 'blue' }, { label: 'Fast', tone: 'accent' }, { label: 'Applied', tone: 'green' }, { label: 'Desired', tone: 'red' }]} />
            <div className="an-uplot-wrap" ref={gainContainerRef} />
          </section>
        </div>

        <aside className="an-session-card">
          <span className="an-section-kicker">Current Session</span>
          <div className="an-session-ring" style={{ background: 'conic-gradient(#ff6b35 0 ' + gatedPercent + '%, #4ade80 ' + gatedPercent + '% 100%)' }}><div><strong>{formatPlain(openPercent, 0)}%</strong><span>Open</span></div></div>
          <div className="an-session-stats">
            <div><span>Open</span><strong>{formatPlain(openPercent, 0)}%</strong></div><div><span>Gated</span><strong>{formatPlain(gatedPercent, 0)}%</strong></div>
            <div><span>Transitions</span><strong>{gateTransitions}</strong></div><div><span>Average gain</span><strong>{formatSigned(averageGain)} dB</strong></div>
            <div><span>Momentary</span><strong>{formatPlain(telemetry.momentary_lufs)} LUFS</strong></div><div><span>Short-term</span><strong>{formatPlain(telemetry.short_term_lufs)} LUFS</strong></div>
            <div><span>True peak</span><strong>{formatPlain(telemetry.true_peak_db)} dBTP</strong></div><div><span>Output peak</span><strong>{formatPlain(telemetry.output_peak_db)} dB</strong></div>
          </div>
          <button className={'an-graph-btn ' + (telemetry.manual_mode ? 'active' : '')} onClick={handleToggleManualMode} type="button">{telemetry.manual_mode ? 'Exit Manual Mode' : 'Manual Mode'}</button>
        </aside>
      </main>

      <section className="an-fold">
        <button className="an-fold-toggle" onClick={() => setTuningOpen((open) => !open)} type="button" aria-expanded={tuningOpen}><span><span className="an-section-kicker">Tuning</span><strong>Normalizer parameters</strong><small>Six focused control groups</small></span><span className={'an-fold-chevron ' + (tuningOpen ? 'open' : '')}>⌄</span></button>
        {tuningOpen ? <div className="an-fold-content"><div className="an-tuning-toolbar"><p>Changes are staged until applied.</p><div className="an-params-actions"><button className="an-btn" onClick={handleResetToDefaults} type="button">Defaults</button><button className="an-btn" onClick={handleSaveCustomPreset} type="button">Save Custom</button><button className="an-btn an-btn-primary" onClick={handleApplyConfig} disabled={isApplying} type="button">{isApplying ? 'Applying...' : 'Apply Changes'}</button></div></div>
          <div className="an-tuning-grid">
            <section className="an-param-section an-param-section-wide">
              <div className="an-param-section-header"><div className="an-param-section-copy"><strong className="an-param-section-title">Loudness Rider</strong><span className="an-param-section-note">Primary leveling and response</span></div><button className={'an-graph-btn ' + (formConfig.slow_enabled ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, slow_enabled: !c.slow_enabled }))} type="button">{formConfig.slow_enabled ? 'On' : 'Off'}</button></div>
              <div className="an-mode-toggle"><span className="an-param-label">Detector source</span><div className="an-mode-toggle-buttons">{([['momentary', 'Momentary'], ['short_term', 'Short-term'], ['blended', 'Blended']] as const).map(([mode, label]) => <button key={mode} className={'an-graph-btn ' + (formConfig.slow_control_mode === mode ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, slow_control_mode: mode as SlowControlMode }))} type="button">{label}</button>)}</div></div>
              <div className="an-mode-toggle"><span className="an-param-label">Response units</span><div className="an-mode-toggle-buttons">{([['time_based', 'Time'], ['db_per_sec', 'dB/sec']] as const).map(([mode, label]) => <button key={mode} className={'an-graph-btn ' + (formConfig.response_mode === mode ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, response_mode: mode as ResponseMode }))} type="button">{label}</button>)}</div></div>
              <div className="an-params-grid">{[...SLOW_PARAMETER_FIELDS, ...TIME_RESPONSE_FIELDS, ...DB_PER_SEC_FIELDS].map((field) => {
                const inactive = TIME_RESPONSE_FIELDS.some((candidate) => candidate.key === field.key)
                  ? formConfig.response_mode !== 'time_based'
                  : DB_PER_SEC_FIELDS.some((candidate) => candidate.key === field.key)
                    ? formConfig.response_mode !== 'db_per_sec'
                    : false;
                return <label className={'an-param ' + (inactive ? 'inactive' : '')} key={field.key}><span>{field.label}</span><div className="an-param-row"><input className="an-param-input" type="number" min={field.min} max={field.max} step={field.step} value={formConfig[field.key]} disabled={inactive} onChange={(e) => handleFieldChange(field.key, e.target.value)} /><small>{field.unit}</small></div></label>;
              })}</div>
            </section>

            <section className="an-param-section">
              <div className="an-param-section-header"><div className="an-param-section-copy"><strong className="an-param-section-title">Fast Control</strong><span className="an-param-section-note">Short spike correction</span></div><button className={'an-graph-btn ' + (formConfig.fast_enabled ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, fast_enabled: !c.fast_enabled }))} type="button">{formConfig.fast_enabled ? 'On' : 'Off'}</button></div>
              <div className="an-mode-toggle"><span className="an-param-label">Detector</span><div className="an-mode-toggle-buttons">{([['true_peak', 'True Peak'], ['momentary_delta', 'Momentary']] as const).map(([mode, label]) => <button key={mode} className={'an-graph-btn ' + (formConfig.fast_detector_mode === mode ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, fast_detector_mode: mode }))} type="button">{label}</button>)}</div></div>
              <div className="an-params-grid">{FAST_PARAMETER_FIELDS.map((field) => {
                const inactive = field.key === 'fast_threshold_lu'
                  ? formConfig.fast_detector_mode === 'true_peak'
                  : field.key === 'fast_true_peak_threshold_db'
                    ? formConfig.fast_detector_mode !== 'true_peak'
                    : false;
                return <label className={'an-param ' + (inactive ? 'inactive' : '')} key={field.key}><span>{field.label}</span><div className="an-param-row"><input className="an-param-input" type="number" min={field.min} max={field.max} step={field.step} value={formConfig[field.key]} disabled={inactive} onChange={(e) => handleFieldChange(field.key, e.target.value)} /><small>{field.unit}</small></div></label>;
              })}</div>
            </section>

            <section className="an-param-section">
              <div className="an-param-section-header"><div className="an-param-section-copy"><strong className="an-param-section-title">Silence Gate</strong><span className="an-param-section-note">Ambient reference and close timing</span></div><div className="an-inline-toggles"><button className={'an-graph-btn ' + (formConfig.adaptive_gate_enabled ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, adaptive_gate_enabled: !c.adaptive_gate_enabled }))} type="button">{formConfig.adaptive_gate_enabled ? 'Adaptive' : 'Fixed'}</button><button className={'an-graph-btn ' + (formConfig.adaptive_max_gain_enabled ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, adaptive_max_gain_enabled: !c.adaptive_max_gain_enabled }))} type="button">Adaptive Boost</button><button className={'an-graph-btn ' + (formConfig.subtitle_assist_enabled ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, subtitle_assist_enabled: !c.subtitle_assist_enabled }))} type="button">Subtitle Assist</button></div></div>
              <div className="an-mode-toggle"><span className="an-param-label">Adaptive mode</span><div className="an-mode-toggle-buttons">{([['direct', 'Direct'], ['stable', 'Stable']] as const).map(([mode, label]) => <button key={mode} className={'an-graph-btn ' + (formConfig.adaptive_gate_mode === mode ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, adaptive_gate_mode: mode as AdaptiveGateMode }))} type="button">{label}</button>)}</div></div>
              <div className="an-mode-toggle"><span className="an-param-label">Gate detector</span><div className="an-mode-toggle-buttons">{([['momentary', 'Momentary'], ['short_term', 'Short-term']] as const).map(([mode, label]) => <button key={mode} className={'an-graph-btn ' + (formConfig.gate_detector_mode === mode ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, gate_detector_mode: mode as GateDetectorMode }))} type="button">{label}</button>)}</div></div>
              <p className="an-param-help">Direct follows the current rolling window. Stable confirms and holds a trusted Gate model through temporary confidence drops. Adaptive Boost adds how far Integrated LUFS sits below Target Loudness to Max Boost, up to Adaptive Hard Max; it works independently from Gate learning and requires the Limiter. Subtitle Assist filters bracketed SDH cues from text subtitles; visible bitmap subtitle events always open the Gate.</p>
              <div className="an-params-grid">{[...GATE_PARAMETER_FIELDS, ...ADAPTIVE_GAIN_PARAMETER_FIELDS].map((f) => {
                const adaptiveGainField = f.key === 'adaptive_max_gain_limit_db';
                const inactive = adaptiveGainField && (!formConfig.adaptive_gate_enabled || !formConfig.adaptive_max_gain_enabled);
                return <label className={'an-param ' + (inactive ? 'inactive' : '')} key={f.key}><span>{f.label}</span><div className="an-param-row"><input className="an-param-input" type="number" min={adaptiveGainField ? formConfig.max_gain_db : f.min} max={f.max} step={f.step} value={formConfig[f.key]} disabled={inactive} onChange={(e) => handleFieldChange(f.key, e.target.value)} /><small>{f.unit}</small></div></label>;
              })}</div>
            </section>

            <section className="an-param-section">
              <div className="an-param-section-header"><div className="an-param-section-copy"><strong className="an-param-section-title">Transient & Peak</strong><span className="an-param-section-note">Rider-side protection</span></div><div className="an-inline-toggles"><button className={'an-graph-btn ' + (formConfig.transient_enabled ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, transient_enabled: !c.transient_enabled }))} type="button">Transient</button><button className={'an-graph-btn ' + (formConfig.peak_ceiling_enabled ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, peak_ceiling_enabled: !c.peak_ceiling_enabled }))} type="button">Ceiling</button></div></div>
              <div className="an-params-grid">{TRANSIENT_PARAMETER_FIELDS.map((f) => <label className="an-param" key={f.key}><span>{f.label}</span><div className="an-param-row"><input className="an-param-input" type="number" step={f.step} value={formConfig[f.key]} onChange={(e) => handleFieldChange(f.key, e.target.value)} /><small>{f.unit}</small></div></label>)}</div>
            </section>

            <section className="an-param-section">
              <div className="an-param-section-header"><div className="an-param-section-copy"><strong className="an-param-section-title">Limiter</strong><span className="an-param-section-note">Final output protection</span></div><button className={'an-graph-btn ' + (formConfig.limiter_enabled ? 'active' : '')} onClick={() => setFormConfig((c) => ({ ...c, limiter_enabled: !c.limiter_enabled }))} type="button">{formConfig.limiter_enabled ? 'On' : 'Off'}</button></div>
              <div className="an-params-grid">{LIMITER_PARAMETER_FIELDS.map((f) => <label className="an-param" key={f.key}><span>{f.label}</span><div className="an-param-row"><input className="an-param-input" type="number" min={f.min} max={f.max} step={f.step} value={formConfig[f.key]} onChange={(e) => handleFieldChange(f.key, e.target.value)} /><small>{f.unit}</small></div></label>)}</div>
            </section>

            <section className="an-param-section"><div className="an-param-section-header"><div className="an-param-section-copy"><strong className="an-param-section-title">Engine</strong><span className="an-param-section-note">Telemetry cadence</span></div></div><div className="an-params-grid">{ENGINE_PARAMETER_FIELDS.map((f) => <label className="an-param" key={f.key}><span>{f.label}</span><div className="an-param-row"><input className="an-param-input" type="number" step={f.step} value={formConfig[f.key]} onChange={(e) => handleFieldChange(f.key, e.target.value)} /><small>{f.unit}</small></div></label>)}</div></section>
          </div>
        </div> : null}
      </section>

      <section className="an-fold">
        <button className="an-fold-toggle" onClick={() => setDiagnosticsOpen((open) => !open)} type="button" aria-expanded={diagnosticsOpen}><span><span className="an-section-kicker">Diagnostics</span><strong>Probe and event trail</strong><small>{logs.length} logged events</small></span><span className={'an-fold-chevron ' + (diagnosticsOpen ? 'open' : '')}>⌄</span></button>
        {diagnosticsOpen ? <div className="an-fold-content an-diagnostics-content">
          <section className="an-log"><div className="an-log-header"><strong>MPV Probe</strong><button className="an-btn" onClick={() => void refreshDebugInfo()} type="button">Refresh</button></div><div className="an-debug-panel">
            <div className="an-debug-block"><span className="an-card-label">Current File</span><code>{debugInfo?.filename ?? 'No file reported'}</code></div>
            <div className="an-debug-probes"><div className="an-debug-probe"><code>Mode</code><span>{telemetry.adaptive_gate_enabled ? 'Adaptive · ' + formatGateModelState(telemetry.gate_model_state) : 'Fixed'}</span></div><div className="an-debug-probe"><code>Model age</code><span>{formatPlain(telemetry.gate_model_age_secs, 0)}s</span></div><div className="an-debug-probe"><code>Detector</code><span>{telemetry.gate_detector_mode === 'momentary' ? 'Momentary' : 'Short-term'}</span></div><div className="an-debug-probe"><code>Raw signal</code><span>{formatPlain(telemetry.gate_signal_lufs)} LUFS</span></div><div className="an-debug-probe"><code>Close / Open</code><span>{formatPlain(telemetry.gate_close_threshold_lufs)} / {formatPlain(telemetry.gate_open_threshold_lufs)} LUFS</span></div><div className="an-debug-probe"><code>Filters</code><pre className="an-debug-pre">{debugInfo?.filters ? JSON.stringify(debugInfo.filters, null, 2) : 'No filter data'}</pre></div></div>
          </div></section>
          <section className="an-log"><div className="an-log-header"><strong>Event Log</strong><button className="an-btn" onClick={() => setLogs([])} type="button">Clear</button></div><div className="an-log-entries">{logs.length === 0 ? <div className="an-log-empty">Waiting for events...</div> : logs.map((entry, index) => <div className="an-log-entry" key={entry.timestamp_ms + '-' + index}><span className="an-log-time">{formatLogTime(entry.timestamp_ms)}</span><span className="an-log-type">{entry.event_type}</span><span>{entry.message}</span></div>)}</div></section>
        </div> : null}
      </section>
    </div>
  );
};

export default AudioNormalizer;
