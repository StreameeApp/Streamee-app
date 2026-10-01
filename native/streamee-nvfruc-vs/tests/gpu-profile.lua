-- Isolated GPU processing probe, not an on-screen smoothness benchmark.
local mp = require "mp"
local utils = require "mp.utils"
local started = mp.get_time()
local telemetry, video, source, fps, drops, passes, chain = nil, nil, nil, nil, nil, nil, {}
local peak_fps = 0
local function remember(name, assign)
    mp.observe_property(name, "native", function(_, value)
        if value ~= nil then assign(value) end
    end)
end
remember("user-data/streamee-optiflow-stats", function(value)
    if type(value) == "table" and value.state then telemetry = value end
end)
remember("video-out-params", function(value) video = value end)
remember("video-params", function(value) source = value end)
remember("estimated-vf-fps", function(value) fps = value; peak_fps = math.max(peak_fps, value) end)
remember("frame-drop-count", function(value) drops = value end)
remember("vf", function(value)
    chain = {}
    for _, filter in ipairs(value) do
        if filter.enabled ~= false then chain[#chain + 1] = filter.label or filter.name end
    end
end)
mp.register_event("end-file", function(event)
    passes = mp.get_property_native("vo-passes")
    if passes then
        for _, list in pairs(passes) do
            for _, pass in ipairs(list) do pass.samples = nil end
        end
    end
    local expected_fruc = os.getenv("STREAMEE_PROFILE_FRUC") == "yes"
    local expected_vsr = os.getenv("STREAMEE_PROFILE_VSR") == "yes"
    local width = tonumber(os.getenv("STREAMEE_PROFILE_WIDTH"))
    local height = tonumber(os.getenv("STREAMEE_PROFILE_HEIGHT"))
    local function contains(label)
        for _, item in ipairs(chain) do if item == label then return true end end
        return false
    end
    local expected_width = expected_vsr and width * 2 or width
    local expected_height = expected_vsr and height * 2 or height
    -- Untimed playback does not reliably update MPV's FPS estimator. Validate
    -- GPU rendering, dimensions, filter chain and adapter activity separately.
    local rendered = false
    for _, pass in ipairs(passes and passes.fresh or {}) do
        if (pass.count or 0) > 0 then rendered = true end
    end
    local valid = event.reason == "eof" and rendered and video and video.w == expected_width
        and video.h == expected_height
        and contains("streamee-nvfruc") == expected_fruc
        and contains("streamee-vsr") == expected_vsr
        and not contains("streamee-rtx-hdr")
        and (not expected_fruc or (telemetry and telemetry.state == "active"))
    mp.msg.info("OPTIFLOW_GPU_PROFILE " .. utils.format_json({
        valid = not not valid, reason = event.reason, seconds = mp.get_time() - started,
        source = source, output = video, finalFps = fps, peakFps = peak_fps, drops = drops,
        filters = chain, adapter = telemetry, rendererPasses = passes,
        minimized = true, presentationValidated = false, rateValidated = false,
    }))
    mp.commandv("quit", valid and 0 or 1)
end)
