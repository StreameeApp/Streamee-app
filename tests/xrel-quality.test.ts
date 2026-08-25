import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyXrelRelease,
  extractXrelReleaseYear,
  normalizeXrelTitle,
  xrelTitleYearKey,
} from '../src/renderer/services/xrel-quality.ts';

test('CAM and telesync sources override misleading resolution tokens', () => {
  const cam = classifyXrelRelease({ dirname: 'Example.Movie.2026.1080p.HDCAM.x264-GROUP' });
  const telesync = classifyXrelRelease({ dirname: 'Example.Movie.2026.x264-GROUP', video_type: 'TeleSync' });

  assert.equal(cam?.label, 'CAM');
  assert.equal(cam?.source, 'CAM');
  assert.equal(telesync?.label, 'TS');
  assert.equal(telesync?.source, 'Telesync');
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
