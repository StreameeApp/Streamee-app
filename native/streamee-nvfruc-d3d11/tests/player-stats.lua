local mp = require "mp"
local utils = require "mp.utils"
local screenshot = os.getenv("STREAMEE_OPTIFLOW_PROBE_SCREENSHOT")
local function sample()
    local t = mp.get_property_native("vf-metadata/streamee-optiflow", {})
    mp.msg.info("OPTIFLOW_SAMPLE " .. utils.format_json({
        time = mp.get_property_number("time-pos"),
        metadata = t,
        drops = mp.get_property_number("frame-drop-count"),
        decoderDrops = mp.get_property_number("decoder-frame-drop-count"),
        avsync = mp.get_property_number("avsync"),
        output = mp.get_property_native("video-out-params"),
    }))
    if screenshot and (mp.get_property_number("time-pos") or 0) >= 5 then
        mp.commandv("screenshot-to-file", screenshot, "window")
        screenshot = nil
    end
end
mp.add_periodic_timer(1, sample)
mp.register_event("end-file", sample)
