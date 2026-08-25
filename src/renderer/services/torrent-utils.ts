interface EpisodeNumber {
  season: number;
  episode: number;
}

type EpisodeCandidate = EpisodeNumber & {
  score: number;
  reason: string;
};

const MAX_EPISODE_NUMBER = 300;
const MAX_SEASON_NUMBER = 99;
const VIDEO_EXTENSION_RE = /\.(mp4|mkv|avi|mov|wmv|webm|m4v|flv)$/i;
const RELEASE_NUMBER_NOISE = new Set([360, 480, 540, 576, 720, 1080, 1440, 2160, 264, 265, 266]);

function clampSeason(season: number, fallbackSeason: number): number {
  if (Number.isFinite(season) && season >= 0 && season <= MAX_SEASON_NUMBER) {
    return season;
  }

  return fallbackSeason;
}

function isPlausibleEpisode(episode: number, allowNoiseNumber = false): boolean {
  if (!Number.isFinite(episode) || episode <= 0 || episode > MAX_EPISODE_NUMBER) {
    return false;
  }

  return allowNoiseNumber || !RELEASE_NUMBER_NOISE.has(episode);
}

function getPathBaseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function stripVideoExtension(name: string): string {
  return name.replace(VIDEO_EXTENSION_RE, '');
}

function normalizeForParsing(value: string): string {
  return value
    .replace(/%20/g, ' ')
    .replace(/[\\/]+/g, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findSeasonHint(value: string, preferredSeason: number): number {
  const normalized = normalizeForParsing(value);
  const seasonMatch = normalized.match(/(?:^|\s)(?:season|series|staffel)\s*0*(\d{1,2})(?=\s|$)/i);
  if (seasonMatch) {
    return clampSeason(parseInt(seasonMatch[1], 10), preferredSeason);
  }

  const shortSeasonMatch = normalized.match(/(?:^|\s)s0*(\d{1,2})(?=\s|$)/i);
  if (shortSeasonMatch) {
    return clampSeason(parseInt(shortSeasonMatch[1], 10), preferredSeason);
  }

  return preferredSeason;
}

function pushCandidate(
  candidates: EpisodeCandidate[],
  season: number,
  episode: number,
  score: number,
  reason: string,
  preferredSeason: number,
  allowNoiseNumber = false
) {
  if (!isPlausibleEpisode(episode, allowNoiseNumber)) {
    return;
  }

  candidates.push({
    season: clampSeason(season, preferredSeason),
    episode,
    score,
    reason,
  });
}

function bestCandidate(candidates: EpisodeCandidate[]): EpisodeNumber | null {
  if (candidates.length === 0) {
    return null;
  }

  const [best] = [...candidates].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    if (a.season !== b.season) {
      return a.season - b.season;
    }

    return a.episode - b.episode;
  });

  return {
    season: best.season,
    episode: best.episode,
  };
}

