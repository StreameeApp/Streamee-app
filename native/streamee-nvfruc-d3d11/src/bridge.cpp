#include "bridge.h"
#include "pipeline.hpp"
#include <algorithm>
#include <cstring>
#include <stdexcept>
#include <type_traits>

using streamee::optiflow::Pipeline;
static_assert(std::is_standard_layout_v<streamee_optiflow_api>);
static_assert(std::is_standard_layout_v<streamee_optiflow_output>);

namespace {
void message(char *buffer, size_t size, const char *text) noexcept {
    if (!buffer || !size) return;
    const auto count = std::min(size - 1, std::strlen(text));
    std::memcpy(buffer, text, count);
    buffer[count] = '\0';
}

template<class Function> int guarded(char *error, size_t size, Function operation) noexcept {
    message(error, size, "");
    try { operation(); return STREAMEE_OPTIFLOW_OK; }
    catch (const std::invalid_argument &failure) {
        message(error, size, failure.what());
        return STREAMEE_OPTIFLOW_INVALID_ARGUMENT;
    } catch (const std::exception &failure) {
        message(error, size, failure.what());
        return STREAMEE_OPTIFLOW_RUNTIME_ERROR;
    } catch (...) {
        message(error, size, "Unexpected OptiFlow prototype failure");
        return STREAMEE_OPTIFLOW_RUNTIME_ERROR;
    }
}

int create(void *device, const streamee_optiflow_config *config,
           void **session, char *error, size_t size) noexcept {
    if (session) *session = nullptr;
    return guarded(error, size, [&] {
        if (!session || !device || !config)
            throw std::invalid_argument("Device, config and session output are required");
        *session = new Pipeline(static_cast<ID3D11Device *>(device), *config);
    });
}

int submit(void *session, void *input, uint32_t slice, double timestamp, uint32_t allow,
           streamee_optiflow_output *output, char *error, size_t size) noexcept {
    if (output) *output = {};
    return guarded(error, size, [&] {
        if (!session || !input || !output)
            throw std::invalid_argument("Session, input texture and output are required");
        auto result = static_cast<Pipeline *>(session)->submit(
            static_cast<ID3D11Texture2D *>(input), slice, timestamp, allow != 0);
        output->timestamp = result.timestamp;
        output->repeated = result.repeated ? 1u : 0u;
        output->reason = result.reason;
        output->priming = result.texture ? 0u : 1u;
        output->texture = result.texture.Detach();
    });
}

int submit_into(void *session, void *input, uint32_t input_slice, double timestamp, uint32_t allow,
                void *destination, uint32_t destination_slice,
                streamee_optiflow_output *output, char *error, size_t size) noexcept {
    if (output) *output = {};
    return guarded(error, size, [&] {
        if (!session || !input || !output)
            throw std::invalid_argument("Session, input texture and output metadata are required");
        auto result = static_cast<Pipeline *>(session)->submit_into(
            static_cast<ID3D11Texture2D *>(input), input_slice, timestamp,
            static_cast<ID3D11Texture2D *>(destination), destination_slice, allow != 0);
        output->timestamp = result.timestamp;
        output->repeated = result.repeated ? 1u : 0u;
        output->priming = result.priming ? 1u : 0u;
        output->reason = result.reason;
    });
}

void destroy(void *session) noexcept { delete static_cast<Pipeline *>(session); }
int get_caps(void *session, streamee_optiflow_caps *caps) noexcept {
    if (!session || !caps || caps->size != sizeof(*caps)) return STREAMEE_OPTIFLOW_INVALID_ARGUMENT;
    *caps = static_cast<Pipeline *>(session)->caps();
    return STREAMEE_OPTIFLOW_OK;
}
int get_stats(void *session, streamee_optiflow_stats *stats) noexcept {
    if (!session || !stats) return STREAMEE_OPTIFLOW_INVALID_ARGUMENT;
    *stats = static_cast<Pipeline *>(session)->stats();
    return STREAMEE_OPTIFLOW_OK;
}
void release_texture(void *texture) noexcept {
    if (texture) static_cast<ID3D11Texture2D *>(texture)->Release();
}
}

extern "C" int streamee_optiflow_d3d11_get_api(uint32_t abi, streamee_optiflow_api *api, size_t size) {
    if (abi != STREAMEE_OPTIFLOW_D3D11_ABI || !api || size < sizeof(*api))
        return STREAMEE_OPTIFLOW_INVALID_ARGUMENT;
    *api = {STREAMEE_OPTIFLOW_D3D11_ABI, sizeof(*api), create, submit, submit_into,
            destroy, release_texture, get_caps, get_stats};
    return STREAMEE_OPTIFLOW_OK;
}
