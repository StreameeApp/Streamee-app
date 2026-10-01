-- Real headless-player probe; run with the diagnostic script and isolated IPC.
local active = false
local expected = os.getenv("STREAMEE_OPTIFLOW_EXPECT_STATE") or "active"
local video = nil
local fps = nil
mp.observe_property("video-out-params", "native", function(_, data)
    if type(data) == "table" then video = data end
end)
mp.observe_property("estimated-vf-fps", "number", function(_, data)
    if data then fps = data end
end)
mp.observe_property("user-data/streamee-optiflow-stats", "native", function(_, data)
    if type(data) == "table" and data.state == expected then
        active = expected ~= "active" or (type(data.packMs) == "number" and type(data.processMs) == "number"
            and type(data.outputs) == "number" and data.outputs > 0)
    end
end)
mp.register_event("end-file", function()
    local format = os.getenv("STREAMEE_OPTIFLOW_EXPECT_FORMAT")
    local gamma = os.getenv("STREAMEE_OPTIFLOW_EXPECT_GAMMA")
    local rate = tonumber(os.getenv("STREAMEE_OPTIFLOW_EXPECT_FPS"))
    if format then active = active and video and video.pixelformat == format end
    if gamma then active = active and video and video.gamma == gamma end
    if rate then active = active and fps and math.abs(fps - rate) < 0.01 end
    if active then
        mp.msg.info("OptiFlow telemetry smoke passed")
    else
        mp.msg.error("OptiFlow telemetry smoke failed: no native sample received")
    end
    mp.commandv("quit", active and 0 or 1)
end)
