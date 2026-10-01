import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type ClockSettings = { enabled: boolean; minimumMhz: number; maximumMhz: number };
const defaults: ClockSettings = { enabled: false, minimumMhz: 0, maximumMhz: 0 };

export default function OptiflowClockSettings() {
  const [saved, setSaved] = useState<ClockSettings>(defaults);
  const [minimum, setMinimum] = useState('');
  const [maximum, setMaximum] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    void invoke<ClockSettings>('get_optiflow_clock_settings').then(value => {
      if (cancelled) return;
      setSaved(value); setEnabled(value.enabled);
      setMinimum(value.minimumMhz ? String(value.minimumMhz) : '');
      setMaximum(value.maximumMhz ? String(value.maximumMhz) : '');
    }).catch(error => { if (!cancelled) setMessage(String(error)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    const subscription = listen<string>('optiflow-clock-error', event => {
      if (!cancelled) setMessage(event.payload);
    });
    return () => { cancelled = true; void subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, []);
  const min = Number(minimum), max = Number(maximum);
  const valid = !enabled || (minimum !== '' && maximum !== '' && Number.isInteger(min)
    && Number.isInteger(max) && min >= 300 && max >= min && max <= 5000);
  const save = async () => {
    setBusy(true); setMessage('');
    const value = { enabled, minimumMhz: enabled ? min : saved.minimumMhz,
      maximumMhz: enabled ? max : saved.maximumMhz };
    try {
      await invoke('save_optiflow_clock_settings', { settings: value });
      setSaved(value);
      setMessage(enabled
        ? 'Saved. Start a new playback session to request administrator approval. Preference saved does not mean clocks are currently locked.'
        : 'Disabled. An active helper will restore automatic clocks on its next check.');
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  return <div className="settings-runtime-card">
    <h3>Advanced GPU clock control (experimental)</h3>
    <p className="settings-description">
      Administrator approval required. These graphics-clock limits affect the whole NVIDIA GPU,
      including other applications, and may increase power use, heat, and fan noise.
      For single-NVIDIA-GPU systems only. Memory clocks, voltage, and power limits are not changed.
    </p>
    <div className="settings-toggle">
      <div className="settings-toggle-info">
        <label>Use a GPU clock range during OptiFlow playback</label>
        <span className="settings-toggle-desc">Off by default. Active only while video is playing with OptiFlow enabled.</span>
      </div>
      <button type="button" className={`toggle-btn ${enabled ? 'active' : ''}`}
        aria-label="Enable advanced OptiFlow GPU clock control" aria-pressed={enabled}
        disabled={busy} onClick={() => setEnabled(!enabled)}><span className="toggle-slider" /></button>
    </div>
    <div className="settings-field">
      <label htmlFor="optiflow-clock-min">Minimum graphics clock (MHz)</label>
      <input id="optiflow-clock-min" type="number" min={300} max={5000} step={1}
        disabled={busy || !enabled} value={minimum} onChange={event => setMinimum(event.target.value)} />
    </div>
    <div className="settings-field">
      <label htmlFor="optiflow-clock-max">Maximum graphics clock (MHz)</label>
      <input id="optiflow-clock-max" type="number" min={300} max={5000} step={1}
        disabled={busy || !enabled} value={maximum} onChange={event => setMaximum(event.target.value)} />
    </div>
    <p className="settings-hint">
      Both values must be supported by your GPU; the maximum cannot exceed its driver-reported limit.
      Pausing, stopping, disabling this setting, or exiting Streamee restores automatic clocks—not
      previous custom locks. Do not use alongside another clock-tuning tool. Changes to the range
      require a new playback session. A driver failure or forced termination of the helper may
      require a manual clock reset or reboot.
    </p>
    {!valid && <p role="alert">Enter whole MHz values from 300 to 5000, with minimum no greater than maximum.</p>}
    <button type="button" className="settings-btn settings-btn-test" disabled={busy || !valid} onClick={() => void save()}>
      {busy ? 'Please wait…' : 'Save advanced clock settings'}
    </button>
    {message && <p role="status" className="settings-hint">{message}</p>}
  </div>;
}
