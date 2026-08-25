//!PARAM strength_bias
//!TYPE float
//!MINIMUM 0.125
//!MAXIMUM 3.000
//!DESC Overall sharpen strength
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
//!DESC Streamee Ultra Sharpen

float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
}

float sharpen_resolution_scale() {
    // Preserve an aggressive native-resolution profile without the former
    // 2x working image amplifying the effective kernel gain.
    float short_edge = min(HOOKED_size.x, HOOKED_size.y);
    return smoothstep(1080.0, 2160.0, short_edge);
}

vec4 hook() {
    vec2 px = 1.0 / HOOKED_size;
    vec4 src = HOOKED_tex(HOOKED_pos);
    vec3 center = src.rgb;
    vec3 north = HOOKED_tex(HOOKED_pos + vec2(0.0, -px.y)).rgb;
    vec3 south = HOOKED_tex(HOOKED_pos + vec2(0.0, px.y)).rgb;
    vec3 east = HOOKED_tex(HOOKED_pos + vec2(px.x, 0.0)).rgb;
    vec3 west = HOOKED_tex(HOOKED_pos + vec2(-px.x, 0.0)).rgb;
    vec3 ne = HOOKED_tex(HOOKED_pos + vec2(px.x, -px.y)).rgb;
    vec3 nw = HOOKED_tex(HOOKED_pos + vec2(-px.x, -px.y)).rgb;
    vec3 se = HOOKED_tex(HOOKED_pos + vec2(px.x, px.y)).rgb;
    vec3 sw = HOOKED_tex(HOOKED_pos + vec2(-px.x, px.y)).rgb;
    float center_luma = luma(center);
    float neighbor_luma = (
        luma(north) + luma(south) + luma(east) + luma(west) +
        luma(ne) + luma(nw) + luma(se) + luma(sw)
    ) / 8.0;
    float neighbor_spread = max(
        max(abs(luma(north) - luma(south)), abs(luma(east) - luma(west))),
        max(
            max(abs(luma(ne) - luma(nw)), abs(luma(se) - luma(sw))),
            max(abs(luma(north) - luma(east)), abs(luma(south) - luma(west)))
        )
    );
    float speckle_mask = smoothstep(0.018 / noise_protection, 0.065 / noise_protection, neighbor_spread);
    speckle_mask *= 1.0 - smoothstep(0.08 / noise_protection, 0.20 / noise_protection, abs(center_luma - neighbor_luma));

    vec3 blur = (north + south + east + west + ne + nw + se + sw + center * 4.0) / 12.0;
    float edge_strength = abs(8.0 * luma(center) - (
        luma(north) + luma(south) + luma(east) + luma(west) +
        luma(ne) + luma(nw) + luma(se) + luma(sw)
    ));
    edge_strength = smoothstep(0.005 / edge_sensitivity, 0.06 / edge_sensitivity, edge_strength);

    float local_contrast = max(
        max(abs(luma(center) - luma(north)), abs(luma(center) - luma(south))),
        max(abs(luma(center) - luma(east)), abs(luma(center) - luma(west)))
    );
    local_contrast = max(
        local_contrast,
        max(
            max(abs(luma(center) - luma(ne)), abs(luma(center) - luma(nw))),
            max(abs(luma(center) - luma(se)), abs(luma(center) - luma(sw)))
        )
    );
    local_contrast = clamp(local_contrast * 4.5, 0.0, 1.0);

    float resolution_scale = sharpen_resolution_scale();
    float min_strength = mix(10.0, 15.0, resolution_scale) * strength_bias;
    float max_strength = mix(18.0, 26.0, resolution_scale) * strength_bias;
    float strength = clamp(edge_strength * (1.0 - local_contrast * 0.6 * halo_control), 0.0, 1.0);
    vec3 sharpened = center + (center - blur) * mix(min_strength, max_strength, strength) * (1.0 - speckle_mask);
    return vec4(clamp(sharpened, 0.0, 1.0), src.a);
}
