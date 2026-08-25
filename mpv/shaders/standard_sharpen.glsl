//!PARAM strength_bias
//!TYPE float
//!MINIMUM 0.125
//!MAXIMUM 3.000
//!DESC Overall sharpen strength
1.0

//!PARAM detail_radius
//!TYPE float
//!MINIMUM 0.125
//!MAXIMUM 3.000
//!DESC Detail sampling radius; 1.0 is natural
1.0

//!PARAM edge_sensitivity
//!TYPE float
//!MINIMUM 0.125
//!MAXIMUM 3.000
//!DESC Edge detection sensitivity
1.0

//!PARAM noise_protection
//!TYPE float
//!MINIMUM 0.125
//!MAXIMUM 3.000
//!DESC Noise and speckle protection
1.0

//!PARAM halo_control
//!TYPE float
//!MINIMUM 0.125
//!MAXIMUM 3.000
//!DESC Halo suppression strength
1.0

//!HOOK MAIN
//!BIND HOOKED
//!SAVE MAIN
//!DESC Streamee Standard Sharpen

float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
}

float sharpen_resolution_scale() {
    // Native-resolution input needs less gain than the former 2x working image.
    // Keep 1080p gentler while allowing a measured lift for 4K sources.
    float short_edge = min(HOOKED_size.x, HOOKED_size.y);
    return smoothstep(1080.0, 2160.0, short_edge);
}

vec4 hook() {
    vec2 px = detail_radius / HOOKED_size;
    vec4 src = HOOKED_tex(HOOKED_pos);
    vec3 center = src.rgb;
    vec3 north = HOOKED_tex(HOOKED_pos + vec2(0.0, -px.y)).rgb;
    vec3 south = HOOKED_tex(HOOKED_pos + vec2(0.0, px.y)).rgb;
    vec3 east = HOOKED_tex(HOOKED_pos + vec2(px.x, 0.0)).rgb;
    vec3 west = HOOKED_tex(HOOKED_pos + vec2(-px.x, 0.0)).rgb;
    float center_luma = luma(center);
    float neighbor_luma = (luma(north) + luma(south) + luma(east) + luma(west)) * 0.25;
    float neighbor_spread = max(
        max(abs(luma(north) - luma(south)), abs(luma(east) - luma(west))),
        max(abs(luma(north) - luma(east)), abs(luma(south) - luma(west)))
    );
    float speckle_mask = smoothstep(0.025 / noise_protection, 0.085 / noise_protection, neighbor_spread);
    speckle_mask *= 1.0 - smoothstep(0.10 / noise_protection, 0.25 / noise_protection, abs(center_luma - neighbor_luma));
    vec3 blur = (north + south + east + west + center * 4.0) / 8.0;
    vec3 detail = center - blur;
    float edge_mask = mix(
        0.45,
        1.0,
        smoothstep(0.01 / edge_sensitivity, 0.08 / edge_sensitivity, abs(center_luma - neighbor_luma))
    );
    float halo_mask = 1.0 - 0.35 * smoothstep(
        0.08 / halo_control,
        0.22 / halo_control,
        abs(center_luma - neighbor_luma)
    );
    float resolution_scale = sharpen_resolution_scale();
    float sharpen_strength = mix(7.5, 13.5, resolution_scale) * strength_bias;
    vec3 sharpened = center + detail * sharpen_strength * edge_mask * halo_mask * (1.0 - speckle_mask);
    return vec4(clamp(sharpened, 0.0, 1.0), src.a);
}
