-- Persistent cache-only lookahead probe for streamee_smart_ultrawide_fill.lua.
-- This helper runs in a second, hidden MPV process and emits only stable
-- top/bottom crop transitions with their first observed playback timestamp.

local mp = require "mp"
local msg = require "mp.msg"
local options = require "mp.options"
local utils = require "mp.utils"

local opts = {
    result_path = "",
    control_path = "",
    generation = "",
    probe_width = 480,
    probe_fps = 6,
    limit = 0.08,
    round = 2,
    reset_count = 6,
    poll_interval = 0.05,
    stable_time = 0.90,
    boundary_quantum = 4,
    crop_tolerance = 12,
    scene_threshold = 8.0,
    scene_gate_window = 0.75,
    min_bar_fraction = 0.03,
    max_total_crop_fraction = 0.35,
    symmetry_tolerance_fraction = 0.02,
    min_content_aspect = 1.8,
    min_pillarbox_content_aspect = 1.2,
    max_pillarbox_content_aspect = 1.85,
}

options.read_options(opts, "streamee_smart_ultrawide_fill_probe")

local FILTER_LABEL = "streamee_adaptive_crop_probe_detector"
local FILTER_METADATA = "vf-metadata/" .. FILTER_LABEL
local candidate_key = nil
local candidate_since = nil
local candidate_first_pts = nil
local candidate_scene_pts = nil
local emitted_candidate = nil
local sequence = 0
local ready = false
local last_scene_pts = nil

local function read_text(path)
    local file = io.open(path, "r")
    if not file then
        return nil
    end
    local value = file:read("*a")
    file:close()
    return value and value:gsub("%s+$", "") or nil
end

local function control_is_current()
    return opts.control_path ~= ""
        and opts.generation ~= ""
        and read_text(opts.control_path) == opts.generation
end

local function write_event(kind, crop, effective_pts)
    if opts.result_path == "" then
        return false
    end

    sequence = sequence + 1
    local payload = utils.format_json({
        generation = opts.generation,
        sequence = sequence,
        kind = kind,
        crop = crop,
        effective_pts = effective_pts,
        helper_pts = mp.get_property_number("time-pos", effective_pts),
    })
    local file = io.open(opts.result_path, "w")
    if not file then
        return false
    end
    file:write(payload)
    file:write("\n")
    file:close()
    msg.info(string.format(
        "Probe %s: crop=%s effective_pts=%.3f",
        kind,
        crop,
        effective_pts
    ))
    return true
end

local function metadata_number(metadata, key)
    if type(metadata) ~= "table" then
        return nil
    end
    return tonumber(metadata[key])
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
    if not lw or not rw then
        return false
    end
    local tolerance = math.max(0, tonumber(opts.crop_tolerance) or 0)
    return math.abs(lw - rw) <= tolerance * 2
        and math.abs(lh - rh) <= tolerance * 2
        and math.abs(lx - rx) <= tolerance
        and math.abs(ly - ry) <= tolerance
end

local function observe_scene_metadata(_, metadata)
    local score = metadata_number(metadata, "lavfi.scd.score")
    if not score or score < opts.scene_threshold then
        return
    end
    last_scene_pts = metadata_number(metadata, "lavfi.scd.time")
        or mp.get_property_number("time-pos")
    msg.info(string.format(
        "Probe scene boundary: score=%.3f pts=%.3f",
        score,
        last_scene_pts or -1
    ))
end

