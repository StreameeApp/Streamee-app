import type { TorrentResult } from '../store/index.ts';

function normalizeDuplicateFilename(filename: string | undefined): string {
  if (!filename) return '';
  const basename = filename.replace(/\\/g, '/').split('/').pop() || '';
  return basename.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function deduplicateResults(results: TorrentResult[]): TorrentResult[] {
  const canonicalKey = (result: TorrentResult) => {
    const filename = normalizeDuplicateFilename(result.streamFilename);
    if (filename) return `filename:${filename}`;

    const hash = result.infoHash.trim().toLowerCase();
    if (hash) {
      const streamFileKey = result.directStreamProvider && result.sourceFileIndex != null
        ? `:file:${result.sourceFileIndex}`
        : '';
      return `hash:${hash}${streamFileKey}`;
    }
    if (result.magnetUri) return `source:${result.magnetUri}`;
    return `id:${result.id}`;
  };
  const sourceRank = (result: TorrentResult) => {
    if (result.directStreamProvider && (result.streamUrl || result.streamHandle)) return 3;
    if (result.cached) return 2;
    return 1;
  };
  const preferResult = (candidate: TorrentResult, existing: TorrentResult) => {
    const rankDifference = sourceRank(candidate) - sourceRank(existing);
    if (rankDifference !== 0) return rankDifference > 0;
    if (candidate.peers !== existing.peers) return candidate.peers > existing.peers;
    return candidate.seeds > existing.seeds;
  };

  const bestBySource = new Map<string, TorrentResult>();
  for (const result of results) {
    const key = canonicalKey(result);
    const existing = bestBySource.get(key);
    if (!existing || preferResult(result, existing)) bestBySource.set(key, result);
  }
  return [...bestBySource.values()];
}
