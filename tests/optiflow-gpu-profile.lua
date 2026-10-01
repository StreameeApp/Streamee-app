-- Profile validation tests only. No GPU, playback, or driver changes.
local host = require "mp"
local utils = require "mp.utils"
local script = assert(os.getenv("STREAMEE_GPU_PROFILE_TEST_SCRIPT"))
local original_getenv = os.getenv

local function scenario(fruc, vsr, width, fault)
    local props = {
        ["video-params"] = {w=width, h=1080},
        ["video-out-params"] = {w=vsr and width*2 or width, h=vsr and 2160 or 1080},
        ["estimated-vf-fps"] = 24, ["frame-drop-count"] = 0,
        ["vo-passes"] = {fresh={{count=10, samples={1,2,3}}}}, vf={},
    }
    if fruc then
        props.vf[#props.vf+1] = {label="streamee-nvfruc"}
        props["user-data/streamee-optiflow-stats"] = {state="active", outputs=60}
    end
    if vsr then props.vf[#props.vf+1] = {label="streamee-vsr"} end
    if fault == "missing-filter" then props.vf = {} end
    if fault == "wrong-size" then props["video-out-params"].w = 1 end
    if fault == "fallback" then props["user-data/streamee-optiflow-stats"].state = "fallback-processing" end
    if fault == "no-render" then props["vo-passes"].fresh = {} end
    if fault == "hdr" then props.vf[#props.vf+1] = {label="streamee-rtx-hdr"} end
    local events, result, exit = {}, nil, nil
    local env = {STREAMEE_PROFILE_FRUC=fruc and "yes" or "no", STREAMEE_PROFILE_VSR=vsr and "yes" or "no",
        STREAMEE_PROFILE_WIDTH=tostring(width), STREAMEE_PROFILE_HEIGHT="1080"}
    os.getenv = function(key) return env[key] or original_getenv(key) end
    package.loaded["mp"] = {
        get_time = function() return 10 end,
        observe_property = function(name, _, fn) if props[name] ~= nil then fn(name, props[name]) end end,
        get_property_native = function(name) return props[name] end,
        register_event = function(name, fn) events[name] = fn end,
        msg = {info=function(text) result=utils.parse_json(text:match("OPTIFLOW_GPU_PROFILE (.*)")) end},
        commandv = function(command, code) assert(command == "quit"); exit=code end,
    }
    dofile(script)
    events["end-file"]({reason=fault == "error" and "error" or "eof"})
    assert(result.valid == (fault == nil), tostring(fault))
    assert(exit == (fault and 1 or 0))
    assert(result.presentationValidated == false and result.rateValidated == false)
    for _, pass in ipairs(result.rendererPasses.fresh) do assert(pass.samples == nil) end
end
local ok, err = pcall(function()
    scenario(false,false,1920); scenario(false,true,1920)
    scenario(true,false,1920); scenario(true,true,1920); scenario(true,false,3840)
    for _, fault in ipairs({"missing-filter","wrong-size","fallback","no-render","hdr","error"}) do
        scenario(true,true,1920,fault)
    end
end)
os.getenv = original_getenv
if ok then host.msg.info("GPU profile validation tests passed") else host.msg.error(tostring(err)) end
host.commandv("quit", ok and 0 or 1)
