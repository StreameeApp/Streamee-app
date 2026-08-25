-- Streamee Sharpen Menu Script
-- Manages shader toggling from MPV's right-click menu

local mp = require("mp")
local utils = require("mp.utils")
local options = require("mp.options")

local o = {
    default_mode = "auto",
    default_denoise_mode = "bilateral",
    default_denoise_strength = "medium",
    default_bm3dcuda_profile = "balanced",
}

options.read_options(o, "streamee_sharpen")

local DEFAULT_SHADER_SETTINGS = {
    strength_bias = 1.0,
    detail_radius = 1.0,
    edge_sensitivity = 1.0,
    noise_protection = 1.0,
    halo_control = 1.0,
}

local SETTINGS_VERSION = 2
local PRESET_KEYS = { "standard", "adaptive", "ultra", "ultra-custom" }

local DENOISE_MODE_ORDER = { "off", "bilateral", "hqdn3d", "bm3dcuda-luma" }
local DENOISE_STRENGTH_ORDER = { "low", "medium", "high" }
local BM3DCUDA_PROFILE_ORDER = { "realtime", "balanced", "maximum" }
local HQDN3D_FILTER_LABEL = "@streamee-hqdn3d"
local SVP_FILTER_LABEL = "svp"
local VSR_FILTER_LABEL = "streamee-vsr"
local BM3DCUDA_MODES = {
    ["bm3dcuda-luma"] = true,
    ["bm3dcuda-color"] = true,
    ["bm3dcuda-temporal"] = true,
    ["bm3dcuda-quality"] = true,
}
local BM3DCUDA_PROFILES = {
    -- Balanced is the plugin's original/default search configuration. Realtime
    -- reduces the search work; Maximum searches more densely and farther.
    realtime = { block_step = 8, bm_range = 5, ps_num = 1, ps_range = 2 },
    balanced = { block_step = 8, bm_range = 9, ps_num = 2, ps_range = 4 },
    maximum = { block_step = 4, bm_range = 16, ps_num = 2, ps_range = 6 },
}

local function normalized_denoise_mode(value)
    local normalized = tostring(value):lower()
    if normalized == "off" or normalized == "hqdn3d" or BM3DCUDA_MODES[normalized] then
        return normalized
    end
    return "bilateral"
end

local function normalized_denoise_strength(value)
    local normalized = tostring(value):lower()
    if normalized == "low" or normalized == "high" then
        return normalized
    end
    return "medium"
end

local function normalized_bm3dcuda_profile(value)
    local normalized = tostring(value):lower()
    if BM3DCUDA_PROFILES[normalized] then
        return normalized
    end
    return "balanced"
end

local current_denoise_mode = normalized_denoise_mode(o.default_denoise_mode)
local current_denoise_strength = normalized_denoise_strength(o.default_denoise_strength)
local current_bm3dcuda_profile = normalized_bm3dcuda_profile(o.default_bm3dcuda_profile)

local function publish_denoise_state()
    mp.set_property_number(
        "user-data/streamee-bm3dcuda-enabled",
        BM3DCUDA_MODES[current_denoise_mode] and 1 or 0
    )
    mp.set_property_number(
        "user-data/streamee-hqdn3d-enabled",
        current_denoise_mode == "hqdn3d" and 1 or 0
    )
    for mode in pairs(BM3DCUDA_MODES) do
        mp.set_property_number(
            "user-data/streamee-" .. mode .. "-enabled",
            current_denoise_mode == mode and 1 or 0
        )
    end
    for _, strength in ipairs(DENOISE_STRENGTH_ORDER) do
        mp.set_property_number(
            "user-data/streamee-denoise-strength-" .. strength .. "-enabled",
            current_denoise_strength == strength and 1 or 0
        )
    end
    for _, profile in ipairs(BM3DCUDA_PROFILE_ORDER) do
        mp.set_property_number(
            "user-data/streamee-bm3dcuda-profile-" .. profile .. "-enabled",
            current_bm3dcuda_profile == profile and 1 or 0
        )
    end
end

publish_denoise_state()

local function get_script_dir()
    if mp.get_script_directory then
        local dir = mp.get_script_directory()
        if dir and dir ~= "" then
            return dir
        end
    end

    local source = debug.getinfo(1, "S").source or ""
    if source:sub(1, 1) == "@" then
        source = source:sub(2)
    end
    return source:match("^(.*)[/\\][^/\\]+$") or "."
end

local function get_shader_paths()
    local script_dir = get_script_dir()
    local mpv_dir = script_dir:match("(.+)[/\\]scripts[/\\]?$") or script_dir
    return mpv_dir,
        utils.join_path(mpv_dir, utils.join_path("shaders", "bilateral_denoise.glsl")),
        utils.join_path(mpv_dir, utils.join_path("shaders", "standard_sharpen.glsl")),
        utils.join_path(mpv_dir, utils.join_path("shaders", "adaptive_sharpen.glsl")),
        utils.join_path(mpv_dir, utils.join_path("shaders", "ultra_sharpen.glsl")),
        utils.join_path(mpv_dir, utils.join_path("shaders", "ultra_legacy_sharpen.glsl"))
end

local mpv_dir, bilateral_path, standard_path, adaptive_path, ultra_custom_path, ultra_path = get_shader_paths()
local script_dir = get_script_dir()
local bm3dcuda_plugin_path = utils.join_path(mpv_dir, utils.join_path("vs-plugins", "bm3dcuda.dll"))
local helper_script_path = utils.join_path(script_dir, "streamee_sharpen_options.ps1")
local settings_path = utils.join_path(script_dir, "streamee_sharpen_settings.json")
local season_state_path = utils.join_path(script_dir, "streamee_video_processing_season.json")
local shader_settings = {}
local preset_settings = {}
local current_mode = "off"
local current_season_scope = nil
local season_override_mode = nil
local season_override_denoise_mode = nil
local season_override_denoise_strength = nil
local season_override_bm3dcuda_profile = nil
local startup_default_pending = true
local startup_scope_pending = true

local function publish_sharpen_state()
    mp.set_property("user-data/streamee-sharpen-mode", current_mode)
end

publish_sharpen_state()

mp.msg.info("Streamee sharpen script loaded")
mp.msg.info("  MPV dir: " .. mpv_dir)
mp.msg.info("  Bilateral shader: " .. bilateral_path)
mp.msg.info("  Standard shader: " .. standard_path)
mp.msg.info("  Adaptive shader: " .. adaptive_path)
mp.msg.info("  Ultra shader: " .. ultra_path)
mp.msg.info("  UltraCustom shader: " .. ultra_custom_path)
mp.msg.info("  BM3D CUDA plugin: " .. bm3dcuda_plugin_path)

