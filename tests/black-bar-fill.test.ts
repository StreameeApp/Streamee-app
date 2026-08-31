import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const scriptPath = join(root, 'mpv', 'scripts', 'streamee_smart_ultrawide_fill.lua');
const probePath = join(root, 'mpv', 'scripts', 'streamee_smart_ultrawide_fill_probe.lua');
const shaderPath = join(root, 'mpv', 'shaders', 'streamee_ultrawide_lighting.glsl');
const mpvPath = join(root, 'mpv', 'mpv.exe');
const script = readFileSync(scriptPath, 'utf8');
const probe = readFileSync(probePath, 'utf8');
const shader = readFileSync(shaderPath, 'utf8');

test('lighting keeps detected content bounds separate from the rendered crop', () => {
  for (const parameter of ['light_x', 'light_y', 'light_w', 'light_h']) {
    assert.match(shader, new RegExp(`//!PARAM ${parameter}\\b`));
    assert.match(script, new RegExp(`streamee_ultrawide_lighting/${parameter}`));
  }
  assert.match(shader, /\/\/!PARAM content_guard\b/);
  assert.match(script, /streamee_ultrawide_lighting\/content_guard.*lighting_content_crop and "1" or "0"/);
  assert.match(shader, /bool inside_render[\s\S]*bool inside_active[\s\S]*inside_render && inside_active/);
  assert.match(script, /lighting_content_crop = crop[\s\S]*if enabled then[\s\S]*set_crop\(crop, reason, force\)/);
  assert.match(script, /fixed_canvas_crop = nil[\s\S]*apply_fixed_canvas_crop\(nil\)/);
});

test('lighting-only playback uses efficient detection without enabling Fill', () => {
  assert.match(
    script,
    /local function effective_detection_mode\(\)[\s\S]*if enabled then return active_mode end[\s\S]*if lighting_enabled then return "efficient" end/,
  );
  assert.match(
    script,
    /elseif lighting_enabled then\s+start_efficient_schedule\(\)/,
  );
});

test('equivalent detector boundaries do not replace the current crop', () => {
  assert.match(
    script,
    /if not force and crops_equivalent\(crop, current_detection_crop\(\)\) then\s+return false/,
  );
  assert.match(
    script,
    /elseif not crops_equivalent\(crop, current_crop\) then\s+apply_detection_result\(crop, "efficient periodic scan"\)/,
  );
});

test('SVP suppression preserves live detection and efficient mode has a remote fallback', () => {
  assert.match(
    script,
    /suppress_svp_outer_lighting\(\)\s+local lighting = svp_outer_lighting_active\(\)/,
  );
  assert.doesNotMatch(script, /local lighting = svp_lighting_suppressed or svp_outer_lighting_active\(\)/);
  assert.match(
    script,
    /efficient_live_scan_active = true[\s\S]*add_detector\(\)[\s\S]*start_timer\(\)/,
  );
});

test('helper scans inherit the complete detector contract and have a deadline', () => {
  for (const option of [
    'limit',
    'round',
    'reset_count',
    'poll_interval',
    'boundary_quantum',
    'min_bar_fraction',
    'max_total_crop_fraction',
    'symmetry_tolerance_fraction',
    'min_content_aspect',
    'min_pillarbox_content_aspect',
    'max_pillarbox_content_aspect',
  ]) {
    assert.match(script, new RegExp(`streamee_smart_ultrawide_fill_probe-${option}=`));
    assert.match(probe, new RegExp(`\\b${option}\\s*=`));
  }
  assert.match(script, /efficient_scan_deadline = now\(\) \+ math\.max/);
  assert.match(script, /helper deadline exceeded/);
  assert.match(script, /helper exited early/);
});

test('crop equivalence tolerates quantized width and height jitter', () => {
  for (const implementation of [script, probe]) {
    assert.match(implementation, /math\.abs\(lw - rw\) <= tolerance \* 2/);
    assert.match(implementation, /math\.abs\(lh - rh\) <= tolerance \* 2/);
  }
});

type LightingCase = {
  name: string;
  marker: string;
  source: string;
  horizontalBars: boolean;
  verticalBars: boolean;
};

