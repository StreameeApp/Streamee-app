import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyXrelRelease,
  extractXrelReleaseYear,
  normalizeXrelTitle,
  xrelTitleYearKey,
} from '../src/renderer/services/xrel-quality.ts';
import { getAddonReleaseQualityConsensus } from '../src/renderer/services/addon-release-quality.ts';

test('early-source tags override misleading 4K and HDR tokens', () => {
  const cases = [
    ['Example.Movie.2026.2160p.HDR.HDCAM.x264-GROUP', 'CAM', 'CAM'],
    ['Example.Movie.2026.4K.HDTS.x264-GROUP', 'TS', 'Telesync'],
    ['Example.Movie.2026.UHD.HQTS.x264-GROUP', 'TS', 'Telesync'],
    ['Example.Movie.2026.2160p.HDTC.x264-GROUP', 'TC', 'Telecine'],
    ['Example.Movie.2026.4K.DVDSCR.x264-GROUP', 'SCREENER', 'Screener'],
    ['Example.Movie.2026.2160p.WORKPRINT.x264-GROUP', 'WORKPRINT', 'Workprint'],
  ] as const;

  for (const [dirname, label, source] of cases) {
    const quality = classifyXrelRelease({ dirname });
    assert.equal(quality?.label, label, dirname);
    assert.equal(quality?.source, source, dirname);
    assert.notEqual(quality?.resolution, '4K', dirname);
  }

  const videoType = classifyXrelRelease({
    dirname: 'Example.Movie.2026.2160p.x264-GROUP',
    video_type: 'TeleSync',
  });
  assert.equal(videoType?.label, 'TS');
});

test('excludes trailers from release-quality badges', () => {
  assert.equal(
    classifyXrelRelease({ dirname: 'Example.Movie.2026.Official.Trailer.2160p.HDR.WEB-DL' }),
    null,
  );
  assert.equal(
    classifyXrelRelease({ dirname: 'Example.Movie.2026.4K.WEB-DL', video_type: 'Trailer' }),
    null,
  );
});

test('add-on badges require two unique releases agreeing on the exact tier', () => {
  const item = { type: 'movie' as const, name: 'Example Movie', year: '2026' };
  const consensus = getAddonReleaseQualityConsensus(item, [
    { title: 'Example.Movie.2026.2160p.WEB-DL.H265-GROUPA.mkv' },
    { title: 'Example.Movie.2026.4K.WEB.H265-GROUPB.mkv' },
  ]);
  assert.equal(consensus?.quality.label, '4K');
  assert.equal(consensus?.support, 2);

  assert.equal(getAddonReleaseQualityConsensus(item, [
    { title: 'Example.Movie.2026.2160p.WEB-DL.H265-GROUPA.mkv' },
    { title: 'Example.Movie.2026.2160p.DV.HDR.WEB-DL.H265-GROUPB.mkv' },
  ]), null, 'different displayed tiers do not confirm each other');

  assert.equal(getAddonReleaseQualityConsensus(item, [
    { title: 'Example.Movie.2026.2160p.WEB-DL.H265-SAME.mkv' },
    { title: 'Example.Movie.2026.2160p.WEB-DL.H265-SAME.mkv', description: 'duplicate provider row' },
  ]), null, 'duplicate filenames count once');
});

test('add-on consensus rejects promos, unrelated titles, mismatched years, and description-only quality', () => {
  assert.equal(getAddonReleaseQualityConsensus(
    { type: 'movie', name: 'Moana', year: '2026' },
    [
      { title: 'MOANA-2026_TLR-1_4K-Scope_HEVC.mkv' },
      { title: 'MOANA-2026_TLR-2_4K-Scope_HEVC.mkv' },
    ],
  ), null);
  assert.equal(getAddonReleaseQualityConsensus(
    { type: 'movie', name: 'The Odyssey', year: '2026' },
    [
      { title: 'The.Odyssey.Prologue.2025.IMAX.4K.mov' },
      { title: 'The.Odyssey.First.Look.2026.2160p.mov' },
    ],
  ), null);
  assert.equal(getAddonReleaseQualityConsensus(
    { type: 'movie', name: 'Insidious: Out of the Further', year: '2026' },
    [
      { title: 'Insidious.The.Last.Key.2018.1080p.BluRay.mkv' },
      { title: 'Insidious.Chapter.2.2013.1080p.BluRay.mkv' },
    ],
  ), null);
  assert.equal(getAddonReleaseQualityConsensus(
    { type: 'movie', name: 'Example Movie', year: '2026' },
    [
      { title: 'Example.Movie.2020.2160p.WEB-DL-GROUPA.mkv' },
      { title: 'Example.Movie.2020.4K.WEB-DL-GROUPB.mkv' },
      { title: 'Example Movie source A', description: '2160p WEB-DL' },
      { title: 'Example Movie source B', description: '4K WEB-DL' },
    ],
  ), null);
});

