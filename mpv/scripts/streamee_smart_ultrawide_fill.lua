-- Adaptive black-bar removal and edge lighting for displays of any aspect.
--
-- Detection is intentionally conservative: FFmpeg cropdetect supplies a crop
-- candidate, while this script requires symmetric bars and a stable result
-- before changing the renderer's fixed-canvas crop coordinates. The video
-- filter dimensions stay constant so SVP does not drain and rebuild at aspect
-- transitions. Soft subtitles and the OSC remain outside the cropped image.

local mp = require "mp"
local msg = require "mp.msg"
local options = require "mp.options"
local utils = require "mp.utils"

local opts = {
    enabled = false,
    default_mode = "off",
    limit = 0.08,
    round = 2,
    reset_count = 6,
    poll_interval = 0.05,
    stable_time = 0.18,
    restore_time = 0.50,
    change_cooldown = 1.00,
    boundary_quantum = 4,
    min_bar_fraction = 0.03,
    max_total_crop_fraction = 0.35,
    symmetry_tolerance_fraction = 0.02,
    min_content_aspect = 1.8,
    -- Zero allows both standard and wide displays. The option name remains
    -- compatible with existing script-opts configurations.
    min_viewport_aspect = 0,
    lookahead_enabled = true,
    lookahead_seconds = 2.25,
    lookahead_schedule_tolerance = 0.005,
    lookahead_render_lead = 0.060,
    lookahead_render_lead_min = 0.030,
    lookahead_render_lead_max = 0.150,
    lookahead_render_lead_padding = 0.010,
    lookahead_render_lead_alpha = 0.35,
    lookahead_probe_width = 480,
    lookahead_probe_fps = 6,
    lookahead_crop_tolerance = 12,
    lookahead_scene_threshold = 8.0,
    lookahead_scene_gate_window = 0.75,
    lookahead_stable_time = 0.90,
    efficient_scan_interval = 60,
    efficient_scan_lead = 0.25,
    fixed_canvas_lighting = true,
    lighting_enabled = true,
}

options.read_options(opts, "streamee_smart_ultrawide_fill")

local FILTER_LABEL = "streamee_adaptive_crop_detector"
local FILTER_METADATA = "vf-metadata/" .. FILTER_LABEL
local FILTER_REFERENCE = "@" .. FILTER_LABEL
local PRE_SVP_CROP_LABEL = "streamee_adaptive_pre_svp_crop"
local PRE_SVP_CROP_REFERENCE = "@" .. PRE_SVP_CROP_LABEL
local SVP_FILTER_LABEL = "svp"
local VSR_FILTER_LABEL = "streamee-vsr"
local LIGHTING_SHADER_NAME = "streamee_ultrawide_lighting.glsl"

local function directory_name(path)
    return type(path) == "string" and path:match("^(.*)[/\\][^/\\]+$") or nil
end

local script_source = debug.getinfo(1, "S").source
local script_path = type(script_source) == "string"
    and script_source:sub(1, 1) == "@"
    and script_source:sub(2)
    or nil
local script_directory = directory_name(script_path)
local bundled_mpv_directory = directory_name(script_directory)
local lighting_shader_path = bundled_mpv_directory
    and utils.join_path(utils.join_path(bundled_mpv_directory, "shaders"), LIGHTING_SHADER_NAME)
    or nil

local active_mode = "off"
local saved_mode = "off"
local enabled = false
local saved_lighting_enabled = false
local lighting_enabled = false
local filter_installed = false
local detector_svp_file = nil
local file_loaded = false
local base_crop = ""
local applied_crop = nil
local crop_application = nil
local pre_svp_crop_installed = false
local candidate_key = nil
local candidate_since = nil
local last_crop_change_at = -math.huge
local timer = nil
local lookahead_generation = 0
local lookahead_running = false
local lookahead_ready = false
local lookahead_baseline_crop = nil
local lookahead_pending = nil
local lookahead_last_sequence = 0
local lookahead_control_path = nil
local lookahead_result_path = nil
local lookahead_restart_timer = nil
local lookahead_purpose = nil
local efficient_interval_timer = nil
local efficient_poll_timer = nil
local efficient_scan_start_timer = nil
local render_lead_estimate = tonumber(opts.lookahead_render_lead) or 0.060
local pending_render_sample = nil
local topology_timer = nil
local topology_reconciling = false
local lighting_cache_file = nil
local lighting_cache_time = -math.huge
local lighting_cache_active = false
local lighting_shader_installed = false
local lighting_shader_opts_updating = false
local lighting_shader_opts_timer = nil
local saved_keepaspect = nil
local fixed_canvas_crop = nil
local svp_shadow_path = nil
local svp_shadow_source = nil
local svp_lighting_suppressed = false
local svp_shadow_generation = 0

local function now()
    return mp.get_time()
end

local function clamp(value, minimum, maximum)
    return math.max(minimum, math.min(maximum, value))
end

local function reset_render_lead_estimate()
    render_lead_estimate = clamp(
        tonumber(opts.lookahead_render_lead) or 0.060,
        tonumber(opts.lookahead_render_lead_min) or 0.030,
        tonumber(opts.lookahead_render_lead_max) or 0.150
    )
    pending_render_sample = nil
end

local function option_enabled(value)
    return value == true or value == "yes" or value == "true" or value == "1"
end

local function renderer_requested()
    return enabled or lighting_enabled
end

local function normalized_path(value)
    return type(value) == "string" and value:gsub("/", "\\"):lower() or ""
end

local function lighting_shader_available()
    return option_enabled(opts.fixed_canvas_lighting)
        and lighting_shader_path ~= nil
        and utils.file_info(lighting_shader_path) ~= nil
        and mp.get_property("vo", ""):find("gpu%-next") ~= nil
end

local function shader_list()
    local shaders = mp.get_property_native("glsl-shaders")
    if type(shaders) == "table" then return shaders end
    if type(shaders) == "string" and shaders ~= "" then return { shaders } end
    return {}
end

