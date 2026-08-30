import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const scriptPath = join(root, 'mpv', 'scripts', 'streamee_smart_ultrawide_fill.lua');
const shaderPath = join(root, 'mpv', 'shaders', 'streamee_ultrawide_lighting.glsl');
const mpvPath = join(root, 'mpv', 'mpv.exe');
const script = readFileSync(scriptPath, 'utf8');
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

test(
  'MPV lights embedded bars while Fill remains off',
  { skip: !existsSync(mpvPath), timeout: 15_000 },
  () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'streamee-black-bar-test-'));
    const checkerPath = join(temporaryDirectory, 'checker.lua');
    const logPath = join(temporaryDirectory, 'mpv.log');
    writeFileSync(
      checkerPath,
      `local mp = require "mp"
local function fail(message)
    io.stderr:write("BLACK_BAR_RUNTIME_FAIL: " .. message .. "\\n")
    mp.commandv("quit", 9)
end
mp.add_timeout(3.0, function()
    local mode = mp.get_property_native("user-data/streamee-adaptive-crop-mode")
    local lighting = mp.get_property_number("user-data/streamee-black-bar-lighting-enabled", 0)
    local values = mp.get_property_native("glsl-shader-opts") or {}
    local crop_y = tonumber(values["streamee_ultrawide_lighting/crop_y"])
    local crop_h = tonumber(values["streamee_ultrawide_lighting/crop_h"])
    local light_y = tonumber(values["streamee_ultrawide_lighting/light_y"])
    local light_h = tonumber(values["streamee_ultrawide_lighting/light_h"])
    if mode ~= "off" then return fail("Fill mode changed to " .. tostring(mode)) end
    if lighting ~= 1 then return fail("Lighting was not enabled") end
    if not crop_y or math.abs(crop_y) > 0.01 then return fail("Rendered frame was cropped") end
    if not crop_h or math.abs(crop_h - 1.0) > 0.01 then return fail("Rendered frame height changed") end
    if not light_y or light_y < 0.08 then return fail("Top embedded bar was not detected") end
    if not light_h or light_h > 0.84 then return fail("Bottom embedded bar was not detected") end
    io.stderr:write("BLACK_BAR_RUNTIME_PASS\\n")
    mp.commandv("quit", 0)
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
          '--length=8',
          `--script=${scriptPath}`,
          `--script=${checkerPath}`,
          '--script-opts=streamee_smart_ultrawide_fill-default_mode=off,streamee_smart_ultrawide_fill-lighting_enabled=yes',
          `--log-file=${logPath}`,
          'av://lavfi:color=c=black:s=1920x1080:r=24,drawbox=x=0:y=140:w=1920:h=800:color=red:t=fill',
        ],
        { encoding: 'utf8', timeout: 12_000 },
      );
      const diagnostics = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''}`;
      assert.equal(result.error, undefined, diagnostics);
      assert.equal(result.status, 0, diagnostics);
      assert.match(diagnostics, /BLACK_BAR_RUNTIME_PASS/);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  },
);
