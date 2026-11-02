import { useEffect, useState, useSyncExternalStore } from 'react';
import { FiDownload, FiRefreshCw, FiTrash2 } from 'react-icons/fi';
import {
  clearImdbDataset, getImdbDatasetSnapshot, initializeImdbDataset, refreshImdbDataset,
  setImdbDatasetEnabled, subscribeImdbDataset,
} from '../../services/imdb-dataset';
import './ImdbDatasetSettings.css';

interface Props {
  onOpenExternal: (url: string) => void;
}

export default function ImdbDatasetSettings({ onOpenExternal }: Props) {
  const dataset = useSyncExternalStore(subscribeImdbDataset, getImdbDatasetSnapshot);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void initializeImdbDataset(); }, []);

  const toggle = async () => {
    setSaving(true);
    setError(null);
    try { await setImdbDatasetEnabled(!dataset.enabled); }
    catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };
  const refresh = async () => {
    setChecking(true);
    setError(null);
    try { await refreshImdbDataset(); }
    catch (reason) { setError(String(reason)); }
    finally { setChecking(false); }
  };
  const clear = async () => {
    setSaving(true);
    setError(null);
    try { await clearImdbDataset(); }
    catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };

  return (
    <div className="settings-api-block imdb-dataset-settings">
      <div className="settings-api-copy">
        <h3>IMDb ratings dataset</h3>
        <p>
          Download IMDb scores and vote counts directly to this computer. Streamee checks for updates
          once every 24 hours while running and keeps the saved copy available offline.
          Local scores take priority over OMDb; Discover score filters continue to use TMDB.
        </p>
        <span className="settings-hint">
          For individual personal, noncommercial use under{' '}
          <button type="button" className="settings-inline-link" onClick={() => onOpenExternal('https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX')}>
            IMDb’s dataset terms
          </button>. The initial download is about 9 MB, with additional disk space for the local index.
        </span>
      </div>

      <div className="settings-field">
        <div className="settings-toggle">
          <div className="settings-toggle-info">
            <label>Download IMDb ratings automatically</label>
            <span className="settings-toggle-desc">Applies immediately. Disabling keeps the downloaded copy on disk.</span>
          </div>
          <button
            type="button"
            className={`toggle-btn ${dataset.enabled ? 'active' : ''}`}
            role="switch"
            aria-checked={dataset.enabled}
            aria-label="Download IMDb ratings automatically"
            disabled={saving || !dataset.available}
            onClick={() => { void toggle(); }}
          >
            <span className="toggle-slider" />
          </button>
        </div>

        <div className="settings-hint" role="status" aria-live="polite">
          {!dataset.initialized ? 'Loading dataset settings…'
            : !dataset.available ? dataset.error || 'Available in the Streamee desktop app.'
            : !dataset.enabled ? dataset.refreshing ? 'Stopping the current IMDb update…'
              : dataset.ready ? 'Off. The saved copy is retained and is not used.' : 'Off. Enable to download a personal copy.'
            : dataset.refreshing ? dataset.ready ? 'Updating IMDb ratings… The saved scores remain available.' : 'Downloading IMDb ratings…'
            : dataset.ready ? `${dataset.entryCount.toLocaleString()} title ratings saved locally.`
            : 'Waiting for the initial download.'}
        </div>
        {!dataset.available && dataset.initialized && dataset.error && (
          <button type="button" className="settings-btn settings-btn-test"
            onClick={() => { void initializeImdbDataset(true); }}>
            <FiRefreshCw /> Retry connection
          </button>
        )}
        {dataset.downloadedAt !== null && (
          <span className="settings-hint">Downloaded: {new Date(dataset.downloadedAt).toLocaleString()}</span>
        )}
        {dataset.lastCheckedAt !== null && (
          <span className="settings-hint">Last checked: {new Date(dataset.lastCheckedAt).toLocaleString()}</span>
        )}
        {dataset.sourceModifiedAt && (
          <span className="settings-hint">IMDb file updated: {new Date(dataset.sourceModifiedAt).toLocaleString()}</span>
        )}
        {(error || dataset.available && dataset.error) && (
          <span className="settings-hint" role="alert">{error || dataset.error}</span>
        )}
        <button
          type="button"
          className="settings-btn settings-btn-test"
          disabled={!dataset.available || !dataset.enabled || dataset.refreshing || saving || checking}
          onClick={() => { void refresh(); }}
        >
          {dataset.ready ? <FiRefreshCw /> : <FiDownload />}
          {dataset.refreshing || checking ? 'Updating…' : dataset.ready ? 'Check for update' : 'Download now'}
        </button>
        {(dataset.ready || dataset.refreshing) && (
          <button type="button" className="settings-btn settings-btn-danger" disabled={!dataset.available || saving}
            onClick={() => { void clear(); }}>
            <FiTrash2 /> Delete saved ratings
          </button>
        )}
        <span className="settings-hint">The local dataset needs no API key. Deleting it also turns automatic downloads off.</span>
        <span className="settings-hint">
          Information courtesy of{' '}
          <button type="button" className="settings-inline-link" onClick={() => onOpenExternal('https://www.imdb.com/')}>
            IMDb (https://www.imdb.com)
          </button>. Used with permission.
        </span>
      </div>
    </div>
  );
}
