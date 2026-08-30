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
    vec2 lo = vec2(crop_x, crop_y) + 0.5 * HOOKED_pt;
    vec2 hi = vec2(crop_x + crop_w, crop_y + crop_h) - 0.5 * HOOKED_pt;
    int edge = int(floor(HOOKED_pos.y * 4.0));
    float center = (floor(HOOKED_pos.x * 10.0) + 0.5) / 10.0;
    vec3 color = vec3(0.0);
    for (int along = 0; along < 8; ++along) {
        float t = clamp(center + ((float(along) + 0.5) / 8.0 - 0.5)
                        * light_width / 10.0, 0.0, 1.0);
        for (int inward = 0; inward < 4; ++inward) {
            float depth = light_depth * (float(inward) + 0.5) / 4.0;
            vec2 p;
            if (edge == 0) p = vec2(lo.x + depth, mix(lo.y, hi.y, t));
            else if (edge == 1) p = vec2(hi.x - depth, mix(lo.y, hi.y, t));
            else if (edge == 2) p = vec2(mix(lo.x, hi.x, t), lo.y + depth);
            else p = vec2(mix(lo.x, hi.x, t), hi.y - depth);
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
    if (all(greaterThanEqual(q, vec2(0.0))) && all(lessThanEqual(q, vec2(1.0)))) {
        vec2 lo = vec2(crop_x, crop_y) + 0.5 * HOOKED_pt;
        vec2 hi = vec2(crop_x + crop_w, crop_y + crop_h) - 0.5 * HOOKED_pt;
        return HOOKED_tex(clamp(vec2(crop_x, crop_y) + q * vec2(crop_w, crop_h), lo, hi));
    }
    bool vertical_edge = fit.x < 0.999999;
    float coordinate = vertical_edge ? q.y : q.x;
    float edge = vertical_edge ? (q.x < 0.0 ? 0.0 : 1.0) : (q.y < 0.0 ? 2.0 : 3.0);
    float available = vertical_edge ? (1.0 - fit.x) : (1.0 - fit.y);
    float outside = vertical_edge ? abs(HOOKED_pos.x - 0.5) - fit.x * 0.5
                                  : abs(HOOKED_pos.y - 0.5) - fit.y * 0.5;
    float distance = outside / max(available * 0.5, 0.000001);
    float fade = pow(max(1.0 - distance / light_length, 0.0), 2.0);
    vec3 light = lighting_enabled > 0.5
        ? STREAMEE_LIGHT_EDGES_tex(vec2(clamp(coordinate, 0.05, 0.95),
                                       (edge + 0.5) / 4.0)).rgb
        : vec3(0.0);
    return vec4(light * fade, 1.0);
}
