local mp = require("mp")
local options = require("mp.options")

local o = {
    enabled = false,
    rtx_hdr = false,
    hdr_contrast_boost = false,
    before_svp = true,
    rife_before_upscaling = true,
    max_width = 2560,
    max_height = 1440,
}

options.read_options(o, "streamee_vsr")

local FILTER_LABEL = "@streamee-vsr"
local HDR_FILTER_LABEL = "@streamee-rtx-hdr"
local SVP_FILTER_LABEL = "svp"
local RIFE_FILTER_LABEL = "streamee-rife"
local last_mode = nil
local order_check_pending = false

local function option_enabled(value)
    return value == true or value == "yes" or value == "true" or value == "1"
end

local vsr_available = option_enabled(o.enabled)
local vsr_enabled = vsr_available
local rtx_hdr_enabled = option_enabled(o.rtx_hdr)
local rtx_hdr_active = false
local base_contrast = mp.get_property_number("contrast", 0)

local function publish_menu_state()
    mp.set_property_number("user-data/streamee-vsr-available", vsr_available and 1 or 0)
    mp.set_property_number("user-data/streamee-vsr-enabled", vsr_enabled and 1 or 0)
    mp.set_property_number("user-data/streamee-rtx-hdr-enabled", rtx_hdr_enabled and 1 or 0)
    mp.set_property_number(
        "user-data/streamee-hdr-contrast-boost-enabled",
        option_enabled(o.hdr_contrast_boost) and 1 or 0
    )
end

local function apply_hdr_contrast()
    if not option_enabled(o.hdr_contrast_boost) then
        return
    end

    local windows_hdr_enabled =
        mp.get_property_native("user-data/streamee-hdr-state", "off") == "on"
    local target = rtx_hdr_active and windows_hdr_enabled and 15 or base_contrast
    if mp.get_property_number("contrast", base_contrast) ~= target then
        mp.set_property_number("contrast", target)
    end
end

local function bm3dcuda_enabled()
    return mp.get_property_number("user-data/streamee-bm3dcuda-enabled", 0) == 1
end

local function source_video_params()
    local params = mp.get_property_native("video-params")
    if type(params) ~= "table" then
        return nil, nil, false
    end

    local transfer = tostring(params.gamma or params.transfer or ""):lower()
    local native_hdr = transfer == "pq" or transfer == "hlg"
    return tonumber(params.w), tonumber(params.h), native_hdr
end

local function desired_mode()
    local width, height, native_hdr = source_video_params()
    if not width or not height then
        return nil, nil, nil
    end

    local long_edge = math.max(width, height)
    local short_edge = math.min(width, height)
    if vsr_enabled
        and long_edge <= tonumber(o.max_width)
        and short_edge <= tonumber(o.max_height) then
        return native_hdr and "vsr-native-hdr" or "vsr", width, height
    end

    if rtx_hdr_enabled and not native_hdr then
        return "hdr", width, height
    end

    if native_hdr then
        return "native-hdr", width, height
    end

    return "off", width, height
end

local function run_vf(operation, value, report_error)
    local ok, err = pcall(mp.commandv, "vf", operation, value)
    if not ok and report_error then
        mp.msg.error(string.format("RTX VSR filter %s failed: %s", operation, tostring(err)))
    end
    return ok
end

local function filter_is_present(label)
    local filters = mp.get_property_native("vf")
    if type(filters) ~= "table" then
        return false
    end

    for _, filter in ipairs(filters) do
        if type(filter) == "table"
            and (filter.label == label or filter.label == label:sub(2)) then
            return true
        end
    end

    return false
end

local function filter_position(label)
    local filters = mp.get_property_native("vf")
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

local function vsr_filter()
    return FILTER_LABEL .. ":d3d11vpp=scale=2:format=nv12:scaling-mode=nvidia"
end

local function hdr_filter()
    return HDR_FILTER_LABEL .. ":d3d11vpp=format=nv12:nvidia-true-hdr"
end

local function frame_generation_target()
    if filter_position(RIFE_FILTER_LABEL) then
        return RIFE_FILTER_LABEL, "RIFE"
    end
    if filter_position(SVP_FILTER_LABEL) then
        return SVP_FILTER_LABEL, "SVP"
    end
    return nil, nil
end

local function vsr_before_frame_generation(target_label)
    if target_label == RIFE_FILTER_LABEL then
        return not option_enabled(o.rife_before_upscaling)
    end
    return option_enabled(o.before_svp) and not bm3dcuda_enabled()
end

