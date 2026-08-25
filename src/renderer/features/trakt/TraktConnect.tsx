import React, { useState, useEffect, useRef } from 'react';
import { FiLink, FiCheck, FiX, FiRefreshCw } from 'react-icons/fi';
import {
  startOAuthFlow,
  pollForToken,
  ensureValidToken,
  disconnectTrakt,
  hasTraktCredentials,
  consumeTraktAuthError,
} from '../../services/trakt';
import { useStore } from '../../store';
import './TraktConnect.css';

const openExternalLink = (url: string) => {
  void window.electronAPI.openExternal(url);
};

const getErrorMessage = (error: unknown, fallback: string) => (
  error instanceof Error && error.message ? error.message : fallback
);

interface TraktConnectProps {
  onResync?: () => void;
  syncStatus?: 'idle' | 'syncing' | 'success' | 'error';
  syncMessage?: string | null;
}

const TraktConnect: React.FC<TraktConnectProps> = ({
  onResync,
  syncStatus = 'idle',
  syncMessage = null,
}) => {
  const [status, setStatus] = useState<'idle' | 'loading' | 'waiting' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [deviceCode, setDeviceCode] = useState('');
  const [verificationUrl, setVerificationUrl] = useState('');
  const [expiresIn, setExpiresIn] = useState(0);
  const pollRef = useRef<number | null>(null);
  
  const { traktConnected, setTraktConnected, setTraktToken, setTraktLastSync } = useStore();

  useEffect(() => {
    let isMounted = true;
    ensureValidToken().then((token) => {
      if (isMounted) {
        setTraktConnected(Boolean(token));
        if (!token) {
          const authError = consumeTraktAuthError();
          if (authError) {
            setErrorMessage(authError);
            setStatus('error');
          }
        }
      }
    }).catch((error: unknown) => {
      if (isMounted) {
        setErrorMessage(getErrorMessage(error, 'Unable to verify the Trakt connection.'));
        setStatus('error');
      }
    });

    return () => {
      isMounted = false;
    };
  }, [setTraktConnected]);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, []);

  const handleConnect = async () => {
    if (!hasTraktCredentials()) {
      setErrorMessage('Please configure your Trakt API credentials in Settings first.');
      setStatus('error');
      return;
    }

    setStatus('loading');
    setErrorMessage('');
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    try {
      const codeData = await startOAuthFlow();
      setDeviceCode(codeData.user_code);
      setVerificationUrl(codeData.verification_url);
      setExpiresIn(codeData.expires_in);
      setStatus('waiting');

      const pollInterval = codeData.interval * 1000;
      const endTime = Date.now() + codeData.expires_in * 1000;

      pollRef.current = window.setInterval(async () => {
        if (Date.now() > endTime) {
          if (pollRef.current !== null) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setErrorMessage('The Trakt device code expired. Please try again.');
          setStatus('error');
          return;
        }

        try {
          const token = await pollForToken(codeData.device_code);
          if (!token) {
            return;
          }

          if (pollRef.current !== null) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setTraktToken(token.access_token);
          setTraktLastSync(0); // reset so the first real sync fetches everything
          setTraktConnected(true);
          setStatus('success');
        } catch (error: unknown) {
          if (pollRef.current !== null) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setErrorMessage(getErrorMessage(error, 'Unable to complete Trakt authentication.'));
          setStatus('error');
        }
      }, pollInterval);
    } catch (error: unknown) {
      const message = getErrorMessage(error, 'Unable to start Trakt authentication.');
      console.error('OAuth error:', message);
      setErrorMessage(message);
      setStatus('error');
    }
  };

  const handleDisconnect = () => {
    disconnectTrakt();
    setTraktToken(null);
    setTraktConnected(false);
    setStatus('idle');
    setDeviceCode('');
  };

  if (traktConnected) {
    return (
      <div className="trakt-connect connected">
        <div className="trakt-status">
          <FiCheck className="trakt-icon success" />
          <span>Connected to Trakt</span>
        </div>
        <div className="trakt-connected-actions">
          {syncMessage && <span className="trakt-sync-message">{syncMessage}</span>}
          {onResync && (
            <button
              className={`trakt-btn resync ${syncStatus}`}
              onClick={onResync}
              disabled={syncStatus === 'syncing'}
              type="button"
            >
              {syncStatus === 'syncing' && <><FiRefreshCw className="spin" /> Syncing...</>}
              {syncStatus === 'success' && <><FiCheck /> Synced!</>}
              {syncStatus === 'error' && <><FiX /> Failed</>}
              {syncStatus === 'idle' && <><FiRefreshCw /> Resync with Trakt</>}
            </button>
          )}
          <button className="trakt-btn disconnect" onClick={handleDisconnect} type="button">
            <FiX /> Disconnect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="trakt-connect">
      <div className="trakt-header">
        <h3>Trakt.tv Sync</h3>
        <p className="trakt-description">
          Connect your Trakt account to sync watch history, watchlist, and view your calendar.
        </p>
      </div>

      {status === 'idle' && (
        <button className="trakt-btn connect" onClick={handleConnect}>
          <FiLink /> Connect to Trakt
        </button>
      )}

      {status === 'loading' && (
        <div className="trakt-loading">
          <FiRefreshCw className="spin" />
          <span>Starting authentication...</span>
        </div>
      )}

      {status === 'waiting' && (
        <div className="trakt-device-code">
          <p>
            Go to{' '}
            <button
              className="trakt-inline-link"
              onClick={() => openExternalLink(verificationUrl)}
              type="button"
            >
              {verificationUrl}
            </button>{' '}
            and enter:
          </p>
          <div className="trakt-code">{deviceCode}</div>
          <p className="trakt-expires">Expires in {Math.floor(expiresIn / 60)} minutes</p>
        </div>
      )}

      {status === 'success' && (
        <div className="trakt-success">
          <FiCheck />
          <span>Connected successfully!</span>
        </div>
      )}

      {status === 'error' && (
        <div className="trakt-error">
          <p>{errorMessage || 'Authentication failed. Please try again.'}</p>
          <button className="trakt-btn retry" onClick={() => { setStatus('idle'); setErrorMessage(''); }}>
            Try Again
          </button>
        </div>
      )}
    </div>
  );
};

export default TraktConnect;
