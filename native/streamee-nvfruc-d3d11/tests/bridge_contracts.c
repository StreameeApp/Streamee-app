#include "bridge.h"
#include <stdio.h>
#include <string.h>

// Compiled as C, exercising the actual DLL ABI without opening a GPU/runtime.
int main(void) {
    struct streamee_optiflow_api api = {0};
    if (streamee_optiflow_d3d11_get_api(99, &api, sizeof(api)) != STREAMEE_OPTIFLOW_INVALID_ARGUMENT) return 1;
    if (streamee_optiflow_d3d11_get_api(STREAMEE_OPTIFLOW_D3D11_ABI, &api, sizeof(api)-1) != STREAMEE_OPTIFLOW_INVALID_ARGUMENT) return 2;
    if (streamee_optiflow_d3d11_get_api(STREAMEE_OPTIFLOW_D3D11_ABI, NULL, sizeof(api)) != STREAMEE_OPTIFLOW_INVALID_ARGUMENT) return 3;
    if (streamee_optiflow_d3d11_get_api(STREAMEE_OPTIFLOW_D3D11_ABI, &api, sizeof(api)) != STREAMEE_OPTIFLOW_OK) return 4;
    if (api.abi != STREAMEE_OPTIFLOW_D3D11_ABI || api.size != sizeof(api) || !api.create || !api.submit || !api.submit_into || !api.destroy || !api.release_texture) return 5;
    char error[8];
    memset(error, 'x', sizeof(error));
    void *session = (void *)1;
    if (api.create(NULL, NULL, &session, error, sizeof(error)) != STREAMEE_OPTIFLOW_INVALID_ARGUMENT) return 6;
    if (session || error[7] != '\0' || !error[0]) return 7;
    struct streamee_optiflow_output output;
    memset(&output, 0xff, sizeof(output));
    if (api.submit(NULL, NULL, 0, 0, 1, &output, NULL, 0) != STREAMEE_OPTIFLOW_INVALID_ARGUMENT) return 8;
    if (output.texture || output.timestamp || output.priming || output.repeated) return 9;
    error[0] = 'x';
    if (api.submit(NULL, NULL, 0, 0, 1, NULL, error, 1) != STREAMEE_OPTIFLOW_INVALID_ARGUMENT || error[0]) return 10;
    memset(&output, 0xff, sizeof(output));
    if (api.submit_into(NULL, NULL, 0, 0, 1, NULL, 0, &output, NULL, 0) != STREAMEE_OPTIFLOW_INVALID_ARGUMENT) return 11;
    if (output.texture || output.timestamp || output.priming || output.repeated) return 12;
    if (!api.get_caps || !api.get_stats) return 13;
    struct streamee_optiflow_caps caps = {sizeof(caps)};
    struct streamee_optiflow_stats stats = {0};
    if (api.get_caps(NULL, &caps) != STREAMEE_OPTIFLOW_INVALID_ARGUMENT) return 14;
    if (api.get_stats(NULL, &stats) != STREAMEE_OPTIFLOW_INVALID_ARGUMENT) return 15;
    api.destroy(NULL);
    api.release_texture(NULL);
    puts("C DLL ABI version, argument, ownership-reset and error-buffer checks passed; no GPU calls");
    return 0;
}
