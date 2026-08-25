import type { TorrentResult } from '../store';

export interface SeriesSearchContext {
  showName: string;
  year?: string | number | null;
  originalName?: string | null;
  aliases?: string[];
}

const TITLE_STOP_WORDS = new Set(['a', 'an', 'and', 'the']);

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02bc\uff07]/g, "'")
    .replace(/['’"]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeRelease(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2012-\u2015]/g, '-')
    .replace(/[~\uff5e]/g, '-')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function titleTokens(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter(token => token.length > 1 && !TITLE_STOP_WORDS.has(token) && !/^\d{4}$/.test(token));
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function uniqueNames(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = normalize(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateNames(context: SeriesSearchContext): string[] {
  return unique([context.showName, context.originalName || '', ...(context.aliases || [])]);
}

function queryNames(context: SeriesSearchContext): string[] {
  return uniqueNames([context.showName, context.originalName || '']);
}

function titleMatchScore(title: string, context: SeriesSearchContext): number {
  const normalizedTitle = normalize(title);
  let best = 0;

  for (const name of candidateNames(context)) {
    const normalizedName = normalize(name);
    if (normalizedName && new RegExp(`(?:^| )${escapeRegExp(normalizedName)}(?: |$)`, 'i').test(normalizedTitle)) {
      best = Math.max(best, 40);
      continue;
    }

    const tokens = titleTokens(name);
    if (tokens.length === 0) continue;
    const matched = tokens.filter(token => new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(normalizedTitle)).length;
    const ratio = matched / tokens.length;
    if (matched === tokens.length) best = Math.max(best, 36);
    else if (matched >= 2 && ratio >= 0.75) best = Math.max(best, 28);
  }

  return best;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function seasonNumberPattern(season: number): string {
  return `0*${season}`;
}

function seasonWord(season: number): string | null {
  return [
    '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen', 'twenty',
  ][season] || null;
}

const EPISODE_NUMBER_PATTERN = '(?:0*\\d{1,2}|1\\d{2})';

function episodeMarkerCount(title: string): number {
  const normalized = normalizeRelease(title);
  const markers = [
    ...normalized.matchAll(/e\d{1,3}(?=\b|e\d)/gi),
    ...normalized.matchAll(new RegExp(`\\b\\d{1,2}\\s*x\\s*${EPISODE_NUMBER_PATTERN}\\b`, 'gi')),
    ...normalized.matchAll(/\bepisodes?\s*\d{1,3}\b/gi),
  ];
  return markers.length;
}

function hasSingleEpisodeMarker(title: string): boolean {
  if (episodeMarkerCount(title) >= 2) return false;

  return (
    /\bs\d{1,2}\s*e\d{1,3}\b(?!\s*(?:-|to|through)\s*(?:s\d{1,2}\s*)?e?\d{1,3}\b)/i.test(title) ||
    new RegExp(`\\b\\d{1,2}\\s*x\\s*${EPISODE_NUMBER_PATTERN}\\b(?!\\s*(?:-|to|through)\\s*(?:\\d{1,2}\\s*x\\s*)?${EPISODE_NUMBER_PATTERN}\\b)`, 'i').test(title) ||
    /\bepisode\s*\d{1,3}\b(?!\s*(?:-|to|through)\s*\d{1,3}\b)/i.test(title)
  );
}

function hasEpisodeRange(title: string, season?: number): boolean {
  const normalized = normalizeRelease(title);
  const seasonPrefix = season === undefined ? '\\d{1,2}' : seasonNumberPattern(season);
  return (
    new RegExp(`\\bs${seasonPrefix}\\s*e\\d{1,3}\\s*(?:-|to|through)\\s*(?:s${seasonPrefix}\\s*)?e?\\d{1,3}\\b`, 'i').test(normalized) ||
    (season === undefined && /\bepisodes?\s*\d{1,3}\s*(?:-|to|through)\s*\d{1,3}\b/i.test(normalized)) ||
    new RegExp(`\\b${seasonPrefix}\\s*x\\s*${EPISODE_NUMBER_PATTERN}\\s*(?:-|to|through)\\s*(?:${seasonPrefix}\\s*x\\s*)?${EPISODE_NUMBER_PATTERN}\\b`, 'i').test(normalized)
  );
}

function mentionedPackSeasons(title: string): number[] {
  const normalized = normalize(title);
  const seasons = new Set<number>();
  for (const match of normalized.matchAll(/\bs(?:eason)?\s*0*(\d{1,2})\b(?!\s*e\d{1,3}\b)/gi)) {
    seasons.add(Number(match[1]));
  }
  for (const match of normalized.matchAll(/\bseasons?\s*0*(\d{1,2})\b/gi)) {
    seasons.add(Number(match[1]));
  }
  return [...seasons];
}

export function buildSeasonPackQueries(context: SeriesSearchContext, season: number): string[] {
  const paddedSeason = String(season).padStart(2, '0');
  const wordSeason = seasonWord(season);
  const year = context.year ? String(context.year).trim() : '';
  const names = queryNames(context);
  const primaryName = names[0];
  const primaryQueries = primaryName ? [
    year ? `${primaryName} ${year} S${paddedSeason}` : '',
    `${primaryName} S${paddedSeason}`,
    paddedSeason !== String(season) ? `${primaryName} S${season}` : '',
    year ? `${primaryName} ${year} Season ${season}` : '',
    `${primaryName} Season ${season}`,
    wordSeason ? `${primaryName} Season ${wordSeason}` : '',
    `${primaryName} Series ${season}`,
  ] : [];
  const aliasQueries = names.slice(1).flatMap(name => [
    `${name} S${paddedSeason}`,
    `${name} Season ${season}`,
  ]);
  return unique([...primaryQueries, ...aliasQueries]);
}

export function buildCompleteSeriesQueries(context: SeriesSearchContext, seasonCount?: number | null): string[] {
  const year = context.year ? String(context.year).trim() : '';
  const range = seasonCount && seasonCount > 1 ? `S01-S${String(seasonCount).padStart(2, '0')}` : '';
  const names = queryNames(context);
  const primaryName = names[0];
  const primaryQueries = primaryName ? [
    `${primaryName} Complete`,
    `${primaryName} Complete Series`,
    `${primaryName} All Seasons`,
    `${primaryName} Box Set`,
    range ? `${primaryName} ${range}` : '',
    range ? `${primaryName} Seasons 1-${seasonCount}` : '',
    year ? `${primaryName} ${year} Complete` : '',
  ] : [];
  const aliasQueries = names.slice(1).flatMap(name => [
    `${name} Complete`,
    range ? `${name} ${range}` : '',
  ]);
  return unique([...primaryQueries, ...aliasQueries]);
}

export function scoreSeasonPack(result: TorrentResult, context: SeriesSearchContext, season: number): number | null {
  const normalizedTitle = normalize(result.title);
  const releaseTitle = normalizeRelease(result.title);
  const nameScore = titleMatchScore(result.title, context);
  if (nameScore === 0) return null;

  const seasonPattern = seasonNumberPattern(season);
  const wordSeason = seasonWord(season);
  const range = hasEpisodeRange(releaseTitle, season);
  const exactSeason =
    new RegExp(`\\bseason\\s*${seasonPattern}\\b`, 'i').test(normalizedTitle) ||
    new RegExp(`\\bseries\\s*${seasonPattern}\\b`, 'i').test(normalizedTitle) ||
    Boolean(wordSeason && new RegExp(`\\bseason\\s+${wordSeason}\\b`, 'i').test(normalizedTitle)) ||
    new RegExp(`\\bs${seasonPattern}\\b`, 'i').test(normalizedTitle) ||
    new RegExp(`\\bs${seasonPattern}e\\d{1,3}`, 'i').test(normalizedTitle) ||
    range;
  if (!exactSeason) return null;

  const otherSeasons = mentionedPackSeasons(normalizedTitle).filter(value => value !== season);
  if (otherSeasons.length > 0) return null;

  if (hasSingleEpisodeMarker(releaseTitle) && !range) return null;
  const episodeMarkers = episodeMarkerCount(releaseTitle);
  const explicitPackMarker = /\b(?:complete|pack)\b/i.test(normalizedTitle);
  if (episodeMarkers >= 2 && episodeMarkers < 4 && !range && !explicitPackMarker) return null;

  let score = nameScore + 35;
  if (explicitPackMarker) score += 14;
  if (range) score += 12;
  if (context.year && new RegExp(`\\b${escapeRegExp(String(context.year))}\\b`).test(normalizedTitle)) score += 5;
  if (/\b(?:sample|extras?|specials?|featurettes?)\b/i.test(normalizedTitle)) score -= 25;
  return score;
}

export function scoreCompleteSeries(
  result: TorrentResult,
  context: SeriesSearchContext,
  seasonCount?: number | null,
): number | null {
  const normalizedTitle = normalize(result.title);
  const releaseTitle = normalizeRelease(result.title);
  const nameScore = titleMatchScore(result.title, context);
  if (nameScore === 0) return null;

  const completeMarker = /\b(?:complete(?: series)?|all seasons|series pack|box set|collection)\b/i.test(normalizedTitle) || /全集/i.test(result.title);
  const rangeMatch = releaseTitle.match(/\bs0*(\d{1,2})\s*(?:-|to)\s*s0*(\d{1,2})\b/i) ||
    releaseTitle.match(/\bseasons?\s*0*(\d{1,2})\s*(?:-|to)\s*0*(\d{1,2})\b/i);
  const isComplete = completeMarker || /\u5168\u96c6/i.test(result.title);
  const explicitSeasons = mentionedPackSeasons(normalizedTitle);
  const multipleSeasons = explicitSeasons.length >= 2;
  const singleSeasonMarker = /\bs0*\d{1,2}\b/i.test(normalizedTitle) ||
    /\b(?:season|series)\s+(?:0*\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i.test(normalizedTitle);
  if (!isComplete && !rangeMatch && !multipleSeasons) return null;
  if (isComplete && singleSeasonMarker && !rangeMatch && !multipleSeasons) return null;
  if (seasonCount && rangeMatch && (Number(rangeMatch[1]) !== 1 || Number(rangeMatch[2]) < seasonCount)) return null;
  if (seasonCount && multipleSeasons && (!explicitSeasons.includes(1) || Math.max(...explicitSeasons) < seasonCount)) return null;

  let score = nameScore;
  if (isComplete) score += 35;
  if (rangeMatch) {
    score += 25;
    if (seasonCount && Number(rangeMatch[1]) === 1 && Number(rangeMatch[2]) === seasonCount) score += 15;
  }
  if (multipleSeasons) score += 15;
  if (context.year && new RegExp(`\\b${escapeRegExp(String(context.year))}\\b`).test(normalizedTitle)) score += 5;
  if (/\b(?:sample|extras?|featurettes?)\b/i.test(normalizedTitle)) score -= 25;
  return score;
}

export function rankPackResults(
  results: TorrentResult[],
  scorer: (result: TorrentResult) => number | null,
): TorrentResult[] {
  const scored = results
    .map(result => ({ result, score: scorer(result) }))
    .filter((entry): entry is { result: TorrentResult; score: number } => entry.score !== null);
  const best = new Map<string, { result: TorrentResult; score: number }>();
  for (const entry of scored) {
    const result = entry.result;
    const key = result.infoHash || result.magnetUri || `${normalize(result.title)}|${result.size}|${result.indexer}`;
    const existing = best.get(key);
    if (!existing || result.peers > existing.result.peers) best.set(key, entry);
  }

  return [...best.values()]
    .sort((a, b) =>
      Number(Boolean(b.result.cached)) - Number(Boolean(a.result.cached)) ||
      b.score - a.score ||
      b.result.seeds - a.result.seeds ||
      b.result.peers - a.result.peers
    )
    .map(entry => entry.result);
}
