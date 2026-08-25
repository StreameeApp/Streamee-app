local mp = require("mp")
local options = require("mp.options")

local o = {
    enabled = false,
    rtx_hdr = false,
    hdr_contrast_boost = false,
    before_svp = true,
    max_width = 2560,
    max_height = 1440,
}

options.read_options(o, "streamee_vsr")

local FILTER_LABEL = "@streamee-vsr"
local SVP_FILTER_LABEL = "svp"
local last_mode = nil
local order_check_pending = false

local function option_enabled(value)
    return value == true or value == "yes" or value == "true" or value == "1"
end

local vsr_available = option_enabled(o.enabled)
local vsr_enabled = vsr_available
local rtx_hdr_enabled = option_enabled(o.rtx_hdr)
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
    local target = rtx_hdr_enabled and windows_hdr_enabled and 15 or base_contrast
    if mp.get_property_number("contrast", base_contrast) ~= target then
        mp.set_property_number("contrast", target)
    end
end

local function bm3dcuda_enabled()
    return mp.get_property_number("user-data/streamee-bm3dcuda-enabled", 0) == 1
end

local function should_run_before_svp()
    return option_enabled(o.before_svp) and not bm3dcuda_enabled()
end

local function source_dimensions()
    local params = mp.get_property_native("video-params")
    if type(params) ~= "table" then
        return nil, nil
    end

    return tonumber(params.w), tonumber(params.h)
end

local function desired_mode()
    local width, height = source_dimensions()
    if not width or not height then
        return nil, nil, nil
    end

    local long_edge = math.max(width, height)
    local short_edge = math.min(width, height)
    if vsr_enabled
        and long_edge <= tonumber(o.max_width)
        and short_edge <= tonumber(o.max_height) then
        return "vsr", width, height
    end

    if rtx_hdr_enabled then
        return "hdr", width, height
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

local function filter_is_present()
    local filters = mp.get_property_native("vf")
    if type(filters) ~= "table" then
        return false
    end

    for _, filter in ipairs(filters) do
        if type(filter) == "table"
            and (filter.label == FILTER_LABEL or filter.label == FILTER_LABEL:sub(2)) then
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
    local filter = FILTER_LABEL .. ":d3d11vpp=scale=2:format=nv12:scaling-mode=nvidia"
    if rtx_hdr_enabled then
        filter = filter .. ":nvidia-true-hdr"
    end
    return filter
end

local function enforce_vsr_order()
    order_check_pending = false
    if last_mode ~= "vsr" then
        return
    end

    local vsr_position = filter_position(FILTER_LABEL:sub(2))
    local svp_position = filter_position(SVP_FILTER_LABEL)
    if not vsr_position or not svp_position then
        return
    end

    local before_svp = should_run_before_svp()
    local correctly_ordered = before_svp and vsr_position < svp_position
        or not before_svp and vsr_position > svp_position
    if correctly_ordered then
        return
    end

    run_vf("remove", FILTER_LABEL, false)
    run_vf(before_svp and "pre" or "add", vsr_filter(), true)
    mp.msg.info("RTX VSR filter moved " .. (before_svp and "before" or "after") .. " SVP")
end

local function schedule_order_check()
    if order_check_pending then
        return
    end

    order_check_pending = true
    mp.add_timeout(0, enforce_vsr_order)
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
    if filter_is_present() then
        run_vf("remove", FILTER_LABEL, false)
    end

    if mode == "vsr" then
        local before_svp = should_run_before_svp()
        run_vf(before_svp and "pre" or "add", vsr_filter(), true)
        mp.msg.info(string.format(
            "RTX VSR 2x enabled for %dx%d source (%s SVP)",
            width,
            height,
            before_svp and "before" or "after"
        ))
        schedule_order_check()
    elseif mode == "hdr" then
        run_vf("add", FILTER_LABEL .. ":d3d11vpp=format=nv12:nvidia-true-hdr", true)
        mp.msg.info(string.format("RTX VSR bypassed for %dx%d source; RTX HDR retained", width, height))
    else
        mp.msg.info(string.format("RTX VSR bypassed for %dx%d source", width, height))
    end
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
