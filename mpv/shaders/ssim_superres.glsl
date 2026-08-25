//!HOOK MAIN
//!BIND HOOKED
//!SAVE MAIN
//!DESC Streamee SSimSuperRes

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
    float neighbor_avg = (
        luma(north) + luma(south) + luma(east) + luma(west) +
        luma(ne) + luma(nw) + luma(se) + luma(sw)
    ) * 0.125;
    float edge = abs(center_y - neighbor_avg);
    float edge_boost = smoothstep(0.01, 0.10, edge);

    float variance = 0.0;
    variance += abs(luma(center) - luma(north));
    variance += abs(luma(center) - luma(south));
    variance += abs(luma(center) - luma(east));
    variance += abs(luma(center) - luma(west));
    variance += abs(luma(center) - luma(ne));
    variance += abs(luma(center) - luma(nw));
    variance += abs(luma(center) - luma(se));
    variance += abs(luma(center) - luma(sw));
    variance *= 0.125;

    float noise_gate = 1.0 - smoothstep(0.10, 0.30, variance);
    vec3 blur = (north + south + east + west + ne + nw + se + sw + center * 4.0) / 12.0;
    vec3 detail = center - blur;
    vec3 sharpened = center + detail * mix(8.0, 18.0, edge_boost) * noise_gate;
    return vec4(clamp(sharpened, 0.0, 1.0), src.a);
}
