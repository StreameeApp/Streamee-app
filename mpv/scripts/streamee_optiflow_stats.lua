-- OptiFlow diagnostics. Only samples from this player process are accepted.
local mp = require "mp"
local utils = require "mp.utils"
local visible = false
local sample = nil
local received = nil
local overlay = mp.create_osd_overlay("ass-events")

local function number(property)
    local value = mp.get_property_number(property)
    return value and string.format("%.2f", value) or "unavailable"
end

local function milliseconds(key)
    local value = sample and sample[key]
    return type(value) == "number" and string.format("%.3f", value) or "?"
end

local function render()
    if not visible then overlay:remove(); return end
    local chain = {}
    local enabled = false
    for _, filter in ipairs(mp.get_property_native("vf", {})) do
        if filter.enabled ~= false then
            local name = filter.label or filter.name or "unknown"
            chain[#chain + 1] = name
            if name == "streamee-optiflow" then enabled = true end
        end
    end
    local state = enabled and (sample and sample.state or "waiting for native telemetry") or "off"
    local lines = {
        "OptiFlow diagnostics (WIP) | Ctrl+Shift+O",
        "Adapter: " .. state .. (received and string.format(" | sample %.1fs ago", mp.get_time() - received) or ""),
        "Source FPS: " .. number("container-fps") .. " | Filter FPS (estimated): " .. number("estimated-vf-fps"),
        "Dropped: " .. number("frame-drop-count") .. " | Decoder dropped: " .. number("decoder-frame-drop-count"),
        "A/V sync: " .. number("avsync") .. " s | Paused: " .. tostring(mp.get_property_native("pause")),
        "Active filters: " .. table.concat(chain, " -> "),
    }
    if sample and sample.native then
        lines[#lines + 1] = string.format("Format: %s | Synthesized: %s | Held: %s | Bypassed: %s",
            tostring(sample.format), tostring(sample.synthesized), tostring(sample.held), tostring(sample.bypassed))
        lines[#lines + 1] = string.format("Metadata holds: %s | Scene cuts: %s | GPU allocation: %.1f MiB",
            tostring(sample.metadataHolds), tostring(sample.sceneCuts), (tonumber(sample.allocatedBytes) or 0) / 1048576)
        lines[#lines + 1] = "Last GPU span ms: analysis " .. milliseconds("analysisMs")
            .. " | flow " .. milliseconds("flowMs") .. " | repair " .. milliseconds("repairMs")
            .. " | synthesis " .. milliseconds("synthesisMs") .. " | total " .. milliseconds("gpuSpanMs")
        lines[#lines + 1] = "Reason: " .. tostring(sample.reason or "")
        lines[#lines + 1] = "GPU spans include queue/host gaps; exclude decode, rendering and presentation."
    end
    -- Strip ASS control characters from external property strings.
    for i, line in ipairs(lines) do lines[i] = line:gsub("[\\{}]", "") end
    overlay.data = "{\\an7\\fs18\\bord1\\shad1}" .. table.concat(lines, "\\N")
    overlay:update()
end

local function reset()
    sample = nil
    received = nil
    mp.set_property_native("user-data/streamee-optiflow-stats", {})
    render()
end
mp.register_event("start-file", reset)
mp.register_event("end-file", reset)
mp.register_event("seek", reset)
mp.add_key_binding("Ctrl+Shift+o", "toggle-optiflow-diagnostics", function()
    visible = not visible
    render()
end)
mp.add_periodic_timer(1, function()
    local native = mp.get_property_native("vf-metadata/streamee-optiflow")
    if type(native) == "table" and type(native.state) == "string" then
        for key, value in pairs(native) do
            native[key] = tonumber(value) or value
        end
        native.native = true
        sample = native
        received = mp.get_time()
        mp.set_property_native("user-data/streamee-optiflow-stats", sample)
    elseif sample then
        -- A removed/replaced filter must not leave another session's counts visible.
        reset()
    end
    if visible then render() end
end)