export function extractEpisodeNumber(filename: string, preferredSeason = 1): EpisodeNumber | null {
  const safePreferredSeason = clampSeason(preferredSeason, 1);
  const basename = stripVideoExtension(getPathBaseName(filename));
  const fullText = normalizeForParsing(stripVideoExtension(filename));
  const baseText = normalizeForParsing(basename);
  const hintedSeason = findSeasonHint(filename, safePreferredSeason);
  const candidates: EpisodeCandidate[] = [];

  for (const match of fullText.matchAll(/(?:^|\s)s0*(\d{1,2})[\s-]*e0*(\d{1,3})(?:\s*v\d+)?(?=\s|$)/gi)) {
    pushCandidate(
      candidates,
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      100,
      'sxe',
      safePreferredSeason,
      true
    );
  }

  for (const match of fullText.matchAll(/(?:^|\s)(\d{1,2})\s*x\s*0*(\d{1,3})(?:\s*v\d+)?(?=\s|$)/gi)) {
    pushCandidate(
      candidates,
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      95,
      'season-x-episode',
      safePreferredSeason,
      true
    );
  }

  for (const match of fullText.matchAll(/(?:^|\s)(?:season|series|staffel)\s*0*(\d{1,2})[\s-]*(?:episode|ep|e)[\s-]*0*(\d{1,3})(?:\s*v\d+)?(?=\s|$)/gi)) {
    pushCandidate(
      candidates,
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      95,
      'season-episode',
      safePreferredSeason,
      true
    );
  }

  for (const match of fullText.matchAll(/(?:^|\s)s0*(\d{1,2})[\s-]+0*(\d{1,3})(?:\s*v\d+)?(?=\s|$)/gi)) {
    pushCandidate(
      candidates,
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      82,
      'season-number-episode',
      safePreferredSeason,
      true
    );
  }

  for (const match of baseText.matchAll(/(?:^|\s)(?:episode|ep)[\s-]*0*(\d{1,3})(?:\s*v\d+)?(?=\s|$)/gi)) {
    pushCandidate(
      candidates,
      hintedSeason,
      parseInt(match[1], 10),
      78,
      'episode-word',
      safePreferredSeason,
      true
    );
  }

  for (const match of baseText.matchAll(/(?:^|[\s-])e0*(\d{1,3})(?:\s*v\d+)?(?=\s|$)/gi)) {
    pushCandidate(
      candidates,
      hintedSeason,
      parseInt(match[1], 10),
      74,
      'episode-token',
      safePreferredSeason,
      true
    );
  }

  const leadingNumber = baseText.match(/^(?:\d{1,2}\s*-\s*)?0*(\d{1,3})(?:\s*v\d+)?(?=\s|$)/i);
  if (leadingNumber) {
    pushCandidate(
      candidates,
      hintedSeason,
      parseInt(leadingNumber[1], 10),
      66,
      'leading-number',
      safePreferredSeason
    );
  }

  for (const match of baseText.matchAll(/(?:^|\s)-\s*0*(\d{1,3})(?:\s*v\d+)?(?=\s|$)/gi)) {
    pushCandidate(
      candidates,
      hintedSeason,
      parseInt(match[1], 10),
      62,
      'dash-number',
      safePreferredSeason
    );
  }

  return bestCandidate(candidates);
}

function naturalCompare(a: string, b: string): number {
  const numRegex = /(\d+)/g;
  const aParts = a.toLowerCase().split(numRegex);
  const bParts = b.toLowerCase().split(numRegex);
  const aNums = a.match(numRegex) || [];
  const bNums = b.match(numRegex) || [];
  
  const maxLen = Math.max(aParts.length, bParts.length);
  
  for (let i = 0; i < maxLen; i++) {
    const aPart = aParts[i] || '';
    const bPart = bParts[i] || '';
    
    if (aPart !== bPart) {
      if (aPart === '') return -1;
      if (bPart === '') return 1;
      const cmp = aPart.localeCompare(bPart);
      if (cmp !== 0) return cmp;
    }
    
    const aNum = aNums[i];
    const bNum = bNums[i];
    
    if (aNum !== undefined && bNum !== undefined) {
      const aNumVal = parseInt(aNum, 10);
      const bNumVal = parseInt(bNum, 10);
      if (aNumVal !== bNumVal) {
        return aNumVal - bNumVal;
      }
    }
  }
  
  return 0;
}

export function sortEpisodes(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const aEp = extractEpisodeNumber(a);
    const bEp = extractEpisodeNumber(b);
    
    if (aEp && bEp) {
      if (aEp.season !== bEp.season) {
        return aEp.season - bEp.season;
      }
      return aEp.episode - bEp.episode;
    }
    
    if (aEp) return -1;
    if (bEp) return 1;
    
    return naturalCompare(a, b);
  });
}

function isVideoFile(filename: string): boolean {
  const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.m4v', '.flv'];
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return videoExtensions.includes(ext);
}

export function filterVideoFiles(files: string[]): string[] {
  return files.filter(isVideoFile);
}