local function install_lighting_shader()
    if lighting_shader_installed then return true end
    if not lighting_shader_available() then return false end
    local target = normalized_path(lighting_shader_path)
    local shaders = shader_list()
    local present = false
    for _, path in ipairs(shaders) do
        if normalized_path(path) == target then
            present = true
            break
        end
    end
    if not present then
        shaders[#shaders + 1] = lighting_shader_path
        local ok, err = pcall(mp.set_property_native, "glsl-shaders", shaders)
        if not ok then
            msg.error("Failed to install fixed-canvas lighting shader: " .. tostring(err))
            return false
        end
    end
    if saved_keepaspect == nil then saved_keepaspect = mp.get_property("keepaspect", "yes") end
    mp.set_property("keepaspect", "no")
    lighting_shader_installed = true
    msg.info("Fixed-canvas crop and lighting renderer installed")
    return true
end


local function remove_lighting_shader()
    if not lighting_shader_installed then return end
    local target, shaders, retained = normalized_path(lighting_shader_path), shader_list(), {}
    for _, path in ipairs(shaders) do
        if normalized_path(path) ~= target then retained[#retained + 1] = path end
    end
    pcall(mp.set_property_native, "glsl-shaders", retained)
    if saved_keepaspect ~= nil then pcall(mp.set_property, "keepaspect", saved_keepaspect) end
    saved_keepaspect = nil
    lighting_shader_installed = false
    fixed_canvas_crop = nil
end

local function crop_geometry(value)
    if value == "none" then
        return nil, nil, nil, nil, true
    end
    if type(value) ~= "string" then
        return nil
    end
    local width, height, x, y = value:match("^(%d+)x(%d+)%+(%d+)%+(%d+)$")
    if not width then
        return nil
    end
    return tonumber(width), tonumber(height), tonumber(x), tonumber(y), false
end

local function crops_equivalent(left, right)
    if left == right then
        return true
    end
    local lw, lh, lx, ly, left_none = crop_geometry(left)
    local rw, rh, rx, ry, right_none = crop_geometry(right)
    if left_none or right_none then
        return left_none == true and right_none == true
    end
    if not lw or not rw or lw ~= rw then
        return false
    end
    local tolerance = math.max(0, tonumber(opts.lookahead_crop_tolerance) or 0)
    return math.abs(lh - rh) <= tolerance * 2
        and math.abs(lx - rx) <= tolerance
        and math.abs(ly - ry) <= tolerance
end

local function read_text(path)
    local file = path and io.open(path, "r") or nil
    if not file then
        return nil
    end
    local value = file:read("*a")
    file:close()
    return value
end

local function write_text(path, value)
    local file = path and io.open(path, "w") or nil
    if not file then
        return false
    end
    file:write(value)
    file:write("\n")
    file:close()
    return true
end

local function normalized_mode(value)
    if value == "efficient" or value == "dynamic" then
        return value
    end
    return "off"
end

local function load_default_mode()
    saved_mode = normalized_mode(opts.default_mode)
    active_mode = option_enabled(opts.enabled) and "dynamic" or saved_mode
    enabled = active_mode ~= "off"
    saved_lighting_enabled = option_enabled(opts.lighting_enabled)
    lighting_enabled = saved_lighting_enabled
end

local function initialize_lookahead_paths()
    if lookahead_control_path and lookahead_result_path then
        return true
    end

    local temp_dir = os.getenv("TEMP") or os.getenv("TMP")
    local pid = mp.get_property("pid", "0")
    if not temp_dir or pid == "0" then
        return false
    end

    local prefix = "streamee_adaptive_crop_" .. pid
    lookahead_control_path = utils.join_path(temp_dir, prefix .. ".control")
    lookahead_result_path = utils.join_path(temp_dir, prefix .. ".json")
    return true
end

local function cache_only_lookahead_source()
    local path = mp.get_property("path")
    if not path or path == "" then
        return nil
    end

    local lower = path:lower()
    if not lower:match("^https?://") then
        return path
    end
    if not lower:match("^https?://127%.0%.0%.1[:/]")
        and not lower:match("^https?://localhost[:/]") then
        return nil
    end
    if lower:find("streamee%-cache%-only=1") then
        return path
    end
    return path .. (path:find("?", 1, true) and "&" or "?")
        .. "streamee-cache-only=1"
end

local function stop_lookahead()
    lookahead_generation = lookahead_generation + 1
    lookahead_running = false
    lookahead_ready = false
    lookahead_baseline_crop = nil
    lookahead_pending = nil
    lookahead_last_sequence = 0
    lookahead_purpose = nil
    if lookahead_restart_timer then
        lookahead_restart_timer:kill()
        lookahead_restart_timer = nil
    end
    if initialize_lookahead_paths() then
        write_text(lookahead_control_path, "stopped-" .. lookahead_generation)
        os.remove(lookahead_result_path)
    end
end

local function start_lookahead(purpose)
    purpose = purpose or "dynamic"
    if not option_enabled(opts.lookahead_enabled)
        or not enabled
        or not file_loaded
        or mp.get_property_bool("pause", false) then
        return
    end

    local source = cache_only_lookahead_source()
    if not source or not initialize_lookahead_paths() then
        msg.info("Adaptive crop lookahead unavailable; using live detector")
        return
    end

    local config_dir = bundled_mpv_directory
        or mp.command_native({ "expand-path", "~~/" })
    local mpv_path = utils.join_path(config_dir, "mpv.exe")
    local probe_script = utils.join_path(
        utils.join_path(config_dir, "scripts"),
        "streamee_smart_ultrawide_fill_probe.lua"
    )
    local mpv_info = utils.file_info(mpv_path)
    local script_info = utils.file_info(probe_script)
    if not mpv_info or not script_info then
        msg.warn(string.format(
            "Adaptive crop lookahead assets are unavailable; using live detector (mpv=%s probe=%s)",
            mpv_path,
            probe_script
        ))
        return
    end

    lookahead_generation = lookahead_generation + 1
    local generation = tostring(mp.get_property("pid", "0"))
        .. "-" .. tostring(lookahead_generation)
    if not write_text(lookahead_control_path, generation) then
        msg.warn("Adaptive crop lookahead control file is unavailable; using live detector")
        return
    end
    os.remove(lookahead_result_path)
    lookahead_running = true
    lookahead_ready = false
    lookahead_baseline_crop = nil
    lookahead_pending = nil
    lookahead_last_sequence = 0
    lookahead_purpose = purpose

    local lead = purpose == "efficient"
        and opts.efficient_scan_lead
        or opts.lookahead_seconds
    local start_position = math.max(
        0,
        mp.get_property_number("time-pos", 0) + lead
    )
    local script_opts = table.concat({
        "streamee_smart_ultrawide_fill_probe-result_path=" .. lookahead_result_path:gsub("\\", "/"),
        "streamee_smart_ultrawide_fill_probe-control_path=" .. lookahead_control_path:gsub("\\", "/"),
        "streamee_smart_ultrawide_fill_probe-generation=" .. generation,
        "streamee_smart_ultrawide_fill_probe-probe_width=" .. tostring(opts.lookahead_probe_width),
        "streamee_smart_ultrawide_fill_probe-probe_fps=" .. tostring(opts.lookahead_probe_fps),
        "streamee_smart_ultrawide_fill_probe-crop_tolerance=" .. tostring(opts.lookahead_crop_tolerance),
        "streamee_smart_ultrawide_fill_probe-scene_threshold=" .. tostring(opts.lookahead_scene_threshold),
        "streamee_smart_ultrawide_fill_probe-scene_gate_window=" .. tostring(opts.lookahead_scene_gate_window),
        "streamee_smart_ultrawide_fill_probe-stable_time=" .. tostring(opts.lookahead_stable_time),
    }, ",")
    local args = {
        mpv_path,
        "--no-config",
        "--load-scripts=no",
        "--script=" .. probe_script,
        "--script-opts=" .. script_opts,
        "--msg-level=all=no",
        "--really-quiet",
        "--no-terminal",
        "--force-window=no",
        "--vo=null",
        "--ao=null",
        "--no-audio",
        "--no-sub",
        "--osc=no",
        "--ytdl=no",
        "--cache=no",
        "--demuxer-readahead-secs=0",
        "--hwdec=auto-copy",
        "--start=" .. string.format("%.3f", start_position),
        "--speed=" .. tostring(mp.get_property_number("speed", 1)),
        "--",
        source,
    }

    msg.info(string.format(
        "Smart Black Bar Fill %s probe started: lead=%.2fs scene_threshold=%.2f gate=%.2fs generation=%s",
        purpose,
        lead,
        opts.lookahead_scene_threshold,
        opts.lookahead_scene_gate_window,
        generation
    ))
    mp.command_native_async({
        name = "subprocess",
        args = args,
        playback_only = false,
    }, function(success, result)
        if generation ~= tostring(mp.get_property("pid", "0"))
                .. "-" .. tostring(lookahead_generation) then
            return
        end
        lookahead_running = false
        lookahead_ready = false
        lookahead_pending = nil
        local status = type(result) == "table" and tonumber(result.status) or nil
        msg.info(string.format(
            "Smart Black Bar Fill %s probe stopped: success=%s status=%s",
            purpose,
            tostring(success),
            tostring(status)
        ))
    end)
    return true
end

local function schedule_lookahead_restart(delay)
    if lookahead_restart_timer then
        lookahead_restart_timer:kill()
    end
    lookahead_restart_timer = mp.add_timeout(delay or 0.25, function()
        lookahead_restart_timer = nil
        stop_lookahead()
        start_lookahead("dynamic")
    end)
end

local function poll_lookahead_result()
    if not lookahead_running or not lookahead_result_path then
        return
    end
    local payload = read_text(lookahead_result_path)
    local event = payload and utils.parse_json(payload) or nil
    if type(event) ~= "table"
        or tonumber(event.sequence) == nil
        or tonumber(event.sequence) <= lookahead_last_sequence then
        return
    end

    local expected_generation = tostring(mp.get_property("pid", "0"))
        .. "-" .. tostring(lookahead_generation)
    if tostring(event.generation) ~= expected_generation then
        return
    end

    lookahead_last_sequence = tonumber(event.sequence)
    if event.kind == "baseline" then
        lookahead_baseline_crop = tostring(event.crop)
        msg.info("Adaptive crop lookahead baseline ready: " .. lookahead_baseline_crop)
    elseif event.kind == "transition" and tonumber(event.effective_pts) then
        lookahead_pending = {
            crop = tostring(event.crop),
            effective_pts = tonumber(event.effective_pts),
        }
        msg.info(string.format(
            "Adaptive crop lookahead planned: crop=%s effective_pts=%.3f",
            lookahead_pending.crop,
            lookahead_pending.effective_pts
        ))
    end
    return event
end

local function set_user_state(state)
    mp.set_property_native(
        "user-data/streamee-adaptive-crop-enabled",
        enabled and 1 or 0
    )
    mp.set_property("user-data/streamee-adaptive-crop-mode", active_mode)
    mp.set_property("user-data/streamee-adaptive-crop-state", state)
    mp.set_property_number("user-data/streamee-black-bar-lighting-enabled", lighting_enabled and 1 or 0)
end

local function reset_candidate()
    candidate_key = nil
    candidate_since = nil
end

local function filter_position(filters, label)
    if type(filters) ~= "table" then
        return nil
    end
    for index, filter in ipairs(filters) do
        if type(filter) == "table" and filter.label == label then
            return index
        end
    end
    return nil
end

local function pre_svp_scale(filters, svp_position)
    local scale = 1
    if not svp_position then
        return scale
    end
    for index, filter in ipairs(filters) do
        if index >= svp_position then
            break
        end
        if type(filter) == "table" and filter.label == VSR_FILTER_LABEL then
            local params = type(filter.params) == "table" and filter.params or nil
            scale = scale * (tonumber(params and params.scale) or 1)
        end
    end
    return scale
end

local function ffmpeg_software_format(value)
    value = type(value) == "string" and value:lower() or nil
    if value == "p010" then
        return "p010le"
    end
    if value == "p016" then
        return "p016le"
    end
    return value
end

local function hardware_download_prefix(filters, insertion_position)
    local previous = insertion_position and filters[insertion_position - 1] or nil
    local format = nil
    if type(previous) == "table" and previous.name == "d3d11vpp" then
        local params = type(previous.params) == "table" and previous.params or nil
        format = ffmpeg_software_format(params and params.format) or "nv12"
    elseif previous == nil then
        local source = mp.get_property_native("video-params")
        if type(source) == "table" and source.pixelformat == "d3d11" then
            format = ffmpeg_software_format(source["hw-pixelformat"]) or "nv12"
        end
    end

    return format and ("hwdownload,format=" .. format .. ",") or ""
end

local function svp_file(filters, svp_position)
    local filter = svp_position and filters[svp_position] or nil
    local params = type(filter) == "table" and filter.params or nil
    return type(params) == "table" and params.file or nil
end

local function discard_svp_shadow()
    if svp_shadow_path then os.remove(svp_shadow_path) end
    svp_shadow_path = nil
    svp_shadow_source = nil
    svp_lighting_suppressed = false
end

local function suppress_svp_outer_lighting()
    if not renderer_requested() or not lighting_shader_available() then return false end
    local filters = mp.get_property_native("vf") or {}
    local position = filter_position(filters, SVP_FILTER_LABEL)
    local path = svp_file(filters, position)
    if not position or not path then return false end
    if svp_shadow_path and normalized_path(path) == normalized_path(svp_shadow_path) then
        svp_lighting_suppressed = true
        return true
    end
    local script = read_text(path)
    if not script or not script:match("light%s*:%s*%b{}") then return false end
    local fixed, replacements = script:gsub(",%s*light%s*:%s*%b{}", "")
    if replacements == 0 then
        fixed, replacements = script:gsub("light%s*:%s*%b{}%s*,?", "")
    end
    if replacements == 0 then return false end
    discard_svp_shadow()
    local temp_dir = os.getenv("TEMP") or os.getenv("TMP")
    if not temp_dir then return false end
    local basename = path:match("([^/\\]+)$") or "svp.py"
    svp_shadow_generation = svp_shadow_generation + 1
    svp_shadow_path = utils.join_path(temp_dir,
        "streamee_svp_fixed_canvas_" .. mp.get_property("pid", "0") .. "_"
            .. svp_shadow_generation .. "_" .. basename)
    if not write_text(svp_shadow_path, fixed) then
        discard_svp_shadow()
        return false
    end
    svp_shadow_source = path
    filters[position].params.file = svp_shadow_path
    local ok, err = pcall(mp.set_property_native, "vf", filters)
    if not ok then
        msg.warn("Could not suppress duplicate SVP lighting: " .. tostring(err))
        discard_svp_shadow()
        return false
    end
    svp_lighting_suppressed = true
    msg.info("SVP outer lighting suppressed for fixed-canvas rendering")
    return true
end

local function restore_svp_outer_lighting()
    if not svp_shadow_path or not svp_shadow_source then
        discard_svp_shadow()
        return
    end
    local filters = mp.get_property_native("vf") or {}
    local position = filter_position(filters, SVP_FILTER_LABEL)
    if position and normalized_path(svp_file(filters, position)) == normalized_path(svp_shadow_path) then
        filters[position].params.file = svp_shadow_source
        pcall(mp.set_property_native, "vf", filters)
    end
    -- The active VapourSynth instance may still be opening the shadow file.
    local old_path = svp_shadow_path
    mp.add_timeout(2, function() os.remove(old_path) end)
    svp_shadow_path = nil
    svp_shadow_source = nil
    svp_lighting_suppressed = false
end

local function svp_outer_lighting_active()
    local filters = mp.get_property_native("vf")
    local position = filter_position(filters, SVP_FILTER_LABEL)
    if not position then
        return false
    end

    local path = svp_file(filters, position)
    if path then
        if path == lighting_cache_file and now() - lighting_cache_time < 0.5 then
            return lighting_cache_active
        end
        local script = read_text(path)
        if script then
            lighting_cache_file = path
            lighting_cache_time = now()
            lighting_cache_active = script:match("light%s*:%s*{%s*aspect%s*:") ~= nil
            return lighting_cache_active
        end
    end

    local source_width = mp.get_property_number("video-params/w")
    local source_height = mp.get_property_number("video-params/h")
    local output_width = mp.get_property_number("video-out-params/w")
    local output_height = mp.get_property_number("video-out-params/h")
    if not source_width or not source_height or not output_width or not output_height
        or source_width <= 0 or source_height <= 0 or output_width <= 0 or output_height <= 0 then
        return false
    end

    local source_aspect = source_width / source_height
    local output_aspect = output_width / output_height
    return math.abs(output_aspect - source_aspect) >= 0.015
end

local function remove_pre_svp_crop()
    if not pre_svp_crop_installed then
        return
    end
    pcall(mp.commandv, "vf", "remove", PRE_SVP_CROP_REFERENCE)
    pre_svp_crop_installed = false
end

local function apply_pre_svp_crop(crop)
    local width, height, x, y = crop_geometry(crop)
    local filters = mp.get_property_native("vf")
    local svp_position = filter_position(filters, SVP_FILTER_LABEL)
    if not width or not svp_position then
        return false
    end

    for index = #filters, 1, -1 do
        local filter = filters[index]
        if type(filter) == "table" and filter.label == PRE_SVP_CROP_LABEL then
            table.remove(filters, index)
        end
    end
    svp_position = filter_position(filters, SVP_FILTER_LABEL)
    if not svp_position then
        return false
    end

    local scale = pre_svp_scale(filters, svp_position)
    local graph = hardware_download_prefix(filters, svp_position) .. string.format(
        "crop=w=%d:h=%d:x=%d:y=%d",
        math.floor(width * scale + 0.5),
        math.floor(height * scale + 0.5),
        math.floor(x * scale + 0.5),
        math.floor(y * scale + 0.5)
    )
    table.insert(filters, svp_position, {
        name = "lavfi",
        label = PRE_SVP_CROP_LABEL,
        enabled = true,
        params = { graph = graph },
    })

    local ok, err = pcall(mp.set_property_native, "vf", filters)
    if not ok then
        msg.error("Failed to apply pre-SVP adaptive crop: " .. tostring(err))
        return false
    end
    pre_svp_crop_installed = true
    return true
end

local function fixed_canvas_coordinates(crop)
    local source_width = mp.get_property_number("video-params/w")
    local source_height = mp.get_property_number("video-params/h")
    local output_width = mp.get_property_number("video-out-params/w")
    local output_height = mp.get_property_number("video-out-params/h")
    if not source_width or not source_height or not output_width or not output_height
        or source_width <= 0 or source_height <= 0 or output_width <= 0 or output_height <= 0 then
        return nil
    end

    local filters = mp.get_property_native("vf") or {}
    local scale = pre_svp_scale(filters, filter_position(filters, SVP_FILTER_LABEL))
    local picture_width, picture_height = source_width * scale, source_height * scale
    local placement_scale = math.min(output_width / picture_width, output_height / picture_height)
    picture_width, picture_height = picture_width * placement_scale, picture_height * placement_scale
    local picture_x = (output_width - picture_width) * 0.5
    local picture_y = (output_height - picture_height) * 0.5

    local width, height, x, y = source_width, source_height, 0, 0
    if crop then
        width, height, x, y = crop_geometry(crop)
        if not width then return nil end
    end
    local source_scale_x, source_scale_y = picture_width / source_width, picture_height / source_height
    return {
        x = (picture_x + x * source_scale_x) / output_width,
        y = (picture_y + y * source_scale_y) / output_height,
        w = width * source_scale_x / output_width,
        h = height * source_scale_y / output_height,
        source_aspect = output_width / output_height,
    }
end

local function update_lighting_shader_opts(coordinates)
    coordinates = coordinates or fixed_canvas_coordinates(fixed_canvas_crop)
    if not coordinates then return false end
    local dimensions = mp.get_property_native("osd-dimensions") or {}
    local canvas_width, canvas_height = tonumber(dimensions.w), tonumber(dimensions.h)
    if not canvas_width or not canvas_height or canvas_width <= 0 or canvas_height <= 0 then
        return false
    end
    local values = mp.get_property_native("glsl-shader-opts")
    if type(values) ~= "table" then values = {} end
    local desired = {
        ["streamee_ultrawide_lighting/crop_x"] = string.format("%.9f", coordinates.x),
        ["streamee_ultrawide_lighting/crop_y"] = string.format("%.9f", coordinates.y),
        ["streamee_ultrawide_lighting/crop_w"] = string.format("%.9f", coordinates.w),
        ["streamee_ultrawide_lighting/crop_h"] = string.format("%.9f", coordinates.h),
        ["streamee_ultrawide_lighting/source_aspect"] = string.format("%.9f", coordinates.source_aspect),
        ["streamee_ultrawide_lighting/canvas_aspect"] = string.format("%.9f", canvas_width / canvas_height),
        ["streamee_ultrawide_lighting/lighting_enabled"] = lighting_enabled and "1" or "0",
    }
    local changed = false
    for key, value in pairs(desired) do
        if tostring(values[key]) ~= value then values[key], changed = value, true end
    end
    if changed then
        lighting_shader_opts_updating = true
        local ok, err = pcall(mp.set_property_native, "glsl-shader-opts", values)
        lighting_shader_opts_updating = false
        if not ok then
            msg.error("Failed to update fixed-canvas lighting: " .. tostring(err))
            return false
        end
    end
    return true
end

local function apply_fixed_canvas_crop(crop)
    if not install_lighting_shader() then return false end
    remove_pre_svp_crop()
    local ok, err = pcall(mp.set_property, "video-crop", base_crop or "")
    if not ok then
        msg.error("Failed to clear renderer crop for fixed canvas: " .. tostring(err))
        return false
    end
    fixed_canvas_crop = crop
    return update_lighting_shader_opts(fixed_canvas_coordinates(crop))
end

local function set_crop(crop, reason, force)
    local value = crop or base_crop or ""
    local use_fixed_canvas = (base_crop or "") == "" and lighting_shader_available()
    local use_pre_svp = not use_fixed_canvas and crop ~= nil
        and (base_crop or "") == ""
        and svp_outer_lighting_active()
    local desired_application = use_fixed_canvas and "fixed-canvas"
        or crop and (use_pre_svp and "pre-svp" or "renderer") or nil
    if not force and applied_crop == crop and crop_application == desired_application then
        applied_crop = crop
        return
    end

    pending_render_sample = {
        started_at = now(),
        crop = value == "" and "none" or value,
    }
    if use_fixed_canvas then
        -- Dynamic uniforms are consumed on the next rendered frame; there is
        -- no filter drain/reconfiguration delay to predict.
        render_lead_estimate = 0.010
        pending_render_sample = nil
    end
    local ok, err
    if use_fixed_canvas then
        ok = apply_fixed_canvas_crop(crop)
        if not ok then
            msg.warn("Fixed-canvas renderer was unavailable; using the existing crop path")
            use_pre_svp = crop ~= nil and svp_outer_lighting_active()
            desired_application = crop and (use_pre_svp and "pre-svp" or "renderer") or nil
            if use_pre_svp then
                ok, err = pcall(mp.set_property, "video-crop", base_crop or "")
                if ok then ok = apply_pre_svp_crop(crop) end
            else
                ok, err = pcall(mp.set_property, "video-crop", value)
            end
        end
    elseif use_pre_svp then
        ok, err = pcall(mp.set_property, "video-crop", base_crop or "")
        if ok then
            ok = apply_pre_svp_crop(crop)
            if not ok then
                msg.warn("Pre-SVP adaptive crop was unavailable; using renderer crop")
                desired_application = "renderer"
                ok, err = pcall(mp.set_property, "video-crop", value)
            end
        end
    else
        remove_pre_svp_crop()
        ok, err = pcall(mp.set_property, "video-crop", value)
    end
    if not ok then
        pending_render_sample = nil
        msg.error("Failed to set adaptive video crop: " .. tostring(err))
        set_user_state("error")
        return
    end

    applied_crop = crop
    crop_application = desired_application
    last_crop_change_at = now()
    if crop then
        msg.info(string.format(
            "Adaptive crop applied: %s via %s (%s)",
            crop,
            desired_application,
            reason
        ))
        set_user_state("cropped")
    else
        msg.info("Adaptive crop restored (" .. reason .. ")")
        set_user_state("watching")
    end
end

local function add_detector()
    if filter_installed or not file_loaded then
        return
    end
    if svp_outer_lighting_active() then
        return
    end

    local detector = string.format(
        "cropdetect=limit=%.4f:round=%d:reset_count=%d",
        opts.limit,
        opts.round,
        opts.reset_count
    )
    local filters = mp.get_property_native("vf") or {}
    local svp_position = filter_position(filters, SVP_FILTER_LABEL)
    local active_svp_file = svp_file(filters, svp_position)
    local insertion_position = svp_position or (#filters + 1)
    local graph = hardware_download_prefix(filters, insertion_position) .. detector

    local ok, err
    if svp_position then
        -- Inspect the original picture before SVP can synthesize outer-lighting
        -- pixels into its bars. The crop itself is inserted after this detector
        -- and immediately before SVP when lighting changes the output aspect.
        local pre_svp_crop_position = filter_position(filters, PRE_SVP_CROP_LABEL)
        insertion_position = pre_svp_crop_position or svp_position
        graph = hardware_download_prefix(filters, insertion_position) .. detector
        table.insert(filters, insertion_position, {
            name = "lavfi",
            label = FILTER_LABEL,
            enabled = true,
            params = { graph = graph },
        })
        ok, err = pcall(mp.set_property_native, "vf", filters)
    else
        local filter = string.format("%s:lavfi=[%s]", FILTER_REFERENCE, graph)
        ok, err = pcall(mp.commandv, "vf", "add", filter)
    end
    if not ok then
        msg.error("Failed to start adaptive crop detector: " .. tostring(err))
        set_user_state("error")
        return
    end

    filter_installed = true
    detector_svp_file = active_svp_file
    msg.info(
        "Adaptive crop detector started"
            .. (svp_position and " before SVP processing" or " at filter-chain end")
    )
    set_user_state("watching")
end

local function remove_detector()
    if not filter_installed then
        return
    end

    pcall(mp.commandv, "vf", "remove", FILTER_REFERENCE)
    filter_installed = false
    detector_svp_file = nil
end

local function viewport_allows_fill()
    if mp.get_property_bool("fullscreen", false) then
        return true
    end
    if opts.min_viewport_aspect <= 0 then
        return true
    end

    local dimensions = mp.get_property_native("osd-dimensions")
    if type(dimensions) ~= "table" then
        return false
    end

    local width = tonumber(dimensions.w)
    local height = tonumber(dimensions.h)
    return width and height and height > 0
        and (width / height) >= opts.min_viewport_aspect
end

local function metadata_number(metadata, key)
    if type(metadata) ~= "table" then
        return nil
    end
    return tonumber(metadata[key])
end

local function detected_rectangle()
    local metadata = mp.get_property_native(FILTER_METADATA)
    if type(metadata) ~= "table" then
        return nil
    end

    local width = metadata_number(metadata, "lavfi.cropdetect.w")
    local height = metadata_number(metadata, "lavfi.cropdetect.h")
    local x = metadata_number(metadata, "lavfi.cropdetect.x")
    local y = metadata_number(metadata, "lavfi.cropdetect.y")

    if width and height and x and y then
        return width, height, x, y
    end

    local legacy = metadata["lavfi.crop"]
    if type(legacy) == "string" then
        local legacy_w, legacy_h, legacy_x, legacy_y =
            legacy:match("^(%d+):(%d+):(%d+):(%d+)$")
        return tonumber(legacy_w), tonumber(legacy_h),
            tonumber(legacy_x), tonumber(legacy_y)
    end

    return nil
end

local function validated_candidate()
    if not viewport_allows_fill() then
        return "none"
    end

    local source_width = mp.get_property_number("video-params/w")
    local source_height = mp.get_property_number("video-params/h")
    local detector_width = mp.get_property_number("video-out-params/w")
    local detector_height = mp.get_property_number("video-out-params/h")
    local filters = mp.get_property_native("vf")
    local svp_position = filter_position(filters, SVP_FILTER_LABEL)
    if svp_position then
        local scale = pre_svp_scale(filters, svp_position)
        detector_width = source_width and source_width * scale or nil
        detector_height = source_height and source_height * scale or nil
    end
    local width, height, x, y = detected_rectangle()
    if not source_width or not source_height or not detector_width or not detector_height
        or not width or not height or not x or not y then
        return nil
    end
    if source_width <= 0 or source_height <= 0
        or detector_width <= 0 or detector_height <= 0
        or width <= 0 or height <= 0 then
        return nil
    end

    local top = y
    local bottom = detector_height - (y + height)
    local symmetry_tolerance = math.max(
        8,
        detector_height * opts.symmetry_tolerance_fraction
    )

    -- Only the top and bottom boundaries matter. cropdetect also follows dark
    -- picture content at the sides, which must not veto letterbox removal.
    if math.abs(top - bottom) > symmetry_tolerance then
        return nil
    end

    local total_crop = top + bottom
    if total_crop < detector_height * opts.min_bar_fraction * 2 then
        return "none"
    end
    if total_crop > detector_height * opts.max_total_crop_fraction then
        return nil
    end

    local source_top = math.floor((top / detector_height) * source_height + 0.5)
    local source_bottom = math.floor((bottom / detector_height) * source_height + 0.5)
    -- Treat a few pixels of detector jitter as the same boundary and keep the
    -- crop centered. This lets a genuine aspect transition settle near its cut
    -- instead of restarting the old multi-second stability timer.
    local boundary_quantum = math.max(1, math.floor(opts.boundary_quantum))
    local source_bar = math.floor(
        (((source_top + source_bottom) / 2) / boundary_quantum) + 0.5
    ) * boundary_quantum
    local source_crop_height = source_height - (source_bar * 2)
    if source_crop_height <= 0 or (source_width / source_crop_height) < opts.min_content_aspect then
        return nil
    end

    return string.format(
        "%dx%d+0+%d",
        source_width,
        source_crop_height,
        source_bar
    )
end

local function apply_pending_lookahead()
    if not lookahead_pending then
        return
    end

    local playback_time = mp.get_property_number("time-pos", 0)
    local command_pts = lookahead_pending.effective_pts - render_lead_estimate
    if playback_time < command_pts - opts.lookahead_schedule_tolerance then
        return
    end

    local transition_reason = string.format(
        "cache-only lookahead transition planned=%.3f command=%.3f command_delta=%+.3f render_lead=%.3f",
        lookahead_pending.effective_pts,
        playback_time,
        playback_time - command_pts,
        render_lead_estimate
    )
    if lookahead_pending.crop == "none" then
        if applied_crop then
            set_crop(nil, transition_reason)
        end
    elseif lookahead_pending.crop ~= applied_crop then
        set_crop(lookahead_pending.crop, transition_reason)
    end
    lookahead_baseline_crop = lookahead_pending.crop
    lookahead_pending = nil
end

local function poll_detector()
    if not enabled or not file_loaded then
        return
    end
    poll_lookahead_result()
    if mp.get_property_bool("pause", false) or mp.get_property_bool("seeking", false) then
        reset_candidate()
        return
    end

    if svp_outer_lighting_active() and lookahead_baseline_crop and not lookahead_ready then
        -- The independent probe sees the original cached source. SVP lighting
        -- makes the live output unsuitable for baseline synchronization.
        remove_detector()
        lookahead_ready = true
        set_crop(
            lookahead_baseline_crop ~= "none" and lookahead_baseline_crop or nil,
            "independent lookahead baseline for SVP lighting"
        )
        msg.info("Adaptive crop lookahead authoritative for SVP lighting")
    end

    if lookahead_ready then
        apply_pending_lookahead()
        return
    end

    if not filter_installed then
        return
    end

    local candidate = validated_candidate()
    if not candidate then
        reset_candidate()
        return
    end

    if lookahead_baseline_crop and crops_equivalent(candidate, lookahead_baseline_crop) then
        lookahead_ready = true
        msg.info(string.format(
            "Adaptive crop lookahead synchronized: live=%s probe=%s; scheduled transitions active",
            candidate,
            lookahead_baseline_crop
        ))
        -- The full-resolution live candidate is the authoritative initial
        -- crop. Before synchronization the fast live fallback may have
        -- applied a transient boundary while the probe was still settling.
        if candidate == "none" then
            if applied_crop then
                set_crop(nil, "lookahead baseline synchronized")
            end
        elseif candidate ~= applied_crop then
            set_crop(candidate, "lookahead baseline synchronized")
        end
        lookahead_baseline_crop = candidate
        apply_pending_lookahead()
        return
    end

    if candidate ~= candidate_key then
        candidate_key = candidate
        candidate_since = now()
        return
    end

    local required_time = candidate == "none" and opts.restore_time or opts.stable_time
    if candidate_since and now() - candidate_since >= required_time then
        if now() - last_crop_change_at < opts.change_cooldown then
            return
        end
        if candidate == "none" then
            if applied_crop then
                set_crop(nil, "stable full-height image")
            end
        elseif candidate ~= applied_crop then
            set_crop(candidate, "transition-confirmed symmetric letterbox")
        end
    end
end

local function start_timer()
    if not timer then
        timer = mp.add_periodic_timer(opts.poll_interval, poll_detector)
    else
        timer:resume()
    end
end

local function stop_timer()
    if timer then
        timer:stop()
    end
end

local function stop_efficient_timers()
    if efficient_interval_timer then
        efficient_interval_timer:stop()
    end
    if efficient_poll_timer then
        efficient_poll_timer:stop()
    end
    if efficient_scan_start_timer then
        efficient_scan_start_timer:kill()
        efficient_scan_start_timer = nil
    end
end

local function poll_efficient_scan()
    if active_mode ~= "efficient" or lookahead_purpose ~= "efficient" then
        return
    end

    local event = poll_lookahead_result()
    if not event or event.kind ~= "baseline" then
        return
    end

    local crop = tostring(event.crop)
    if crop == "none" then
        if applied_crop then
            set_crop(nil, "efficient periodic scan")
        end
    elseif crop ~= applied_crop then
        set_crop(crop, "efficient periodic scan")
    end
    msg.info("Smart Black Bar Fill efficient scan completed: crop=" .. crop)
    stop_lookahead()
    if efficient_poll_timer then
        efficient_poll_timer:stop()
    end
end

local function start_efficient_scan()
    if active_mode ~= "efficient"
        or not file_loaded
        or not viewport_allows_fill()
        or mp.get_property_bool("pause", false)
        or lookahead_running then
        return
    end

    if start_lookahead("efficient") then
        if not efficient_poll_timer then
            efficient_poll_timer = mp.add_periodic_timer(
                opts.poll_interval,
                poll_efficient_scan
            )
        else
            efficient_poll_timer:resume()
        end
    end
end

local function schedule_efficient_scan(delay)
    if efficient_scan_start_timer then
        efficient_scan_start_timer:kill()
    end
    efficient_scan_start_timer = mp.add_timeout(delay or 0.25, function()
        efficient_scan_start_timer = nil
        start_efficient_scan()
    end)
end

local function start_efficient_schedule()
    stop_efficient_timers()
    local interval = math.max(5, tonumber(opts.efficient_scan_interval) or 60)
    efficient_interval_timer = mp.add_periodic_timer(interval, start_efficient_scan)
    schedule_efficient_scan(0.25)
end

local function stop_mode_runtime()
    stop_lookahead()
    stop_timer()
    stop_efficient_timers()
    remove_detector()
    reset_candidate()
end

local function reconcile_filter_topology()
    topology_timer = nil
    if not file_loaded or not renderer_requested() or topology_reconciling then
        return
    end
    topology_reconciling = true

    suppress_svp_outer_lighting()
    local lighting = svp_lighting_suppressed or svp_outer_lighting_active()
    if lighting then
        local had_detector = filter_installed
        remove_detector()
        if had_detector then
            msg.info("Adaptive crop live detector suspended; SVP lighting uses the independent probe")
        end
        if applied_crop and (crop_application ~= "pre-svp" or had_detector) then
            set_crop(applied_crop, "SVP lighting filter attached", true)
        end
    else
        if applied_crop and crop_application == "pre-svp" then
            set_crop(applied_crop, "SVP lighting filter detached", true)
        end
        if active_mode == "dynamic" then
            local filters = mp.get_property_native("vf") or {}
            local svp_position = filter_position(filters, SVP_FILTER_LABEL)
            local detector_position = filter_position(filters, FILTER_LABEL)
            local wrong_order = svp_position and detector_position
                and detector_position > svp_position
            if not filter_installed or not detector_position or wrong_order
                or detector_svp_file ~= svp_file(filters, svp_position) then
                remove_detector()
                add_detector()
                reset_candidate()
            end
        end
    end

    topology_reconciling = false
end

local function schedule_topology_reconcile()
    if not file_loaded or not renderer_requested() or topology_reconciling then
        return
    end
    lighting_cache_time = -math.huge
    if topology_timer then
        topology_timer:kill()
    end
    topology_timer = mp.add_timeout(0.05, reconcile_filter_topology)
end

local function set_mode(mode, show_osd)
    if mode ~= "off" and mode ~= "dynamic" and mode ~= "efficient" then
        return
    end

    stop_mode_runtime()
    active_mode = mode
    enabled = mode ~= "off"

    if mode == "off" then
        if applied_crop then
            set_crop(nil, "Smart Black Bar Fill disabled")
        end
        if lighting_enabled and file_loaded and (base_crop or "") == "" then
            install_lighting_shader()
            fixed_canvas_crop = nil
            update_lighting_shader_opts()
            schedule_topology_reconcile()
        else
            remove_lighting_shader()
            restore_svp_outer_lighting()
        end
        set_user_state("off")
    elseif mode == "dynamic" then
        if file_loaded then
            add_detector()
            start_timer()
            schedule_lookahead_restart(0.25)
        end
        set_user_state("watching")
    else
        if file_loaded then
            start_efficient_schedule()
        end
        set_user_state("watching")
    end

    if show_osd then
        local label = mode == "off" and "Off"
            or mode == "dynamic" and "Dynamic"
            or "Efficient"
        if mode ~= saved_mode then
            label = label .. " (this title)"
        end
        mp.osd_message("Smart Black Bar Fill: " .. label)
    end
    msg.info(string.format(
        "Smart Black Bar Fill mode: active=%s saved=%s",
        active_mode,
        saved_mode
    ))
end

local function set_lighting(value, show_osd)
    lighting_enabled = value == true
    if file_loaded and (base_crop or "") == "" then
        if renderer_requested() then
            install_lighting_shader()
            if not enabled then fixed_canvas_crop = nil end
            update_lighting_shader_opts()
            schedule_topology_reconcile()
        else
            remove_lighting_shader()
            restore_svp_outer_lighting()
        end
    end
    mp.set_property_number("user-data/streamee-black-bar-lighting-enabled", lighting_enabled and 1 or 0)
    if show_osd then
        mp.osd_message("Black Bar Lighting: " .. (lighting_enabled and "On" or "Off") .. " (this title)")
    end
    msg.info("Black Bar Lighting: " .. (lighting_enabled and "on" or "off"))
end

local function toggle_dynamic()
    if active_mode == "dynamic" then
        set_mode(saved_mode, true)
    else
        set_mode("dynamic", true)
    end
end

mp.register_event("file-loaded", function()
    file_loaded = true
    filter_installed = false
    detector_svp_file = nil
    applied_crop = nil
    crop_application = nil
    pre_svp_crop_installed = false
    lighting_cache_file = nil
    lighting_cache_time = -math.huge
    base_crop = mp.get_property("video-crop", "")
    reset_render_lead_estimate()
    reset_candidate()
    if renderer_requested() and (base_crop or "") == "" and lighting_shader_available() then
        install_lighting_shader()
        fixed_canvas_crop = nil
        update_lighting_shader_opts()
    end
    if active_mode == "dynamic" then
        add_detector()
        start_timer()
        schedule_lookahead_restart(0.25)
    elseif active_mode == "efficient" then
        start_efficient_schedule()
    end
    set_user_state(enabled and "watching" or "off")
end)

mp.register_event("end-file", function()
    if topology_timer then
        topology_timer:kill()
        topology_timer = nil
    end
    stop_lookahead()
    stop_timer()
    stop_efficient_timers()
    if applied_crop then
        set_crop(nil, "playback ended")
    end
    remove_lighting_shader()
    restore_svp_outer_lighting()
    filter_installed = false
    detector_svp_file = nil
    file_loaded = false
    applied_crop = nil
    crop_application = nil
    pre_svp_crop_installed = false
    pending_render_sample = nil
    reset_candidate()
    active_mode = saved_mode
    enabled = active_mode ~= "off"
    lighting_enabled = saved_lighting_enabled
    set_user_state(enabled and "watching" or "off")
end)

mp.register_event("video-reconfig", function()
    schedule_topology_reconcile()
    if lighting_shader_installed then update_lighting_shader_opts() end
    if not pending_render_sample then
        return
    end

    local sample = pending_render_sample
    pending_render_sample = nil
    local elapsed = now() - sample.started_at
    if elapsed < 0 or elapsed > 0.50 then
        return
    end

    local minimum = tonumber(opts.lookahead_render_lead_min) or 0.030
    local maximum = tonumber(opts.lookahead_render_lead_max) or 0.150
    local padding = tonumber(opts.lookahead_render_lead_padding) or 0.010
    local alpha = clamp(tonumber(opts.lookahead_render_lead_alpha) or 0.35, 0, 1)
    local measured_lead = clamp(elapsed + padding, minimum, maximum)
    render_lead_estimate = clamp(
        render_lead_estimate + (measured_lead - render_lead_estimate) * alpha,
        minimum,
        maximum
    )
    msg.info(string.format(
        "Adaptive crop renderer timing: crop=%s sample=%.3fs render_lead=%.3fs",
        sample.crop,
        elapsed,
        render_lead_estimate
    ))
end)

mp.observe_property("vf", "native", schedule_topology_reconcile)
mp.observe_property("osd-dimensions", "native", function()
    if lighting_shader_installed and file_loaded then update_lighting_shader_opts() end
end)
mp.observe_property("glsl-shader-opts", "native", function()
    if not lighting_shader_installed or not file_loaded or lighting_shader_opts_updating then return end
    if lighting_shader_opts_timer then lighting_shader_opts_timer:kill() end
    lighting_shader_opts_timer = mp.add_timeout(0, function()
        lighting_shader_opts_timer = nil
        update_lighting_shader_opts()
    end)
end)

mp.register_event("seek", function()
    reset_candidate()
    if active_mode == "dynamic" then
        schedule_lookahead_restart(0.35)
    elseif active_mode == "efficient" then
        stop_lookahead()
        schedule_efficient_scan(0.35)
    end
end)
mp.observe_property("pause", "bool", function(_, paused)
    if not enabled or not file_loaded then
        return
    end
    if paused then
        stop_lookahead()
        if efficient_poll_timer then
            efficient_poll_timer:stop()
        end
    else
        if active_mode == "dynamic" then
            schedule_lookahead_restart(0.20)
        elseif active_mode == "efficient" then
            schedule_efficient_scan(0.20)
        end
    end
end)
mp.observe_property("window-minimized", "bool", function(_, minimized)
    if not enabled or not file_loaded then return end
    if minimized then
        stop_lookahead()
    elseif active_mode == "dynamic" then
        schedule_lookahead_restart(0.20)
    elseif active_mode == "efficient" then
        schedule_efficient_scan(0.20)
    end
end)
mp.observe_property("speed", "number", function()
    if enabled and file_loaded and lookahead_running then
        if active_mode == "dynamic" then
            schedule_lookahead_restart(0.20)
        else
            stop_lookahead()
            schedule_efficient_scan(0.20)
        end
    end
end)
mp.register_event("shutdown", function()
    if topology_timer then
        topology_timer:kill()
        topology_timer = nil
    end
    stop_lookahead()
    stop_efficient_timers()
    if lighting_shader_opts_timer then
        lighting_shader_opts_timer:kill()
        lighting_shader_opts_timer = nil
    end
    remove_lighting_shader()
    discard_svp_shadow()
    if lookahead_control_path then
        os.remove(lookahead_control_path)
    end
    if lookahead_result_path then
        os.remove(lookahead_result_path)
    end
end)
mp.register_script_message("smart-ultrawide-fill-off", function()
    set_mode("off", true)
end)
mp.register_script_message("smart-ultrawide-fill-dynamic", function()
    set_mode("dynamic", true)
end)
mp.register_script_message("smart-ultrawide-fill-efficient", function()
    set_mode("efficient", true)
end)
mp.register_script_message("toggle-black-bar-lighting", function()
    set_lighting(not lighting_enabled, true)
end)
mp.register_script_message("adaptive-crop-toggle", toggle_dynamic)
mp.register_script_message("adaptive-crop-enable", function()
    set_mode("dynamic", true)
end)
mp.register_script_message("adaptive-crop-disable", function()
    set_mode("off", true)
end)

load_default_mode()
set_user_state(enabled and "watching" or "off")
