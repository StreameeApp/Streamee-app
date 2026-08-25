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
//!DESC Streamee UltraCustom Sharpen

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
    vec2 px = detail_radius / HOOKED_size;
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

    // Sharpen only across the edge normal. The former 3x3 blur spread its
    // response through diagonal neighbours, which made strong outlines read
    // as thick even at a reduced strength bias.
    float gradient_x = abs(
        luma(ne) + 2.0 * luma(east) + luma(se) -
        luma(nw) - 2.0 * luma(west) - luma(sw)
    );
    float gradient_y = abs(
        luma(sw) + 2.0 * luma(south) + luma(se) -
        luma(nw) - 2.0 * luma(north) - luma(ne)
    );
    float horizontal_weight = gradient_x / max(gradient_x + gradient_y, 0.000001);
    vec3 horizontal_blur = (west + center * 2.0 + east) * 0.25;
    vec3 vertical_blur = (north + center * 2.0 + south) * 0.25;
    vec3 blur = mix(vertical_blur, horizontal_blur, horizontal_weight);
    vec3 detail = center - blur;
    float detail_strength = abs(luma(center) - luma(blur));
    float detail_mask = smoothstep(
        0.00075 / edge_sensitivity,
        0.010 / edge_sensitivity,
        detail_strength
    );

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
    float strong_edge_mask = smoothstep(
        0.12 / halo_control,
        0.36 / halo_control,
        local_contrast
    );

    float resolution_scale = sharpen_resolution_scale();
    float peak_strength = mix(26.0, 38.0, resolution_scale) * strength_bias;
    float edge_guard = mix(1.0, 0.45, strong_edge_mask);
    float texture_guard = 1.0 - speckle_mask * 0.45;
    vec3 sharpen_delta = detail * peak_strength * detail_mask * edge_guard * texture_guard;
    float delta_limit = mix(0.090, 0.045, strong_edge_mask);
    sharpen_delta = clamp(sharpen_delta, vec3(-delta_limit), vec3(delta_limit));
    vec3 sharpened = center + sharpen_delta;
    return vec4(clamp(sharpened, 0.0, 1.0), src.a);
}
