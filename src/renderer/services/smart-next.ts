import type { TorrentResult } from '../store';

export const SMART_NEXT_AUTOLOAD_TRIGGER_RATIO = 0.7;

export type SmartEpisodeDirection = 'next' | 'previous';
export type SmartEpisodeTarget = { season: number; episode: number };

export function orderSmartEpisodeSeasons(
  seasonNumbers: number[],
  current: SmartEpisodeTarget,
  direction: SmartEpisodeDirection,
): number[] {
  return seasonNumbers
    .filter((season) => (
      current.season === 0 || season > 0
    ) && (direction === 'next'
      ? season >= current.season
      : season <= current.season))
    .sort((a, b) => direction === 'next' ? a - b : b - a);
}

export function selectSmartEpisodeInSeason(
  episodeNumbers: number[],
  season: number,
  current: SmartEpisodeTarget,
  direction: SmartEpisodeDirection,
): number | null {
  const candidates = episodeNumbers
    .filter((episode) => direction === 'next'
      ? season > current.season || episode > current.episode
      : season < current.season || episode < current.episode)
    .sort((a, b) => direction === 'next' ? a - b : b - a);
  return candidates[0] ?? null;
}

export function shouldReuseSmartNextPreparation(
  existingKey: string,
  requestedKey: string,
  expiresAt: number,
  hasReadyWarmup: boolean,
  now = Date.now(),
): boolean {
  return existingKey === requestedKey && (hasReadyWarmup || expiresAt > now);
}

export function shouldAutoloadSmartNext(
  enabled: boolean,
  playbackTime: number | null | undefined,
  duration: number | null | undefined,
): boolean {
  return enabled
    && typeof playbackTime === 'number'
    && typeof duration === 'number'
    && Number.isFinite(playbackTime)
    && Number.isFinite(duration)
    && duration > 0
    && playbackTime / duration >= SMART_NEXT_AUTOLOAD_TRIGGER_RATIO;
}

export type ReleaseFingerprint = {
  resolution: TorrentResult['quality'];
  dynamicRange: 'dolby-vision' | 'hdr10-plus' | 'hdr10' | 'hlg' | 'sdr';
  source: 'web-dl' | 'webrip' | 'bluray' | 'remux' | 'hdtv' | null;
  videoCodec: 'hevc' | 'avc' | 'av1' | null;
  audioCodec: 'truehd' | 'ddp' | 'dd' | 'dts-hd' | 'dts' | 'aac' | 'flac' | null;
  atmos: boolean;
  releaseGroup: string | null;
};

export type RankedSmartNextCandidate = {
  result: TorrentResult;
  score: number;
  matchedTraits: string[];
};

export type SmartNextRequestIdentity = {
  request_id: number;
  mpv_pid: number;
};

export function smartNextRequestKey(request: SmartNextRequestIdentity): string {
  return `${request.mpv_pid}:${request.request_id}`;
}

export function rememberCompletedSmartNextRequest(
  completed: Set<string>,
  requestKey: string,
  limit = 32,
): void {
  completed.add(requestKey);
  while (completed.size > limit) {
    const oldest = completed.values().next().value;
    if (typeof oldest !== 'string') break;
    completed.delete(oldest);
  }
}

export function shouldExecuteSmartNextRequest(
  completed: ReadonlySet<string>,
  activeRequestKey: string | null,
  request: SmartNextRequestIdentity,
): boolean {
  const requestKey = smartNextRequestKey(request);
  return request.request_id > 0
    && request.mpv_pid > 0
    && activeRequestKey === null
    && !completed.has(requestKey);
}

const RELEASE_NOISE = new Set([
  'sdr', 'hdr', 'hdr10', 'hlg', 'dv', 'dovi', 'uhd', 'web', 'webdl', 'webrip',
  'bluray', 'remux', 'hdtv', 'hevc', 'avc', 'av1', 'x264', 'x265', 'h264', 'h265',
  'aac', 'dd', 'ddp', 'eac3', 'ac3', 'dts', 'truehd', 'atmos', 'proper', 'repack',
]);

function releaseText(result: TorrentResult): string {
  return [result.streamFilename, result.title].filter(Boolean).join(' ');
}

function normalizedTechnicalText(value: string): string {
  return value
    .replace(/dolby[ ._-]*vision/gi, ' dovi ')
    .replace(/hdr10\+/gi, ' hdr10plus ')
    .replace(/web[ ._-]*dl/gi, ' webdl ')
    .replace(/dts[ ._-]*hd(?:[ ._-]*ma)?/gi, ' dtshd ')
    .replace(/true[ ._-]*hd/gi, ' truehd ')
    .replace(/e[ ._-]*ac[ ._-]*3/gi, ' eac3 ')
    .replace(/h[ ._-]*265/gi, ' h265 ')
    .replace(/h[ ._-]*264/gi, ' h264 ')
    .toLowerCase();
}

function detectResolution(value: string, fallback: TorrentResult['quality']): TorrentResult['quality'] {
  if (/\b(?:2160p?|4k|uhd)\b/i.test(value)) return '4K';
  if (/\b1080[pi]?\b/i.test(value)) return '1080p';
  if (/\b720[pi]?\b/i.test(value)) return '720p';
  if (/\b(?:480[pi]?|sd)\b/i.test(value)) return '480p';
  return fallback;
}

