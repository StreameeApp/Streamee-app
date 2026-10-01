-- Exercise the real thumbnail script with deterministic helper and timer events.
local host = require "mp"
local native_utils = require "mp.utils"
local script = assert(os.getenv("STREAMEE_THUMBFAST_TEST_SCRIPT"))

local function session(hdr)
    local messages, events, observers, timers, helpers, logs, seeks = {}, {}, {}, {}, {}, {}, {}
    local clock = 0
    local properties = {platform="windows", vid=1, path="http://127.0.0.1:1234/addon/local",
        ["demuxer-via-network"]=true, ["current-vo"]="gpu-next",
        ["current-tracks/video"]={codec="hevc"},
        ["video-dec-params"]={w=3840,h=2160}, ["video-out-params"]={w=3840,h=2160},
        ["video-params"]={rotate=0}, vf={}, duration=120}
    if hdr then properties["video-params"].gamma="pq" end
    local function timer(period, callback)
        local t = {period=period, callback=callback, enabled=true}
        function t:kill() self.enabled=false end
        function t:resume() self.enabled=true end
        function t:is_enabled() return self.enabled end
        timers[#timers+1] = t
        return t
    end
    local files = {}
    local fake = {
        utils={getpid=function() return 654321 end,
            format_json=native_utils.format_json,
            file_info=function(path) return files[path] and {size=files[path]} end},
        options={read_options=function(o)
            o.enabled=true; o.network=true; o.cache_only=true; o.mpv_path="test-mpv"
            o.hwdec="auto-copy"
        end},
        msg={}, get_time=function() return clock end,
        get_property=function(name) return properties[name] end,
        get_property_native=function(name, default)
            if properties[name]==nil then return default end
            return properties[name]
        end,
        get_property_number=function(name, default) return properties[name] or default end,
        command_native=function(command)
            if command[1]=="expand-path" then return command[2] end
        end, commandv=function() end,
        command_native_async=function(command, callback)
            helpers[#helpers+1]={args=command.args, callback=callback}
            return #helpers
        end,
        abort_async_command=function() end,
        add_timeout=timer, add_periodic_timer=timer,
        register_script_message=function(name, callback) messages[name]=callback end,
        register_event=function(name, callback) events[name]=callback end,
        register_idle=function() end,
        observe_property=function(name, _, callback)
            observers[name]=callback
            if properties[name]~=nil then callback(name, properties[name]) end
        end,
        unobserve_property=function() end,
    }
    for _, level in ipairs({"info", "warn", "error"}) do
        fake.msg[level]=function(message) logs[#logs+1]=message end
    end
    local old_open, old_remove, old_rename = io.open, os.remove, os.rename
    io.open=function(path)
        assert(path:find("pipe", 1, true), "unexpected file access")
        return {seek=function() return 0 end, write=function(_, command) seeks[#seeks+1]=command end,
            flush=function() end, close=function() end}
    end
    os.remove=function(path) files[path]=nil; return true end
    os.rename=function(from, to) files[to]=files[from]; files[from]=nil; return true end
    mp=fake
    package.loaded["mp.utils"]=fake.utils
    package.loaded["mp.options"]=fake.options
    dofile(script)
    events["file-loaded"]()
    local function hover(time) messages.thumb(tostring(time), "1", "2") end
    local function write_frame()
        local output
        for _, arg in ipairs(helpers[#helpers].args) do
            if arg:sub(1,4)=="--o=" then output=arg:sub(5) end
        end
        files[assert(output)]=288*162*4
    end
    local function render()
        write_frame()
        for _, t in ipairs(timers) do
            if t.period==1/60 and t.enabled then t.callback() end
        end
    end
    return {hover=hover, render=render, write_frame=write_frame, helpers=helpers, logs=logs, seeks=seeks,
        advance=function() clock=clock+2 end,
        cleanup=function()
            events.shutdown()
            io.open, os.remove, os.rename=old_open, old_remove, old_rename
        end}
end

local function has_arg(helper, value)
    for _, arg in ipairs(helper.args) do if arg==value then return true end end
    return false
end

local function tests()
    local s=session()
    s.hover(10); s.hover(20)
    s.helpers[1].callback(true, {status=1})
    assert(#s.helpers==2, "CUVID failure must restart the helper")
    assert(has_arg(s.helpers[2], "--hwdec=auto-copy"), "fallback must use copy-back decoding")
    assert(has_arg(s.helpers[2], "--start=20"), "fallback must service the newest hover")
    assert(s.seeks[#s.seeks]:find("seek 20 ", 1, true), "fallback seek must match its issued timestamp")
    s.render()
    assert(s.logs[#s.logs]:find("request_time=20.000", 1, true), "render must retain the correct timestamp")
    assert(has_arg(s.helpers[2], "--cache=no"))
    assert(s.helpers[2].args[#s.helpers[2].args]:find("streamee-cache-only=1", 1, true))
    s.cleanup()

    s=session(true)
    s.hover(10)
    s.helpers[1].callback(true, {status=1})
    s.helpers[2].callback(true, {status=1})
    s.advance(); s.hover(10)
    assert(#s.helpers==3, "a failed fallback must allow the same hover to retry")
    local filter
    for _, arg in ipairs(s.helpers[3].args) do
        if arg:sub(1,5)=="--vf=" then filter=arg end
    end
    assert(filter and filter:find("eq=gamma=", 1, true), "transient failure must preserve HDR conversion")
    s.cleanup()

    s=session()
    s.hover(10); s.write_frame()
    s.helpers[1].callback(true, {status=0})
    local rendered=false
    for _, message in ipairs(s.logs) do
        assert(not message:find("helper_eof", 1, true), "completed frame must not become a cache miss")
        if message:find("preview rendered:", 1, true) then rendered=true end
    end
    assert(rendered, "helper exit must collect the final frame before stopping the poll")
    s.cleanup()

    s=session()
    s.hover(10); s.render()
    s.helpers[1].callback(true, {status=0})
    s.hover(20)
    assert(#s.helpers==2, "an exited helper must never be reused")
    s.cleanup()

    s=session()
    s.hover(10); s.render(); s.hover(20); s.hover(30)
    s.helpers[1].callback(false, nil)
    assert(#s.helpers==2, "failure after a successful render must service the queued hover")
    assert(has_arg(s.helpers[2], "--start=30"))
    s.cleanup()

    s=session()
    s.hover(10); s.hover(20)
    s.helpers[1].callback(true, {status=0})
    assert(#s.helpers==2, "EOF must service the queued hover immediately")
    s.helpers[1].callback(true, {status=0})
    s.render()
    assert(s.logs[#s.logs]:find("request_time=20.000", 1, true), "stale callback must not cancel recovery")
    s.cleanup()
end

local ok, message=pcall(tests)
mp=host
if ok then host.msg.info("Thumbfast recovery tests passed") else host.msg.error(message) end
host.commandv("quit", ok and 0 or 1)
