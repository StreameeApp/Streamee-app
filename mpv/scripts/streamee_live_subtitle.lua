-- Streamee live subtitle overlay
-- Displays WhisperLive captions directly in the MPV render stack and aligns
-- them to playback time instead of a fixed wall-clock timeout.

local mp = require('mp')

local overlay = mp.create_osd_overlay('ass-events')
local state = {
    current = nil,
    timer = nil,
    base_offset = 0,
}

local COLORS = {
    text = '&HFBFCFF&',
    shadow = '&H000000&',
}

local TIME_WINDOW = {
    lead = 0.35,
    tail = 1.10,
}

local STYLE_PRESETS = {
    compact = { size = 34, shadow = 1.5 },
    balanced = { size = 42, shadow = 2.0 },
    large = { size = 50, shadow = 2.0 },
}

local POSITION_PRESETS = {
    bottom = { y = 0.085 },
    raised = { y = 0.135 },
    high = { y = 0.185 },
}

local function normalize_style(value)
    if value == 'compact' or value == 'large' then
        return value
    end
    return 'balanced'
end

local function normalize_position(value)
    if value == 'raised' or value == 'high' then
        return value
    end
    return 'bottom'
end

local function ass_escape(text)
    if not text or text == '' then
        return ''
    end
    local ok, escaped = pcall(mp.command_native, { 'escape-ass', text })
    if ok and escaped then
        return escaped
    end
    return (text:gsub('\\', '\\\\'):gsub('{', '\\{'):gsub('}', '\\}'))
end

local function draw_text(parts, x, y, text, color, size, bold, anchor, shadow, font)
    local font_tag = font and ('\\fn' .. font) or ''
    parts[#parts + 1] = string.format(
        '{\\pos(%d,%d)\\an%d\\bord0\\shad%.1f\\fs%d\\1c%s\\3c%s%s%s}%s',
        x,
        y,
        anchor or 5,
        shadow or 2,
        size,
        color,
        COLORS.shadow,
        bold and '\\b1' or '\\b0',
        font_tag,
        ass_escape(text)
    )
end

local function normalize_text(text)
    local clean = (text or ''):gsub('\r\n', '\n'):gsub('\r', '\n')
    clean = clean:gsub('\n+', '\\N')
    return ass_escape(clean)
end

local function hide_overlay()
    overlay.data = ''
    overlay.hidden = true
    overlay:update()
end

local function render()
    local caption = state.current
    local w = math.floor(mp.get_property_number('osd-width') or 0)
    local h = math.floor(mp.get_property_number('osd-height') or 0)
    local current_time = mp.get_property_number('playback-time')

    if w <= 0 or h <= 0 or not caption or not caption.text or caption.text == '' or current_time == nil then
        hide_overlay()
        return
    end

    local effective_time = current_time ~= nil and (current_time + (tonumber(state.base_offset) or 0)) or nil
    local visible_from = tonumber(caption.visible_from) or 0
    local visible_until = tonumber(caption.visible_until) or 0
    if effective_time == nil
        or effective_time < visible_from
        or effective_time > visible_until then
        hide_overlay()
        return
    end

    local safe = normalize_text(caption.text)
    local lines = 1
    for _ in safe:gmatch('\\N') do
        lines = lines + 1
    end

    local style = STYLE_PRESETS[normalize_style(caption.style)] or STYLE_PRESETS.balanced
    local position = POSITION_PRESETS[normalize_position(caption.position)] or POSITION_PRESETS.bottom
    local y = h - math.floor(math.max(72, h * position.y))
    local cx = math.floor(w / 2)

    local parts = {}
    parts[#parts + 1] = '{\\an8\\bord0\\shad0}'
    draw_text(parts, cx, y, caption.text, COLORS.text, lines > 1 and (style.size - 2) or style.size, true, 8, style.shadow, 'Segoe UI')

    overlay.res_x = w
    overlay.res_y = h
    overlay.data = table.concat(parts, '\n')
    overlay.hidden = false
    overlay:update()
end

local function ensure_timer()
    if state.timer then
        return
    end
    state.timer = mp.add_periodic_timer(0.08, render)
end

local function show(text, start_time, end_time, base_offset, style, position)
    local start_num = tonumber(start_time) or 0
    local end_num = tonumber(end_time) or 0
    local base_offset_num = tonumber(base_offset) or 0
    local playback_time = mp.get_property_number('playback-time') or 0
    local effective_now = playback_time + base_offset_num
    local min_visible_secs = math.max(1.5, math.min(4.5, math.max(0.0, end_num - start_num) + 0.5))
    local visible_from = math.min(start_num - TIME_WINDOW.lead, effective_now - 0.05)
    local visible_until = math.max(end_num + TIME_WINDOW.tail, effective_now + min_visible_secs)

    state.current = {
        text = text or '',
        start = start_num,
        ['end'] = end_num,
        visible_from = visible_from,
        visible_until = visible_until,
        style = normalize_style(style),
        position = normalize_position(position),
    }
    state.base_offset = base_offset_num
    ensure_timer()
    render()
end

local function clear()
    state.current = nil
    hide_overlay()
end

mp.register_script_message('streamee-live-subtitle', function(action, text, start_time, end_time, base_offset, style, position)
    if action == 'show' then
        show(text, start_time, end_time, base_offset, style, position)
    elseif action == 'clear' then
        clear()
    end
end)

mp.register_event('file-loaded', clear)
