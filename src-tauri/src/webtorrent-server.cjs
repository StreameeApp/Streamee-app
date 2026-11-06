const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns');

// DHT uses an IPv4 UDP socket; prefer matching addresses for dual-stack routers.
dns.setDefaultResultOrder('ipv4first');

const STREAM_CACHE_ROOT = path.join(os.tmpdir(), 'Streamee', 'webtorrent-stream-cache');
const PERSISTENT_CACHE_VERSION = 1;
const PERSISTENT_CACHE_UPDATE_BYTES = 64 * 1024 * 1024;
let streamCacheSequence = 0;

function cleanupStreamCacheDirectory(cacheDirectory = STREAM_CACHE_ROOT) {
  try {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
    if (fs.existsSync(cacheDirectory)) {
      throw new Error('Cache directory still exists after removal');
    }
    return true;
  } catch (err) {
    // Cache cleanup must not prevent the sidecar from reporting a useful
    // startup or playback error through its normal command channel.
    writeLog('error', 'cache.cleanup_failed', 'Failed to clear stream cache', {
      directory: cacheDirectory,
      error: err.message,
    });
    return false;
  }
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return err?.code === 'EPERM';
  }
}

// Session folders are named "<sidecar pid>-<sequence>-<time>". Another Streamee
// window's sidecar may be streaming from its folder right now, so only remove
// sessions whose sidecar has exited.
function cleanupStaleSessionCaches() {
  let children;
  try {
    children = fs.readdirSync(STREAM_CACHE_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    const ownerPid = Number.parseInt(child.name.split('-')[0], 10);
    if (child.isDirectory() && ownerPid !== process.pid && processIsRunning(ownerPid)) continue;
    cleanupStreamCacheDirectory(path.join(STREAM_CACHE_ROOT, child.name));
  }
}

cleanupStaleSessionCaches();
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

const CLIENT_MAX_CONNS = 150;
const CLIENT_NUMWANT = 82;
const FORWARD_SEGMENT_BYTES = 128 * 1024 * 1024;
const TAIL_SEGMENT_BYTES = 64 * 1024 * 1024;
const FULL_CACHE_SEEK_TOLERANCE_BYTES = 8 * 1024 * 1024;
const TORRENT_DESTROY_TIMEOUT_MS = 10_000;
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
let parentClosing = false;
let parseTorrentSource = null;
let WebTorrentClient = null;
let SafePathChunkStore = null;
let lastClientRebuildAt = 0;
const CLIENT_REBUILD_MIN_INTERVAL_MS = 5_000;

// Windows cannot create these characters, trailing dots/spaces, or device names.
const UNSAFE_PATH_CHARACTERS = /[<>:"|?*\u0000-\u001F]/g;
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function toSafePathSegment(segment) {
  let safe = segment.replace(UNSAFE_PATH_CHARACTERS, '').replace(/[. ]+$/, '');
  if (!safe) safe = '_';
  if (RESERVED_DEVICE_NAME.test(safe)) safe = `_${safe}`;
  return safe;
}

function toSafeStorePath(relativePath) {
  return String(relativePath)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(toSafePathSegment)
    .join(path.sep);
}

// fs-chunk-store only cleans the file name, so a folder such as "Title: Part 1"
// fails to open on Windows. Clean every path segment before the store sees it.
async function loadSafePathChunkStore() {
  try {
    const storeModule = await import('fs-chunk-store');
    const BaseStore = storeModule.default || storeModule;
    return class extends BaseStore {
      constructor(chunkLength, opts = {}) {
        super(chunkLength, Array.isArray(opts.files)
          ? {
            ...opts,
            files: opts.files.map((file) => ({
              path: toSafeStorePath(file.path),
              length: file.length,
              offset: file.offset,
            })),
          }
          : opts);
      }
    };
  } catch (err) {
    writeLog('warn', 'cache.safe_store_unavailable', 'Using default stream storage paths', {
      error: err.message,
    });
    return null;
  }
}

function createClient(useConfiguredPort) {
  const nextClient = new WebTorrentClient({
    tracker: {
      announce: ['udp://tracker.opentrackr.org:1337/announce'],
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
    ...(useConfiguredPort ? { torrentPort: configuredTorrentPort, dhtPort: configuredTorrentPort } : {}),
  });

  if (useConfiguredPort) {
    writeLog('debug', 'client.listen_port_configured', 'Using configured BT listening port', {
      port: configuredTorrentPort,
    });
  }

  nextClient.on('error', (err) => {
    writeLog('error', 'client.error', 'WebTorrent client error', { error: err.message });
    sendMessage({ type: 'error', message: err.message });
    if (nextClient === client && nextClient.destroyed) rebuildDestroyedClient(err);
  });

  return nextClient;
}

// A listener failure (for example, the configured port is taken) destroys the
// WebTorrent client, and every later add would throw. Replace it so the next
// start works, falling back to a random port when the configured one is busy.
function rebuildDestroyedClient(err) {
  const now = Date.now();
  if (now - lastClientRebuildAt < CLIENT_REBUILD_MIN_INTERVAL_MS) {
    writeLog('error', 'client.rebuild_skipped', 'WebTorrent client failed again; not rebuilding yet', {
      error: err.message,
    });
    return;
  }
  lastClientRebuildAt = now;
  // The destroyed client closed the current source with it.
  if (currentTorrent) sourceFailure = err.message;
  const portBusy = err?.code === 'EADDRINUSE' || err?.code === 'EACCES';
  writeLog('warn', 'client.rebuilding', 'Rebuilding destroyed WebTorrent client', {
    error: err.message,
    configured_port: configuredTorrentPort,
    using_random_port: !!configuredTorrentPort && portBusy,
  });
  client = createClient(!!configuredTorrentPort && !portBusy);
}

const clientReady = Promise.all([
  import('webtorrent'),
  import('parse-torrent'),
  loadSafePathChunkStore(),
])
  .then(([webTorrentModule, parseTorrentModule, safeStore]) => {
    WebTorrentClient = webTorrentModule.default || webTorrentModule;
    parseTorrentSource = parseTorrentModule.default || parseTorrentModule;
    SafePathChunkStore = safeStore;
    client = createClient(!!configuredTorrentPort);
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
let torrentSessionGeneration = 0;
// Identifies the source behind currentTorrent. Stream URLs carry it, so a
// player reconnecting after a source switch cannot read the new source's bytes.
let currentSourceId = 0;
// Why the current start or source failed; reported by health until the next start.
let sourceFailure = null;
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

// The app's own cache and this sidecar share the persistent cache folder and
// each prunes it. An entry in use holds this file with its owner's process id;
// neither pruner removes an entry whose owner is still running.
const PERSISTENT_CACHE_IN_USE_FILE = 'in-use.lock';

function persistentEntryInUseElsewhere(entryDirectory) {
  try {
    const ownerPid = Number.parseInt(
      fs.readFileSync(path.join(entryDirectory, PERSISTENT_CACHE_IN_USE_FILE), 'utf8'),
      10,
    );
    return ownerPid !== process.pid && processIsRunning(ownerPid);
  } catch {
    return false;
  }
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

function prunePersistentStreamCache(
  root,
  limitBytes,
  excludedDirectory = null,
  replacementTotalSize = null,
) {
  if (!root || !Number.isSafeInteger(limitBytes) || limitBytes <= 0 || !fs.existsSync(root)) return;
  const entries = [];
  let residentTotal = 0;
  for (const child of fs.readdirSync(root, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const entryDirectory = path.join(root, child.name);
    // Counted toward the limit, but never removed while its owner runs.
    const inUse = entryDirectory === excludedDirectory || persistentEntryInUseElsewhere(entryDirectory);
    const manifest = readPersistentCacheManifest(path.join(entryDirectory, 'manifest.json'));
    if (!manifest) {
      if (!inUse) cleanupStreamCacheDirectory(entryDirectory);
      continue;
    }
    const residentBytes = Number.isSafeInteger(manifest.resident_bytes)
      ? Math.max(0, manifest.resident_bytes)
      : 0;
    residentTotal += residentBytes;
    entries.push({
      entryDirectory,
      inUse,
      residentBytes,
      totalSize: Number.isSafeInteger(manifest.total_size) ? Math.max(0, manifest.total_size) : 0,
      lastAccessMs: Number.isSafeInteger(manifest.last_access_ms) ? manifest.last_access_ms : 0,
    });
  }
  if (Number.isSafeInteger(replacementTotalSize) && replacementTotalSize > 0) {
    const replacementIsOversized = replacementTotalSize > limitBytes;
    for (const entry of entries) {
      if (entry.inUse) continue;
      if (!replacementIsOversized && entry.totalSize <= limitBytes) continue;
      if (!cleanupStreamCacheDirectory(entry.entryDirectory)) continue;
      residentTotal = Math.max(0, residentTotal - entry.residentBytes);
      entry.removed = true;
      writeLog('debug', 'cache.persistent_item_replaced', 'Replaced persistent stream cache item', {
        directory: entry.entryDirectory,
        newTotalSize: replacementTotalSize,
        limitBytes,
      });
    }
  }
  entries.sort((a, b) => a.lastAccessMs - b.lastAccessMs);
  for (const entry of entries) {
    if (residentTotal <= limitBytes) break;
    if (entry.removed) continue;
    if (entry.inUse) continue;
    if (!cleanupStreamCacheDirectory(entry.entryDirectory)) continue;
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
  const bitfield = getBitfieldBuffer(currentTorrent.bitfield);
  if (bitfield) manifest.bitfield = Buffer.from(bitfield).toString('base64');
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

const TORRENT_SOURCE_TIMEOUT_MS = 20_000;
const TORRENT_SOURCE_MAX_BYTES = 32 * 1024 * 1024;

function requestTorrentSource(url) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.get(url, (res) => {
      resolve(res);
    });
    // Covers both connecting and a server that stops sending mid-body.
    req.setTimeout(TORRENT_SOURCE_TIMEOUT_MS, () => {
      req.destroy(new Error('Torrent source request timed out'));
    });
    req.on('error', reject);
  });
}

function normalizeMagnetUri(source) {
  if (typeof source !== 'string' || !source.startsWith('magnet:?')) return source;
  return source.replace(/([?&]xt=)([^&]*)/gi, (match, prefix, value) => {
    try {
      const decoded = decodeURIComponent(value);
      if (/^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(decoded)) {
        return `${prefix}${decoded}`;
      }
    } catch {
      // Keep invalid identifiers intact so the torrent parser reports the error.
    }
    return match;
  });
}

async function resolveTorrentSource(source, redirectCount = 0) {
  if (!source || !/^https?:/i.test(source)) {
    return normalizeMagnetUri(source);
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
      return normalizeMagnetUri(resolvedLocation);
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

  const declaredLength = Number(response.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > TORRENT_SOURCE_MAX_BYTES) {
    response.destroy();
    throw new Error(`Torrent source is too large (${declaredLength} bytes)`);
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    const fail = (err) => {
      response.destroy();
      reject(err);
    };
    response.on('data', (chunk) => {
      // A .torrent file is a bencoded dictionary; anything else (for example a
      // direct media link) is rejected before it is buffered into memory.
      if (receivedBytes === 0 && chunk.length > 0 && chunk[0] !== 0x64) {
        fail(new Error('Torrent source did not return torrent metadata'));
        return;
      }
      receivedBytes += chunk.length;
      if (receivedBytes > TORRENT_SOURCE_MAX_BYTES) {
        fail(new Error('Torrent source exceeded the metadata size limit'));
        return;
      }
      chunks.push(chunk);
    });
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

// A body shorter than its Content-Length must not idle on a keep-alive socket;
// closing it lets the client notice at once and request the remaining range.
function abortIncompleteResponse(res) {
  if (!res.destroyed) res.destroy();
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
      abortIncompleteResponse(res);
    });
    // File streams are streamx Readables, whose pipe() ignores { end: false }
    // and would end the response after the first segment. Write manually.
    stream.on('data', (chunk) => {
      if (stopped || activeStream !== stream) return;
      if (!res.write(chunk)) {
        stream.pause();
        res.once('drain', () => {
          if (!stopped && activeStream === stream) stream.resume();
        });
      }
    });
    stream.on('end', () => {
      if (stopped || activeStream !== stream) return;
      activeStream = null;
      nextStart = chunkEnd + 1;
      pipeNext();
    });
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

  // Start at the first missing byte. After a pass has finished, a seek must not
  // re-read the already cached remainder of the file from disk.
  const forwardStart = firstUncachedFileByte(file, start, file.length - 1);
  const backfillStart = forwardStart == null && start > 0
    ? firstUncachedFileByte(file, 0, start - 1)
    : null;
  if (forwardStart == null && backfillStart == null) return;

  stopFullCacheWorker(false);
  const generation = fullCacheGeneration;
  if (forwardStart != null) {
    runFullCachePass(file, forwardStart, file.length - 1, generation, 'forward', start);
  } else {
    runFullCachePass(file, backfillStart, start - 1, generation, 'backfill', start);
  }
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
    if (nextStart > end) {
      res.end();
      return;
    }
    if (currentTorrent !== torrent) {
      stop();
      abortIncompleteResponse(res);
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
        stop();
        abortIncompleteResponse(res);
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
        abortIncompleteResponse(res);
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

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// MPV and the transcription client connect directly. Reject a non-loopback Host
// (DNS rebinding) and any request a web page issued (browser fetch metadata).
function isTrustedLocalRequest(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host && !LOOPBACK_HOSTNAMES.has(host.replace(/:\d+$/, ''))) return false;
  const fetchSite = req.headers['sec-fetch-site'];
  return !fetchSite || fetchSite === 'none' || fetchSite === 'same-origin';
}

function createHttpServer() {
  return http.createServer((req, res) => {
    if (!isTrustedLocalRequest(req)) {
      writeLog('warn', 'stream.request_rejected', 'Rejected non-local stream request', {
        host: req.headers.host || null,
        fetchSite: req.headers['sec-fetch-site'] || null,
      });
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Connection': 'close' });
      res.end('Forbidden');
      return;
    }

    if (!currentTorrent) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Accept-Ranges': 'bytes' });
      res.end('No torrent loaded');
      return;
    }

    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const requestPath = requestUrl.pathname;
    const requestedSource = requestUrl.searchParams.get('source');
    if (requestedSource != null && requestedSource !== String(currentSourceId)) {
      res.writeHead(410, { 'Content-Type': 'text/plain', 'Connection': 'close' });
      res.end('This stream belongs to a source that was replaced');
      return;
    }
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
  if (parentClosing) return;
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let currentTorrentMetadataReady = false;

function mapTorrentFile(f, i) {
  const sourcePath = f.path || f.name;
  // Report the path the store actually wrote to.
  const relativePath = SafePathChunkStore ? toSafeStorePath(sourcePath) : sourcePath;
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
    const torrent = currentTorrent;
    persistActiveStreamCache(true);
    // WebTorrent never calls back for a source it already destroyed after an
    // error, so only wait for sources that are still alive.
    if (!torrent.destroyed) {
      const destroyed = new Promise((resolve) => {
        torrent.destroy({ destroyStore: !activeStreamCachePersistent }, () => resolve(true));
      });
      if (!await Promise.race([destroyed, waitForTick(TORRENT_DESTROY_TIMEOUT_MS).then(() => false)])) {
        writeLog('warn', 'torrent.destroy_timeout', 'Source did not finish closing; continuing', {
          timeout_ms: TORRENT_DESTROY_TIMEOUT_MS,
        });
      }
    }
    if (currentTorrent === torrent) currentTorrent = null;
  }

  if (activeStreamCacheDir && !activeStreamCachePersistent) {
    cleanupStreamCacheDirectory(activeStreamCacheDir);
  } else if (activeStreamCacheDir) {
    try {
      fs.rmSync(path.join(activeStreamCacheDir, PERSISTENT_CACHE_IN_USE_FILE), { force: true });
    } catch {
      // A stale marker names an exited process, which pruners treat as unused.
    }
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
function findExistingTorrent(infoHash) {
  if (!infoHash || !client) return null;
  return client.torrents.find(
    (torrent) => torrent && torrent.infoHash?.toLowerCase() === infoHash,
  ) || null;
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
  const generation = ++torrentSessionGeneration;
  sourceFailure = null;
  // The start command replies before the previous source is replaced. Until
  // then health and progress must not report that source as ready, or the app
  // would take its file list for the new source's.
  currentTorrentMetadataReady = false;
  await ensureClientReady();
  if (generation !== torrentSessionGeneration) return null;

  if (currentTorrent) {
    emitDownloadTransferProgress(true);
    await destroyCurrentTorrent();
    await waitForTick(250);
    if (generation !== torrentSessionGeneration) return null;
    currentTorrentMetadataReady = false;
    resetDownloadTransferTelemetry();
    resetTrackerStats();
  }

  const resolvedTorrentSource = await resolveTorrentSource(magnetUri);
  const parsedTorrentSource = await parseTorrentSource(resolvedTorrentSource);
  if (generation !== torrentSessionGeneration) return null;
  const infoHash = typeof parsedTorrentSource?.infoHash === 'string'
    ? parsedTorrentSource.infoHash.toLowerCase()
    : null;
  const existingTorrent = findExistingTorrent(infoHash);

  if (existingTorrent) {
    writeLog('info', 'torrent.reused', 'Reusing existing torrent instead of adding duplicate', {
      info_hash: infoHash,
    });
    currentTorrent = existingTorrent;
    currentSourceId = generation;
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
  const usePersistentCache = cacheOptions.persistentCacheEnabled === true
    && !!infoHash
    && !!persistentRoot
    && Number.isSafeInteger(persistentLimitBytes)
    && persistentLimitBytes > 0;

  let startupBitfield = null;
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
    )) {
      if (!cleanupStreamCacheDirectory(activeStreamCacheDir)) {
        throw new Error('Failed to reset an incompatible persistent WebTorrent cache');
      }
    } else if (typeof existingManifest?.bitfield === 'string') {
      // WebTorrent then spot-checks one piece per file instead of hashing the
      // whole cached title, and fully re-checks any file that fails.
      startupBitfield = Buffer.from(existingManifest.bitfield, 'base64');
    }
    prunePersistentStreamCache(
      activeStreamCacheRoot,
      activeStreamCacheLimitBytes,
      activeStreamCacheDir,
    );
  } else {
    streamCacheSequence += 1;
    activeStreamCacheDir = path.join(
      STREAM_CACHE_ROOT,
      `${process.pid}-${streamCacheSequence}-${Date.now()}`,
    );
  }
  fs.mkdirSync(activeStreamCacheDir, { recursive: true });
  if (activeStreamCachePersistent) {
    fs.writeFileSync(path.join(activeStreamCacheDir, PERSISTENT_CACHE_IN_USE_FILE), String(process.pid));
  }

  return new Promise((resolve, reject) => {
    let startupComplete = false;
    const addOptions = {
      path: activeStreamCacheDir,
      deselect: true,
      destroyStoreOnDestroy: !activeStreamCachePersistent,
      ...(SafePathChunkStore ? { store: SafePathChunkStore } : {}),
      ...(startupBitfield ? { bitfield: startupBitfield } : {}),
    };
    const torrent = client.add(resolvedTorrentSource, addOptions, async (torrent) => {
      if (generation !== torrentSessionGeneration || currentTorrent !== torrent) {
        resolve(null);
        return;
      }

      try {
        await markTorrentStoreSparse(torrent);
      } catch (err) {
        reject(err);
        if (currentTorrent === torrent) await destroyCurrentTorrent();
        return;
      }

      if (generation !== torrentSessionGeneration || currentTorrent !== torrent) {
        resolve(null);
        return;
      }

      if (activeStreamCachePersistent) {
        prunePersistentStreamCache(
          activeStreamCacheRoot,
          activeStreamCacheLimitBytes,
          activeStreamCacheDir,
          torrent.length,
        );
        persistActiveStreamCache(true);
      }

      // Retain every verified piece for this playback session. Live eviction
      // must also invalidate WebTorrent's bitfield and peer availability; an
      // earlier store-only LRU caused read failures after pieces were evicted.

      // WebTorrent invokes the add callback after metadata and storage are ready.
      currentTorrentMetadataReady = true;
      startupComplete = true;
      attachTrackerStats(torrent);
      sendMessage({
        type: 'ready',
        status: 'ready',
        fileCount: torrent.files.length,
        files: torrent.files.map((f, i) => mapTorrentFile(f, i)),
      });
      resolve({
        name: torrent.name,
        files: torrent.files.map((f, i) => mapTorrentFile(f, i)),
      });
    });

    // Track the returned torrent immediately, including during metadata discovery.
    currentTorrent = torrent;
    currentSourceId = generation;
    currentTorrentMetadataReady = false;
    resetDownloadTransferTelemetry();
    torrent.on('download', recordDownloadedBytes);
    torrent.on('error', (err) => {
      if (startupComplete) {
        // WebTorrent destroys the source on error; report it through health too.
        if (currentTorrent === torrent) sourceFailure = err.message;
        sendMessage({ type: 'error', message: err.message });
      } else {
        reject(err);
      }
    });
    torrent.once('close', () => resolve(null));
    torrent.once('infoHash', () => {
      const attach = () => setImmediate(() => {
        if (currentTorrent === torrent) attachTrackerStats(torrent);
      });
      if (client.listening) attach();
      else client.once('listening', attach);
      writeLog('info', 'torrent.metadata_waiting', 'Waiting for torrent metadata', {
        tracker_count: torrent.announce.length,
      });
    });
    torrent.once('metadata', () => {
      writeLog('info', 'torrent.metadata_received', 'Torrent metadata received', {
        file_count: torrent.files.length,
      });
    });
    torrent.on('wire', (wire) => {
      wire.ut_metadata?.on('warning', (err) => {
        writeLog('warn', 'torrent.metadata_peer_warning', 'Peer could not provide torrent metadata', {
          reason: err.message,
          connected_peers: torrent.numPeers,
        });
      });
    });

    // Note: client.on('error') is handled globally at line 46 — no duplicate listener here
  });
}

async function stopTorrent() {
  torrentSessionGeneration += 1;
  sourceFailure = null;
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

  return `http://127.0.0.1:${httpPort}/stream/${fileIndex}?source=${currentSourceId}`;
}

function getWhisperStreamUrl(fileIndex) {
  if (!currentTorrent || !httpPort) return null;
  const file = currentTorrent.files[fileIndex];
  if (!file) return null;

  return `http://127.0.0.1:${httpPort}/whisper/${fileIndex}?source=${currentSourceId}`;
}

function getHealth() {
  // Every failure path records a reason: source errors, failed starts and a
  // destroyed client. A destroyed source alone is not one; the sidecar destroys
  // the previous source itself while replacing it.
  if (sourceFailure) {
    return {
      status: 'failed',
      message: sourceFailure,
      metadata_ready: false,
      file_count: 0,
      port: httpPort,
    };
  }
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
  if (parentClosing) return;
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
            const starting = startTorrent(msg.magnet, {
              persistentCacheEnabled: msg.persistentCacheEnabled,
              persistentCacheRoot: msg.persistentCacheRoot,
              persistentCacheLimitBytes: msg.persistentCacheLimitBytes,
              expectedSize: msg.expectedSize,
            });
            // startTorrent advances the generation synchronously.
            const startGeneration = torrentSessionGeneration;
            starting.catch((err) => {
              const message = err?.message || String(err);
              // Health reports the failure so startup stops waiting for metadata.
              if (startGeneration === torrentSessionGeneration) sourceFailure = message;
              sendMessage({ type: 'error', message });
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

async function shutdownAfterParentClose() {
  if (parentClosing) return;
  parentClosing = true;
  // Bound shutdown even if a socket or native client never acknowledges disposal.
  const deadline = setTimeout(() => process.exit(0), 3_000);
  try {
    await stopTorrent();
    if (httpServer) {
      httpServer.closeAllConnections?.();
      httpServer.close();
    }
    if (client) await new Promise(resolve => client.destroy(resolve));
  } catch (err) {
    writeLog('error', 'process.parent_shutdown_failed', 'Could not finish parent shutdown', {
      error: err?.message || String(err),
    });
  } finally {
    // Let native dependency finalizers drain instead of exiting inside their callback.
    process.exitCode = 0;
    deadline.unref();
  }
}

process.stdin.once('end', shutdownAfterParentClose);
process.stdin.once('close', shutdownAfterParentClose);
process.stdout.on('error', shutdownAfterParentClose);

main();

process.on('exit', () => {
  persistActiveStreamCache(true);
  cleanupStreamCacheDirectory();
});
