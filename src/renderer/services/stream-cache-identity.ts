import type { TorrentResult } from '../store';

type DirectStreamCacheIdentitySource = Pick<
  TorrentResult,
  | 'id'
  | 'infoHash'
  | 'size'
  | 'sourceFileIndex'
  | 'addonInstallationId'
  | 'addonId'
  | 'directStreamProvider'
  | 'sourceProvider'
  | 'streamFilename'
  | 'title'
>;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function normalizeInfoHash(value?: string): string {
  const normalized = value?.trim().replace(/^urn:btih:/i, '') || '';
  if (/^[a-f\d]{40}$/i.test(normalized)) return normalized.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(normalized)) {
    const bytes: number[] = [];
    let accumulator = 0;
    let bitCount = 0;
    for (const character of normalized.toUpperCase()) {
      accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
      bitCount += 5;
      if (bitCount >= 8) {
        bitCount -= 8;
        bytes.push((accumulator >>> bitCount) & 0xff);
      }
    }
    return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return normalized.toLowerCase();
}

function normalizeFilename(value?: string): string {
  const leaf = value?.split(/[\\/]/).pop() || '';
  return leaf.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildDirectStreamCacheIdentity(
  source: DirectStreamCacheIdentitySource,
): string {
  const infoHash = normalizeInfoHash(source.infoHash);
  const filename = normalizeFilename(source.streamFilename || source.title);
  const stableSourceIdentity = infoHash
    || (filename ? `file=${filename}` : source.id.trim().toLowerCase());
  return [
    source.addonInstallationId
      || source.directStreamProvider
      || source.sourceProvider
      || 'direct-stream',
    source.addonId || 'installed',
    stableSourceIdentity,
    source.sourceFileIndex ?? 'none',
    source.size,
  ].join(':');
}