local function clamp(value, min_value, max_value)
    if value < min_value then
        return min_value
    end
    if value > max_value then
        return max_value
    end
    return value
end

local function normalized_sharpen_mode(value)
    local normalized = tostring(value):lower()
    if normalized == "standard"
        or normalized == "adaptive"
        or normalized == "ultra"
        or normalized == "ultra-custom"
        or normalized == "off"
    then
        return normalized
    end
    return nil
end

local function preset_key_for_mode(mode)
    return mode
end

local function normalized_denoise_mode_override(value)
    local normalized = tostring(value):lower()
    if normalized == "off"
        or normalized == "bilateral"
        or normalized == "hqdn3d"
        or BM3DCUDA_MODES[normalized]
    then
        return normalized
    end
    return nil
end

local function normalized_denoise_strength_override(value)
    local normalized = tostring(value):lower()
    if normalized == "low" or normalized == "medium" or normalized == "high" then
        return normalized
    end
    return nil
end

local function normalized_bm3dcuda_profile_override(value)
    local normalized = tostring(value):lower()
    if BM3DCUDA_PROFILES[normalized] then
        return normalized
    end
    return nil
end

local function normalized_scope_title(value)
    local normalized = tostring(value):lower()
    normalized = normalized:gsub("[^%w]+", "-")
    normalized = normalized:gsub("^-+", ""):gsub("-+$", "")
    return normalized
end

local function season_scope_from_title(value)
    if not value or value == "" then
        return nil
    end

    local prefix, season = tostring(value):match("^(.-)[%s%._%-]*[Ss](%d+)[Ee]%d+")
    if not prefix then
        prefix, season = tostring(value):match(
            "^(.-)[%s%._%-]*[Ss]eason[%s%._%-]*(%d+)[%s%._%-]+[Ee]pisode[%s%._%-]*%d+"
        )
    end
    if not prefix then
        prefix, season = tostring(value):match("^(.-)[%s%._%-]+(%d%d?)[xX]%d%d?%d?")
    end
    if not prefix or not season then
        return nil
    end

    local show_key = normalized_scope_title(prefix)
    local season_number = tonumber(season)
    if show_key == "" or not season_number then
        return nil
    end
    return string.format("%s:s%d", show_key, season_number)
end


local function get_current_season_scope()
    local properties = { "force-media-title", "media-title", "filename", "path" }
    for _, property in ipairs(properties) do
        local candidate = mp.get_property(property)
        local scope = season_scope_from_title(candidate)
        if scope then
            return scope
        end
    end
    return nil
end

local function load_saved_season_state()
    local file = io.open(season_state_path, "r")
    if not file then
        return nil
    end
    local content = file:read("*a")
    file:close()
    if content then
        content = content:gsub("^\239\187\191", "")
    end
    local data = utils.parse_json(content or "")
    if type(data) ~= "table" or type(data.scope) ~= "string" then
        return nil
    end
    return data
end

local function save_current_season_state()
    if not current_season_scope then
        return
    end
    local file = io.open(season_state_path, "w")
    if not file then
        mp.msg.error("Failed to save season video processing state: " .. season_state_path)
        return
    end
    file:write(utils.format_json({
        version = 2,
        scope = current_season_scope,
        sharpen_mode = season_override_mode,
        denoise_mode = season_override_denoise_mode,
        denoise_strength = season_override_denoise_strength,
        bm3dcuda_profile = season_override_bm3dcuda_profile,
    }))
    file:close()
end

local function prepare_season_state_for_current_file()
    current_season_scope = get_current_season_scope()
    season_override_mode = nil
    season_override_denoise_mode = nil
    season_override_denoise_strength = nil
    season_override_bm3dcuda_profile = nil
    current_denoise_mode = normalized_denoise_mode(o.default_denoise_mode)
    current_denoise_strength = normalized_denoise_strength(o.default_denoise_strength)
    current_bm3dcuda_profile = normalized_bm3dcuda_profile(o.default_bm3dcuda_profile)
    publish_denoise_state()

    if not current_season_scope then
        mp.msg.info("Video processing season scope unavailable; using user defaults")
        return
    end

    local saved = load_saved_season_state()
    if saved and saved.scope == current_season_scope then
        season_override_mode = normalized_sharpen_mode(saved.sharpen_mode)
        season_override_denoise_mode = normalized_denoise_mode_override(saved.denoise_mode)
        season_override_denoise_strength = normalized_denoise_strength_override(saved.denoise_strength)
        season_override_bm3dcuda_profile = normalized_bm3dcuda_profile_override(saved.bm3dcuda_profile)
        current_denoise_mode = season_override_denoise_mode or current_denoise_mode
        current_denoise_strength = season_override_denoise_strength or current_denoise_strength
        current_bm3dcuda_profile = season_override_bm3dcuda_profile or current_bm3dcuda_profile
        publish_denoise_state()
        mp.msg.info("Restored season video processing state: " .. current_season_scope)
    else
        mp.msg.info("New season video processing scope; using user defaults: " .. current_season_scope)
        save_current_season_state()
    end
end

local function normalized_shader_settings(candidate)
    local merged = {}
    candidate = type(candidate) == "table" and candidate or {}

    merged.strength_bias = clamp(tonumber(candidate.strength_bias) or DEFAULT_SHADER_SETTINGS.strength_bias, 0.125, 3.000)
    merged.detail_radius = clamp(tonumber(candidate.detail_radius) or DEFAULT_SHADER_SETTINGS.detail_radius, 0.125, 3.000)
    merged.edge_sensitivity = clamp(tonumber(candidate.edge_sensitivity) or DEFAULT_SHADER_SETTINGS.edge_sensitivity, 0.125, 3.000)
    merged.noise_protection = clamp(tonumber(candidate.noise_protection) or DEFAULT_SHADER_SETTINGS.noise_protection, 0.125, 3.000)
    merged.halo_control = clamp(tonumber(candidate.halo_control) or DEFAULT_SHADER_SETTINGS.halo_control, 0.125, 3.000)

    return merged
end

local function default_preset_settings()
    local presets = {}
    for _, key in ipairs(PRESET_KEYS) do
        presets[key] = normalized_shader_settings(nil)
    end
    return presets
end

