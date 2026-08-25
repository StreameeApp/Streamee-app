import type { TorrentResult } from '../store';
import { rankSmartNextCandidates } from './smart-next.ts';

export function selectDirectStartupReplacement(
  current: TorrentResult,
  candidates: TorrentResult[],
): TorrentResult | undefined {
  const playable = candidates.filter((candidate) =>
    !!candidate.addonInstallationId && !!(candidate.streamHandle || candidate.infoHash)
  );
  const currentHash = current.infoHash?.toLowerCase();
  const exact = playable.find((candidate) => (
    !!currentHash
    && candidate.infoHash?.toLowerCase() === currentHash
    && (current.sourceFileIndex == null || candidate.sourceFileIndex === current.sourceFileIndex)
  ));
  return exact || rankSmartNextCandidates(current, playable)[0]?.result;
}