function runLightingCase(runtimeCase: LightingCase) {
  test(runtimeCase.name, { skip: !existsSync(mpvPath), timeout: 20_000 }, () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'streamee-bar-test-'));
    const checkerPath = join(temporaryDirectory, 'checker.lua');
    const logPath = join(temporaryDirectory, 'mpv.log');
    writeFileSync(
      checkerPath,
      `local mp = require "mp"
local marker = "${runtimeCase.marker}"
local expect_horizontal = ${runtimeCase.horizontalBars}
local expect_vertical = ${runtimeCase.verticalBars}
local deadline = mp.get_time() + 8.0
local function fail(message)
    io.stderr:write(marker .. "_FAIL: " .. message .. "\\n")
    mp.commandv("quit", 9)
end
local function axis_ready(offset, size, expected)
    if not offset or not size then return false end
    if expected then return offset >= 0.05 and size <= 0.90 end
    return math.abs(offset) <= 0.01 and math.abs(size - 1.0) <= 0.01
end
local timer
timer = mp.add_periodic_timer(0.1, function()
    local mode = mp.get_property_native("user-data/streamee-adaptive-crop-mode")
    local lighting = mp.get_property_number("user-data/streamee-black-bar-lighting-enabled", 0)
    local values = mp.get_property_native("glsl-shader-opts") or {}
    local crop_x = tonumber(values["streamee_ultrawide_lighting/crop_x"])
    local crop_y = tonumber(values["streamee_ultrawide_lighting/crop_y"])
    local crop_w = tonumber(values["streamee_ultrawide_lighting/crop_w"])
    local crop_h = tonumber(values["streamee_ultrawide_lighting/crop_h"])
    local light_x = tonumber(values["streamee_ultrawide_lighting/light_x"])
    local light_y = tonumber(values["streamee_ultrawide_lighting/light_y"])
    local light_w = tonumber(values["streamee_ultrawide_lighting/light_w"])
    local light_h = tonumber(values["streamee_ultrawide_lighting/light_h"])
    local render_is_full = crop_x and crop_y and crop_w and crop_h
        and math.abs(crop_x) <= 0.01 and math.abs(crop_y) <= 0.01
        and math.abs(crop_w - 1.0) <= 0.01 and math.abs(crop_h - 1.0) <= 0.01
    if mode == "off" and lighting == 1 and render_is_full
        and axis_ready(light_x, light_w, expect_horizontal)
        and axis_ready(light_y, light_h, expect_vertical) then
        timer:kill()
        io.stderr:write(marker .. "_PASS\\n")
        mp.commandv("quit", 0)
        return
    end
    if mp.get_time() >= deadline then
        fail(string.format(
            "mode=%s lighting=%s crop=%s,%s,%s,%s light=%s,%s,%s,%s",
            tostring(mode), tostring(lighting), tostring(crop_x), tostring(crop_y),
            tostring(crop_w), tostring(crop_h), tostring(light_x), tostring(light_y),
            tostring(light_w), tostring(light_h)
        ))
    end
end)
`,
      'utf8',
    );

    try {
      const result = spawnSync(
        mpvPath,
        [
          '--no-config',
          '--load-scripts=no',
          '--vo=gpu-next',
          '--gpu-api=d3d11',
          '--gpu-context=d3d11',
          '--ao=null',
          '--no-audio',
          '--force-window=no',
          '--length=12',
          `--script=${scriptPath}`,
          `--script=${checkerPath}`,
          '--script-opts=streamee_smart_ultrawide_fill-default_mode=off,streamee_smart_ultrawide_fill-lighting_enabled=yes',
          `--log-file=${logPath}`,
          runtimeCase.source,
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );
      const diagnostics = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''}`;
      assert.equal(result.error, undefined, diagnostics);
      assert.equal(result.status, 0, diagnostics);
      assert.match(diagnostics, new RegExp(`${runtimeCase.marker}_PASS`));
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
}

runLightingCase({
  name: 'MPV lights embedded letterbox bars while Fill remains off',
  marker: 'LETTERBOX_RUNTIME',
  source: 'av://lavfi:color=c=black:s=1920x1080:r=24,drawbox=x=0:y=140:w=1920:h=800:color=red:t=fill',
  horizontalBars: false,
  verticalBars: true,
});

runLightingCase({
  name: 'MPV detects embedded 16:9 pillarbox bars in an ultrawide frame',
  marker: 'PILLARBOX_RUNTIME',
  source: 'av://lavfi:color=c=black:s=2560x1080:r=24,drawbox=x=320:y=0:w=1920:h=1080:color=red:t=fill',
  horizontalBars: true,
  verticalBars: false,
});

runLightingCase({
  name: 'MPV preserves both axes of an embedded windowbox',
  marker: 'WINDOWBOX_RUNTIME',
  source: 'av://lavfi:color=c=black:s=1920x1080:r=24,drawbox=x=240:y=140:w=1440:h=800:color=red:t=fill',
  horizontalBars: true,
  verticalBars: true,
});

test(
  'MPV lighting hides thin native-edge fringes in rendered pixels',
  { skip: !existsSync(mpvPath), timeout: 15_000 },
  () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'streamee-lighting-pixels-'));
    const checkerPath = join(temporaryDirectory, 'checker.lua');
    const screenshotPath = join(temporaryDirectory, 'lighting.png');
    const logPath = join(temporaryDirectory, 'mpv.log');
    const luaScreenshotPath = screenshotPath.replaceAll('\\', '/');
    writeFileSync(
      checkerPath,
      `local mp = require "mp"
mp.add_timeout(1.0, function()
    mp.commandv("screenshot-to-file", ${JSON.stringify(luaScreenshotPath)}, "window")
    mp.add_timeout(0.5, function()
        io.stderr:write("LIGHTING_PIXELS_PASS\\n")
        mp.commandv("quit", 0)
    end)
end)
`,
      'utf8',
    );

    try {
      const result = spawnSync(
        mpvPath,
        [
          '--no-config',
          '--load-scripts=no',
          '--vo=gpu-next',
          '--gpu-api=d3d11',
          '--gpu-context=d3d11',
          '--ao=null',
          '--no-audio',
          '--force-window=yes',
          '--window-minimized=yes',
          '--geometry=854x360',
          '--length=6',
          `--script=${scriptPath}`,
          `--script=${checkerPath}`,
          '--script-opts=streamee_smart_ultrawide_fill-default_mode=off,streamee_smart_ultrawide_fill-lighting_enabled=yes,streamee_smart_ultrawide_fill-efficient_initial_delay=30',
          `--log-file=${logPath}`,
          'av://lavfi:color=c=0xA06020:s=1440x1080:r=24,drawbox=x=0:y=0:w=2:h=1080:color=black:t=fill,drawbox=x=1436:y=0:w=4:h=1080:color=black:t=fill',
        ],
        { encoding: 'utf8', timeout: 12_000 },
      );
      const diagnostics = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''}`;
      assert.equal(result.error, undefined, diagnostics);
      assert.equal(result.status, 0, diagnostics);
      assert.match(diagnostics, /LIGHTING_PIXELS_PASS/);
      assert.equal(existsSync(screenshotPath), true, diagnostics);

      const escapedScreenshotPath = screenshotPath.replaceAll("'", "''");
      const pixelResult = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Add-Type -AssemblyName System.Drawing; $image=[System.Drawing.Bitmap]::new('${escapedScreenshotPath}'); try { foreach($x in @(186,187,188,665,666,667)){ $color=$image.GetPixel($x,180); Write-Output ($color.R.ToString() + ',' + $color.G.ToString() + ',' + $color.B.ToString()) } } finally { $image.Dispose() }`,
        ],
        { encoding: 'utf8', timeout: 5_000 },
      );
      assert.equal(pixelResult.error, undefined, pixelResult.stderr);
      assert.equal(pixelResult.status, 0, pixelResult.stderr);
      const pixels = pixelResult.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split(',').map(Number));
      assert.equal(pixels.length, 6, pixelResult.stdout);
      const maxChannelDelta = (left: number[], right: number[]) =>
        Math.max(...left.map((channel, index) => Math.abs(channel - right[index])));
      for (const [label, lighting, boundary, picture] of [
        ['left', pixels[0], pixels[1], pixels[2]],
        ['right', pixels[5], pixels[4], pixels[3]],
      ] as const) {
        assert.ok(
          maxChannelDelta(lighting, boundary) <= 12,
          `${label} lighting-to-boundary seam: ${lighting} -> ${boundary}`,
        );
        assert.ok(
          maxChannelDelta(boundary, picture) <= 12,
          `${label} boundary-to-picture seam: ${boundary} -> ${picture}`,
        );
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  },
);