local function normalized_preset_settings(candidate)
    if type(candidate) == "table" and type(candidate.presets) == "table" then
        local presets = {}
        local needs_migration = tonumber(candidate.version) ~= SETTINGS_VERSION
        for _, key in ipairs(PRESET_KEYS) do
            if type(candidate.presets[key]) ~= "table" then
                needs_migration = true
            end
            presets[key] = normalized_shader_settings(candidate.presets[key])
        end
        return presets, needs_migration
    end

    -- Legacy settings used one tuning block for every shader. Preserve that
    -- tuning for the non-canonical presets, while canonical Ultra starts from
    -- its neutral 1.000 values so widening its accepted range changes nothing.
    local legacy = normalized_shader_settings(candidate)
    local presets = default_preset_settings()
    presets.standard = normalized_shader_settings(legacy)
    presets.adaptive = normalized_shader_settings(legacy)
    presets["ultra-custom"] = normalized_shader_settings(legacy)
    return presets, true
end

local function shader_settings_equal(left, right)
    return left.strength_bias == right.strength_bias
        and left.detail_radius == right.detail_radius
        and left.edge_sensitivity == right.edge_sensitivity
        and left.noise_protection == right.noise_protection
        and left.halo_control == right.halo_control
end

local function preset_settings_equal(left, right)
    for _, key in ipairs(PRESET_KEYS) do
        if not left[key] or not right[key] or not shader_settings_equal(left[key], right[key]) then
            return false
        end
    end
    return true
end

local function shader_settings_summary()
    if current_mode == "off" then
        return "Preset values inactive"
    end
    if current_mode == "ultra" then
        return string.format(
            "Bias %.3f | Edge %.3f | Noise %.3f | Halo %.3f",
            shader_settings.strength_bias,
            shader_settings.edge_sensitivity,
            shader_settings.noise_protection,
            shader_settings.halo_control
        )
    end
    return string.format(
        "Bias %.3f | Radius %.3f | Edge %.3f | Noise %.3f | Halo %.3f",
        shader_settings.strength_bias,
        shader_settings.detail_radius,
        shader_settings.edge_sensitivity,
        shader_settings.noise_protection,
        shader_settings.halo_control
    )
end

local function save_shader_settings()
    local file = io.open(settings_path, "w")
    if not file then
        mp.msg.error("Failed to save sharpen settings: " .. settings_path)
        return false
    end

    file:write(utils.format_json({
        version = SETTINGS_VERSION,
        presets = preset_settings,
    }))
    file:close()
    return true
end

local function load_shader_settings()
    local file = io.open(settings_path, "r")
    if not file then
        preset_settings = default_preset_settings()
        shader_settings = preset_settings.standard
        save_shader_settings()
        return
    end

    local content = file:read("*a")
    file:close()
    if content then
        content = content:gsub("^\239\187\191", "")
    end

    local data = utils.parse_json(content)
    if content and content ~= "" and type(data) ~= "table" then
        mp.msg.warn("Failed to parse sharpen settings JSON, using defaults: " .. settings_path)
        data = nil
    end
    local migrated = false
    preset_settings, migrated = normalized_preset_settings(data)
    shader_settings = preset_settings.standard
    if migrated then
        save_shader_settings()
        mp.msg.info("Migrated sharpener settings to per-preset format")
    end
    mp.msg.info("Loaded per-preset sharpener settings")
end

local function get_source_dimensions()
    local params = mp.get_property_native("video-params")
    if type(params) ~= "table" then
        return nil, nil
    end

    local width = tonumber(params.w or params.dw)
    local height = tonumber(params.h or params.dh)
    if not width or not height then
        return nil, nil
    end

    return width, height
end

local function get_resolution_profile()
    local width, height = get_source_dimensions()
    if not width or not height then
        return "Unknown", "Profile pending"
    end

    local short_edge = math.min(width, height)
    local resolution_label = string.format("%dx%d", width, height)

    if short_edge <= 1080 then
        return resolution_label, "1080p tuned"
    end

    if width >= 3840 or height >= 2160 then
        return resolution_label, "4K tuned"
    end

    return resolution_label, "Mid-res blend"
end

local function is_source_4k()
    local width, height = get_source_dimensions()
    if not width or not height then
        return false
    end

    return width >= 3840 or height >= 2160
end

local function denoise_mode_label(mode)
    if mode == "bilateral" then
        return "Bilateral"
    end
    if mode == "hqdn3d" then
        return "HQDN3D"
    end
    if mode == "bm3dcuda-luma" then
        return "BM3D CUDA Luma Spatial"
    end
    if mode == "bm3dcuda-color" then
        return "BM3D CUDA Full Color"
    end
    if mode == "bm3dcuda-temporal" then
        return "BM3D CUDA Luma Temporal"
    end
    if mode == "bm3dcuda-quality" then
        return "BM3D CUDA Two-stage"
    end
    return "Off"
end

local function denoise_strength_label(strength)
    if strength == "low" then
        return "Low"
    end
    if strength == "high" then
        return "High"
    end
    return "Medium"
end

local function bm3dcuda_profile_label(profile)
    if profile == "realtime" then
        return "Realtime"
    end
    if profile == "maximum" then
        return "Maximum"
    end
    return "Balanced"
end

local function denoise_summary()
    local summary = string.format(
        "Denoiser: %s | Strength: %s",
        denoise_mode_label(current_denoise_mode),
        denoise_strength_label(current_denoise_strength)
    )
    if BM3DCUDA_MODES[current_denoise_mode] then
        summary = summary .. " | Processing: " .. bm3dcuda_profile_label(current_bm3dcuda_profile)
    end
    return summary
end

local function get_denoise_strength_value()
    if current_denoise_strength == "low" then
        return 0.75
    end
    if current_denoise_strength == "high" then
        return 1.10
    end
    return 0.90
end

local function get_denoise_shader_path()
    if current_denoise_mode == "bilateral" then
        return bilateral_path
    end
    return nil
end

local function get_hqdn3d_strengths()
    if current_denoise_strength == "low" then
        return 0.80, 0.60, 1.20, 0.90
    end
    if current_denoise_strength == "high" then
        return 2.50, 1.50, 4.00, 2.50
    end
    return 1.50, 1.00, 2.50, 1.50
end

local function get_hqdn3d_input_graph()
    local params = mp.get_property_native("video-params")
    if type(params) ~= "table" or tostring(params.pixelformat):lower() ~= "d3d11" then
        return ""
    end

    local hardware_format = tostring(params["hw-pixelformat"]):lower()
    if hardware_format == "nv12" then
        return "hwdownload,format=nv12,format=yuv420p,"
    end
    if hardware_format == "p010" then
        return "hwdownload,format=p010le,format=yuv420p10le,"
    end
    if hardware_format == "p016" then
        return "hwdownload,format=p016le,format=yuv420p16le,"
    end

    return nil, "unsupported D3D11 format: " .. hardware_format
end

