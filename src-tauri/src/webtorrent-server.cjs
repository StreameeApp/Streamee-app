const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const STREAM_CACHE_ROOT = path.join(os.tmpdir(), 'Streamee', 'webtorrent-stream-cache');
const PERSISTENT_CACHE_VERSION = 1;
const PERSISTENT_CACHE_UPDATE_BYTES = 64 * 1024 * 1024;
let streamCacheSequence = 0;

function cleanupStreamCacheDirectory(cacheDirectory = STREAM_CACHE_ROOT) {
  try {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  } catch (err) {
    // Cache cleanup must not prevent the sidecar from reporting a useful
    // startup or playback error through its normal command channel.
    writeLog('error', 'cache.cleanup_failed', 'Failed to clear stream cache', {
      directory: cacheDirectory,
      error: err.message,
    });
  }
}

cleanupStreamCacheDirectory();
fs.mkdirSync(STREAM_CACHE_ROOT, { recursive: true });

function writeLog(level, event, message, fields = {}) {
  process.stderr.write(`${JSON.stringify({
    level,
    source: 'webtorrent',
    subsystem: 'webtorrent',
    event,
    message,
    fields,
  })}\n`);
}

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.stealth.si:80/announce',
];
const CLIENT_MAX_CONNS = 150;
const CLIENT_NUMWANT = 82;
const FORWARD_SEGMENT_BYTES = 128 * 1024 * 1024;
const TAIL_SEGMENT_BYTES = 64 * 1024 * 1024;
const FULL_CACHE_SEEK_TOLERANCE_BYTES = 8 * 1024 * 1024;
const CACHE_ONLY_POLL_MS = 250;
const CACHE_ONLY_IDLE_TIMEOUT_MS = 15_000;
const configuredTorrentPort = (() => {
  const raw = process.env.STREAMEE_TORRENT_PORT;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : null;
})();

// Global error handlers to prevent process crashes
process.on('uncaughtException', (err) => {
  writeLog('error', 'process.uncaught_exception', 'Uncaught WebTorrent exception', {
    error: err.message,
    stack: err.stack,
  });
  // Do NOT exit - log and continue
  sendMessage({ type: 'error', message: err.message });
});

process.on('unhandledRejection', (reason, promise) => {
  const detail = reason instanceof Error ? (reason.stack || reason.message) : reason;
  writeLog('error', 'process.unhandled_rejection', 'Unhandled WebTorrent promise rejection', {
    promise: String(promise),
    error: detail,
  });
  // Do NOT exit - log and continue
});

let client = null;
const clientReady = import('webtorrent')
  .then((mod) => {
    const WebTorrent = mod.default || mod;
    client = new WebTorrent({
      tracker: {
        rtcConfig: null,
        wrtc: false,
        getAnnounceOpts: () => ({
          numwant: CLIENT_NUMWANT,
        }),
      },
      dht: true,
      lsd: true,
      utp: true,
      natUpnp: true,
      natPmp: true,
      webSeeds: true,
      downloadLimit: -1,
      uploadLimit: -1,
      uploads: 16,
      maxConns: CLIENT_MAX_CONNS,
      ...(configuredTorrentPort ? { torrentPort: configuredTorrentPort, dhtPort: configuredTorrentPort } : {}),
    });

    if (configuredTorrentPort) {
      writeLog('debug', 'client.listen_port_configured', 'Using configured BT listening port', {
        port: configuredTorrentPort,
      });
    }

    client.on('error', (err) => {
      writeLog('error', 'client.error', 'WebTorrent client error', { error: err.message });
      sendMessage({ type: 'error', message: err.message });
    });

    return client;
  })
  .catch((err) => {
    writeLog('error', 'client.initialize_failed', 'Failed to initialize WebTorrent', {
      error: err.message,
    });
    sendMessage({ type: 'error', message: err.message });
    throw err;
  });

async function ensureClientReady() {
  try {
    await clientReady;
  } catch (err) {
    throw new Error(err?.message || String(err));
  }

  if (!client) {
    throw new Error('WebTorrent client did not initialize');
  }

  return client;
}

let httpServer = null;
let httpPort = null;
let currentTorrent = null;
let fullCacheEnabled = false;
let fullCacheFileIndex = null;
let fullCacheGeneration = 0;
let fullCacheWorker = null;
let activeStreamCacheDir = null;
let activeStreamCachePersistent = false;
let activeStreamCacheManifestPath = null;
let activeStreamCacheKey = null;
let activeStreamCacheRoot = null;
let activeStreamCacheLimitBytes = 0;
let lastPersistedCacheBytes = 0;
let pendingReceivedBytes = 0;
let lastDownloadProgressTime = 0;
let currentTrackerStats = {
  peers: 0,
  seeders: 0,
  leechers: 0,
};

function resetTrackerStats() {
  currentTrackerStats = {
    peers: 0,
    seeders: 0,
    leechers: 0,
  };
}

function updateTrackerStatsFromResponse(response) {
  const seeders = Number(response?.complete ?? response?.seeders ?? 0) || 0;
  const leechers = Number(response?.incomplete ?? response?.leechers ?? 0) || 0;

  currentTrackerStats = {
    peers: seeders + leechers,
    seeders,
    leechers,
  };
}

function attachTrackerStats(torrent) {
  const trackerClient = torrent?.discovery?.tracker;
  if (!trackerClient || trackerClient.__streameeTrackerStatsAttached) return;

  trackerClient.__streameeTrackerStatsAttached = true;
  trackerClient.on('update', updateTrackerStatsFromResponse);
}

