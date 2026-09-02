-- thumbfast.lua
--
-- High-performance on-the-fly thumbnailer
--
-- Built for easy integration in third-party UIs.

--[[
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
]]

local options = {
    -- Master switch controlled by Streamee's seek preview setting
    enabled = false,

    -- Socket path (leave empty for auto)
    socket = "",

    -- Thumbnail path (leave empty for auto)
    thumbnail = "",

    -- Maximum thumbnail generation size in pixels (scaled down to fit)
    -- Values are scaled when hidpi is enabled
    max_height = 288,
    max_width = 288,

    -- Scale factor for thumbnail display size (requires mpv 0.38+)
    -- Note that this is lower quality than increasing max_height and max_width
    scale_factor = 1,

    -- Apply tone-mapping, no to disable
    tone_mapping = "auto",

    -- Overlay id
    overlay_id = 42,

    -- Spawn thumbnailer on file load for faster initial thumbnails
    spawn_first = false,

    -- Close thumbnailer process after an inactivity period in seconds, 0 to disable
    quit_after_inactivity = 0,

    -- Enable on network playback
    network = false,

    -- Restrict supported Streamee network streams to the local cache-only proxy
    cache_only = false,

    -- Enable on audio playback
    audio = false,

    -- Hardware decoder used by the thumbnail helper
    hwdec = "no",

    -- Windows only: use native Windows API to write to pipe (requires LuaJIT)
    direct_io = false,

    -- Custom path to the mpv executable
    mpv_path = "mpv"
}

mp.utils = require "mp.utils"
mp.options = require "mp.options"
mp.options.read_options(options, "thumbfast")

local properties = {}
local pre_0_30_0 = mp.command_native_async == nil
local pre_0_33_0 = true
local support_media_control = mp.get_property_native("media-controls") ~= nil

function subprocess(args, async, callback)
    callback = callback or function() end

    if not pre_0_30_0 then
        if async then
            return mp.command_native_async({
                name = "subprocess",
                playback_only = true,
                capture_stdout = true,
                capture_stderr = true,
                args = args
            }, callback)
        else
            return mp.command_native({
                name = "subprocess",
                playback_only = false,
                capture_stdout = true,
                capture_stderr = true,
                args = args
            })
        end
    else
        if async then
            return mp.utils.subprocess_detached({args = args}, callback)
        else
            return mp.utils.subprocess({args = args})
        end
    end
end

local winapi = {}
if options.direct_io then
    local ffi_loaded, ffi = pcall(require, "ffi")
    if ffi_loaded then
        winapi = {
            ffi = ffi,
            C = ffi.C,
            bit = require("bit"),
            socket_wc = "",

            -- WinAPI constants
            CP_UTF8 = 65001,
            GENERIC_WRITE = 0x40000000,
            OPEN_EXISTING = 3,
            FILE_FLAG_WRITE_THROUGH = 0x80000000,
            FILE_FLAG_NO_BUFFERING = 0x20000000,
            PIPE_NOWAIT = ffi.new("unsigned long[1]", 0x00000001),

            INVALID_HANDLE_VALUE = ffi.cast("void*", -1),

            -- don't care about how many bytes WriteFile wrote, so allocate something to store the result once
            _lpNumberOfBytesWritten = ffi.new("unsigned long[1]"),
        }
        -- cache flags used in run() to avoid bor() call
        winapi._createfile_pipe_flags = winapi.bit.bor(winapi.FILE_FLAG_WRITE_THROUGH, winapi.FILE_FLAG_NO_BUFFERING)

        ffi.cdef[[
            void* __stdcall CreateFileW(const wchar_t *lpFileName, unsigned long dwDesiredAccess, unsigned long dwShareMode, void *lpSecurityAttributes, unsigned long dwCreationDisposition, unsigned long dwFlagsAndAttributes, void *hTemplateFile);
            bool __stdcall WriteFile(void *hFile, const void *lpBuffer, unsigned long nNumberOfBytesToWrite, unsigned long *lpNumberOfBytesWritten, void *lpOverlapped);
            bool __stdcall CloseHandle(void *hObject);
            bool __stdcall SetNamedPipeHandleState(void *hNamedPipe, unsigned long *lpMode, unsigned long *lpMaxCollectionCount, unsigned long *lpCollectDataTimeout);
            int __stdcall MultiByteToWideChar(unsigned int CodePage, unsigned long dwFlags, const char *lpMultiByteStr, int cbMultiByte, wchar_t *lpWideCharStr, int cchWideChar);
        ]]

        winapi.MultiByteToWideChar = function(MultiByteStr)
            if MultiByteStr then
                local utf16_len = winapi.C.MultiByteToWideChar(winapi.CP_UTF8, 0, MultiByteStr, -1, nil, 0)
                if utf16_len > 0 then
                    local utf16_str = winapi.ffi.new("wchar_t[?]", utf16_len)
                    if winapi.C.MultiByteToWideChar(winapi.CP_UTF8, 0, MultiByteStr, -1, utf16_str, utf16_len) > 0 then
                        return utf16_str
                    end
                end
            end
            return ""
        end

    else
        options.direct_io = false
    end
end

local file
local file_bytes = 0
local spawned = false
local disabled = false
local force_disabled = false
local spawn_waiting = false
local spawn_working = false
local script_written = false
local helper_request_id
local helper_generation = 0

local dirty = false

local x, y
local last_x, last_y

local last_seek_time

local effective_w, effective_h = options.max_width, options.max_height
local real_w, real_h
local last_real_w, last_real_h

local script_name

local show_thumbnail = false

local filters_reset = {["lavfi-crop"]=true, ["crop"]=true}
local filters_runtime = {["hflip"]=true, ["vflip"]=true}
local filters_all = {["hflip"]=true, ["vflip"]=true, ["lavfi-crop"]=true, ["crop"]=true}