local function get_hqdn3d_filter_spec()
    local luma_spatial, chroma_spatial, luma_temporal, chroma_temporal = get_hqdn3d_strengths()
    local input_graph, input_error = get_hqdn3d_input_graph()
    if not input_graph then
        return nil, input_error
    end
    return string.format(
        "%s:lavfi=[%shqdn3d=%.2f:%.2f:%.2f:%.2f]",
        HQDN3D_FILTER_LABEL,
        input_graph,
        luma_spatial,
        chroma_spatial,
        luma_temporal,
        chroma_temporal
    )
end

local function get_video_filters()
    local filters = mp.get_property_native("vf")
    return type(filters) == "table" and filters or {}
end

local function filter_position(label)
    for index, filter in ipairs(get_video_filters()) do
        if type(filter) == "table" and filter.label == label then
            return index
        end
    end
    return nil
end

local function hqdn3d_filter_position()
    return filter_position(HQDN3D_FILTER_LABEL:sub(2))
end

local applied_hqdn3d_filter_spec = nil
local hqdn3d_order_check_pending = false

local function run_hqdn3d_vf(operation, value, report_error)
    local ok, err = pcall(mp.commandv, "vf", operation, value)
    if not ok and report_error then
        mp.osd_message("HQDN3D filter failed")
        mp.msg.error(string.format("HQDN3D filter %s failed: %s", operation, tostring(err)))
    end
    return ok
end

local function hqdn3d_needs_reorder(position)
    if not position then
        return false
    end
    local svp_position = filter_position(SVP_FILTER_LABEL)
    local vsr_position = filter_position(VSR_FILTER_LABEL)
    return svp_position and position > svp_position
        or vsr_position and position > vsr_position
end

local function apply_hqdn3d_filter()
    local position = hqdn3d_filter_position()
    if current_denoise_mode ~= "hqdn3d" then
        applied_hqdn3d_filter_spec = nil
        if position then
            run_hqdn3d_vf("remove", HQDN3D_FILTER_LABEL, true)
        end
        return
    end

    local desired_spec, spec_error = get_hqdn3d_filter_spec()
    if not desired_spec then
        applied_hqdn3d_filter_spec = nil
        if position then
            run_hqdn3d_vf("remove", HQDN3D_FILTER_LABEL, false)
        end
        current_denoise_mode = "off"
        publish_denoise_state()
        mp.osd_message("HQDN3D unavailable for this video format")
        mp.msg.error("HQDN3D unavailable: " .. tostring(spec_error))
        return
    end
    local needs_replace = not position or applied_hqdn3d_filter_spec ~= desired_spec
    if needs_replace or hqdn3d_needs_reorder(position) then
        if position then
            run_hqdn3d_vf("remove", HQDN3D_FILTER_LABEL, false)
        end
        if run_hqdn3d_vf("pre", desired_spec, true) then
            applied_hqdn3d_filter_spec = desired_spec
            mp.msg.info("HQDN3D filter applied before SVP/RTX processing: " .. desired_spec)
        end
    end
end

local function schedule_hqdn3d_order_check()
    if current_denoise_mode ~= "hqdn3d" or hqdn3d_order_check_pending then
        return
    end
    hqdn3d_order_check_pending = true
    mp.add_timeout(0, function()
        hqdn3d_order_check_pending = false
        apply_hqdn3d_filter()
    end)
end

local BM3DCUDA_SCRIPT_SUFFIX = ".streamee-bm3dcuda.py"
local bm3dcuda_original_svp_script = nil
local bm3dcuda_combined_svp_script = nil
local bm3dcuda_applied_signature = nil
local bm3dcuda_filter_update_in_progress = false
local bm3dcuda_filter_check_pending = false
local bm3dcuda_health_check_serial = 0
local bm3dcuda_health_timers = {}
local bm3dcuda_generated_scripts = {}
local bm3dcuda_failure_recovery_in_progress = false

local function is_bm3dcuda_mode(mode)
    return BM3DCUDA_MODES[mode] == true
end

local function get_bm3dcuda_sigma()
    if current_denoise_strength == "low" then
        return 1.5
    end
    if current_denoise_strength == "high" then
        return 5.0
    end
    return 3.0
end

local function get_bm3dcuda_profile_settings()
    return BM3DCUDA_PROFILES[current_bm3dcuda_profile] or BM3DCUDA_PROFILES.balanced
end

local function get_bm3dcuda_profile_python_args()
    local profile = get_bm3dcuda_profile_settings()
    return string.format(
        "block_step=%d, bm_range=%d, ps_num=%d, ps_range=%d",
        profile.block_step,
        profile.bm_range,
        profile.ps_num,
        profile.ps_range
    )
end

local function read_text_file(path)
    local file, open_error = io.open(path, "rb")
    if not file then
        return nil, open_error
    end
    local content = file:read("*a")
    file:close()
    return content
end

local function write_text_file(path, content)
    local file, open_error = io.open(path, "wb")
    if not file then
        return false, open_error
    end
    local ok, write_error = file:write(content)
    file:close()
    if not ok then
        return false, write_error
    end
    return true
end