test('add-on consensus requires the requested episode and preserves lower-tier overrides', () => {
  const item = { type: 'series' as const, name: 'Example Show' };
  assert.equal(getAddonReleaseQualityConsensus(item, [
    { title: 'Example.Show.S01E02.2160p.WEB-DL-GROUPA.mkv' },
    { title: 'Example.Show.S01E03.2160p.WEB-DL-GROUPB.mkv' },
  ], { season: 1, episode: 2 }), null);

  const cam = getAddonReleaseQualityConsensus(item, [
    { title: 'Example.Show.S01E02.2160p.HDCAM-GROUPA.mkv' },
    { title: 'Example.Show.S01E02.4K.CAMRip-GROUPB.mkv' },
  ], { season: 1, episode: 2 });
  assert.equal(cam?.quality.label, 'CAM');
  assert.equal(cam?.support, 2);
});

test('recognizes common web and high-definition quality tiers', () => {
  const fullHd = classifyXrelRelease({ dirname: 'Example.Movie.2026.1080p.WEB-DL.DDP5.1.H264-GROUP' });
  const hd = classifyXrelRelease({ dirname: 'Example.Movie.2026.720p.WEBRip.x264-GROUP' });
  const web = classifyXrelRelease({ dirname: 'Example.Movie.2026.WEB-DL.H264-GROUP' });

  assert.equal(fullHd?.label, '1080p');
  assert.equal(fullHd?.source, 'WEB-DL');
  assert.equal(fullHd?.codec, 'H.264');
  assert.equal(fullHd?.audio, 'Dolby Digital Plus');
  assert.equal(hd?.label, '720p');
  assert.equal(web?.label, 'WEB');
});

test('distinguishes 4K, HDR, and Dolby Vision releases', () => {
  const hdr10Plus = classifyXrelRelease({ dirname: 'Example.Movie.2026.UHD.BluRay.2160p.HDR10Plus.HEVC-GROUP' });
  const dolbyVision = classifyXrelRelease({ dirname: 'Example.Movie.2026.2160p.WEB-DL.DV.HDR.HEVC-GROUP' });
  const sdr = classifyXrelRelease({ dirname: 'Example.Movie.2026.2160p.WEB-DL.HEVC-GROUP' });
  const remux = classifyXrelRelease({ dirname: 'Example.Movie.2026.UHD.BluRay.2160p.HEVC.REMUX-GROUP' });

  assert.equal(hdr10Plus?.label, '4K HDR10+');
  assert.equal(hdr10Plus?.dynamicRange, 'HDR10+');
  assert.equal(dolbyVision?.label, '4K DV');
  assert.equal(dolbyVision?.dynamicRange, 'Dolby Vision');
  assert.equal(sdr?.label, '4K');
  assert.equal(remux?.label, '4K REMUX');
  assert.equal(remux?.source, 'UHD Blu-ray Remux');
});

test('classifies representative srrDB scene release names', () => {
  const sceneUhd = classifyXrelRelease({
    dirname: 'The.Dark.Knight.2008.2160p.UHD.BluRay.H265-PRiSTiNE',
  });
  const sceneWeb = classifyXrelRelease({
    dirname: 'Example.Show.S01E03.1080p.WEB.H264-GROUP',
  });

  assert.equal(sceneUhd?.label, '4K');
  assert.equal(sceneUhd?.source, 'UHD Blu-ray');
  assert.equal(sceneUhd?.codec, 'HEVC');
  assert.equal(sceneWeb?.label, '1080p');
  assert.equal(sceneWeb?.source, 'WEB');
  assert.equal(sceneWeb?.codec, 'H.264');
});

test('does not invent a badge for an unrecognized dirname', () => {
  assert.equal(classifyXrelRelease({ dirname: 'Example.Movie.2026-GROUP' }), null);
});

test('normalizes title punctuation and extracts the release year', () => {
  assert.equal(normalizeXrelTitle('Wall-E: L’aventure & Friends'), 'wall e l aventure and friends');
  assert.equal(extractXrelReleaseYear('Example.Movie.2026.2160p.WEB-DL-GROUP'), '2026');
  assert.equal(xrelTitleYearKey('Example: Movie', '2026'), 'example movie:2026');
});
