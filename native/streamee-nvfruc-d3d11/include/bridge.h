/* SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef STREAMEE_OPTIFLOW_D3D11_BRIDGE_H
#define STREAMEE_OPTIFLOW_D3D11_BRIDGE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define STREAMEE_OPTIFLOW_D3D11_ABI 3u
enum streamee_optiflow_status { STREAMEE_OPTIFLOW_OK, STREAMEE_OPTIFLOW_INVALID_ARGUMENT, STREAMEE_OPTIFLOW_RUNTIME_ERROR };
enum streamee_optiflow_hold { STREAMEE_OPTIFLOW_SYNTHESIZED, STREAMEE_OPTIFLOW_METADATA_HOLD, STREAMEE_OPTIFLOW_SCENE_CUT, STREAMEE_OPTIFLOW_UNRELIABLE_FLOW };
struct streamee_optiflow_config {
    uint32_t size, format, width, height, left, top, visible_width, visible_height;
    /* Chroma position in luma pixels: left=(0,0.5), center=(0.5,0.5). */
    float chroma_x, chroma_y;
    uint32_t matrix, transfer, primaries, range;
};
struct streamee_optiflow_caps {
    uint32_t size, api_version, min_width, min_height, max_width, max_height, grid, nv12, p010;
};
struct streamee_optiflow_stats {
    uint64_t inputs, synthesized, held, metadata_holds, scene_cuts, allocated_bytes;
    /* Last completed GPU sample, not cumulative CPU wall time. */
    double analysis_ms, flow_ms, repair_ms, synthesis_ms, total_ms;
};
struct streamee_optiflow_output {
    /* submit owns this reference; submit_into leaves it null. */
    void *texture;
    double timestamp;
    uint32_t repeated, priming, reason;
};
/* Calls serialized under host D3D11 lock. Textures borrowed on the same device.
   DLL must outlive every session and returned texture reference. */
struct streamee_optiflow_api {
    uint32_t abi, size;
    int (*create)(void *, const struct streamee_optiflow_config *, void **, char *, size_t);
    int (*submit)(void *, void *, uint32_t, double, uint32_t, struct streamee_optiflow_output *, char *, size_t);
    int (*submit_into)(void *, void *, uint32_t, double, uint32_t, void *, uint32_t, struct streamee_optiflow_output *, char *, size_t);
    void (*destroy)(void *);
    void (*release_texture)(void *);
    int (*get_caps)(void *, struct streamee_optiflow_caps *);
    int (*get_stats)(void *, struct streamee_optiflow_stats *);
};
typedef int (*streamee_optiflow_get_api_fn)(uint32_t, struct streamee_optiflow_api *, size_t);
#ifdef STREAMEE_OPTIFLOW_BRIDGE_EXPORTS
__declspec(dllexport)
#endif
int streamee_optiflow_d3d11_get_api(uint32_t, struct streamee_optiflow_api *, size_t);
#ifdef __cplusplus
}
#endif
#endif