local function remove_generated_bm3dcuda_script(path)
    path = path and tostring(path) or nil
    if not path or path:sub(-#BM3DCUDA_SCRIPT_SUFFIX) ~= BM3DCUDA_SCRIPT_SUFFIX then
        return
    end

    bm3dcuda_generated_scripts[path] = nil
    if not utils.file_info(path) then
        return
    end

    local removed, remove_error = os.remove(path)
    if removed then
        mp.msg.info("Removed generated BM3D CUDA script: " .. path)
    else
        mp.msg.warn("Could not remove generated BM3D CUDA script: " .. tostring(remove_error))
    end
end

local function remove_all_generated_bm3dcuda_scripts()
    local paths = {}
    for path in pairs(bm3dcuda_generated_scripts) do
        table.insert(paths, path)
    end
    for _, path in ipairs(paths) do
        remove_generated_bm3dcuda_script(path)
    end
end

local function python_string_literal(value)
    return string.format("%q", tostring(value))
end

local function build_bm3dcuda_python_block()
    local sigma = get_bm3dcuda_sigma()
    local profile_args = get_bm3dcuda_profile_python_args()
    local lines = {
        "",
        "# BEGIN STREAMEE BM3D CUDA",
        "if not hasattr(core, 'bm3dcuda'):",
        "    core.std.LoadPlugin(" .. python_string_literal(bm3dcuda_plugin_path) .. ")",
    }

    if current_denoise_mode == "bm3dcuda-color" then
        table.insert(lines, "_streamee_source_format = clip.format.id")
        table.insert(lines, "_streamee_work = clip.resize.Point(format=vs.YUV444PS)")
        table.insert(lines, string.format(
            "clip = core.bm3dcuda.BM3Dv2(_streamee_work, sigma=[%.2f, %.2f, %.2f], radius=0, chroma=True, device_id=0, %s, fast=True)",
            sigma,
            sigma,
            sigma,
            profile_args
        ))
        table.insert(lines, "clip = clip.resize.Point(format=_streamee_source_format)")
    else
        table.insert(lines, "_streamee_luma = clip.std.ShufflePlanes(0, vs.GRAY)")
        table.insert(lines, "_streamee_luma_format = _streamee_luma.format.id")
        table.insert(lines, "_streamee_work = _streamee_luma.resize.Point(format=vs.GRAYS)")

        if current_denoise_mode == "bm3dcuda-quality" then
            table.insert(lines, string.format(
                "_streamee_basic = core.bm3dcuda.BM3D(_streamee_work, sigma=[%.2f], radius=0, device_id=0, %s, fast=True)",
                sigma,
                profile_args
            ))
            table.insert(lines, string.format(
                "_streamee_denoised = core.bm3dcuda.BM3D(_streamee_work, ref=_streamee_basic, sigma=[%.2f], radius=0, device_id=0, %s, fast=True)",
                sigma,
                profile_args
            ))
        else
            local radius = current_denoise_mode == "bm3dcuda-temporal" and 1 or 0
            table.insert(lines, string.format(
                "_streamee_denoised = core.bm3dcuda.BM3Dv2(_streamee_work, sigma=[%.2f], radius=%d, device_id=0, %s, fast=True)",
                sigma,
                radius,
                profile_args
            ))
        end

        table.insert(lines, "_streamee_luma_out = _streamee_denoised.resize.Point(format=_streamee_luma_format)")
        table.insert(lines, "clip = core.std.ShufflePlanes([_streamee_luma_out, clip], [0, 1, 2], vs.YUV)")
    end

    table.insert(lines, "# END STREAMEE BM3D CUDA")
    table.insert(lines, "")
    return table.concat(lines, "\n")
end

local function build_combined_bm3dcuda_svp_script(source_path)
    local source, read_error = read_text_file(source_path)
    if not source then
        return nil, "could not read SVP script: " .. tostring(read_error)
    end

    local clip_start, clip_end = source:find("[\r\n]clip%s*=%s*[^\r\n]+")
    if not clip_start or not clip_end then
        return nil, "SVP script clip assignment was not found"
    end

    local combined_path = source_path .. BM3DCUDA_SCRIPT_SUFFIX
    local combined = source:sub(1, clip_end) .. "\n" .. build_bm3dcuda_python_block() .. source:sub(clip_end + 1)
    local wrote, write_error = write_text_file(combined_path, combined)
    if not wrote then
        return nil, "could not write combined SVP script: " .. tostring(write_error)
    end
    bm3dcuda_generated_scripts[combined_path] = true
    return combined_path
end

local function get_svp_filter()
    local filters = get_video_filters()
    for index, filter in ipairs(filters) do
        if type(filter) == "table" and filter.label == SVP_FILTER_LABEL and filter.name == "vapoursynth" then
            return filters, filter, index
        end
    end
    return filters, nil, nil
end

local function cancel_bm3dcuda_health_checks()
    bm3dcuda_health_check_serial = bm3dcuda_health_check_serial + 1
    for _, timer in ipairs(bm3dcuda_health_timers) do
        timer:kill()
    end
    bm3dcuda_health_timers = {}
end

local function replace_svp_script_path(path)
    local filters, filter, index = get_svp_filter()
    if not filter or not index or type(filter.params) ~= "table" then
        return false, "SVP VapourSynth filter is unavailable"
    end

    filter.params.file = path
    -- MPV marks a VapourSynth filter disabled after an asynchronous script
    -- failure. Re-enable it explicitly when restoring or replacing the script.
    filter.enabled = true
    filters[index] = filter
    bm3dcuda_filter_update_in_progress = true
    local ok, update_error = pcall(mp.set_property_native, "vf", filters)
    bm3dcuda_filter_update_in_progress = false
    if not ok then
        return false, update_error
    end
    return true
end

local function restore_original_svp_script()
    cancel_bm3dcuda_health_checks()
    local generated_path = bm3dcuda_combined_svp_script
    if not bm3dcuda_original_svp_script then
        bm3dcuda_applied_signature = nil
        bm3dcuda_combined_svp_script = nil
        local _, filter = get_svp_filter()
        local active_path = filter and filter.params and tostring(filter.params.file)
        if generated_path and active_path ~= generated_path then
            remove_generated_bm3dcuda_script(generated_path)
        end
        return true
    end

    local _, filter = get_svp_filter()
    local active_path = filter and filter.params and filter.params.file
    if active_path and active_path:sub(-#BM3DCUDA_SCRIPT_SUFFIX) == BM3DCUDA_SCRIPT_SUFFIX then
        local restored, restore_error = replace_svp_script_path(bm3dcuda_original_svp_script)
        if not restored then
            return false, restore_error
        end
        mp.msg.info("Restored original SVP VapourSynth script")
    end

    bm3dcuda_applied_signature = nil
    bm3dcuda_combined_svp_script = nil
    remove_generated_bm3dcuda_script(generated_path)
    return true
end

local function disable_bm3dcuda_after_error(reason)
    if bm3dcuda_failure_recovery_in_progress then
        return
    end
    bm3dcuda_failure_recovery_in_progress = true
    local restored, restore_error = restore_original_svp_script()
    current_denoise_mode = "off"
    season_override_denoise_mode = "off"
    publish_denoise_state()
    save_current_season_state()
    local detail = tostring(reason)
    if not restored then
        detail = detail .. "\nOriginal SVP restore failed: " .. tostring(restore_error)
    end
    mp.osd_message("BM3D CUDA unavailable\n" .. detail, 3.0)
    mp.msg.error("BM3D CUDA unavailable: " .. detail)
    bm3dcuda_failure_recovery_in_progress = false
end

local function handle_mpv_log_message(event)
    if not is_bm3dcuda_mode(current_denoise_mode) or bm3dcuda_failure_recovery_in_progress then
        return
    end

    local prefix = tostring(event and event.prefix or "")
    local message = tostring(event and event.text or "")
    if prefix == "vf" and message:find("Disabling filter svp because it has failed", 1, true) then
        disable_bm3dcuda_after_error("SVP/BM3D filter failed to initialize")
    end
end

local function schedule_bm3dcuda_health_check(expected_path)
    cancel_bm3dcuda_health_checks()
    local serial = bm3dcuda_health_check_serial

    for _, delay in ipairs({ 0.25, 1.50 }) do
        local timer = mp.add_timeout(delay, function()
            if serial ~= bm3dcuda_health_check_serial or not is_bm3dcuda_mode(current_denoise_mode) then
                return
            end

            local _, filter = get_svp_filter()
            local active_path = filter and filter.params and tostring(filter.params.file)
            if active_path ~= expected_path then
                -- SVP is replacing its generated script. The vf observer will
                -- integrate BM3D into the new script once that chain settles.
                return
            end
            if filter.enabled == false then
                disable_bm3dcuda_after_error("SVP/BM3D filter failed to initialize")
            end
        end)
        table.insert(bm3dcuda_health_timers, timer)
    end
end

local function apply_bm3dcuda_filter()
    if not is_bm3dcuda_mode(current_denoise_mode) then
        local restored, restore_error = restore_original_svp_script()
        if not restored then
            mp.msg.error("Could not restore original SVP script: " .. tostring(restore_error))
        end
        return
    end

    if not utils.file_info(bm3dcuda_plugin_path) then
        disable_bm3dcuda_after_error("plugin file is missing")
        return
    end

    local _, filter = get_svp_filter()
    if not filter or type(filter.params) ~= "table" or not filter.params.file then
        bm3dcuda_applied_signature = nil
        mp.osd_message("BM3D CUDA waiting for SVP", 2.0)
        mp.msg.info("BM3D CUDA is waiting for the SVP VapourSynth filter")
        return
    end

    local active_path = tostring(filter.params.file)
    if filter.enabled == false then
        disable_bm3dcuda_after_error("SVP VapourSynth filter is disabled")
        return
    end
    if active_path:sub(-#BM3DCUDA_SCRIPT_SUFFIX) ~= BM3DCUDA_SCRIPT_SUFFIX then
        bm3dcuda_original_svp_script = active_path
    elseif not bm3dcuda_original_svp_script then
        local candidate = active_path:sub(1, #active_path - #BM3DCUDA_SCRIPT_SUFFIX)
        if utils.file_info(candidate) then
            bm3dcuda_original_svp_script = candidate
        end
    end

    if not bm3dcuda_original_svp_script then
        disable_bm3dcuda_after_error("original SVP script path is unavailable")
        return
    end

    local signature = table.concat({
        current_denoise_mode,
        current_denoise_strength,
        current_bm3dcuda_profile,
        bm3dcuda_original_svp_script,
    }, "|")
    if bm3dcuda_applied_signature == signature and active_path == bm3dcuda_combined_svp_script then
        return
    end

    local combined_path, build_error = build_combined_bm3dcuda_svp_script(bm3dcuda_original_svp_script)
    if not combined_path then
        disable_bm3dcuda_after_error(build_error)
        return
    end

    local replaced, replace_error = replace_svp_script_path(combined_path)
    if not replaced then
        remove_generated_bm3dcuda_script(combined_path)
        disable_bm3dcuda_after_error(replace_error)
        return
    end

    local previous_combined_path = bm3dcuda_combined_svp_script
    bm3dcuda_combined_svp_script = combined_path
    bm3dcuda_applied_signature = signature
    if previous_combined_path and previous_combined_path ~= combined_path then
        remove_generated_bm3dcuda_script(previous_combined_path)
    end
    schedule_bm3dcuda_health_check(combined_path)
    mp.msg.info(string.format(
        "BM3D CUDA integrated into SVP: mode=%s strength=%s profile=%s sigma=%.2f",
        current_denoise_mode,
        current_denoise_strength,
        current_bm3dcuda_profile,
        get_bm3dcuda_sigma()
    ))
    if is_source_4k() and current_denoise_mode ~= "bm3dcuda-luma" then
        mp.osd_message("BM3D CUDA enabled\nExperimental 4K mode may not run in real time", 3.0)
    end
end

local function schedule_bm3dcuda_filter_check()
    if bm3dcuda_filter_update_in_progress or bm3dcuda_filter_check_pending then
        return
    end
    if not is_bm3dcuda_mode(current_denoise_mode) and not bm3dcuda_combined_svp_script then
        return
    end
    bm3dcuda_filter_check_pending = true
    mp.add_timeout(0.05, function()
        bm3dcuda_filter_check_pending = false
        apply_bm3dcuda_filter()
    end)
end

local function show_denoiser_osd()
    mp.osd_message(denoise_summary(), 2.0)
    mp.msg.info(denoise_summary())
end

local reapply_current_mode

local function set_denoise_mode(mode)
    current_denoise_mode = mode
    publish_denoise_state()
    season_override_denoise_mode = current_denoise_mode
    season_override_denoise_strength = current_denoise_strength
    season_override_bm3dcuda_profile = current_bm3dcuda_profile
    reapply_current_mode()
    save_current_season_state()
    show_denoiser_osd()
end

local function set_denoise_strength(strength)
    current_denoise_strength = strength
    publish_denoise_state()
    season_override_denoise_mode = current_denoise_mode
    season_override_denoise_strength = current_denoise_strength
    season_override_bm3dcuda_profile = current_bm3dcuda_profile
    reapply_current_mode()
    save_current_season_state()
    show_denoiser_osd()
end

local function set_bm3dcuda_profile(profile)
    current_bm3dcuda_profile = normalized_bm3dcuda_profile(profile)
    publish_denoise_state()
    season_override_denoise_mode = current_denoise_mode
    season_override_denoise_strength = current_denoise_strength
    season_override_bm3dcuda_profile = current_bm3dcuda_profile
    if is_bm3dcuda_mode(current_denoise_mode) then
        reapply_current_mode()
    end
    save_current_season_state()
    mp.osd_message("BM3D Processing Profile: " .. bm3dcuda_profile_label(current_bm3dcuda_profile), 2.0)
    mp.msg.info("BM3D Processing Profile: " .. bm3dcuda_profile_label(current_bm3dcuda_profile))
end

local function cycle_denoise_mode()
    local current_index = 1
    for index, mode in ipairs(DENOISE_MODE_ORDER) do
        if mode == current_denoise_mode then
            current_index = index
            break
        end
    end

    local next_index = current_index + 1
    if next_index > #DENOISE_MODE_ORDER then
        next_index = 1
    end

    set_denoise_mode(DENOISE_MODE_ORDER[next_index])
end

local function apply_shader_opts()
    local option_parts = {
        string.format("denoise_strength=%.2f", get_denoise_strength_value()),
    }
    if current_mode ~= "off" then
        table.insert(option_parts, string.format("strength_bias=%.3f", shader_settings.strength_bias))
        if current_mode ~= "ultra" then
            table.insert(option_parts, string.format("detail_radius=%.3f", shader_settings.detail_radius))
        end
        table.insert(option_parts, string.format("edge_sensitivity=%.3f", shader_settings.edge_sensitivity))
        table.insert(option_parts, string.format("noise_protection=%.3f", shader_settings.noise_protection))
        table.insert(option_parts, string.format("halo_control=%.3f", shader_settings.halo_control))
    end
    local option_string = table.concat(option_parts, ",")

    mp.set_property("glsl-shader-opts", option_string)
    mp.msg.info("Sharpener shader options: " .. option_string)
end

local function sync_shader_settings_from_disk()
    local file = io.open(settings_path, "r")
    if not file then
        return false
    end

    local content = file:read("*a")
    file:close()
    if not content or content == "" then
        return false
    end
    content = content:gsub("^\239\187\191", "")

    local data = utils.parse_json(content)
    if type(data) ~= "table" then
        return false
    end

    local updated = normalized_preset_settings(data)
    if preset_settings_equal(updated, preset_settings) then
        return false
    end

    preset_settings = updated
    local preset_key = preset_key_for_mode(current_mode)
    if preset_settings[preset_key] then
        shader_settings = preset_settings[preset_key]
    end
    apply_shader_opts()
    return true
end

local function get_current_shaders()
    local shaders = mp.get_property_native("glsl-shaders")
    if type(shaders) == "table" then
        return shaders
    end
    if type(shaders) == "string" and shaders ~= "" then
        return { shaders }
    end
    return {}
end

local function has_shader(path)
    local shaders = get_current_shaders()
    local norm_path = path:gsub("/", "\\"):lower()
    for _, shader in ipairs(shaders) do
        local norm_shader = tostring(shader):gsub("/", "\\"):lower()
        if norm_shader == norm_path or norm_shader:find(norm_path, 1, true) ~= nil then
            return true
        end
    end
    return false
end

local function is_streamee_managed_shader(shader)
    local norm_shader = tostring(shader):gsub("/", "\\"):lower()
    return norm_shader:find("bilateral_denoise.glsl", 1, true) ~= nil
        or norm_shader:find("standard_sharpen.glsl", 1, true) ~= nil
        or norm_shader:find("adaptive_sharpen.glsl", 1, true) ~= nil
        or norm_shader:find("ultra_sharpen.glsl", 1, true) ~= nil
        or norm_shader:find("ultra_legacy_sharpen.glsl", 1, true) ~= nil
end

local function get_active_mode()
    if has_shader("ultra_legacy_sharpen") then
        return "ultra"
    end
    if has_shader("ultra_sharpen") then
        return "ultra-custom"
    end
    if has_shader("adaptive_sharpen") then
        return "adaptive"
    end
    if has_shader("standard_sharpen") then
        return "standard"
    end
    return "off"
end

local function set_shaders(paths, mode_name, mode_key)
    apply_hqdn3d_filter()
    -- The BM3D state observer can make the VSR script reorder the vf chain.
    -- Defer the SVP script swap so it reads that settled chain instead of
    -- writing back a stale snapshot that can accidentally remove RTX VSR.
    schedule_bm3dcuda_filter_check()
    local preserved = {}
    for _, shader in ipairs(get_current_shaders()) do
        if not is_streamee_managed_shader(shader) then
            table.insert(preserved, shader)
        end
    end

    local combined = {}
    for _, shader in ipairs(preserved) do
        table.insert(combined, shader)
    end

    local denoise_shader = get_denoise_shader_path()
    if denoise_shader then
        local info = utils.file_info(denoise_shader)
        if not info then
            mp.osd_message("Denoiser: missing shader file")
            mp.msg.error("Missing denoiser shader file: " .. denoise_shader)
            return
        end
        table.insert(combined, denoise_shader)
    end

    for _, path in ipairs(paths) do
        local info = utils.file_info(path)
        if not info then
            mp.osd_message("Sharpener: missing shader file")
            mp.msg.error("Missing shader file: " .. path)
            return
        end
        table.insert(combined, path)
    end

    current_mode = mode_key or "off"
    local preset_key = preset_key_for_mode(current_mode)
    if preset_settings[preset_key] then
        shader_settings = preset_settings[preset_key]
    end
    publish_sharpen_state()
    apply_shader_opts()
    mp.set_property_native("glsl-shaders", combined)
    local applied = mp.get_property_native("glsl-shaders")
    local source_resolution, resolution_profile = get_resolution_profile()
    mp.msg.info("Sharpener applied shaders: " .. utils.format_json(applied))
    mp.osd_message(
        "Sharpener: " .. mode_name ..
        "\nProfile: " .. resolution_profile .. " (" .. source_resolution .. ")" ..
        "\n" .. shader_settings_summary() ..
        "\n" .. denoise_summary(),
        2.5
    )
    mp.msg.info(
        "Sharpener: " .. mode_name ..
        " | Profile: " .. resolution_profile ..
        " | Source: " .. source_resolution ..
        " | " .. shader_settings_summary() ..
        " | " .. denoise_summary()
    )
end

local function remember_sharpen_override(remember_override)
    if remember_override ~= false then
        season_override_mode = current_mode
        save_current_season_state()
    end
end

local function set_sharpen_off(remember_override)
    set_shaders({}, "Off", "off")
    remember_sharpen_override(remember_override)
end

local function set_sharpen_standard(remember_override)
    set_shaders({ standard_path }, "Standard", "standard")
    remember_sharpen_override(remember_override)
end

local function set_sharpen_adaptive(remember_override)
    set_shaders({ adaptive_path }, "Adaptive", "adaptive")
    remember_sharpen_override(remember_override)
end

local function set_sharpen_ultra(remember_override)
    set_shaders({ ultra_path }, "Ultra", "ultra")
    remember_sharpen_override(remember_override)
end

local function set_sharpen_ultra_custom(remember_override)
    set_shaders({ ultra_custom_path }, "UltraCustom", "ultra-custom")
    remember_sharpen_override(remember_override)
end

local function cycle_sharpen()
    if has_shader("adaptive_sharpen") then
        set_sharpen_ultra()
    elseif has_shader("ultra_legacy_sharpen") then
        set_sharpen_ultra_custom()
    elseif has_shader("ultra_sharpen") then
        set_sharpen_off()
    elseif has_shader("standard_sharpen") then
        set_sharpen_adaptive()
    else
        set_sharpen_standard()
    end
end

reapply_current_mode = function()
    local mode = get_active_mode()
    if mode == "standard" then
        set_sharpen_standard(false)
    elseif mode == "adaptive" then
        set_sharpen_adaptive(false)
    elseif mode == "ultra" then
        set_sharpen_ultra(false)
    elseif mode == "ultra-custom" then
        set_sharpen_ultra_custom(false)
    else
        set_sharpen_off(false)
    end
end

local options_process_active = false
local options_refresh_timer = nil

local function open_sharpener_options()
    if not utils.file_info(helper_script_path) then
        mp.osd_message("Sharpener options helper missing")
        mp.msg.error("Missing helper script: " .. helper_script_path)
        return
    end

    if options_process_active then
        mp.osd_message("Sharpener options are already open")
        return
    end

    local source_resolution, resolution_profile = get_resolution_profile()
    options_process_active = true
    options_refresh_timer = mp.add_periodic_timer(0.10, sync_shader_settings_from_disk)

    mp.command_native_async({
        name = "subprocess",
        playback_only = false,
        capture_stdout = true,
        args = {
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            helper_script_path,
            "-ConfigPath",
            settings_path,
            "-CurrentMode",
            preset_key_for_mode(get_active_mode()),
            "-CurrentProfile",
            resolution_profile,
            "-SourceResolution",
            source_resolution,
        },
    }, function(success, result, error_message)
        if options_refresh_timer then
            options_refresh_timer:kill()
            options_refresh_timer = nil
        end
        options_process_active = false
        sync_shader_settings_from_disk()

        if not success or not result or result.status ~= 0 then
            local message = error_message or (result and result.error_string) or "unknown error"
            mp.osd_message("Sharpener options failed to open")
            mp.msg.error("Sharpener options failed: " .. tostring(message))
            return
        end

        mp.osd_message("Sharpener settings applied\n" .. shader_settings_summary(), 2.0)
    end)
end

local function set_denoise_off()
    set_denoise_mode("off")
end

local function set_denoise_bilateral()
    set_denoise_mode("bilateral")
end

local function toggle_denoise_hqdn3d()
    if current_denoise_mode == "hqdn3d" then
        set_denoise_mode("off")
    else
        set_denoise_mode("hqdn3d")
    end
end

local function set_denoise_bm3dcuda_luma()
    set_denoise_mode("bm3dcuda-luma")
end

local function set_denoise_bm3dcuda_color()
    set_denoise_mode("bm3dcuda-color")
end

local function set_denoise_bm3dcuda_temporal()
    set_denoise_mode("bm3dcuda-temporal")
end

local function set_denoise_bm3dcuda_quality()
    set_denoise_mode("bm3dcuda-quality")
end

local function set_denoise_strength_low()
    set_denoise_strength("low")
end

local function set_denoise_strength_medium()
    set_denoise_strength("medium")
end

local function set_denoise_strength_high()
    set_denoise_strength("high")
end

local function set_bm3dcuda_profile_realtime()
    set_bm3dcuda_profile("realtime")
end

local function set_bm3dcuda_profile_balanced()
    set_bm3dcuda_profile("balanced")
end

local function set_bm3dcuda_profile_maximum()
    set_bm3dcuda_profile("maximum")
end

local function apply_startup_default()
    if not startup_default_pending then
        return
    end

    if startup_scope_pending then
        if not mp.get_property("path") then
            return
        end
        prepare_season_state_for_current_file()
        startup_scope_pending = false
    end

    local default_mode = season_override_mode or tostring(o.default_mode):lower()
    if default_mode == "off" then
        startup_default_pending = false
        set_sharpen_off(false)
        return
    end

    local width, height = get_source_dimensions()
    if not width or not height then
        return
    end

    if default_mode == "standard" then
        startup_default_pending = false
        set_sharpen_standard(false)
        return
    end

    if default_mode == "adaptive" then
        startup_default_pending = false
        set_sharpen_adaptive(false)
        return
    end

    if default_mode == "ultra" then
        startup_default_pending = false
        set_sharpen_ultra(false)
        return
    end

    if default_mode == "ultra-custom" or default_mode == "ultracustom" then
        startup_default_pending = false
        set_sharpen_ultra_custom(false)
        return
    end

    startup_default_pending = false
    if is_source_4k() then
        set_sharpen_ultra(false)
    else
        set_sharpen_standard(false)
    end
end

-- Register script messages for menu items and keybinds
mp.register_script_message("sharpen-off", set_sharpen_off)
mp.register_script_message("sharpen-standard", set_sharpen_standard)
mp.register_script_message("sharpen-adaptive", set_sharpen_adaptive)
mp.register_script_message("sharpen-ultra", set_sharpen_ultra)
mp.register_script_message("sharpen-ultra-custom", set_sharpen_ultra_custom)
mp.register_script_message("sharpen-cycle", cycle_sharpen)
mp.register_script_message("sharpen-open-options", open_sharpener_options)
mp.register_script_message("denoise-off", set_denoise_off)
mp.register_script_message("denoise-bilateral", set_denoise_bilateral)
mp.register_script_message("denoise-hqdn3d-toggle", toggle_denoise_hqdn3d)
mp.register_script_message("denoise-bm3dcuda-luma", set_denoise_bm3dcuda_luma)
mp.register_script_message("denoise-bm3dcuda-color", set_denoise_bm3dcuda_color)
mp.register_script_message("denoise-bm3dcuda-temporal", set_denoise_bm3dcuda_temporal)
mp.register_script_message("denoise-bm3dcuda-quality", set_denoise_bm3dcuda_quality)
mp.register_script_message("denoise-strength-low", set_denoise_strength_low)
mp.register_script_message("denoise-strength-medium", set_denoise_strength_medium)
mp.register_script_message("denoise-strength-high", set_denoise_strength_high)
mp.register_script_message("bm3dcuda-profile-realtime", set_bm3dcuda_profile_realtime)
mp.register_script_message("bm3dcuda-profile-balanced", set_bm3dcuda_profile_balanced)
mp.register_script_message("bm3dcuda-profile-maximum", set_bm3dcuda_profile_maximum)
mp.register_script_message("denoise-cycle", cycle_denoise_mode)

-- Make the startup default depend on the selected upscaler path.
load_shader_settings()
mp.register_event("file-loaded", function()
    startup_default_pending = true
    startup_scope_pending = true
    apply_startup_default()
end)
mp.observe_property("video-params", "native", apply_startup_default)
mp.observe_property("vf", "native", schedule_hqdn3d_order_check)
mp.observe_property("vf", "native", schedule_bm3dcuda_filter_check)
mp.enable_messages("warn")
mp.register_event("log-message", handle_mpv_log_message)
mp.register_event("shutdown", remove_all_generated_bm3dcuda_scripts)
apply_startup_default()
