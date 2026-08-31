import React, { useEffect, useState } from 'react';
import { FiCheck, FiMenu, FiPlus, FiRefreshCw, FiShield, FiTrash2, FiX } from 'react-icons/fi';
import {
  installAddonFromManifestUrl,
  getSupportedCatalogs,
  loadInstalledAddons,
  refreshInstalledAddon,
  reorderInstalledAddons,
  setInstalledAddonEnabled,
  uninstallAddon,
  type InstalledAddon,
} from '../../services/installed-addons';
import { useStore } from '../../store';

type AddonTestState = { status: 'testing' | 'success' | 'error'; message?: string };

const AddonSettings: React.FC = () => {
  const [addons, setAddons] = useState<InstalledAddon[]>([]);
  const [manifestUrl, setManifestUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, AddonTestState>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalogSourceInstallationId = useStore((state) => state.catalogSourceInstallationId);
  const adultCatalogsEnabled = useStore((state) => state.adultCatalogsEnabled);
  const setCatalogSourceInstallationId = useStore((state) => state.setCatalogSourceInstallationId);
  const setAdultCatalogsEnabled = useStore((state) => state.setAdultCatalogsEnabled);
  const catalogAddons = addons.filter((addon) => addon.enabled && getSupportedCatalogs(addon).length > 0);

  useEffect(() => setAddons(loadInstalledAddons()), []);

  const install = async () => {
    if (!manifestUrl.trim() || installing) return;
    setInstalling(true);
    setMessage(null);
    setError(null);
    try {
      const addon = await installAddonFromManifestUrl(manifestUrl);
      setAddons(loadInstalledAddons());
      setManifestUrl('');
      setMessage(`${addon.manifest.name} installed.`);
    } catch (installError) {
      setError(String(installError));
    } finally {
      setInstalling(false);
    }
  };

  const toggle = (addon: InstalledAddon) => {
    if (addon.enabled && catalogSourceInstallationId === addon.installationId) {
      setCatalogSourceInstallationId(null);
    }
    setAddons(setInstalledAddonEnabled(addon.installationId, !addon.enabled));
    setMessage(null);
    setError(null);
  };

  const test = async (addon: InstalledAddon) => {
    setTests((current) => ({ ...current, [addon.installationId]: { status: 'testing' } }));
    try {
      const refreshed = await refreshInstalledAddon(addon.installationId);
      setAddons(loadInstalledAddons());
      setTests((current) => ({
        ...current,
        [addon.installationId]: {
          status: 'success',
          message: `Connected · manifest ${refreshed.manifest.version}`,
        },
      }));
    } catch (testError) {
      setTests((current) => ({
        ...current,
        [addon.installationId]: { status: 'error', message: String(testError) },
      }));
    }
  };

  const remove = async (addon: InstalledAddon) => {
    if (!window.confirm(`Uninstall ${addon.manifest.name}?`)) return;
    setMessage(null);
    setError(null);
    try {
      if (catalogSourceInstallationId === addon.installationId) {
        setCatalogSourceInstallationId(null);
      }
      setAddons(await uninstallAddon(addon.installationId));
      setMessage(`${addon.manifest.name} uninstalled.`);
    } catch (removeError) {
      setError(String(removeError));
    }
  };

  const reorder = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const ids = addons.map((addon) => addon.installationId);
    const sourceIndex = ids.indexOf(sourceId);
    const targetIndex = ids.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    ids.splice(sourceIndex, 1);
    ids.splice(targetIndex, 0, sourceId);
    setAddons(reorderInstalledAddons(ids));
  };

  const move = (installationId: string, offset: -1 | 1) => {
    const index = addons.findIndex((addon) => addon.installationId === installationId);
    const target = addons[index + offset];
    if (index < 0 || !target) return;
    reorder(installationId, target.installationId);
  };

  return (
    <div className="addon-settings">
      <div className="addon-install-panel">
        <div className="addon-install-heading">
          <div>
            <h3>Install from manifest</h3>
            <span>Paste the configured manifest URL supplied by an add-on you trust.</span>
          </div>
        </div>

        <form
          className="addon-install-form"
          onSubmit={(event) => {
            event.preventDefault();
            void install();
          }}
        >
          <label htmlFor="addon-manifest-url">Manifest URL</label>
          <div className="addon-install-row">
            <input
              id="addon-manifest-url"
              type="password"
              autoComplete="off"
              value={manifestUrl}
              placeholder="https://example.com/configured/manifest.json"
              onChange={(event) => setManifestUrl(event.target.value)}
            />
            <button
              className="settings-btn settings-btn-primary"
              type="submit"
              disabled={installing || !manifestUrl.trim()}
            >
              <FiPlus /> {installing ? 'Installing…' : 'Install add-on'}
            </button>
          </div>
        </form>

        <div className="addon-security-note">
          <FiShield aria-hidden="true" />
          <div>
            <strong>Privacy and third-party notice</strong>
            <span>
              Configured URLs stay in Windows Credential Manager and are never written to frontend storage or logs. Streamee supports Stremio-compatible add-ons but is not affiliated with or endorsed by Stremio or any installed add-on provider. Only install services you trust and use authorized sources.
            </span>
          </div>
        </div>
      </div>

      <div className="addon-install-panel addon-catalog-source-panel">
        <div className="addon-install-heading">
          <div>
            <h3>Catalog source</h3>
            <span>Choose what appears on the Board. TMDB stays configured and is restored when you switch back.</span>
          </div>
        </div>

        <div className="addon-catalog-source-controls">
          <label htmlFor="addon-catalog-source">Active browsing source</label>
          <select
            id="addon-catalog-source"
            className="settings-select"
            value={catalogSourceInstallationId || 'tmdb'}
            onChange={(event) => setCatalogSourceInstallationId(
              event.target.value === 'tmdb' ? null : event.target.value
            )}
          >
            <option value="tmdb">TMDB (default)</option>
            {catalogAddons
              .filter((addon) => adultCatalogsEnabled || !addon.manifest.behaviorHints?.adult)
              .map((addon) => (
                <option key={addon.installationId} value={addon.installationId}>
                  {addon.manifest.name}
                </option>
              ))}
          </select>
          {catalogAddons.length === 0 && (
            <span className="addon-catalog-source-help">
              Install or refresh an add-on that declares catalog and metadata resources to use it here.
            </span>
          )}
        </div>

        <div className="addon-enable-control addon-adult-catalog-control">
          <div>
            <strong>Adult catalog sources</strong>
            <span>Allow installed add-ons marked as adult to appear in the browsing-source selector.</span>
          </div>
          <button
            className={`toggle-btn ${adultCatalogsEnabled ? 'active' : ''}`}
            type="button"
            aria-label={`${adultCatalogsEnabled ? 'Disable' : 'Enable'} adult catalog sources`}
            aria-pressed={adultCatalogsEnabled}
            onClick={() => {
              if (adultCatalogsEnabled) {
                const selected = addons.find((addon) => addon.installationId === catalogSourceInstallationId);
                if (selected?.manifest.behaviorHints?.adult) setCatalogSourceInstallationId(null);
              }
              setAdultCatalogsEnabled(!adultCatalogsEnabled);
            }}
          ><span className="toggle-slider" /></button>
        </div>
      </div>

      <div className="addon-feedback" aria-live="polite">
        {message && <div className="addon-test-results"><span className="success"><FiCheck />{message}</span></div>}
        {error && <div className="addon-test-results"><span className="error"><FiX />{error}</span></div>}
      </div>

      <div className="addon-library-heading">
        <div>
          <h3>Installed add-ons <span className="addon-count">{addons.length}</span></h3>
          <span>Drag to set the automatic fallback order, or use the arrow keys while a card is focused.</span>
        </div>
      </div>

      {addons.length === 0 && (
        <div className="addon-empty-state">
          No add-ons installed. Configure an add-on on its own website, then paste its manifest URL above.
        </div>
      )}

      <div className="addon-list" role="list" aria-label="Installed add-on fallback priority">
        {addons.map((addon, index) => {
          const testState = tests[addon.installationId];
          return (
            <div
              className={`addon-card${draggedId === addon.installationId ? ' is-dragging' : ''}${addon.enabled ? '' : ' is-disabled'}`}
              key={addon.installationId}
              role="listitem"
              tabIndex={0}
              data-addon-installation-id={addon.installationId}
              aria-label={`${addon.manifest.name}, priority ${index + 1}. Drag or use arrow keys to reorder.`}
              onPointerDown={(event) => {
                if (event.button !== 0 || event.target instanceof Element && event.target.closest('button, input, a')) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                setDraggedId(addon.installationId);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                event.preventDefault();
                const target = document
                  .elementFromPoint(event.clientX, event.clientY)
                  ?.closest<HTMLElement>('[data-addon-installation-id]');
                const targetId = target?.dataset.addonInstallationId;
                if (targetId) reorder(addon.installationId, targetId);
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                setDraggedId(null);
              }}
              onPointerCancel={() => setDraggedId(null)}
              onLostPointerCapture={() => setDraggedId(null)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp') { event.preventDefault(); move(addon.installationId, -1); }
                if (event.key === 'ArrowDown') { event.preventDefault(); move(addon.installationId, 1); }
              }}
            >
              <div className="addon-main">
                <span className="addon-drag-handle" aria-hidden="true"><FiMenu /></span>
                <span className="source-provider-priority-rank">{index + 1}</span>
                <div className="addon-copy">
                  <div className="addon-title-row">
                    <strong>{addon.manifest.name}</strong>
                    <span className={`addon-status${addon.enabled ? ' is-active' : ''}`}>
                      {addon.enabled ? 'Active' : 'Paused'}
                    </span>
                  </div>
                  <span>Stremio-compatible source add-on</span>
                  <div className="addon-capabilities">
                    <span className="is-version">v{addon.manifest.version}</span>
                    {addon.manifest.types.map((type) => <span key={type}>{type}</span>)}
                    {(addon.manifest.catalogs?.length || 0) > 0 && <span>Catalog</span>}
                    {addon.manifest.behaviorHints?.adult && <span>Adult</span>}
                    {addon.manifest.behaviorHints?.configurable && <span className="is-configurable">Configurable</span>}
                  </div>
                </div>
              </div>
              <div className="addon-actions">
                <div className="addon-enable-control">
                  <span>{addon.enabled ? 'Enabled' : 'Disabled'}</span>
                  <button
                    className={`toggle-btn ${addon.enabled ? 'active' : ''}`}
                    type="button"
                    aria-label={`${addon.enabled ? 'Disable' : 'Enable'} ${addon.manifest.name}`}
                    aria-pressed={addon.enabled}
                    onClick={() => toggle(addon)}
                  ><span className="toggle-slider" /></button>
                </div>
                <button
                  className="settings-btn settings-btn-test"
                  type="button"
                  disabled={testState?.status === 'testing'}
                  onClick={() => void test(addon)}
                >
                  <FiRefreshCw /> {testState?.status === 'testing' ? 'Testing…' : 'Test'}
                </button>
                <button
                  className="addon-icon-btn is-danger"
                  type="button"
                  aria-label={`Uninstall ${addon.manifest.name}`}
                  onClick={() => void remove(addon)}
                ><FiTrash2 /></button>
              </div>
              {testState && testState.status !== 'testing' && (
                <div className="addon-test-results">
                  <span className={testState.status === 'success' ? 'success' : 'error'}>
                    {testState.status === 'success' ? <FiCheck /> : <FiX />}
                    {testState.message}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AddonSettings;
