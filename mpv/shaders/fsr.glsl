//!HOOK MAIN
//!BIND HOOKED
//!SAVE MAIN
//!DESC Streamee FSR

float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
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

    float center_y = luma(center);
    float cross_y = (luma(north) + luma(south) + luma(east) + luma(west)) * 0.25;
    float diag_y = (luma(ne) + luma(nw) + luma(se) + luma(sw)) * 0.25;

    float edge_cross = abs(center_y - cross_y);
    float edge_diag = abs(center_y - diag_y);
    float edge = smoothstep(0.015, 0.12, max(edge_cross, edge_diag));

    float local_contrast = max(
        max(abs(center_y - luma(north)), abs(center_y - luma(south))),
        max(abs(center_y - luma(east)), abs(center_y - luma(west)))
    );
    local_contrast = max(
        local_contrast,
        max(
            max(abs(center_y - luma(ne)), abs(center_y - luma(nw))),
            max(abs(center_y - luma(se)), abs(center_y - luma(sw)))
        )
    );

    float speckle_guard = 1.0 - smoothstep(0.08, 0.24, local_contrast);
    vec3 blur = (north + south + east + west + ne + nw + se + sw + center * 4.0) / 12.0;
    vec3 detail = center - blur;
    vec3 sharpened = center + detail * mix(10.0, 20.0, edge) * speckle_guard;
    return vec4(clamp(sharpened, 0.0, 1.0), src.a);
}