local tone_mappings = {["none"]=true, ["clip"]=true, ["linear"]=true, ["gamma"]=true, ["reinhard"]=true, ["hable"]=true, ["mobius"]=true}
local libplacebo_tone_mappings = {["clip"]=true, ["linear"]=true, ["gamma"]=true, ["reinhard"]=true, ["hable"]=true, ["mobius"]=true}
local last_tone_mapping

local last_vf_reset = ""
local last_vf_runtime = ""

local last_rotate = 0

local par = ""
local last_par = ""

local last_crop = nil

local last_has_vid = 0
local has_vid = 0

local file_timer
local file_check_period = 1/60

local allow_fast_seek = true
local fast_preview = false
local helper_decoder_resize
local decoder_resize_disabled = false
local request_timer
local start_request_timer
local request_generation = 0
-- A cache-only request is served from memory/disk or rejected immediately by
-- the local proxy.  Leave enough room for a 4K keyframe decode, but do not
-- blank the seek preview for three seconds when the helper gets stuck after a
-- local cache miss deeper in demuxing.
local request_timeout_seconds = 1.25
local retry_cooldown_seconds = 1
local failed_time
local failed_at
local rendered_time
local issued_seek_time
local queued_seek_time
local shutting_down = false
local request_started_at
local last_cache_miss_bucket

-- These records are written by the parent MPV process and ingested into
-- DeeBugee as source=mpv, subsystem=mpv.lua.  Keep URLs and file paths out of
-- them: the cache state, request time, and helper lifecycle are sufficient to
-- identify why a preview stopped without exposing stream credentials.
local function thumbfast_log(level, message)
    mp.msg[level]("[Thumbfast] " .. message)
end

local function log_cache_miss(time)
    -- OSC can send the same hover position every render tick. Report a cache
    -- miss once per second of media time so it remains useful in DeeBugee.
    local bucket = math.floor(time)
    if last_cache_miss_bucket == bucket then return end
    last_cache_miss_bucket = bucket
    thumbfast_log("info", string.format(
        "preview unavailable: cache_state=outside_seekable_range request_time=%.3f status=cache_miss",
        time
    ))
end

