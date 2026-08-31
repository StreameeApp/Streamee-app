// Fixed-size crop and edge lighting for Smart Black Bar Fill.
// Coordinates are normalized to the unchanged post-filter texture.
//!PARAM crop_x
//!TYPE DYNAMIC float
//!MINIMUM 0
//!MAXIMUM 1
0
//!PARAM crop_y
//!TYPE DYNAMIC float
//!MINIMUM 0
//!MAXIMUM 1
0
//!PARAM crop_w
//!TYPE DYNAMIC float
//!MINIMUM 0.001
//!MAXIMUM 1
1
//!PARAM crop_h
//!TYPE DYNAMIC float
//!MINIMUM 0.001
//!MAXIMUM 1
1
//!PARAM light_x
//!TYPE DYNAMIC float
//!MINIMUM 0
//!MAXIMUM 1
0
//!PARAM light_y
//!TYPE DYNAMIC float
//!MINIMUM 0
//!MAXIMUM 1
0
//!PARAM light_w
//!TYPE DYNAMIC float
//!MINIMUM 0.001
//!MAXIMUM 1
1
//!PARAM light_h
//!TYPE DYNAMIC float
//!MINIMUM 0.001
//!MAXIMUM 1
1
//!PARAM content_guard
//!TYPE DYNAMIC float
//!MINIMUM 0
//!MAXIMUM 1
0
//!PARAM source_aspect
//!TYPE DYNAMIC float
//!MINIMUM 0.1
//!MAXIMUM 10
1.7777778
//!PARAM canvas_aspect
//!TYPE DYNAMIC float
//!MINIMUM 0.1
//!MAXIMUM 10
2.3888889
//!PARAM light_depth
//!TYPE float
//!MINIMUM 0
//!MAXIMUM 0.25
0.015
//!PARAM light_width
//!TYPE float
//!MINIMUM 0.1
//!MAXIMUM 5
3
//!PARAM light_length
//!TYPE float
//!MINIMUM 0.1
//!MAXIMUM 5
2.5
//!PARAM lighting_enabled
//!TYPE DYNAMIC float
//!MINIMUM 0
//!MAXIMUM 1
1

//!HOOK MAIN
//!BIND HOOKED
//!SAVE STREAMEE_LIGHT_EDGES
//!WIDTH 10
//!HEIGHT 4
//!DESC Streamee edge-light averages
vec4 hook() {
    if (lighting_enabled < 0.5) return vec4(0.0, 0.0, 0.0, 1.0);
    vec2 lo = vec2(light_x, light_y) + 0.5 * HOOKED_pt;
    vec2 hi = vec2(light_x + light_w, light_y + light_h) - 0.5 * HOOKED_pt;
    vec2 sample_inset = min(
        4.0 * HOOKED_pt,
        max((hi - lo) * 0.01, vec2(0.0))
    );
    int edge = int(floor(HOOKED_pos.y * 4.0));
    float center = (floor(HOOKED_pos.x * 10.0) + 0.5) / 10.0;
    vec3 color = vec3(0.0);
    for (int along = 0; along < 8; ++along) {
        float t = clamp(center + ((float(along) + 0.5) / 8.0 - 0.5)
                        * light_width / 10.0, 0.0, 1.0);
        for (int inward = 0; inward < 4; ++inward) {
            float depth = light_depth * (float(inward) + 0.5) / 4.0;
            vec2 p;
            if (edge == 0) p = vec2(lo.x + sample_inset.x + depth, mix(lo.y, hi.y, t));
            else if (edge == 1) p = vec2(hi.x - sample_inset.x - depth, mix(lo.y, hi.y, t));
            else if (edge == 2) p = vec2(mix(lo.x, hi.x, t), lo.y + sample_inset.y + depth);
            else p = vec2(mix(lo.x, hi.x, t), hi.y - sample_inset.y - depth);
            color += HOOKED_tex(clamp(p, lo, hi)).rgb;
        }
    }
    return vec4(color / 32.0, 1.0);
}

