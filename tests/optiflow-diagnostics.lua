-- Run in headless MPV. Player calls are mocked; no GPU or media is needed.
local host = require "mp"
local utils = require "mp.utils"
local events, bindings = {}, {}
local properties = {vf = {{label = "streamee-optiflow"}, {label = "streamee-vsr"},
    {label = "streamee-rtx-hdr", enabled = false}}, ["container-fps"] = 24,
    ["estimated-vf-fps"] = 48, ["frame-drop-count"] = 3, pause = false, pid = 123}
local overlay = {data = "", update = function() end, remove = function() end}
local fake = {
    create_osd_overlay = function() return overlay end,
    get_property_native = function(key, fallback)
        if properties[key] == nil then return fallback end
        return properties[key]
    end,
    get_property_number = function(key) return properties[key] end,
    set_property_native = function(key, value) properties[key] = value end,
    get_time = function() return 10 end,
    register_script_message = function(name, callback) events[name] = callback end,
    register_event = function(name, callback) events[name] = callback end,
    add_key_binding = function(key, _, callback) bindings[key] = callback end,
    add_periodic_timer = function(_, callback) events.timer = callback end,
}
local function test()
    package.loaded["mp"] = fake
    dofile(assert(os.getenv("STREAMEE_OPTIFLOW_TEST_SCRIPT")))
    bindings["Ctrl+Shift+o"]()
    assert(overlay.data:find("waiting for native telemetry", 1, true))
    properties["vf-metadata/streamee-optiflow"] = {state="active", outputs="60",
        synthesized="59", held="0", bypassed="0", format="P010", flowMs="1.25"}
    events.timer()
    assert(properties["user-data/streamee-optiflow-stats"].outputs == 60)
    assert(overlay.data:find("flow 1.250", 1, true))
    assert(overlay.data:find("Format: P010", 1, true))
    assert(overlay.data:find("streamee-optiflow -> streamee-vsr", 1, true))
    assert(not overlay.data:find("streamee-rtx-hdr", 1, true))
    assert(overlay.data:find("Decoder dropped: unavailable", 1, true))
    properties["vf-metadata/streamee-optiflow"] = {state="bypassed", reason="processing-failed"}
    events.timer()
    assert(overlay.data:find("processing-failed", 1, true))
    properties["vf-metadata/streamee-optiflow"] = nil
    properties.vf = {}
    events.timer()
    assert(next(properties["user-data/streamee-optiflow-stats"]) == nil)
    assert(overlay.data:find("Adapter: off", 1, true))
    assert(not overlay.data:find("processing-failed", 1, true))
    properties.vf = {{label = "streamee-optiflow"}}
    events.seek()
    assert(next(properties["user-data/streamee-optiflow-stats"]) == nil)
    assert(overlay.data:find("waiting for native telemetry", 1, true))
    events["end-file"]()
end
local ok, message = pcall(test)
if ok then host.msg.info("OptiFlow diagnostics tests passed") else host.msg.error(message) end
host.commandv("quit", ok and 0 or 1)
