export type XrelQualityLabel =
  | 'CAM'
  | 'TS'
  | 'SCREENER'
  | 'SD'
  | 'WEB'
  | 'BLU-RAY'
  | '720p'
  | '1080p'
  | '1080p HDR'
  | '1080p HDR10+'
  | '1080p DV'
  | '1080p REMUX'
  | '4K'
  | '4K HDR'
  | '4K HDR10+'
  | '4K DV'
  | '4K REMUX';

export interface XrelQuality {
  label: XrelQualityLabel;
  rank: number;
  resolution?: string;
  dynamicRange?: string;
  source?: string;
  codec?: string;
  audio?: string;
}

export interface XrelReleaseForClassification {
  dirname: string;
  video_type?: string;
  category?: unknown;
}

function flattenCategory(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenCategory).join(' ');
  if (value && typeof value === 'object') {
    return Object.values(value).map(flattenCategory).join(' ');
  }
  return '';
}

function releaseText(release: XrelReleaseForClassification): string {
  return [release.dirname, release.video_type, flattenCategory(release.category)]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
}

export function classifyXrelRelease(
  release: XrelReleaseForClassification
): XrelQuality | null {
  const text = releaseText(release);
  const hasCam = /(?:^|[. _-])(?:HD[- ]?)?CAM(?:RIP)?(?:[. _-]|$)/.test(text);
  const hasTelesync = /(?:^|[. _-])(?:HD[- ]?)?(?:TS|TELESYNC)(?:[. _-]|$)/.test(text);
  const hasScreener = /(?:^|[. _-])(?:DVD|WEB)?SCREENER(?:[. _-]|$)|(?:^|[. _-])SCR(?:[. _-]|$)/.test(text);

  const codec = /(?:^|[. _-])AV1(?:[. _-]|$)/.test(text)
    ? 'AV1'
    : /(?:^|[. _-])(?:HEVC|H[. _-]?265|X265)(?:[. _-]|$)/.test(text)
      ? 'HEVC'
      : /(?:^|[. _-])(?:AVC|H[. _-]?264|X264)(?:[. _-]|$)/.test(text)
        ? 'H.264'
        : undefined;
  const audio = /(?:^|[. _-])ATMOS(?:[. _-]|$)/.test(text)
    ? 'Dolby Atmos'
    : /(?:^|[. _-])TRUEHD(?:[. _-]|$)/.test(text)
      ? 'TrueHD'
      : /DTS[-. _]?HD|DTSHD|DTSMA/.test(text)
        ? 'DTS-HD'
        : /(?:^|[. _-])DTS(?:[. _-]|$)/.test(text)
          ? 'DTS'
          : /(?:DDP|EAC3|DD\+)(?:[. _-]|\d|$)/.test(text)
            ? 'Dolby Digital Plus'
            : undefined;

  if (hasCam) return { label: 'CAM', rank: 10, source: 'CAM', codec, audio };
  if (hasTelesync) return { label: 'TS', rank: 20, source: 'Telesync', codec, audio };
  if (hasScreener) return { label: 'SCREENER', rank: 30, source: 'Screener', codec, audio };

  const isDolbyVision = /(?:^|[. _-])(?:DV|DOVI)(?:[. _-]|$)|DOLBY[. _-]?VISION/.test(text);
  const isHdr10Plus = /HDR10(?:PLUS|\+)/.test(text);
  const isHdr10 = !isHdr10Plus && /HDR10/.test(text);
  const isHdr = isDolbyVision || isHdr10Plus || isHdr10 || /(?:^|[. _-])HDR(?:[. _-]|$)/.test(text);
  const is4k = /(?:^|[. _-])(?:2160P|UHD|4K)(?:[. _-]|$)/.test(text);
  const is1080p = /(?:^|[. _-])1080[PI](?:[. _-]|$)/.test(text);
  const is720p = /(?:^|[. _-])720P(?:[. _-]|$)/.test(text);
  const isRemux = /(?:^|[. _-])(?:REMUX|BDREMUX)(?:[. _-]|$)/.test(text);
  const isUhdBluray = /(?:^|[. _-])UHD[. _-]?BLU[- ]?RAY(?:[. _-]|$)/.test(text);
  const isBluray = isUhdBluray || /(?:^|[. _-])(?:BLU[- ]?RAY|BDRIP)(?:[. _-]|$)/.test(text);
  const isWebDl = /(?:^|[. _-])WEB[- ]?DL(?:[. _-]|$)/.test(text);
  const isWebRip = /(?:^|[. _-])WEB[- ]?RIP(?:[. _-]|$)|(?:^|[. _-])WEBRIP(?:[. _-]|$)/.test(text);
  const isWeb = isWebDl || isWebRip || /(?:^|[. _-])WEB(?:[. _-]|$)/.test(text);
  const source = isRemux
    ? isUhdBluray
      ? 'UHD Blu-ray Remux'
      : isBluray
        ? 'Blu-ray Remux'
        : 'Remux'
    : isUhdBluray
      ? 'UHD Blu-ray'
      : isBluray
        ? 'Blu-ray'
        : isWebDl
          ? 'WEB-DL'
          : isWebRip
            ? 'WEBRip'
            : isWeb
              ? 'WEB'
            : /(?:^|[. _-])HDTV(?:[. _-]|$)/.test(text)
              ? 'HDTV'
              : undefined;
  const dynamicRange = isDolbyVision
    ? 'Dolby Vision'
    : isHdr10Plus
      ? 'HDR10+'
      : isHdr10
        ? 'HDR10'
        : isHdr
          ? 'HDR'
          : undefined;

  if (is4k && isDolbyVision) return { label: '4K DV', rank: 96, resolution: '4K', dynamicRange, source, codec, audio };
  if (is4k && isHdr10Plus) return { label: '4K HDR10+', rank: 92, resolution: '4K', dynamicRange, source, codec, audio };
  if (is4k && isHdr) return { label: '4K HDR', rank: 88, resolution: '4K', dynamicRange, source, codec, audio };
  if (is4k && isRemux) return { label: '4K REMUX', rank: 84, resolution: '4K', source, codec, audio };
  if (is4k) return { label: '4K', rank: 80, resolution: '4K', source, codec, audio };
  if (is1080p && isDolbyVision) return { label: '1080p DV', rank: 76, resolution: '1080p', dynamicRange, source, codec, audio };
  if (is1080p && isHdr10Plus) return { label: '1080p HDR10+', rank: 74, resolution: '1080p', dynamicRange, source, codec, audio };
  if (is1080p && isHdr) return { label: '1080p HDR', rank: 72, resolution: '1080p', dynamicRange, source, codec, audio };
  if (is1080p && isRemux) return { label: '1080p REMUX', rank: 68, resolution: '1080p', source, codec, audio };
  if (is1080p) return { label: '1080p', rank: 60, resolution: '1080p', source, codec, audio };
  if (is720p) return { label: '720p', rank: 50, resolution: '720p', source, codec, audio };

  if (isBluray || isRemux) {
    return { label: 'BLU-RAY', rank: 45, source, codec, audio };
  }
  if (isWeb) {
    return { label: 'WEB', rank: 40, source, codec, audio };
  }
  if (/(?:^|[. _-])(?:DVDRIP|DVD[- ]?R|HDTV|576P|480P)(?:[. _-]|$)/.test(text)) {
    return { label: 'SD', rank: 35, resolution: /576P/.test(text) ? '576p' : /480P/.test(text) ? '480p' : undefined, source, codec, audio };
  }

  return null;
}

export function normalizeXrelTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function extractXrelReleaseYear(dirname: string): string | undefined {
  const years = dirname.match(/(?:^|[. _(-])((?:19|20)\d{2})(?=[. _)-]|$)/g);
  if (!years?.length) return undefined;
  return years[0].match(/(?:19|20)\d{2}/)?.[0];
}

export function xrelTitleYearKey(title: string, year?: string): string {
  const normalizedTitle = normalizeXrelTitle(title);
  return year ? `${normalizedTitle}:${year}` : normalizedTitle;
}