local function observe_scene_time(_, value)
    local scene_pts = tonumber(value)
    if scene_pts and scene_pts ~= last_scene_pts then
        last_scene_pts = scene_pts
        msg.info(string.format("Probe scene boundary: pts=%.3f", scene_pts))
    end
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
    local source_width = mp.get_property_number("video-params/w")
    local source_height = mp.get_property_number("video-params/h")
    local detector_height = mp.get_property_number("video-out-params/h")
    local detector_width = mp.get_property_number("video-out-params/w")
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

    local top = math.max(0, y)
    local bottom = math.max(0, detector_height - (y + height))
    local left = math.max(0, x)
    local right = math.max(0, detector_width - (x + width))
    local vertical_symmetry_tolerance = math.max(
        4,
        detector_height * opts.symmetry_tolerance_fraction
    )
    local vertical_crop = top + bottom
    local has_vertical_bars = vertical_crop >= detector_height * opts.min_bar_fraction * 2
    if has_vertical_bars
        and (math.abs(top - bottom) > vertical_symmetry_tolerance
            or vertical_crop > detector_height * opts.max_total_crop_fraction) then
        return nil
    end

    local horizontal_symmetry_tolerance = math.max(
        4,
        detector_width * opts.symmetry_tolerance_fraction
    )
    local horizontal_crop = left + right
    local has_horizontal_bars = horizontal_crop >= detector_width * opts.min_bar_fraction * 2
    if has_horizontal_bars
        and (math.abs(left - right) > horizontal_symmetry_tolerance
            or horizontal_crop > detector_width * opts.max_total_crop_fraction) then
        return nil
    end
    if not has_vertical_bars and not has_horizontal_bars then
        return "none"
    end

    local quantum = math.max(1, math.floor(opts.boundary_quantum))
    local source_bar_y = 0
    if has_vertical_bars then
        local source_top = math.floor((top / detector_height) * source_height + 0.5)
        local source_bottom = math.floor((bottom / detector_height) * source_height + 0.5)
        source_bar_y = math.floor(
            (((source_top + source_bottom) / 2) / quantum) + 0.5
        ) * quantum
    end
    local source_bar_x = 0
    if has_horizontal_bars then
        local source_left = math.floor((left / detector_width) * source_width + 0.5)
        local source_right = math.floor((right / detector_width) * source_width + 0.5)
        source_bar_x = math.floor(
            (((source_left + source_right) / 2) / quantum) + 0.5
        ) * quantum
    end

    local source_crop_width = source_width - (source_bar_x * 2)
    local source_crop_height = source_height - (source_bar_y * 2)
    if source_crop_width <= 0 or source_crop_height <= 0 then
        return nil
    end
    local content_aspect = source_crop_width / source_crop_height
    if has_horizontal_bars then
        if content_aspect < opts.min_pillarbox_content_aspect
            or content_aspect > opts.max_pillarbox_content_aspect then
            return nil
        end
    elseif content_aspect < opts.min_content_aspect then
        return nil
    end

    return string.format(
        "%dx%d+%d+%d",
        source_crop_width,
        source_crop_height,
        source_bar_x,
        source_bar_y
    )
end

local function reset_candidate()
    candidate_key = nil
    candidate_since = nil
    candidate_first_pts = nil
    candidate_scene_pts = nil
end

local function poll()
    if not control_is_current() then
        mp.commandv("quit")
        return
    end
    if mp.get_property_bool("pause", false) or mp.get_property_bool("seeking", false) then
        reset_candidate()
        return
    end

    observe_scene_metadata(nil, mp.get_property_native(FILTER_METADATA))

    local candidate = validated_candidate()
    if not candidate then
        reset_candidate()
        return
    end

    if candidate_key and crops_equivalent(candidate, candidate_key) then
        candidate = candidate_key
    end

    if candidate ~= candidate_key then
        candidate_key = candidate
        candidate_since = mp.get_time()
        local fps = mp.get_property_number(
            "estimated-vf-fps",
            mp.get_property_number("container-fps", 24)
        )
        local metadata_lag = fps and fps > 0 and (2 / fps) or 0
        candidate_first_pts = mp.get_property_number("time-pos", 0) + metadata_lag
        candidate_scene_pts = nil
        if last_scene_pts
                and candidate_first_pts - last_scene_pts >= -0.10
                and candidate_first_pts - last_scene_pts <= opts.scene_gate_window then
            candidate_scene_pts = last_scene_pts
        end
        return
    end

    if not candidate_scene_pts and last_scene_pts and candidate_first_pts
            and candidate_first_pts - last_scene_pts >= -0.10
            and candidate_first_pts - last_scene_pts <= opts.scene_gate_window then
        candidate_scene_pts = last_scene_pts
    end

    if candidate_since and mp.get_time() - candidate_since >= opts.stable_time
        and not crops_equivalent(candidate, emitted_candidate) then
        local kind = ready and "transition" or "baseline"
        -- Scene detection refines the transition timestamp when available, but
        -- must not veto a stable crop change. Dark cuts, fades, and gradual
        -- transitions can legitimately change the letterbox without producing
        -- a strong scdet score.
        local effective_pts = kind == "transition"
            and (candidate_scene_pts or candidate_first_pts)
            or candidate_first_pts
            or 0
        if write_event(kind, candidate, effective_pts) then
            emitted_candidate = candidate
            ready = true
        end
    end
end

local helper_configured = opts.result_path ~= ""
    and opts.control_path ~= ""
    and opts.generation ~= ""

if helper_configured then
    mp.register_event("file-loaded", function()
        if not control_is_current() then
            msg.error("Adaptive crop probe has invalid coordination options")
            mp.commandv("quit")
            return
        end

        local graph = string.format(
            "scale=w=%d:h=-2,fps=fps=%.3f,scdet=threshold=%.3f,cropdetect=limit=%.4f:round=%d:reset_count=%d",
            opts.probe_width,
            opts.probe_fps,
            opts.scene_threshold,
            opts.limit,
            opts.round,
            opts.reset_count
        )
        mp.commandv(
            "vf",
            "add",
            "@" .. FILTER_LABEL .. ":lavfi=[" .. graph .. "]"
        )
        mp.observe_property(
            FILTER_METADATA .. "/lavfi.scd.time",
            "string",
            observe_scene_time
        )
        mp.add_periodic_timer(opts.poll_interval, poll)
    end)
else
    msg.verbose("Adaptive crop probe inactive in the primary player")
end