function enhanceMagnet(magnetUri) {
  if (!magnetUri || !magnetUri.startsWith('magnet:?')) {
    return magnetUri;
  }

  const existingTrackers = new Set();
  for (const match of magnetUri.matchAll(/[?&]tr=([^&]+)/g)) {
    try {
      existingTrackers.add(decodeURIComponent(match[1]));
    } catch {
      existingTrackers.add(match[1]);
    }
  }

  const fallbackTrackers = TRACKERS
    .filter(tracker => !existingTrackers.has(tracker))
    .map(tracker => `tr=${encodeURIComponent(tracker)}`);

  if (fallbackTrackers.length === 0) {
    return magnetUri;
  }

  return `${magnetUri}${magnetUri.includes('?') ? '&' : '?'}${fallbackTrackers.join('&')}`;
}

function persistentCacheKey(identity) {
  return crypto.createHash('sha1').update(identity).digest('hex');
}

function readPersistentCacheManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function prunePersistentStreamCache(root, limitBytes, excludedDirectory = null) {
  if (!root || !Number.isSafeInteger(limitBytes) || limitBytes <= 0 || !fs.existsSync(root)) return;
  const entries = [];
  let residentTotal = 0;
  for (const child of fs.readdirSync(root, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const entryDirectory = path.join(root, child.name);
    const manifest = readPersistentCacheManifest(path.join(entryDirectory, 'manifest.json'));
    if (!manifest) {
      if (entryDirectory !== excludedDirectory) cleanupStreamCacheDirectory(entryDirectory);
      continue;
    }
    const residentBytes = Number.isSafeInteger(manifest.resident_bytes)
      ? Math.max(0, manifest.resident_bytes)
      : 0;
    residentTotal += residentBytes;
    entries.push({
      entryDirectory,
      residentBytes,
      lastAccessMs: Number.isSafeInteger(manifest.last_access_ms) ? manifest.last_access_ms : 0,
    });
  }
  entries.sort((a, b) => a.lastAccessMs - b.lastAccessMs);
  for (const entry of entries) {
    if (residentTotal <= limitBytes) break;
    if (entry.entryDirectory === excludedDirectory) continue;
    cleanupStreamCacheDirectory(entry.entryDirectory);
    residentTotal = Math.max(0, residentTotal - entry.residentBytes);
    writeLog('debug', 'cache.persistent_item_evicted', 'Evicted persistent stream cache item', {
      directory: entry.entryDirectory,
      bytes: entry.residentBytes,
      remainingBytes: residentTotal,
      limitBytes,
    });
  }
}

function persistActiveStreamCache(force = false) {
  if (!activeStreamCachePersistent || !activeStreamCacheManifestPath || !currentTorrent) return;
  const residentBytes = Math.max(0, Number(currentTorrent.downloaded) || 0);
  if (!force && residentBytes - lastPersistedCacheBytes < PERSISTENT_CACHE_UPDATE_BYTES) return;
  const manifest = {
    version: PERSISTENT_CACHE_VERSION,
    cache_key: activeStreamCacheKey,
    provider: 'webtorrent',
    total_size: Math.max(0, Number(currentTorrent.length) || 0),
    resident_bytes: residentBytes,
    last_access_ms: Date.now(),
    covered_ranges: [],
    resident_blocks: [],
  };
  const temporaryPath = `${activeStreamCacheManifestPath}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(manifest));
    fs.renameSync(temporaryPath, activeStreamCacheManifestPath);
    lastPersistedCacheBytes = residentBytes;
    prunePersistentStreamCache(
      activeStreamCacheRoot,
      activeStreamCacheLimitBytes,
      activeStreamCacheDir,
    );
  } catch (err) {
    writeLog('warn', 'cache.index_persist_failed', 'Failed to persist stream cache index', {
      error: err.message,
    });
  }
}

function requestTorrentSource(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, (res) => {
      resolve(res);
    });
    req.on('error', reject);
  });
}

async function resolveTorrentSource(source, redirectCount = 0) {
  if (!source || !/^https?:/i.test(source)) {
    return source;
  }

  if (redirectCount > 5) {
    throw new Error('Too many redirects while resolving torrent source');
  }

  const response = await requestTorrentSource(source);
  const statusCode = response.statusCode || 0;

  if (statusCode >= 300 && statusCode < 400) {
    const location = response.headers.location;
    response.resume();

    if (!location) {
      throw new Error(`Redirect missing location for torrent source: ${source}`);
    }

    const resolvedLocation = new URL(location, source).toString();
    writeLog('debug', 'metadata.redirect_resolved', 'Resolved torrent redirect', {
      source_url: source,
      resolved_url: resolvedLocation,
    });

    if (resolvedLocation.startsWith('magnet:?')) {
      return resolvedLocation;
    }

    if (/^https?:/i.test(resolvedLocation)) {
      return resolveTorrentSource(resolvedLocation, redirectCount + 1);
    }

    throw new Error(`Unsupported torrent redirect target: ${resolvedLocation}`);
  }

  if (statusCode < 200 || statusCode >= 300) {
    response.resume();
    throw new Error(`Torrent source request failed with status ${statusCode}`);
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      const torrentBuffer = Buffer.concat(chunks);
      if (!torrentBuffer.length) {
        reject(new Error('Torrent source returned an empty response'));
        return;
      }

      writeLog('debug', 'metadata.download_complete', 'Downloaded torrent metadata', {
        bytes: torrentBuffer.length,
      });
      resolve(torrentBuffer);
    });
    response.on('error', reject);
  });
}

function parseByteRange(range, fileLength) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match || (!match[1] && !match[2]) || fileLength <= 0) return null;

  if (!match[1]) {
    const suffixLength = parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return [Math.max(0, fileLength - suffixLength), fileLength - 1];
  }

  const start = parseInt(match[1], 10);
  const requestedEnd = match[2] ? parseInt(match[2], 10) : fileLength - 1;
  if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start >= fileLength || requestedEnd < start) {
    return null;
  }
  return [start, Math.min(requestedEnd, fileLength - 1)];
}

function getOnDemandChunkEnd(fileLength, start, requestedEnd) {
  const tailStart = Math.max(0, fileLength - TAIL_SEGMENT_BYTES);
  if (start >= tailStart) return requestedEnd;

  const segmentStart = Math.floor(start / FORWARD_SEGMENT_BYTES) * FORWARD_SEGMENT_BYTES;
  const segmentEnd = Math.min(
    segmentStart + FORWARD_SEGMENT_BYTES - 1,
    tailStart - 1,
    fileLength - 1,
  );
  return Math.min(requestedEnd, segmentEnd);
}

function pipeRangeOnDemand(res, file, start, end, logTag) {
  let nextStart = start;
  let activeStream = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (activeStream) activeStream.destroy();
  };
  res.on('close', stop);
  res.on('error', stop);

  const pipeNext = () => {
    if (stopped) return;
    if (nextStart > end) {
      res.end();
      return;
    }

    const chunkStart = nextStart;
    const chunkEnd = getOnDemandChunkEnd(file.length, chunkStart, end);
    writeLog('debug', 'stream.selection_active', `${logTag} active selection`, {
      start: chunkStart,
      end: chunkEnd,
      selectionSize: chunkEnd - chunkStart + 1,
    });

    const stream = file.createReadStream({ start: chunkStart, end: chunkEnd });
    activeStream = stream;
    stream.on('error', (err) => {
      writeLog('error', 'stream.selection_error', `${logTag} stream error`, {
        start: chunkStart,
        end: chunkEnd,
        error: err.message,
      });
      stop();
      if (!res.writableEnded) res.end();
    });
    stream.on('end', () => {
      if (stopped || activeStream !== stream) return;
      activeStream = null;
      nextStart = chunkEnd + 1;
      pipeNext();
    });
    stream.pipe(res, { end: false });
  };

  pipeNext();
}

function stopFullCacheWorker(clearConfiguration = false) {
  fullCacheGeneration += 1;
  if (fullCacheWorker?.stream) {
    fullCacheWorker.stream.destroy();
  }
  fullCacheWorker = null;
  if (clearConfiguration) {
    fullCacheEnabled = false;
    fullCacheFileIndex = null;
  }
}

function firstUncachedFileByte(file, start, end) {
  const torrent = currentTorrent;
  const pieceLength = torrent?.pieceLength || 0;
  if (!torrent || pieceLength <= 0 || start > end) return null;
  const fileOffset = Number.isFinite(file.offset) ? file.offset : 0;
  const firstPiece = Math.floor((fileOffset + start) / pieceLength);
  const lastPiece = Math.floor((fileOffset + end) / pieceLength);
  for (let pieceIndex = firstPiece; pieceIndex <= lastPiece; pieceIndex += 1) {
    if (!isTorrentPieceCached(torrent, pieceIndex)) {
      return Math.max(start, (pieceIndex * pieceLength) - fileOffset);
    }
  }
  return null;
}

function runFullCachePass(file, start, end, generation, phase, priorityStart) {
  if (!fullCacheEnabled || generation !== fullCacheGeneration || start > end) return;
  const stream = file.createReadStream({ start, end });
  fullCacheWorker = {
    stream,
    phase,
    cursor: start,
    priorityStart,
  };
  writeLog('info', 'cache.full_pass_started', 'Full stream cache pass started', {
    phase,
    start,
    end,
    priorityStart,
  });
  stream.on('data', (chunk) => {
    if (generation === fullCacheGeneration && fullCacheWorker?.stream === stream) {
      fullCacheWorker.cursor += chunk.length;
    }
  });
  stream.on('error', (err) => {
    if (generation !== fullCacheGeneration) return;
    writeLog('warn', 'cache.full_pass_failed', 'Full stream cache pass failed', {
      phase,
      start,
      end,
      error: err.message,
    });
    if (fullCacheWorker?.stream === stream) fullCacheWorker = null;
  });
  stream.on('end', () => {
    if (generation !== fullCacheGeneration || fullCacheWorker?.stream !== stream) return;
    if (phase === 'forward' && priorityStart > 0) {
      const backfillEnd = priorityStart - 1;
      const backfillStart = firstUncachedFileByte(file, 0, backfillEnd);
      if (backfillStart != null) {
        runFullCachePass(
          file,
          backfillStart,
          backfillEnd,
          generation,
          'backfill',
          priorityStart,
        );
        return;
      }
    }
    writeLog('info', 'cache.full_pass_complete', 'Full stream cache pass completed', {
      phase,
      priorityStart,
    });
    fullCacheWorker = null;
  });
  stream.resume();
}

function prioritizeFullCache(file, fileIndex, start) {
  if (!fullCacheEnabled || fileIndex !== fullCacheFileIndex || file.length <= 0) return;
  const tailStart = Math.max(0, file.length - TAIL_SEGMENT_BYTES);
  if (start >= tailStart) return;

  const uncachedStart = firstUncachedFileByte(file, start, start);
  if (fullCacheWorker) {
    if (uncachedStart == null) return;
    if (
      fullCacheWorker.phase === 'forward'
      && start <= fullCacheWorker.cursor + FULL_CACHE_SEEK_TOLERANCE_BYTES
    ) {
      return;
    }
  }

  stopFullCacheWorker(false);
  const generation = fullCacheGeneration;
  runFullCachePass(file, start, file.length - 1, generation, 'forward', start);
}

function isTorrentPieceCached(torrent, pieceIndex) {
  const buf = getBitfieldBuffer(torrent?.bitfield);
  if (!buf || !Number.isInteger(pieceIndex) || pieceIndex < 0) return false;
  const byteIndex = pieceIndex >> 3;
  const bitIndex = 7 - (pieceIndex % 8);
  return byteIndex < buf.length && (buf[byteIndex] & (1 << bitIndex)) !== 0;
}

function serveCacheOnlyRange(req, res, file, start, end, statusCode, logTag) {
  const torrent = currentTorrent;
  const pieceLength = torrent?.pieceLength || 0;
  const fileOffset = Number.isFinite(file.offset) ? file.offset : 0;
  const firstPiece = pieceLength > 0 ? Math.floor((fileOffset + start) / pieceLength) : -1;
  if (!torrent || pieceLength <= 0 || !isTorrentPieceCached(torrent, firstPiece)) {
    res.writeHead(425, { 'Content-Length': 0, 'Connection': 'close' });
    res.end();
    return;
  }

  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': getContentType(file.name),
  };
  if (statusCode === 206) {
    headers['Content-Range'] = `bytes ${start}-${end}/${file.length}`;
  }
  res.writeHead(statusCode, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  let nextStart = start;
  let pollTimer = null;
  let missingSince = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
  };
  res.on('close', stop);
  res.on('error', stop);

  const pipeNextCachedPiece = () => {
    if (stopped) return;
    if (nextStart > end || currentTorrent !== torrent) {
      res.end();
      return;
    }

    const torrentPosition = fileOffset + nextStart;
    const pieceIndex = Math.floor(torrentPosition / pieceLength);
    if (!isTorrentPieceCached(torrent, pieceIndex)) {
      if (!missingSince) missingSince = Date.now();
      if (Date.now() - missingSince >= CACHE_ONLY_IDLE_TIMEOUT_MS) {
        writeLog('debug', 'stream.cache_only_wait_stopped', `${logTag} stopped at uncached piece`, {
          pieceIndex,
          nextStart,
        });
        res.end();
        return;
      }
      pollTimer = setTimeout(pipeNextCachedPiece, CACHE_ONLY_POLL_MS);
      return;
    }

    missingSince = 0;
    const pieceEndInFile = ((pieceIndex + 1) * pieceLength) - fileOffset - 1;
    const chunkEnd = Math.min(end, pieceEndInFile);
    const pieceOffset = torrentPosition % pieceLength;
    const chunkLength = chunkEnd - nextStart + 1;
    writeLog('debug', 'stream.verified_cache_served', `${logTag} serving verified cache`, {
      pieceIndex,
      start: nextStart,
      end: chunkEnd,
    });
    torrent.store.get(pieceIndex, { offset: pieceOffset, length: chunkLength }, (err, buffer) => {
      if (stopped) return;
      if (err || !buffer) {
        writeLog('warn', 'stream.cached_piece_read_failed', `${logTag} cached piece read failed`, {
          error: err?.message || 'empty piece',
        });
        stop();
        if (!res.writableEnded) res.end();
        return;
      }
      nextStart = chunkEnd + 1;
      res.write(buffer, pipeNextCachedPiece);
    });
  };

  pipeNextCachedPiece();
}

function handleRangeRequest(req, res, file, fileIndex, logTag, cacheOnly = false) {
  const range = req.headers.range;
  if (!range) return false;

  const parsedRange = parseByteRange(range, file.length);
  if (!parsedRange) {
    res.writeHead(416, { 'Content-Range': `bytes */${file.length}` });
    res.end();
    return true;
  }
  const [start, requestedEnd] = parsedRange;
  const end = requestedEnd;
  const buf = getBitfieldBuffer(currentTorrent.bitfield);

  writeLog('debug', 'stream.range_requested', `${logTag} range request`, {
    start,
    requestedEnd,
    end,
    rangeSize: end - start + 1,
    bitfieldLen: buf ? buf.length : 0,
    fileDownloaded: file.downloaded,
  });

  if (cacheOnly) {
    serveCacheOnlyRange(req, res, file, start, end, 206, `${logTag} cache-only range`);
    return true;
  }

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${file.length}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': (end - start + 1),
    'Content-Type': getContentType(file.name),
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  if (logTag === 'Stream') {
    prioritizeFullCache(file, fileIndex, start);
  }

  pipeRangeOnDemand(res, file, start, end, `${logTag} range`);
  return true;
}

function createHttpServer() {
  return http.createServer((req, res) => {
    if (!currentTorrent) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Accept-Ranges': 'bytes' });
      res.end('No torrent loaded');
      return;
    }

    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const requestPath = requestUrl.pathname;
    const cacheOnly = req.headers['x-streamee-cache-only'] === '1'
      || requestUrl.searchParams.get('streamee-cache-only') === '1';

    // /whisper/<index> - seekable full-file endpoint for ffmpeg/Whisper.
    const whisperMatch = requestPath.match(/^\/whisper\/(\d+)$/);
    if (whisperMatch) {
      const fileIndex = parseInt(whisperMatch[1], 10);
      const file = currentTorrent.files[fileIndex];

      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Accept-Ranges': 'bytes' });
        res.end('File not found');
        return;
      }

      if (handleRangeRequest(req, res, file, fileIndex, 'Whisper', cacheOnly)) return;

      if (cacheOnly) {
        serveCacheOnlyRange(req, res, file, 0, file.length - 1, 200, 'Whisper cache-only');
        return;
      }

      writeLog('debug', 'stream.whisper_full_file_requested', 'Whisper full-file request', {
        fileSize: file.length,
        fileDownloaded: file.downloaded,
      });

      res.writeHead(200, {
        'Content-Length': file.length,
        'Accept-Ranges': 'bytes',
        'Content-Type': getContentType(file.name),
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      pipeRangeOnDemand(res, file, 0, file.length - 1, 'Whisper full-file');
      return;
    }

    const urlMatch = requestPath.match(/^\/stream\/(\d+)$/);
    if (!urlMatch) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Accept-Ranges': 'bytes' });
      res.end('Invalid path');
      return;
    }

    const fileIndex = parseInt(urlMatch[1], 10);
    const file = currentTorrent.files[fileIndex];

    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Accept-Ranges': 'bytes' });
      res.end('File not found');
      return;
    }

    if (handleRangeRequest(req, res, file, fileIndex, 'Stream', cacheOnly)) return;

    if (cacheOnly) {
      serveCacheOnlyRange(req, res, file, 0, file.length - 1, 200, 'Stream cache-only');
      return;
    }

    const buf = getBitfieldBuffer(currentTorrent.bitfield);
    const totalPieces = currentTorrent.pieces ? currentTorrent.pieces.length : 0;
    const pieceLength = currentTorrent.pieceLength || 0;
    writeLog('debug', 'stream.full_requested', 'Full stream request', {
      fileSize: file.length,
      pieceLength,
      totalPieces,
      bitfieldLen: buf ? buf.length : 0,
      downloaded: currentTorrent.downloaded,
      fileDownloaded: file.downloaded,
    });

    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': file.length,
      'Content-Type': getContentType(file.name),
    });

    if (req.method === 'HEAD') {
      writeLog('debug', 'stream.head_probe', 'Full stream HEAD probe', {
        fileSize: file.length,
        downloaded: currentTorrent.downloaded,
        fileDownloaded: file.downloaded,
      });
      res.end();
      return;
    }

    prioritizeFullCache(file, fileIndex, 0);
    pipeRangeOnDemand(res, file, 0, file.length - 1, 'Full stream');
  });
}

function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.m4v': 'video/m4v',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
  };
  return types[ext] || 'application/octet-stream';
}

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let currentTorrentMetadataReady = false;

function mapTorrentFile(f, i) {
  const relativePath = f.path || f.name;
  return {
    name: f.name,
    size: f.length,
    index: i,
    path: activeStreamCacheDir
      ? path.join(activeStreamCacheDir, relativePath)
      : relativePath,
    downloaded: f.downloaded || 0,
    progress: f.length > 0 ? ((f.downloaded || 0) / f.length) * 100 : 0,
  };
}

function getRawTorrentStore(torrent) {
  let store = torrent?.store;
  const visited = new Set();
  while (store?.store && !visited.has(store)) {
    visited.add(store);
    store = store.store;
  }
  return store;
}

async function markTorrentStoreSparse(torrent) {
  if (process.platform !== 'win32') return;

  let nativeFs;
  try {
    nativeFs = require('fs-native-extensions');
  } catch (err) {
    throw new Error(`Sparse WebTorrent storage is unavailable: ${err.message}`);
  }
  if (typeof nativeFs.sparse !== 'function') {
    throw new Error('Sparse WebTorrent storage is unavailable: native sparse support is missing');
  }

  const store = getRawTorrentStore(torrent);
  const files = Array.isArray(store?.files) ? store.files : [];
  if (files.length === 0) {
    throw new Error('Sparse WebTorrent storage could not locate its backing files');
  }

  for (const file of files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    const descriptor = fs.openSync(file.path, 'a+');
    try {
      await nativeFs.sparse(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  writeLog('info', 'cache.sparse_session_ready', 'Sparse session cache ready', {
    directory: activeStreamCacheDir,
    files: files.length,
  });
}

async function destroyCurrentTorrent() {
  stopFullCacheWorker(true);
  if (currentTorrent) {
    persistActiveStreamCache(true);
    await new Promise(resolve => currentTorrent.destroy({ destroyStore: !activeStreamCachePersistent }, resolve));
    currentTorrent = null;
  }

  if (activeStreamCacheDir && !activeStreamCachePersistent) {
    cleanupStreamCacheDirectory(activeStreamCacheDir);
  }
  activeStreamCacheDir = null;
  activeStreamCachePersistent = false;
  activeStreamCacheManifestPath = null;
  activeStreamCacheKey = null;
  activeStreamCacheRoot = null;
  activeStreamCacheLimitBytes = 0;
  lastPersistedCacheBytes = 0;
}

function getBitfieldBuffer(bitfield) {
  if (!bitfield) return null;
  // BitField instance from 'bitfield' npm package — data is in .buffer (Uint8Array)
  if (bitfield.buffer instanceof Uint8Array) return bitfield.buffer;
  // Already a Buffer/Uint8Array
  if (bitfield instanceof Uint8Array) return bitfield;
  return null;
}
function extractMagnetInfoHash(magnetUri) {
  try {
    const parsed = new URL(magnetUri);
    const xt = parsed.searchParams.get('xt');
    if (!xt) return null;

    const match = xt.match(/^urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})$/);
    if (!match) return null;

    return match[1].toLowerCase();
  } catch {
    return null;
  }
}

function findExistingTorrent(infoHash) {
  if (!infoHash || !client) return null;
  return client.torrents.find((torrent) => torrent && torrent.infoHash === infoHash) || null;
}

function waitForTick(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getProgress() {
  if (!currentTorrent) {
    return {
      downloaded: 0,
      total: 0,
      progress: 0,
      download_speed: 0,
      status: 'idle',
      files: [],
      pieces: 0,
      downloaded_pieces: 0,
      bitfield: [],
      peers: 0,
      connected_peers: 0,
      tracker_peers: 0,
      seeders: 0,
      leechers: 0,
      metadata_ready: false,
      file_count: 0,
    };
  }

  const downloaded = currentTorrent.downloaded || 0;
  const total = currentTorrent.length || 0;
  const progress = total > 0 ? (downloaded / total) * 100 : 0;
  const download_speed = currentTorrent.downloadSpeed || 0;

  let status = 'getting_metadata';
  if (currentTorrentMetadataReady && currentTorrent.files && currentTorrent.files.length > 0) {
    status = currentTorrent.paused ? 'paused' : 'downloading';
  }
  if (currentTorrent.done) {
    status = 'seeding';
  }

  const files = currentTorrentMetadataReady ? currentTorrent.files.map((f, i) => mapTorrentFile(f, i)) : [];

  const buf = getBitfieldBuffer(currentTorrent.bitfield);
  const totalPieces = currentTorrent.pieces ? currentTorrent.pieces.length : 0;
  let downloadedPieces = 0;
  let bitfieldArray = [];

  if (buf) {
    bitfieldArray = Array.from(buf);
    for (let i = 0; i < totalPieces; i++) {
      const byteIndex = i >> 3;
      const bitIndex = 7 - (i % 8);
      if (byteIndex < buf.length && (buf[byteIndex] & (1 << bitIndex)) !== 0) {
        downloadedPieces++;
      }
    }
  }

  const connectedPeers = currentTorrent.numPeers || 0;
  const trackerPeers = currentTrackerStats.peers || 0;
  const seeders = currentTrackerStats.seeders || 0;
  const leechers = currentTrackerStats.leechers || 0;
  
  return {
    downloaded,
    total,
    progress,
    download_speed,
    status,
    files,
    pieces: totalPieces,
    downloaded_pieces: downloadedPieces,
    bitfield: bitfieldArray,
    peers: connectedPeers,
    connected_peers: connectedPeers,
    tracker_peers: trackerPeers,
    seeders,
    leechers,
    metadata_ready: currentTorrentMetadataReady,
    file_count: currentTorrentMetadataReady ? files.length : 0,
  };
}

function resetDownloadTransferTelemetry() {
  pendingReceivedBytes = 0;
  lastDownloadProgressTime = 0;
}

function emitDownloadTransferProgress(force = false) {
  if (!currentTorrent || pendingReceivedBytes <= 0) return;

  const now = Date.now();
  if (!force && now - lastDownloadProgressTime < 250) return;

  const receivedDelta = pendingReceivedBytes;
  pendingReceivedBytes = 0;
  lastDownloadProgressTime = now;
  sendMessage({
    type: 'progress',
    ...getProgress(),
    received_delta: receivedDelta,
  });
}

function recordDownloadedBytes(bytes) {
  const received = Number(bytes);
  if (!Number.isFinite(received) || received <= 0) return;
  pendingReceivedBytes += received;
  persistActiveStreamCache();
  emitDownloadTransferProgress();
}

async function startTorrent(magnetUri, cacheOptions = {}) {
  await ensureClientReady();

  if (currentTorrent) {
    emitDownloadTransferProgress(true);
    await destroyCurrentTorrent();
    await waitForTick(250);
    currentTorrentMetadataReady = false;
    resetDownloadTransferTelemetry();
    resetTrackerStats();
  }

  const resolvedTorrentSource = await resolveTorrentSource(magnetUri);
  const enhancedMagnet = typeof resolvedTorrentSource === 'string'
    ? enhanceMagnet(resolvedTorrentSource)
    : resolvedTorrentSource;
  const infoHash = typeof enhancedMagnet === 'string'
    ? extractMagnetInfoHash(enhancedMagnet)
    : null;
  const existingTorrent = findExistingTorrent(infoHash);

  if (existingTorrent) {
    writeLog('info', 'torrent.reused', 'Reusing existing torrent instead of adding duplicate', {
      info_hash: infoHash,
    });
    currentTorrent = existingTorrent;
    resetDownloadTransferTelemetry();
    if (existingTorrent.pieces?.length) {
      existingTorrent.deselect(0, existingTorrent.pieces.length - 1);
    }
    currentTorrentMetadataReady = !!(existingTorrent.files && existingTorrent.files.length > 0);
    attachTrackerStats(existingTorrent);
    if (currentTorrentMetadataReady) {
      sendMessage({
        type: 'ready',
        status: 'ready',
        fileCount: existingTorrent.files.length,
        files: existingTorrent.files.map((f, i) => mapTorrentFile(f, i))
      });
    }
    return {
      name: existingTorrent.name,
      files: currentTorrentMetadataReady ? existingTorrent.files.map((f, i) => mapTorrentFile(f, i)) : [],
    };
  }

  const persistentRoot = typeof cacheOptions.persistentCacheRoot === 'string'
    ? cacheOptions.persistentCacheRoot.trim()
    : '';
  const persistentLimitBytes = Number(cacheOptions.persistentCacheLimitBytes);
  const expectedSize = Number(cacheOptions.expectedSize);
  const usePersistentCache = cacheOptions.persistentCacheEnabled === true
    && !!infoHash
    && !!persistentRoot
    && Number.isSafeInteger(persistentLimitBytes)
    && persistentLimitBytes > 0
    && Number.isSafeInteger(expectedSize)
    && expectedSize > 0
    && expectedSize <= persistentLimitBytes;

  if (usePersistentCache) {
    activeStreamCacheRoot = persistentRoot;
    activeStreamCacheLimitBytes = persistentLimitBytes;
    activeStreamCacheKey = persistentCacheKey(`webtorrent:${infoHash}`);
    activeStreamCacheDir = path.join(activeStreamCacheRoot, activeStreamCacheKey);
    activeStreamCacheManifestPath = path.join(activeStreamCacheDir, 'manifest.json');
    activeStreamCachePersistent = true;
    fs.mkdirSync(activeStreamCacheRoot, { recursive: true });
    const existingManifest = readPersistentCacheManifest(activeStreamCacheManifestPath);
    if (existingManifest && (
      existingManifest.version !== PERSISTENT_CACHE_VERSION
      || existingManifest.cache_key !== activeStreamCacheKey
      || existingManifest.provider !== 'webtorrent'
      || existingManifest.total_size !== expectedSize
    )) {
      cleanupStreamCacheDirectory(activeStreamCacheDir);
    }
    prunePersistentStreamCache(activeStreamCacheRoot, activeStreamCacheLimitBytes, activeStreamCacheDir);
  } else {
    streamCacheSequence += 1;
    activeStreamCacheDir = path.join(
      STREAM_CACHE_ROOT,
      `${process.pid}-${streamCacheSequence}-${Date.now()}`,
    );
  }
  fs.mkdirSync(activeStreamCacheDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const addOptions = {
      path: activeStreamCacheDir,
      deselect: true,
      destroyStoreOnDestroy: !activeStreamCachePersistent,
    };
    client.add(enhancedMagnet, addOptions, async (torrent) => {
      currentTorrent = torrent;
      resetDownloadTransferTelemetry();

      // Report actual peer bytes, including retries, without treating cached pieces as transfers.
      torrent.on('download', recordDownloadedBytes);

      torrent.on('error', (err) => {
        sendMessage({ type: 'error', message: err.message });
      });

      try {
        await markTorrentStoreSparse(torrent);
      } catch (err) {
        await destroyCurrentTorrent();
        reject(err);
        return;
      }

      if (activeStreamCachePersistent && torrent.length > activeStreamCacheLimitBytes) {
        writeLog('info', 'cache.persistent_disabled_oversized', 'Persistent cache disabled for oversized torrent', {
          totalSize: torrent.length,
          limitBytes: activeStreamCacheLimitBytes,
        });
        activeStreamCachePersistent = false;
        activeStreamCacheManifestPath = null;
      } else {
        persistActiveStreamCache(true);
      }

      // Retain every verified piece for this playback session. Live eviction
      // must also invalidate WebTorrent's bitfield and peer availability; an
      // earlier store-only LRU caused read failures after pieces were evicted.

      // Check if metadata already available (for non-magnet torrents)
      if (torrent.files && torrent.files.length > 0) {
        writeLog('debug', 'torrent.files_immediately_available', 'Torrent files available immediately', {
          file_count: torrent.files.length,
        });
        currentTorrentMetadataReady = true;
        attachTrackerStats(torrent);
        sendMessage({
          type: 'ready', 
          status: 'ready', 
          fileCount: torrent.files.length,
          files: torrent.files.map((f, i) => mapTorrentFile(f, i))
        });
        resolve({
          name: torrent.name,
          files: torrent.files.map((f, i) => mapTorrentFile(f, i)),
        });
        return;
      }

      // For magnets, wait for metadata event
      writeLog('debug', 'torrent.metadata_waiting', 'Waiting for torrent metadata');
      torrent.on('metadata', () => {
        writeLog('info', 'torrent.metadata_received', 'Torrent metadata received', {
          file_count: torrent.files.length,
        });
        currentTorrentMetadataReady = true;
        attachTrackerStats(torrent);
        sendMessage({
          type: 'ready', 
          status: 'ready', 
          fileCount: torrent.files.length, 
          files: torrent.files.map((f, i) => mapTorrentFile(f, i)) 
        });
        resolve({
          name: torrent.name,
          files: torrent.files.map((f, i) => mapTorrentFile(f, i)),
        });
      });

    });

    // Note: client.on('error') is handled globally at line 46 — no duplicate listener here
  });
}

async function stopTorrent() {
  await clientReady.catch(() => {});
  if (currentTorrent) {
    emitDownloadTransferProgress(true);
    await destroyCurrentTorrent();
    await waitForTick(250);
    currentTorrentMetadataReady = false;
    resetDownloadTransferTelemetry();
    resetTrackerStats();
  }
  sendMessage({ type: 'status', status: 'stopped' });
}

function pauseTorrent() {
  if (currentTorrent) {
    currentTorrent.pause();
    sendMessage({ type: 'status', status: 'paused' });
  }
}

function resumeTorrent() {
  if (currentTorrent) {
    currentTorrent.resume();
    sendMessage({ type: 'status', status: 'downloading' });
  }
}

function getFiles() {
  if (!currentTorrent) return [];
  return currentTorrent.files.map((f, i) => mapTorrentFile(f, i));
}

function getStreamUrl(fileIndex) {
  if (!currentTorrent || !httpPort) return null;
  const file = currentTorrent.files[fileIndex];
  if (!file) return null;

  return `http://127.0.0.1:${httpPort}/stream/${fileIndex}`;
}

function getWhisperStreamUrl(fileIndex) {
  if (!currentTorrent || !httpPort) return null;
  const file = currentTorrent.files[fileIndex];
  if (!file) return null;

  return `http://127.0.0.1:${httpPort}/whisper/${fileIndex}`;
}

function getHealth() {
  return {
    status: currentTorrent ? (currentTorrentMetadataReady ? 'active' : 'waiting_for_metadata') : 'idle',
    metadata_ready: !!currentTorrentMetadataReady,
    file_count: currentTorrentMetadataReady && currentTorrent?.files ? currentTorrent.files.length : 0,
    port: httpPort,
  };
}

function initServer() {
  return new Promise((resolve, reject) => {
    httpServer = createHttpServer();
    
    httpServer.listen(0, '127.0.0.1', () => {
      httpPort = httpServer.address().port;
      sendMessage({ type: 'port', port: httpPort });
      resolve(httpPort);
    });

    httpServer.on('error', (err) => {
      sendMessage({ type: 'error', message: err.message });
      reject(err);
    });
  });
}

async function main() {
  try {
    await initServer();
    await ensureClientReady();
    sendMessage({ type: 'server_ready' });
  } catch (err) {
    writeLog('error', 'server.start_failed', 'Failed to start WebTorrent server', {
      error: err.message,
    });
    sendMessage({ type: 'error', message: 'Failed to start server: ' + err.message });
    // Do NOT exit - server will continue without the failed component
  }
}

process.stdin.setEncoding('utf8');

process.stdin.on('data', async (data) => {
  const lines = data.trim().split('\n');
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    try {
      const msg = JSON.parse(line);
      const { action, requestId } = msg;

      // Helper: echo requestId back in responses for Rust-side correlation
      const reply = (obj) => sendMessage(requestId != null ? { ...obj, requestId } : obj);

      switch (action) {
        case 'start': {
          try {
            await ensureClientReady();
            startTorrent(msg.magnet, {
              persistentCacheEnabled: msg.persistentCacheEnabled,
              persistentCacheRoot: msg.persistentCacheRoot,
              persistentCacheLimitBytes: msg.persistentCacheLimitBytes,
              expectedSize: msg.expectedSize,
            }).catch((err) => {
              sendMessage({ type: 'error', message: err.message || String(err) });
            });
            reply({ type: 'started', status: 'starting', metadata_ready: false, file_count: 0 });
          } catch (err) {
            reply({ type: 'error', message: err?.message || String(err) });
          }
          break;
        }
        case 'stop':
          await stopTorrent();
          reply({ type: 'stopped' });
          break;
        case 'pause':
          pauseTorrent();
          reply({ type: 'status', status: 'paused' });
          break;
        case 'resume':
          resumeTorrent();
          reply({ type: 'status', status: 'downloading' });
          break;
        case 'configure_full_cache': {
          stopFullCacheWorker(false);
          fullCacheEnabled = msg.enabled === true;
          fullCacheFileIndex = Number.isInteger(msg.fileIndex) ? msg.fileIndex : null;
          writeLog('info', 'cache.full_mode_configured', 'Full stream cache mode configured', {
            enabled: fullCacheEnabled,
            fileIndex: fullCacheFileIndex,
          });
          reply({ type: 'full_cache_configured', enabled: fullCacheEnabled });
          break;
        }
        case 'get_progress': {
          const progress = getProgress();
          reply({ type: 'progress', ...progress });
          break;
        }
        case 'get_files': {
          const files = getFiles();
          reply({ type: 'files', files });
          break;
        }
        case 'get_stream_url': {
          const url = getStreamUrl(msg.fileIndex);
          reply({ type: 'stream_url', url });
          break;
        }
        case 'get_whisper_stream_url': {
          const url = getWhisperStreamUrl(msg.fileIndex);
          reply({ type: 'whisper_stream_url', url });
          break;
        }
        case 'get_file_progress': {
          const fileIndex = msg.fileIndex;
          if (!currentTorrent || !currentTorrent.files || !currentTorrent.files[fileIndex]) {
            reply({ type: 'file_progress', fileIndex, downloaded: 0, total: 0, progress: 0, ready: false });
          } else {
            const f = currentTorrent.files[fileIndex];
            const downloaded = f.downloaded || 0;
            const total = f.length || 0;
            const fileProgress = total > 0 ? (downloaded / total) * 100 : 0;
            // Adaptive threshold: proportional to file size with min/max bounds
            const READY_MIN = 2 * 1024 * 1024;   // 2MB minimum
            const READY_MAX = 20 * 1024 * 1024;  // 20MB maximum
            const readyThreshold = Math.max(READY_MIN, Math.min(READY_MAX, total * 0.005));
            const ready = downloaded >= readyThreshold;
            reply({ type: 'file_progress', fileIndex, downloaded, total, progress: fileProgress, ready });
          }
          break;
        }
        case 'get_pieces': {
          if (!currentTorrent || !currentTorrent.pieces) {
            reply({ type: 'pieces', downloaded_pieces: 0, total_pieces: 0, bitfield: [] });
          } else {
            const totalPieces = currentTorrent.pieces.length;
            let downloadedCount = 0;
            let bitfieldArray = [];
            const buf = getBitfieldBuffer(currentTorrent.bitfield);
            if (buf) {
              bitfieldArray = Array.from(buf);
              for (let i = 0; i < totalPieces; i++) {
                const byteIndex = i >> 3;
                const bitIndex = 7 - (i % 8);
                if (byteIndex < buf.length && (buf[byteIndex] & (1 << bitIndex)) !== 0) {
                  downloadedCount++;
                }
              }
            }
            reply({ type: 'pieces', downloaded_pieces: downloadedCount, total_pieces: totalPieces, bitfield: bitfieldArray });
          }
          break;
        }
        case 'get_port': {
          reply({ type: 'port', port: httpPort });
          break;
        }
        case 'health': {
          reply({ type: 'health', ...getHealth() });
          break;
        }
        case 'reset_torrent_session': {
          await stopTorrent();
          reply({ type: 'status', status: 'reset' });
          break;
        }
        default:
          reply({ type: 'error', message: `Unknown action: ${action}` });
      }
    } catch (err) {
      sendMessage({ type: 'error', message: 'Failed to parse command: ' + err.message });
    }
  }
});

main();

process.on('exit', () => {
  persistActiveStreamCache(true);
  cleanupStreamCacheDirectory();
});