//!HOOK MAIN
//!BIND HOOKED
//!BIND STREAMEE_LIGHT_EDGES
//!DESC Streamee fixed-canvas crop and lighting
vec4 hook() {
    float aspect = source_aspect * crop_w / crop_h;
    vec2 fit = vec2(min(aspect / canvas_aspect, 1.0),
                    min(canvas_aspect / aspect, 1.0));
    vec2 q = (HOOKED_pos - 0.5) / fit + 0.5;
    vec2 render_lo = vec2(crop_x, crop_y) + 0.5 * HOOKED_pt;
    vec2 render_hi = vec2(crop_x + crop_w, crop_y + crop_h) - 0.5 * HOOKED_pt;
    vec2 source_position = vec2(crop_x, crop_y) + q * vec2(crop_w, crop_h);
    vec2 active_lo = (vec2(light_x, light_y) - vec2(crop_x, crop_y))
                   / vec2(crop_w, crop_h);
    vec2 active_hi = (vec2(light_x + light_w, light_y + light_h)
                   - vec2(crop_x, crop_y)) / vec2(crop_w, crop_h);
    vec2 q_min = vec2(0.5) - 0.5 / fit;
    vec2 q_max = vec2(0.5) + 0.5 / fit;
    // cropdetect is intentionally quantized and can retain a few black pixels.
    // Absorb that rounding margin into the lighting instead of drawing a seam.
    vec2 guarded_axes = step(
        0.5 * HOOKED_pt / vec2(crop_w, crop_h),
        max(active_lo, vec2(1.0) - active_hi)
    );
    vec2 edge_guard = content_guard * guarded_axes * min(
        4.0 * HOOKED_pt / vec2(crop_w, crop_h),
        max((active_hi - active_lo) * 0.01, vec2(0.0))
    );
    // Native picture edges can also contain a small dark resampling fringe.
    // Guard only edges that actually border lighting so unaffected sides retain
    // the complete source picture.
    vec2 seam_guard = lighting_enabled * min(
        4.0 * HOOKED_pt / vec2(crop_w, crop_h),
        max((active_hi - active_lo) * 0.01, vec2(0.0))
    );
    vec2 low_seam_guard = min(seam_guard, max(active_lo - q_min, vec2(0.0)));
    vec2 high_seam_guard = min(seam_guard, max(q_max - active_hi, vec2(0.0)));
    active_lo += max(edge_guard, low_seam_guard);
    active_hi -= max(edge_guard, high_seam_guard);
    bool inside_render = all(greaterThanEqual(q, vec2(0.0)))
                      && all(lessThanEqual(q, vec2(1.0)));
    bool inside_active = all(greaterThanEqual(q, active_lo))
                      && all(lessThanEqual(q, active_hi));
    if (inside_render && inside_active) {
        return HOOKED_tex(clamp(source_position, render_lo, render_hi));
    }
    vec4 violations = vec4(active_lo.x - q.x, q.x - active_hi.x,
                           active_lo.y - q.y, q.y - active_hi.y);
    vec4 spans = max(vec4(active_lo.x - q_min.x, q_max.x - active_hi.x,
                          active_lo.y - q_min.y, q_max.y - active_hi.y),
                     vec4(0.000001));
    vec4 normalized = violations / spans;
    float edge = 0.0;
    float distance = normalized.x;
    if (normalized.y > distance) { edge = 1.0; distance = normalized.y; }
    if (normalized.z > distance) { edge = 2.0; distance = normalized.z; }
    if (normalized.w > distance) { edge = 3.0; distance = normalized.w; }
    bool vertical_edge = edge < 1.5;
    float coordinate = vertical_edge
        ? (q.y - active_lo.y) / max(active_hi.y - active_lo.y, 0.000001)
        : (q.x - active_lo.x) / max(active_hi.x - active_lo.x, 0.000001);
    float fade = pow(max(1.0 - distance / light_length, 0.0), 2.0);
    vec3 light = lighting_enabled > 0.5
        ? STREAMEE_LIGHT_EDGES_tex(vec2(clamp(coordinate, 0.05, 0.95),
                                       (edge + 0.5) / 4.0)).rgb
        : vec3(0.0);
    return vec4(light * fade, 1.0);
}
