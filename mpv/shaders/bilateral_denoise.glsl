//!PARAM denoise_strength
//!TYPE float
//!MINIMUM 0.60
//!MAXIMUM 1.40
//!DESC Bilateral denoise strength
1.0

//!HOOK MAIN
//!BIND HOOKED
//!SAVE MAIN
//!DESC Streamee Bilateral Denoise

float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
}

vec4 hook() {
    vec2 px = 1.0 / HOOKED_size;
    vec4 src = HOOKED_tex(HOOKED_pos);
    vec3 center = src.rgb;
    float center_luma = luma(center);

    float amount = clamp((denoise_strength - 0.75) / 0.50, 0.0, 1.0);
    float spatial_sigma = mix(0.85, 2.40, amount);
    float range_sigma = mix(0.018, 0.120, amount);
    float inv_spatial = 0.5 / (spatial_sigma * spatial_sigma);
    float inv_range = 0.5 / (range_sigma * range_sigma);

    vec3 accum = vec3(0.0);
    float total = 0.0;

    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y));
            vec3 sample_rgb = HOOKED_tex(HOOKED_pos + offset * px).rgb;
            float sample_luma = luma(sample_rgb);
            float spatial_dist2 = dot(offset, offset);
            float range_dist = sample_luma - center_luma;
            float weight = exp(-spatial_dist2 * inv_spatial - range_dist * range_dist * inv_range);
            accum += sample_rgb * weight;
            total += weight;
        }
    }

    vec3 denoised = accum / max(total, 1e-5);
    float preserve = smoothstep(0.006, 0.040, abs(center_luma - luma(denoised)));
    float blend = mix(0.28, 0.96, amount);
    vec3 result = mix(center, denoised, blend * (1.0 - preserve * 0.76));
    return vec4(clamp(result, 0.0, 1.0), src.a);
}