function detectReleaseGroup(value: string): string | null {
  const withoutExtension = value.replace(/\.(?:mkv|mp4|avi|mov|wmv|webm|m4v)$/i, '').trim();
  const dashMatch = withoutExtension.match(/-([a-z0-9]{2,16})$/i);
  if (dashMatch) return dashMatch[1].toLowerCase();

  const tokens = withoutExtension.split(/[ ._[\](){}-]+/).filter(Boolean);
  const last = tokens.at(-1)?.toLowerCase();
  if (!last || !/^[a-z][a-z0-9]{1,15}$/i.test(last)) return null;
  if (RELEASE_NOISE.has(last) || /^s\d{1,2}e\d{1,3}$/i.test(last) || /^\d{3,4}p$/i.test(last)) {
    return null;
  }
  return last;
}

export function fingerprintRelease(result: TorrentResult): ReleaseFingerprint {
  const raw = releaseText(result);
  const text = normalizedTechnicalText(raw);
  const dynamicRange: ReleaseFingerprint['dynamicRange'] = /\b(?:dovi|dv)\b/.test(text)
    ? 'dolby-vision'
    : /\bhdr10plus\b/.test(text)
      ? 'hdr10-plus'
      : /\bhdr(?:10)?\b/.test(text)
        ? 'hdr10'
        : /\bhlg\b/.test(text)
          ? 'hlg'
          : 'sdr';
  const source: ReleaseFingerprint['source'] = /\bremux\b/.test(text)
    ? 'remux'
    : /\b(?:blu[ ._-]*ray|b[dr]rip)\b/.test(text)
      ? 'bluray'
      : /\bwebdl\b/.test(text)
        ? 'web-dl'
        : /\bwebrip\b/.test(text)
          ? 'webrip'
          : /\bhdtv\b/.test(text)
            ? 'hdtv'
            : null;
  const videoCodec: ReleaseFingerprint['videoCodec'] = /\b(?:x265|h265|hevc)\b/.test(text)
    ? 'hevc'
    : /\b(?:x264|h264|avc)\b/.test(text)
      ? 'avc'
      : /\bav1\b/.test(text)
        ? 'av1'
        : null;
  const audioCodec: ReleaseFingerprint['audioCodec'] = /\btruehd(?:\d(?:\.\d)?)?\b/.test(text)
    ? 'truehd'
    : /\b(?:ddp(?:\d(?:\.\d)?)?|eac3)\b/.test(text)
      ? 'ddp'
      : /\b(?:dd(?:\d(?:\.\d)?)?|ac3)\b/.test(text)
        ? 'dd'
        : /\bdtshd\b/.test(text)
          ? 'dts-hd'
          : /\bdts\b/.test(text)
            ? 'dts'
            : /\baac\b/.test(text)
              ? 'aac'
              : /\bflac\b/.test(text)
                ? 'flac'
                : null;

  return {
    resolution: detectResolution(raw, result.quality),
    dynamicRange,
    source,
    videoCodec,
    audioCodec,
    atmos: /\batmos\b/.test(text),
    releaseGroup: detectReleaseGroup(result.streamFilename || result.title),
  };
}

function sizeSimilarity(currentSize: number, candidateSize: number): number {
  if (currentSize <= 0 || candidateSize <= 0) return 0;
  const ratio = Math.min(currentSize, candidateSize) / Math.max(currentSize, candidateSize);
  return Math.round(ratio * 10);
}

function scoreCandidate(current: TorrentResult, candidate: TorrentResult): RankedSmartNextCandidate {
  const currentRelease = fingerprintRelease(current);
  const candidateRelease = fingerprintRelease(candidate);
  const matchedTraits: string[] = [];
  let score = 0;

  if (currentRelease.releaseGroup && candidateRelease.releaseGroup === currentRelease.releaseGroup) {
    score += 50;
    matchedTraits.push(`group ${candidateRelease.releaseGroup.toUpperCase()}`);
  }
  if (candidateRelease.resolution === currentRelease.resolution) {
    score += 35;
    matchedTraits.push(candidateRelease.resolution);
  }
  if (candidateRelease.dynamicRange === currentRelease.dynamicRange) {
    score += 30;
    matchedTraits.push(candidateRelease.dynamicRange.toUpperCase());
  }
  if (currentRelease.source && candidateRelease.source === currentRelease.source) {
    score += 18;
    matchedTraits.push(candidateRelease.source);
  }
  if (currentRelease.videoCodec && candidateRelease.videoCodec === currentRelease.videoCodec) {
    score += 12;
    matchedTraits.push(candidateRelease.videoCodec);
  }
  if (currentRelease.audioCodec && candidateRelease.audioCodec === currentRelease.audioCodec) {
    score += 8;
  }
  if (currentRelease.atmos === candidateRelease.atmos) score += 4;
  if (current.sourceProvider && candidate.sourceProvider === current.sourceProvider) score += 5;
  if (current.indexer && candidate.indexer === current.indexer) score += 3;
  score += sizeSimilarity(current.size, candidate.size);

  if (candidate.cached || candidate.streamHandle) score += 20;
  score += Math.min(8, Math.log2(Math.max(1, candidate.seeds + 1)));

  return { result: candidate, score, matchedTraits };
}

export function rankSmartNextCandidates(
  current: TorrentResult,
  candidates: TorrentResult[],
): RankedSmartNextCandidate[] {
  return candidates
    .map((candidate) => scoreCandidate(current, candidate))
    .sort((a, b) =>
      b.score - a.score
      || Number(Boolean(b.result.cached)) - Number(Boolean(a.result.cached))
      || b.result.seeds - a.result.seeds
      || b.result.peers - a.result.peers
      || a.result.title.localeCompare(b.result.title)
    );
}