local client_script = [=[
#!/usr/bin/env bash
MPV_IPC_FD=0; MPV_IPC_PATH="%s"
trap "kill 0" EXIT
while [[ $# -ne 0 ]]; do case $1 in --mpv-ipc-fd=*) MPV_IPC_FD=${1/--mpv-ipc-fd=/} ;; esac; shift; done
if echo "print-text thumbfast" >&"$MPV_IPC_FD"; then echo -n > "$MPV_IPC_PATH"; tail -f "$MPV_IPC_PATH" >&"$MPV_IPC_FD" & while read -r -u "$MPV_IPC_FD" 2>/dev/null; do :; done; fi
]=]

local function get_os()
    local raw_os_name = ""

    if jit and jit.os and jit.arch then
        raw_os_name = jit.os
    else
        if package.config:sub(1,1) == "\\" then
            -- Windows
            local env_OS = os.getenv("OS")
            if env_OS then
                raw_os_name = env_OS
            end
        else
            raw_os_name = subprocess({"uname", "-s"}).stdout
        end
    end

    raw_os_name = (raw_os_name):lower()

    local os_patterns = {
        ["windows"] = "windows",
        ["linux"]   = "linux",

        ["osx"]     = "darwin",
        ["mac"]     = "darwin",
        ["darwin"]  = "darwin",

        ["^mingw"]  = "windows",
        ["^cygwin"] = "windows",

        ["bsd$"]    = "darwin",
        ["sunos"]   = "darwin"
    }

    -- Default to linux
    local str_os_name = "linux"

    for pattern, name in pairs(os_patterns) do
        if raw_os_name:match(pattern) then
            str_os_name = name
            break
        end
    end

    return str_os_name
end

local os_name = mp.get_property("platform") or get_os()

local path_separator = os_name == "windows" and "\\" or "/"

if options.socket == "" then
    if os_name == "windows" then
        options.socket = "thumbfast"
    else
        options.socket = "/tmp/thumbfast"
    end
end

if options.thumbnail == "" then
    if os_name == "windows" then
        options.thumbnail = os.getenv("TEMP").."\\thumbfast.out"
    else
        options.thumbnail = "/tmp/thumbfast.out"
    end
end

local unique = mp.utils.getpid()

options.socket = options.socket .. unique
options.thumbnail = options.thumbnail .. unique

if options.direct_io then
    if os_name == "windows" then
        winapi.socket_wc = winapi.MultiByteToWideChar("\\\\.\\pipe\\" .. options.socket)
    end

    if winapi.socket_wc == "" then
        options.direct_io = false
    end
end

options.scale_factor = math.floor(options.scale_factor)

local mpv_path = options.mpv_path
local frontend_path

if mpv_path == "mpv" and os_name == "windows" then
    frontend_path = mp.get_property_native("user-data/frontend/process-path")
    mpv_path = frontend_path or mpv_path
end

if mpv_path == "mpv" and os_name == "darwin" and unique then
    -- TODO: look into ~~osxbundle/
    mpv_path = string.gsub(subprocess({"ps", "-o", "comm=", "-p", tostring(unique)}).stdout, "[\n\r]", "")
    if mpv_path ~= "mpv" then
        mpv_path = string.gsub(mpv_path, "/mpv%-bundle$", "/mpv")
        local mpv_bin = mp.utils.file_info("/usr/local/mpv")
        if mpv_bin and mpv_bin.is_file then
            mpv_path = "/usr/local/mpv"
        else
            local mpv_app = mp.utils.file_info("/Applications/mpv.app/Contents/MacOS/mpv")
            if mpv_app and mpv_app.is_file then
                mp.msg.warn("symlink mpv to fix Dock icons: `sudo ln -s /Applications/mpv.app/Contents/MacOS/mpv /usr/local/mpv`")
            else
                mp.msg.warn("drag to your Applications folder and symlink mpv to fix Dock icons: `sudo ln -s /Applications/mpv.app/Contents/MacOS/mpv /usr/local/mpv`")
            end
        end
    end
end

local function vo_tone_mapping()
    local passes = mp.get_property_native("vo-passes")
    if passes and passes["fresh"] then
        for k, v in pairs(passes["fresh"]) do
            for k2, v2 in pairs(v) do
                if k2 == "desc" and v2 then
                    local tone_mapping = string.match(v2, "([0-9a-z.-]+) tone map")
                    if tone_mapping then
                        return tone_mapping
                    end
                end
            end
        end
    end
end

local function source_video_params()
    return properties["video-dec-params"] or properties["video-out-params"]
end

local function params_are_hdr(color)
    color = color or {}
    local primaries = string.lower(tostring(color["primaries"] or ""))
    local transfer = string.lower(tostring(color["gamma"] or color["transfer"] or ""))
    return primaries == "bt.2020" or transfer == "pq" or
        transfer == "smpte2084" or transfer == "hlg" or transfer == "arib-std-b67"
end

local function source_is_hdr()
    return params_are_hdr(properties["video-params"]) or
        params_are_hdr(properties["video-dec-params"]) or
        params_are_hdr(properties["video-out-params"])
end

local function should_use_fast_preview()
    local params = source_video_params()
    local width = params and (params["dw"] or params["w"]) or 0
    local height = params and (params["dh"] or params["h"]) or 0

    return math.max(width, height) >= 3000 and source_is_hdr()
end

local cuvid_decoders = {
    av1 = "av1_cuvid",
    h264 = "h264_cuvid",
    avc1 = "h264_cuvid",
    hevc = "hevc_cuvid",
    h265 = "hevc_cuvid",
    mjpeg = "mjpeg_cuvid",
    mpeg1video = "mpeg1_cuvid",
    mpeg2video = "mpeg2_cuvid",
    mpeg4 = "mpeg4_cuvid",
    vc1 = "vc1_cuvid",
    vp8 = "vp8_cuvid",
    vp9 = "vp9_cuvid",
}

local function decoder_resize_config()
    if os_name ~= "windows" or decoder_resize_disabled then return nil end
    if (properties["video-crop"] or "") ~= "" then return nil end

    local track = properties["current-tracks/video"] or {}
    local decoder = cuvid_decoders[string.lower(tostring(track.codec or ""))]
    if not decoder then return nil end

    local params = source_video_params()
    local width = params and (params["dw"] or params["w"]) or 0
    local height = params and (params["dh"] or params["h"]) or 0
    if width <= 0 or height <= 0 or math.max(width, height) < 3000 then return nil end

    local vf_table = properties["vf"] or {}
    for _, filter in ipairs(vf_table) do
        if filter.name == "crop" or filter.name == "lavfi-crop" then return nil end
    end

    -- CUVID reduces the frame as part of decoding, before MPV's software
    -- thumbnail filters see it. Keep a small even intermediate at or above
    -- the final size so the existing filter chain only has a cheap last step.
    local target_ratio = math.max(effective_w / width, effective_h / height)
    local ratio = math.min(1, math.max(0.1, target_ratio))
    local resize_w = math.max(144, math.ceil(width * ratio / 2) * 2)
    local resize_h = math.max(144, math.ceil(height * ratio / 2) * 2)
    return {decoder=decoder, size=resize_w.."x"..resize_h}
end

local function vf_string(filters, full)
    local vf = ""
    local vf_table = properties["vf"]

    if (properties["video-crop"] or "") ~= "" then
        vf = "lavfi-crop="..string.gsub(properties["video-crop"], "(%d*)x?(%d*)%+(%d+)%+(%d+)", "w=%1:h=%2:x=%3:y=%4")..","
        local params = source_video_params()
        local width = params and (params["dw"] or params["w"])
        local height = params and (params["dh"] or params["h"])
        if width and height then
            vf = string.gsub(vf, "w=:h=:", "w="..width..":h="..height..":")
        end
    end

    if vf_table and #vf_table > 0 then
        for i = #vf_table, 1, -1 do
            if filters[vf_table[i].name] then
                local args = ""
                for key, value in pairs(vf_table[i].params) do
                    if args ~= "" then
                        args = args .. ":"
                    end
                    args = args .. key .. "=" .. value
                end
                vf = vf .. vf_table[i].name .. "=" .. args .. ","
            end
        end
    end

    local hdr_thumbnail = false
    if (full and options.tone_mapping ~= "no") or options.tone_mapping == "auto" then
        if source_is_hdr() then
            local tone_mapping = options.tone_mapping
            if tone_mapping == "auto" then
                tone_mapping = last_tone_mapping or properties["tone-mapping"]
                if tone_mapping == "auto" and properties["current-vo"] == "gpu-next" then
                    tone_mapping = vo_tone_mapping()
                end
            end
            if not tone_mappings[tone_mapping] then
                tone_mapping = "hable"
            end
            last_tone_mapping = tone_mapping
            local libplacebo_tone_mapping = tone_mapping
            if libplacebo_tone_mapping == "none" then
                libplacebo_tone_mapping = "clip"
            elseif not libplacebo_tone_mappings[libplacebo_tone_mapping] then
                libplacebo_tone_mapping = "hable"
            end
            if full then
                if fast_preview then
                    -- Full libplacebo tone mapping costs more than decoding on
                    -- 4K HDR. Downscale first and use a cheap gamma lift; this
                    -- is intentionally approximate but remains recognizable.
                    vf = vf.."scale=w="..effective_w..":h="..effective_h..par..",eq=gamma=1.35:gamma_weight=0.8:contrast=1.05:saturation=1.08,format=bgra,pad=w="..effective_w..":h="..effective_h..":x=-1:y=-1"
                else
                    vf = vf.."libplacebo=w="..effective_w..":h="..effective_h..":force_original_aspect_ratio=decrease:format=bgra:colorspace=bt709:color_primaries=bt709:color_trc=bt709:tonemapping="..libplacebo_tone_mapping..":apply_dolbyvision=yes,pad=w="..effective_w..":h="..effective_h..":x=-1:y=-1,format=bgra"
                end
                hdr_thumbnail = true
            else
                vf = vf .. "zscale=transfer=linear,format=gbrpf32le,tonemap="..tone_mapping..",zscale=transfer=bt709,"
            end
        end
    end

    if full and not hdr_thumbnail then
        vf = vf.."scale=w="..effective_w..":h="..effective_h..par..",pad=w="..effective_w..":h="..effective_h..":x=-1:y=-1,format=bgra"
    end

    return vf
end

local function calc_dimensions()
    -- SVP and other runtime filters can temporarily change video-out-params.
    -- Thumbnail geometry belongs to the decoded source and must stay stable.
    local params = source_video_params()
    local width = params and (params["dw"] or params["w"])
    local height = params and (params["dh"] or params["h"])
    if not width or not height then return end

    local scale = properties["display-hidpi-scale"] or 1

    if width / height > options.max_width / options.max_height then
        effective_w = math.floor(options.max_width * scale + 0.5)
        effective_h = math.floor(height / width * effective_w + 0.5)
    else
        effective_h = math.floor(options.max_height * scale + 0.5)
        effective_w = math.floor(width / height * effective_h + 0.5)
    end

    local v_par = params["par"] or 1
    if v_par == 1 then
        par = ":force_original_aspect_ratio=decrease"
    else
        par = ""
    end
end

local info_timer = nil

local function thumbnail_source()
    local path = properties["path"]
    local open_filename = properties["stream-open-filename"]
    if open_filename and properties["demuxer-via-network"] and path ~= open_filename then
        return open_filename
    end
    return path
end

local function is_streamee_proxy_source(path)
    if path == nil then return false end
    local lower = string.lower(path)
    return
        string.match(lower, "^http://127%.0%.0%.1:%d+/addon/") ~= nil
end

local function cache_only_source(path)
    if path == nil or not options.cache_only then return path end

    local lower = string.lower(path)
    if not string.match(lower, "^https?://") then return path end

    if not is_streamee_proxy_source(path) then return nil end
    if string.find(lower, "[?&]streamee%-cache%-only=1") then return path end

    return path .. (string.find(path, "?", 1, true) and "&" or "?") .. "streamee-cache-only=1"
end

local function cache_contains_time(time)
    if not options.cache_only or not properties["demuxer-via-network"] then return true end

    -- Streamee's cache-only proxy is the source of truth for sparse-cache
    -- coverage. Its full-cache backfill is independent of MPV's demuxer
    -- cache, so backfilled bytes do not appear in seekable-ranges. Let the
    -- helper try the local endpoint; missing bytes still fail closed with 425
    -- and never start an upstream producer.
    if is_streamee_proxy_source(thumbnail_source()) then return true end

    local state = mp.get_property_native("demuxer-cache-state", {})
    local ranges = state and state["seekable-ranges"] or {}
    for _, range in ipairs(ranges) do
        local range_start = tonumber(range.start)
        local range_end = tonumber(range["end"])
        if range_start and range_end and time >= range_start and time <= range_end then
            return true
        end
    end
    return false
end

local function info(w, h)
    local rotate = properties["video-params"] and properties["video-params"]["rotate"]
    local image = properties["current-tracks/video"] and properties["current-tracks/video"]["image"]
    local albumart = image and properties["current-tracks/video"]["albumart"]

    disabled = not options.enabled or
        (w or 0) == 0 or (h or 0) == 0 or
        has_vid == 0 or
        (properties["demuxer-via-network"] and not options.network) or
        (properties["demuxer-via-network"] and cache_only_source(thumbnail_source()) == nil) or
        (albumart and not options.audio) or
        (image and not albumart) or
        force_disabled

    if info_timer then
        info_timer:kill()
        info_timer = nil
    elseif has_vid == 0 or (rotate == nil and not disabled) then
        info_timer = mp.add_timeout(0.05, function() info(w, h) end)
    end

    local json, err = mp.utils.format_json({width=w * options.scale_factor, height=h * options.scale_factor, scale_factor=options.scale_factor, disabled=disabled, available=true, socket=options.socket, thumbnail=options.thumbnail, overlay_id=options.overlay_id})
    mp.command_native({"script-message", "thumbfast-info", json})
end

local function remove_thumbnail_files()
    if file then
        file:close()
        file = nil
        file_bytes = 0
    end
    os.remove(options.thumbnail)
    os.remove(options.thumbnail..".bgra")
    os.remove(options.thumbnail..".tmp")
end

local activity_timer

local function spawn(time)
    if disabled then return end

    local path = cache_only_source(thumbnail_source())
    if path == nil then
        thumbfast_log("warn", "helper not started: status=unsupported_source")
        return
    end

    if options.quit_after_inactivity > 0 then
        if show_thumbnail or activity_timer:is_enabled() then
            activity_timer:kill()
        end
        activity_timer:resume()
    end

    remove_thumbnail_files()

    local vid = properties["vid"]
    has_vid = vid or 0
    fast_preview = should_use_fast_preview()
    helper_decoder_resize = decoder_resize_config()
    local helper_hwdec = helper_decoder_resize and "no" or options.hwdec

    helper_generation = helper_generation + 1
    local generation = helper_generation
    local args = {
        mpv_path, "--no-config", "--msg-level=all=no", "--pause", "--force-window=no", "--really-quiet", "--no-terminal",
        "--load-scripts=no", "--osc=no", "--ytdl=no",
        "--vid="..(vid or "auto"), "--no-sub", "--no-audio",
        -- The helper is restricted to a single local cache snapshot.  Its
        -- default network read-ahead can ask past that snapshot after a frame
        -- is decoded, leaving the helper waiting even though the requested
        -- preview was already available.  Decode only what the seek needs.
        "--cache=no", "--demuxer-readahead-secs=0",
        "--start="..time,
        "--hwdec="..helper_hwdec,
        "--vf="..vf_string(filters_all, true),
        "--ovc=rawvideo", "--of=image2", "--ofopts=update=1", "--o="..options.thumbnail
    }

    if helper_decoder_resize then
        table.insert(args, "--vd="..helper_decoder_resize.decoder)
        table.insert(args, "--vd-lavc-o=resize="..helper_decoder_resize.size)
    end

    if fast_preview then
        -- A seek-bar preview only needs a nearby recognizable frame. Avoid
        -- decoding a long 4K HDR GOP to the exact requested timestamp.
        table.insert(args, "--hr-seek=no")
        table.insert(args, "--vd-lavc-fast=yes")
        table.insert(args, "--vd-lavc-skiploopfilter=all")
    end

    if os_name == "windows" or pre_0_33_0 then
        table.insert(args, "--input-ipc-server="..options.socket)
    elseif not script_written then
        local client_script_path = options.socket..".run"
        local script = io.open(client_script_path, "w+")
        if script == nil then
            mp.msg.error("client script write failed")
            return
        else
            script_written = true
            script:write(string.format(client_script, options.socket))
            script:close()
            subprocess({"chmod", "+x", client_script_path}, true)
            table.insert(args, "--scripts="..client_script_path)
        end
    else
        local client_script_path = options.socket..".run"
        table.insert(args, "--scripts="..client_script_path)
    end

    table.insert(args, "--")
    table.insert(args, path)

    spawned = true
    spawn_waiting = true
    thumbfast_log("info", string.format(
        "helper started: generation=%d request_time=%.3f fast_preview=%s decoder_resize=%s status=started",
        generation,
        time,
        tostring(fast_preview),
        helper_decoder_resize and (helper_decoder_resize.decoder..":"..helper_decoder_resize.size) or "off"
    ))

    local request_id
    request_id = subprocess(args, true,
        function(success, result)
            if generation ~= helper_generation then return end
            helper_request_id = nil
            if spawn_waiting and (success == false or (result.status ~= 0 and result.status ~= -2)) then
                local retry_time = issued_seek_time
                local retry_without_resize = helper_decoder_resize ~= nil and retry_time ~= nil
                spawned = false
                spawn_waiting = false
                thumbfast_log("error", string.format(
                    "helper failed: generation=%d status=failed result_status=%s",
                    generation,
                    tostring(result and result.status)
                ))
                if retry_without_resize then
                    decoder_resize_disabled = true
                    helper_decoder_resize = nil
                    thumbfast_log("warn", "CUVID thumbnail resize unavailable; retrying with copy-back scaling")
                    spawn(retry_time)
                    if spawned then
                        request_started_at = mp.get_time()
                        request_seek()
                        if not file_timer:is_enabled() then file_timer:resume() end
                        start_request_timer(retry_time)
                    end
                    return
                end
                options.tone_mapping = "no"
                mp.msg.error("mpv subprocess create failed")
                if result then
                    if result.stderr and result.stderr ~= "" then
                        mp.msg.error("thumbfast helper stderr: " .. string.gsub(result.stderr, "[\r\n]+$", ""))
                    elseif result.stdout and result.stdout ~= "" then
                        mp.msg.error("thumbfast helper stdout: " .. string.gsub(result.stdout, "[\r\n]+$", ""))
                    end
                end
                if not spawn_working then -- notify users of required configuration
                    if options.mpv_path == "mpv" then
                        if properties["current-vo"] == "libmpv" then
                            if options.mpv_path == mpv_path then -- attempt to locate ImPlay
                                mpv_path = "ImPlay"
                                spawn(time)
                            else -- ImPlay not in path
                                if os_name ~= "darwin" then
                                    force_disabled = true
                                    info(real_w or effective_w, real_h or effective_h)
                                end
                                mp.commandv("show-text", "thumbfast: ERROR! cannot create mpv subprocess", 5000)
                                mp.commandv("script-message-to", "implay", "show-message", "thumbfast initial setup", "Set mpv_path=PATH_TO_ImPlay in thumbfast config:\n" .. string.gsub(mp.command_native({"expand-path", "~~/script-opts/thumbfast.conf"}), "[/\\]", path_separator).."\nand restart ImPlay")
                            end
                        else
                            mp.commandv("show-text", "thumbfast: ERROR! cannot create mpv subprocess", 5000)
                            if os_name == "windows" and frontend_path == nil then
                                mp.commandv("script-message-to", "mpvnet", "show-text", "thumbfast: ERROR! install standalone mpv, see README", 5000, 20)
                                mp.commandv("script-message", "mpv.net", "show-text", "thumbfast: ERROR! install standalone mpv, see README", 5000, 20)
                            end
                        end
                    else
                        mp.commandv("show-text", "thumbfast: ERROR! cannot create mpv subprocess", 5000)
                        -- found ImPlay but not defined in config
                        mp.commandv("script-message-to", "implay", "show-message", "thumbfast", "Set mpv_path=PATH_TO_ImPlay in thumbfast config:\n" .. string.gsub(mp.command_native({"expand-path", "~~/script-opts/thumbfast.conf"}), "[/\\]", path_separator).."\nand restart ImPlay")
                    end
                end
            elseif success == true and (result.status == 0 or result.status == -2) then
                -- Cache-only HTTP 425 puts the helper at EOF. Do not retain an
                -- idle helper until the watchdog fires: treat it as an
                -- immediate cache miss, preserve the last frame, and let the
                -- next hover position launch a fresh local-only helper.
                if spawned and issued_seek_time then
                    local time = issued_seek_time
                    helper_request_id = nil
                    spawned = false
                    spawn_waiting = false
                    if request_timer then
                        request_timer:kill()
                        request_timer = nil
                    end
                    file_timer:kill()
                    failed_time = time
                    failed_at = mp.get_time()
                    last_seek_time = nil
                    issued_seek_time = nil
                    queued_seek_time = nil
                    request_started_at = nil
                    thumbfast_log("info", string.format(
                        "preview unavailable: cache_state=helper_eof request_time=%.3f status=cache_miss",
                        time
                    ))
                    return
                end
                if not spawn_working and properties["current-vo"] == "libmpv" and options.mpv_path ~= mpv_path then
                    mp.commandv("script-message-to", "implay", "show-message", "thumbfast initial setup", "Set mpv_path=ImPlay in thumbfast config:\n" .. string.gsub(mp.command_native({"expand-path", "~~/script-opts/thumbfast.conf"}), "[/\\]", path_separator).."\nand restart ImPlay")
                end
                spawn_working = true
                spawn_waiting = false
                thumbfast_log("info", string.format(
                    "helper exited: generation=%d status=completed result_status=%s",
                    generation,
                    tostring(result.status)
                ))
            end
        end
    )
    helper_request_id = request_id
end

local function run(command)
    if not spawned then return end

    if options.direct_io then
        local hPipe = winapi.C.CreateFileW(winapi.socket_wc, winapi.GENERIC_WRITE, 0, nil, winapi.OPEN_EXISTING, winapi._createfile_pipe_flags, nil)
        if hPipe ~= winapi.INVALID_HANDLE_VALUE then
            local buf = command .. "\n"
            winapi.C.SetNamedPipeHandleState(hPipe, winapi.PIPE_NOWAIT, nil, nil)
            winapi.C.WriteFile(hPipe, buf, #buf + 1, winapi._lpNumberOfBytesWritten, nil)
            winapi.C.CloseHandle(hPipe)
        end

        return
    end

    local command_n = command.."\n"

    if os_name == "windows" then
        if file and file_bytes + #command_n >= 4096 then
            file:close()
            file = nil
            file_bytes = 0
        end
        if not file then
            file = io.open("\\\\.\\pipe\\"..options.socket, "r+b")
        end
    elseif pre_0_33_0 then
        subprocess({"/usr/bin/env", "sh", "-c", "echo '" .. command .. "' | socat - " .. options.socket})
        return
    elseif not file then
        file = io.open(options.socket, "r+")
    end
    if file then
        file_bytes = file:seek("end")
        file:write(command_n)
        file:flush()
    end
end

local function terminate_helper()
    if spawned then
        thumbfast_log("info", string.format(
            "helper stopping: generation=%d status=stopping",
            helper_generation
        ))
    end
    if spawned then run("quit") end
    if helper_request_id and not pre_0_30_0 then
        mp.abort_async_command(helper_request_id)
    end
    if file then
        file:close()
        file = nil
        file_bytes = 0
    end
    helper_request_id = nil
    helper_generation = helper_generation + 1
    spawned = false
    spawn_waiting = false
    real_w, real_h = nil, nil
end

local function draw(w, h, script)
    if not w or not show_thumbnail then return end
    if x ~= nil then
        local scale_w, scale_h = options.scale_factor ~= 1 and (w * options.scale_factor) or nil, options.scale_factor ~= 1 and (h * options.scale_factor) or nil
        mp.command_native({"overlay-add", options.overlay_id, x, y, options.thumbnail..".bgra", 0, "bgra", w, h, (4*w), scale_w, scale_h})
    elseif script then
        local json, err = mp.utils.format_json({width=w, height=h, scale_factor=options.scale_factor, x=x, y=y, socket=options.socket, thumbnail=options.thumbnail, overlay_id=options.overlay_id})
        mp.commandv("script-message-to", script, "thumbfast-render", json)
    end
end

local function real_res(req_w, req_h, filesize)
    local count = filesize / 4
    local diff = (req_w * req_h) - count

    if (properties["video-params"] and properties["video-params"]["rotate"] or 0) % 180 == 90 then
        req_w, req_h = req_h, req_w
    end

    if diff == 0 then
        return req_w, req_h
    else
        local threshold = 5 -- throw out results that change too much
        local long_side, short_side = req_w, req_h
        if req_h > req_w then
            long_side, short_side = req_h, req_w
        end
        for a = short_side, short_side - threshold, -1 do
            if count % a == 0 then
                local b = count / a
                if long_side - b < threshold then
                    if req_h < req_w then return b, a else return a, b end
                end
            end
        end
        return nil
    end
end

local function move_file(from, to)
    if os_name == "windows" then
        os.remove(to)
    end
    -- move the file because it can get overwritten while overlay-add is reading it, and crash the player
    os.rename(from, to)
end

local function seek(fast)
    if last_seek_time then
        run("async seek " .. last_seek_time .. (fast and " absolute+keyframes" or " absolute+exact"))
    end
end

local function request_seek()
    -- SDR previews remain exact. Only the intentionally approximate 4K HDR
    -- path seeks to a nearby keyframe, which also guarantees one output per
    -- request and lets us associate it with the correct hover position.
    seek(fast_preview and allow_fast_seek)
end

local function same_time(first, second)
    return first ~= nil and second ~= nil and math.abs(first - second) < 0.05
end

local function stop_request_timer()
    if request_timer then
        request_timer:kill()
        request_timer = nil
    end
end

local function hide_thumbnail()
    if not script_name then
        mp.command_native({"overlay-remove", options.overlay_id})
    end
end

local function abandon_request(generation, time)
    if generation ~= request_generation or not same_time(time, issued_seek_time) then return end

    local elapsed_ms = request_started_at and math.floor((mp.get_time() - request_started_at) * 1000) or -1
    local queued = queued_seek_time
    thumbfast_log("warn", string.format(
        "preview timed out: generation=%d request_time=%.3f duration_ms=%d status=timeout queued_time=%s last_frame_retained=%s",
        generation,
        time,
        elapsed_ms,
        tostring(queued),
        tostring(rendered_time ~= nil)
    ))
    request_timer = nil
    failed_time = time
    failed_at = mp.get_time()
    issued_seek_time = nil
    queued_seek_time = nil
    file_timer:kill()
    terminate_helper()
    last_seek_time = nil
    request_started_at = nil

    -- The helper can stall after its first local range succeeds but a later
    -- demuxer range is absent.  Keep the already-rendered frame on screen,
    -- then immediately service the newest hover request with a clean helper.
    -- `spawn()` always re-applies streamee-cache-only=1, so this recovery can
    -- never turn into a CDN request.
    if queued and not same_time(queued, time) and show_thumbnail and not shutting_down then
        spawn(queued)
        if spawned then
            issued_seek_time = queued
            queued_seek_time = nil
            request_started_at = mp.get_time()
            request_seek()
            if not file_timer:is_enabled() then file_timer:resume() end
            start_request_timer(queued)
        end
    end
end

start_request_timer = function(time)
    stop_request_timer()
    request_generation = request_generation + 1
    local generation = request_generation
    request_timer = mp.add_timeout(request_timeout_seconds, function()
        abandon_request(generation, time)
    end)
end

local function check_new_thumb()
    local tmp = options.thumbnail..".tmp"
    local finfo = mp.utils.file_info(tmp)
    local w, h

    -- A Windows rename can succeed while image2 is still filling the file.
    -- If that partial file is rejected and removed, the writer finishes on an
    -- unlinked handle and no new source filename appears until another seek;
    -- the current request then reaches the watchdog despite a decoded frame.
    -- Accept a completed temporary file first, and never move the source until
    -- its raw BGRA size is already valid.
    if finfo then
        w, h = real_res(effective_w, effective_h, finfo.size)
    end
    if not w then
        local source_info = mp.utils.file_info(options.thumbnail)
        if not source_info then return false end
        w, h = real_res(effective_w, effective_h, source_info.size)
        if not w then return false end
        move_file(options.thumbnail, tmp)
        finfo = mp.utils.file_info(tmp)
        if not finfo then return false end
        w, h = real_res(effective_w, effective_h, finfo.size)
    end
    if not w then return false end

    spawn_waiting = false
    move_file(tmp, options.thumbnail..".bgra")

    failed_time = nil
    failed_at = nil
    rendered_time = issued_seek_time or last_seek_time
    local elapsed_ms = request_started_at and math.floor((mp.get_time() - request_started_at) * 1000) or -1
    local preview_path = fast_preview and "hdr_fast_gamma" or (source_is_hdr() and "hdr_libplacebo" or "sdr")
    thumbfast_log("info", string.format(
        "preview rendered: request_time=%.3f duration_ms=%d status=rendered preview_path=%s width=%d height=%d",
        rendered_time or -1,
        elapsed_ms,
        preview_path,
        w,
        h
    ))
    real_w, real_h = w, h
    if real_w and (real_w ~= last_real_w or real_h ~= last_real_h) then
        last_real_w, last_real_h = real_w, real_h
        info(real_w, real_h)
    end
    local queued = queued_seek_time
    if queued and not same_time(queued, rendered_time) then
        queued_seek_time = nil
        issued_seek_time = queued
        request_started_at = mp.get_time()
        request_seek()
        start_request_timer(queued)
    else
        stop_request_timer()
        issued_seek_time = nil
        queued_seek_time = nil
        request_started_at = nil
        file_timer:kill()
    end
    return true
end

file_timer = mp.add_periodic_timer(file_check_period, function()
    if check_new_thumb() then
        draw(real_w, real_h, script_name)
    end
end)
file_timer:kill()

local function clear()
    if not show_thumbnail then return end
    -- A hover can disappear for a render tick while OSC animates. Hide the
    -- overlay, but let the one local-only decode finish so it can be reused.
    show_thumbnail = false
    queued_seek_time = nil
    last_x = nil
    last_y = nil
    hide_thumbnail()
end

local function reset_request()
    stop_request_timer()
    request_generation = request_generation + 1
    file_timer:kill()
    last_seek_time = nil
    failed_time = nil
    failed_at = nil
    rendered_time = nil
    issued_seek_time = nil
    queued_seek_time = nil
    request_started_at = nil
    remove_thumbnail_files()
end

local function quit()
    activity_timer:kill()
    if show_thumbnail then
        activity_timer:resume()
        return
    end
    thumbfast_log("info", "helper idle cleanup: status=inactive")
    terminate_helper()
    clear()
    reset_request()
end

activity_timer = mp.add_timeout(options.quit_after_inactivity, quit)
activity_timer:kill()

local function thumb(time, r_x, r_y, script)
    if disabled or shutting_down then return end

    time = tonumber(time)
    if time == nil then return end

    if not cache_contains_time(time) then
        log_cache_miss(time)
        clear()
        return
    end

    if r_x == "" or r_y == "" then
        x, y = nil, nil
    else
        x, y = math.floor(r_x + 0.5), math.floor(r_y + 0.5)
    end

    script_name = script
    local position_changed = last_x ~= x or last_y ~= y or not show_thumbnail
    if position_changed then
        show_thumbnail = true
        last_x, last_y = x, y
        if same_time(time, rendered_time) then
            draw(real_w, real_h, script)
        end
    end

    if options.quit_after_inactivity > 0 then
        if show_thumbnail or activity_timer:is_enabled() then
            activity_timer:kill()
        end
        activity_timer:resume()
    end

    if same_time(time, failed_time) then
        if failed_at and mp.get_time() - failed_at < retry_cooldown_seconds then return end
        failed_time = nil
        failed_at = nil
    end
    if same_time(time, last_seek_time) then return end
    failed_time = nil
    last_seek_time = time
    if not spawned then
        spawn(time)
        if not spawned then return end
        issued_seek_time = time
        queued_seek_time = nil
    elseif issued_seek_time then
        queued_seek_time = time
        return
    else
        issued_seek_time = time
        queued_seek_time = nil
    end
    request_started_at = mp.get_time()
    request_seek()
    if not file_timer:is_enabled() then file_timer:resume() end
    start_request_timer(time)
end

local function watch_changes()
    if shutting_down or not dirty or not properties["video-out-params"] then return end
    dirty = false

    local old_w = effective_w
    local old_h = effective_h

    calc_dimensions()

    local vf_reset = vf_string(filters_reset)
    local rotate = properties["video-rotate"] or 0

    local resized = old_w ~= effective_w or
        old_h ~= effective_h or
        last_vf_reset ~= vf_reset or
        (last_rotate % 180) ~= (rotate % 180) or
        par ~= last_par or last_crop ~= properties["video-crop"]

    if resized then
        last_rotate = rotate
        info(effective_w, effective_h)
    elseif last_has_vid ~= has_vid and has_vid ~= 0 then
        info(effective_w, effective_h)
    end

    if spawned then
        if resized then
            -- mpv doesn't allow us to change output size
            local seek_time = last_seek_time
            clear()
            terminate_helper()
            reset_request()
            spawn(seek_time or mp.get_property_number("time-pos", 0))
            file_timer:resume()
        else
            if rotate ~= last_rotate then
                run("set video-rotate "..rotate)
            end
            local vf_runtime = vf_string(filters_runtime)
            if vf_runtime ~= last_vf_runtime then
                run("vf set "..vf_string(filters_all, true))
                last_vf_runtime = vf_runtime
            end
        end
    else
        last_vf_runtime = vf_string(filters_runtime)
    end

    last_vf_reset = vf_reset
    last_rotate = rotate
    last_par = par
    last_crop = properties["video-crop"]
    last_has_vid = has_vid

    if not spawned and not disabled and options.spawn_first and resized then
        spawn(mp.get_property_number("time-pos", 0))
        file_timer:resume()
    end
end

local function update_property(name, value)
    properties[name] = value
end

local function update_property_dirty(name, value)
    properties[name] = value
    dirty = true
    if name == "tone-mapping" then
        last_tone_mapping = nil
    end
end

local function update_tracklist(name, value)
    -- current-tracks shim
    for _, track in ipairs(value) do
        if track.type == "video" and track.selected then
            properties["current-tracks/video"] = track
            return
        end
    end
end

local function sync_changes(prop, val)
    update_property(prop, val)
    if val == nil then return end

    if type(val) == "boolean" then
        if prop == "vid" then
            has_vid = 0
            last_has_vid = 0
            info(effective_w, effective_h)
            clear()
            return
        end
        val = val and "yes" or "no"
    end

    if prop == "vid" then
        has_vid = 1
    end

    if not spawned then return end

    run("set "..prop.." "..val)
    dirty = true
end

local function file_load()
    shutting_down = false
    decoder_resize_disabled = false
    helper_decoder_resize = nil
    terminate_helper()
    clear()
    reset_request()
    real_w, real_h = nil, nil
    last_real_w, last_real_h = nil, nil
    last_tone_mapping = nil
    last_cache_miss_bucket = nil
    if info_timer then
        info_timer:kill()
        info_timer = nil
    end

    calc_dimensions()
    info(effective_w, effective_h)
end

local function shutdown()
    shutting_down = true
    terminate_helper()
    clear()
    reset_request()
    if os_name ~= "windows" then
        os.remove(options.socket)
        os.remove(options.socket..".run")
    end
end

local function on_duration(prop, val)
    allow_fast_seek = (val or 30) >= 30
end

mp.observe_property("current-tracks/video", "native", function(name, value)
    if pre_0_33_0 then
        mp.unobserve_property(update_tracklist)
        pre_0_33_0 = false
    end
    update_property(name, value)
end)

mp.observe_property("track-list", "native", update_tracklist)
mp.observe_property("display-hidpi-scale", "native", update_property_dirty)
mp.observe_property("video-dec-params", "native", update_property_dirty)
mp.observe_property("video-out-params", "native", update_property_dirty)
mp.observe_property("video-params", "native", update_property_dirty)
mp.observe_property("vf", "native", update_property_dirty)
mp.observe_property("tone-mapping", "native", update_property_dirty)
mp.observe_property("demuxer-via-network", "native", update_property)
mp.observe_property("stream-open-filename", "native", update_property)
mp.observe_property("macos-app-activation-policy", "native", update_property)
mp.observe_property("current-vo", "native", update_property)
mp.observe_property("video-rotate", "native", update_property)
mp.observe_property("video-crop", "native", update_property)
mp.observe_property("path", "native", update_property)
mp.observe_property("vid", "native", sync_changes)
mp.observe_property("edition", "native", sync_changes)
mp.observe_property("duration", "native", on_duration)

mp.register_script_message("thumb", thumb)
mp.register_script_message("clear", clear)

mp.register_event("file-loaded", file_load)
mp.register_event("shutdown", shutdown)

mp.register_idle(watch_changes)
