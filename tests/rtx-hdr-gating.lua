-- Run inside headless MPV; all player operations below are mocked.
local host = require("mp")
local script = assert(os.getenv("STREAMEE_VSR_TEST_SCRIPT"))
local function scenario(vsr_selected)
    local props = {vf = {}, contrast = 0,
        ["video-params"] = {w = 1920, h = 1080, gamma = "bt.1886"}}
    local observers, messages = {}, {}
    local fake = {
        get_property_native = function(name, fallback)
            if props[name] == nil then return fallback end
            return props[name]
        end,
        get_property_number = function(name, fallback) return props[name] or fallback end,
        set_property_number = function(name, value) props[name] = value end,
        observe_property = function(name, _, callback) observers[name] = callback end,
        register_script_message = function(name, callback) messages[name] = callback end,
        register_event = function() end,
        add_timeout = function(_, callback) callback() end,
        osd_message = function() end,
        msg = {info = function() end, error = function(message) error(message) end},
    }
    fake.commandv = function(command, operation, value)
        assert(command == "vf")
        local label = value:match("^@([^:]+)")
        assert(label)
        if operation == "remove" then
            for index = #props.vf, 1, -1 do
                if props.vf[index].label == label then table.remove(props.vf, index) end
            end
        elseif operation == "pre" then
            table.insert(props.vf, 1, {label = label})
        else
            assert(operation == "add")
            table.insert(props.vf, {label = label})
        end
    end
    package.loaded["mp"] = fake
    package.loaded["mp.options"] = {read_options = function(o)
        o.enabled = vsr_selected
        o.rtx_hdr = true
        o.hdr_contrast_boost = true
    end}
    dofile(script)
    local function check(expected)
        local count = 0
        for _, filter in ipairs(props.vf) do
            if filter.label == "streamee-rtx-hdr" then count = count + 1 end
        end
        assert(count == (expected and 1 or 0), "wrong HDR filter count: " .. count)
        assert(props.contrast == (expected and 15 or 0), "wrong contrast")
        assert(props["user-data/streamee-rtx-hdr-enabled"] == 1, "preference changed")
    end
    observers["video-params"](); check(false) -- Unknown display state.
    props["user-data/streamee-hdr-state"] = "off"
    observers["user-data/streamee-hdr-state"](); check(false)
    props["user-data/streamee-hdr-state"] = "on"
    observers["user-data/streamee-hdr-state"](); check(true)
    observers["video-params"](); check(true) -- No duplicate insertion.
    for _, transfer in ipairs({"pq", "hlg"}) do
        props["video-params"].gamma = transfer
        observers["video-params"](); check(false)
        for _, filter in ipairs(props.vf) do
            assert(filter.label ~= "streamee-vsr", "Native HDR must not be converted to NV12")
        end
    end
    props["video-params"] = {w = 1920, h = 1080, gamma = "bt.1886", pixelformat = "d3d11",
        ["hw-pixelformat"] = "p010"}
    observers["video-params"](); check(false)
    for _, filter in ipairs(props.vf) do assert(filter.label ~= "streamee-vsr") end
    for _, format in ipairs({"yuv420p9", "yuv420p10le", "yuv444p12be", "yuv444p14",
        "yuv444p16", "yuv444p16le", "p016", "p216le", "y416", "gbrp16be",
        "gbrpf32le", "gray16", "grayf32", "rgb48le", "rgba64be", "x2rgb10le",
        "yuv444pf", "yuva420pf", "rgb30", "xyz12be", "nv20be", "ya16", "yap16",
        "ayuv64be", "xv30", "xv36be", "rgbaf16", "bayer_bggr16"}) do
        props["video-params"] = {w = 1920, h = 1080, gamma = "bt.1886", pixelformat = format}
        observers["video-params"](); check(false)
        for _, filter in ipairs(props.vf) do
            assert(filter.label ~= "streamee-vsr", format .. " must preserve its precision")
        end
    end
    props["video-params"] = {w = 1920, h = 1080, gamma = "bt.1886", pixelformat = "d3d11",
        ["hw-pixelformat"] = "p016"}
    observers["video-params"](); check(false)
    for _, filter in ipairs(props.vf) do assert(filter.label ~= "streamee-vsr") end
    for _, format in ipairs({"yuv420p", "nv12", "rgb24", "rgba", "rgb565le", "gray"}) do
        props["video-params"] = {w = 1920, h = 1080, gamma = "bt.1886", pixelformat = format}
        observers["video-params"](); check(true)
    end
    props["video-params"] = {w = 1920, h = 1080, gamma = "bt.1886", ["dovi-profile"] = 8}
    observers["video-params"](); check(false)
    for _, filter in ipairs(props.vf) do assert(filter.label ~= "streamee-vsr") end
    props["video-params"] = {w = 1920, h = 1080, gamma = "bt.1886", hdr10plus = true}
    observers["video-params"](); check(false)
    for _, filter in ipairs(props.vf) do assert(filter.label ~= "streamee-vsr") end
    props["video-params"] = {w = 1920, h = 1080, gamma = "bt.1886"}
    props["video-params"].gamma = "bt.1886"
    observers["video-params"](); check(true)
    props["user-data/streamee-hdr-state"] = "off"
    observers["user-data/streamee-hdr-state"](); check(false)
    -- Distinguish native 4K from 1080p-to-4K scaling in OptiFlow sessions.
    props.vf = {{label = "streamee-optiflow"}}
    props["video-params"] = {w = 3840, h = 2160, gamma = "bt.1886"}
    observers["video-params"](); check(false)
    assert(#props.vf == 1 and props.vf[1].label == "streamee-optiflow",
        "Native 4K must not acquire a redundant 2x VSR filter")
    props["user-data/streamee-hdr-state"] = "on"
    observers["user-data/streamee-hdr-state"](); check(true)
    assert(#props.vf == 2 and props.vf[2].label == "streamee-rtx-hdr",
        "4K SDR enhancement must follow OptiFlow without VSR")
    props["video-params"] = {w = 1920, h = 1080, gamma = "bt.1886"}
    observers["video-params"](); check(true)
    assert(props.vf[1].label == "streamee-optiflow", "OptiFlow must process source resolution")
    if vsr_selected then
        assert(#props.vf == 3 and props.vf[2].label == "streamee-vsr"
            and props.vf[3].label == "streamee-rtx-hdr", "Expected OptiFlow -> VSR -> HDR")
    else
        assert(#props.vf == 2 and props.vf[2].label == "streamee-rtx-hdr")
    end
end
local ok, err = pcall(function() scenario(true); scenario(false) end)
if ok then host.msg.info("HDR gating: all display/source transition checks passed")
else host.msg.error(tostring(err)) end
host.commandv("quit", ok and 0 or 1)