local function enforce_filter_order()
    order_check_pending = false
    if last_mode == "off" or not last_mode then
        return
    end

    local vsr_position = filter_position(FILTER_LABEL:sub(2))
    local target_label, target_name = frame_generation_target()
    local target_position = target_label and filter_position(target_label) or nil
    if last_mode:find("^vsr") and vsr_position and target_position then
        local before_target = vsr_before_frame_generation(target_label)
        local correctly_ordered = before_target and vsr_position < target_position
            or not before_target and vsr_position > target_position
        if not correctly_ordered then
            run_vf("remove", FILTER_LABEL, false)
            run_vf(before_target and "pre" or "add", vsr_filter(), true)
            mp.msg.info("RTX VSR filter moved " .. (before_target and "before " or "after ") .. target_name)
        end
    end

    local hdr_position = filter_position(HDR_FILTER_LABEL:sub(2))
    if rtx_hdr_enabled and hdr_position then
        vsr_position = filter_position(FILTER_LABEL:sub(2))
        target_position = target_label and filter_position(target_label) or nil
        if (vsr_position and hdr_position < vsr_position)
            or (target_position and hdr_position < target_position) then
            run_vf("remove", HDR_FILTER_LABEL, false)
            run_vf("add", hdr_filter(), true)
            mp.msg.info("RTX Video HDR filter moved after frame generation and upscaling")
        end
    end
end

local function schedule_order_check()
    if order_check_pending then
        return
    end

    order_check_pending = true
    mp.add_timeout(0, enforce_filter_order)
end

local function apply_for_source()
    if not vsr_available then
        return
    end

    local mode, width, height = desired_mode()
    if not mode or mode == last_mode then
        return
    end

    last_mode = mode
    if filter_is_present(FILTER_LABEL) then
        run_vf("remove", FILTER_LABEL, false)
    end
    if filter_is_present(HDR_FILTER_LABEL) then
        run_vf("remove", HDR_FILTER_LABEL, false)
    end
    rtx_hdr_active = false

    if mode == "vsr" or mode == "vsr-native-hdr" then
        local target_label, target_name = frame_generation_target()
        local before_target = vsr_before_frame_generation(target_label)
        run_vf(before_target and "pre" or "add", vsr_filter(), true)
        mp.msg.info(string.format(
            "RTX VSR 2x enabled for %dx%d source (%s%s)",
            width,
            height,
            before_target and "before " or "after ",
            target_name or "frame-generation slot"
        ))
    elseif mode == "hdr" then
        mp.msg.info(string.format("RTX VSR bypassed for %dx%d source; RTX HDR retained", width, height))
    elseif mode == "native-hdr" then
        mp.msg.info(string.format(
            "RTX VSR bypassed for %dx%d native HDR source; RTX Video HDR bypassed",
            width,
            height
        ))
    else
        mp.msg.info(string.format("RTX VSR bypassed for %dx%d source", width, height))
    end

    if rtx_hdr_enabled and (mode == "vsr" or mode == "hdr") then
        rtx_hdr_active = run_vf("add", hdr_filter(), true)
    end
    apply_hdr_contrast()
    schedule_order_check()
end

local function reapply_for_source()
    last_mode = nil
    apply_for_source()
end

local function toggle_vsr()
    if not vsr_available then
        mp.osd_message("RTX VSR is not the selected upscaler", 2.0)
        return
    end

    vsr_enabled = not vsr_enabled
    publish_menu_state()
    reapply_for_source()
    mp.osd_message("RTX VSR: " .. (vsr_enabled and "On" or "Off"), 2.0)
end

local function toggle_rtx_hdr()
    if not vsr_available then
        mp.osd_message("RTX Video HDR requires the RTX VSR upscaler", 2.0)
        return
    end

    rtx_hdr_enabled = not rtx_hdr_enabled
    publish_menu_state()
    reapply_for_source()
    apply_hdr_contrast()
    mp.osd_message("RTX Video HDR: " .. (rtx_hdr_enabled and "On" or "Off"), 2.0)
end

publish_menu_state()
mp.register_script_message("toggle-vsr", toggle_vsr)
mp.register_script_message("toggle-hdr", toggle_rtx_hdr)

mp.register_event("file-loaded", function()
    last_mode = nil
    apply_for_source()
end)

mp.observe_property("video-params", "native", apply_for_source)
mp.observe_property("vf", "native", schedule_order_check)
mp.observe_property("user-data/streamee-bm3dcuda-enabled", "number", schedule_order_check)
mp.observe_property("user-data/streamee-hdr-state", "native", apply_hdr_contrast)
