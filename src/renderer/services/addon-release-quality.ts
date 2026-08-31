import {
  classifyXrelRelease,
  extractXrelReleaseYear,
  normalizeXrelTitle,
  type XrelQuality,
} from './xrel-quality.ts';

export interface AddonReleaseQualityItem {
  type: 'movie' | 'series';
  name: string;
  year?: string;
  originalName?: string;
  aliases?: string[];
}

export interface AddonReleaseQualityObservation {
  title: string;
  description?: string;
  filename?: string;
}

export interface AddonReleaseQualityConsensus {
  dirname: string;
  quality: XrelQuality;
  support: number;
}

const PROMO_MARKER = /\b(?:TRAILER|TLR|TEASER|PROMO|PREVIEW|PROLOGUE|SAMPLE|FEATURETTE|CLIP|EXTRA|BONUS|FIRST LOOK|SNEAK PEEK|BEHIND THE SCENES)\b/;

function itemNames(item: AddonReleaseQualityItem): string[] {
  return [...new Set([item.name, item.originalName, ...(item.aliases ?? [])]
    .filter((value): value is string => !!value?.trim())
    .map(normalizeXrelTitle)
    .filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

function matchingTitlePrefix(value: string, names: string[]): string | undefined {
  return names.find((name) => value === name || value.startsWith(`${name} `));
}

function episodeMatches(dirname: string, scope?: { season?: number; episode?: number }): boolean {
  if (scope?.season === undefined || scope.episode === undefined) return true;
  const scene = /(?:^|[. _-])S(\d{1,3})E(\d{1,4})(?=[. _-]|$)/i.exec(dirname);
  const alternate = /(?:^|[. _-])(\d{1,3})X(\d{1,4})(?=[. _-]|$)/i.exec(dirname);
  const match = scene ?? alternate;
  return !!match
    && Number(match[1]) === scope.season
    && Number(match[2]) === scope.episode;
}

function movieYearMatches(item: AddonReleaseQualityItem, dirname: string): boolean {
  if (item.type !== 'movie' || !item.year) return true;
  const releaseYear = extractXrelReleaseYear(dirname);
  if (!releaseYear) return true;
  const expected = Number(item.year);
  const actual = Number(releaseYear);
  return Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) <= 1;
}

export function getAddonReleaseQualityConsensus(
  item: AddonReleaseQualityItem,
  observations: AddonReleaseQualityObservation[],
  scope?: { season?: number; episode?: number },
): AddonReleaseQualityConsensus | null {
  const names = itemNames(item);
  const uniqueCandidates = new Map<string, { dirname: string; quality: XrelQuality }>();

  for (const observation of observations) {
    const dirname = observation.filename?.trim() || observation.title.trim();
    if (!dirname) continue;
    const normalized = normalizeXrelTitle(dirname);
    const titlePrefix = matchingTitlePrefix(normalized, names);
    if (!titlePrefix) continue;
    const releaseRemainder = normalized.slice(titlePrefix.length).trim().toUpperCase();
    if (PROMO_MARKER.test(releaseRemainder)) continue;
    if (!movieYearMatches(item, dirname) || !episodeMatches(dirname, scope)) continue;

    const quality = classifyXrelRelease({ dirname });
    if (!quality) continue;
    if (!uniqueCandidates.has(normalized)) uniqueCandidates.set(normalized, { dirname, quality });
  }

  const byLabel = new Map<string, Array<{ dirname: string; quality: XrelQuality }>>();
  for (const candidate of uniqueCandidates.values()) {
    const group = byLabel.get(candidate.quality.label) ?? [];
    group.push(candidate);
    byLabel.set(candidate.quality.label, group);
  }

  const winner = [...byLabel.values()]
    .filter((group) => group.length >= 2)
    .sort((left, right) => right[0].quality.rank - left[0].quality.rank)[0];
  if (!winner) return null;
  return {
    dirname: winner[0].dirname,
    quality: winner[0].quality,
    support: winner.length,
  };
}
