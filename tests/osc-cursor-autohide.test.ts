import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const osc = readFileSync('mpv/scripts/PlexOSC.lua', 'utf8');
const backend = readFileSync('src-tauri/src/lib.rs', 'utf8');

test('new playback arms MPV-native cursor hiding without synthetic mouse input', () => {
  assert.match(
    osc,
    /mp\.register_event\('file-loaded',[\s\S]{0,260}state\.showtime = mp\.get_time\(\)[\s\S]{0,80}request_tick\(\)/,
  );
  assert.match(
    osc,
    /if timeout <= 0 then[\s\S]{0,180}hide_osc\(\)[\s\S]{0,80}force_hide_idle_cursor\(\)/,
  );
  assert.match(
    osc,
    /function force_hide_idle_cursor\(\)[\s\S]{0,420}mp\.set_property\('cursor-autohide', 'always'\)/,
  );
  assert.doesNotMatch(backend, /PostMessageW|WM_MOUSEMOVE/);
});

test('real mouse movement restores the previous MPV cursor policy', () => {
  assert.match(
    osc,
    /function restore_cursor_autohide_on_mouse_move\(\)[\s\S]{0,1200}mp\.set_property\('cursor-autohide', restore\)/,
  );
  assert.match(
    osc,
    /elseif source == 'mouse_move' then\s+restore_cursor_autohide_on_mouse_move\(\)/,
  );
});
