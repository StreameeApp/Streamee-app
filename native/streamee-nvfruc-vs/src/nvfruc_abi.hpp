#pragma once

#include <Windows.h>
#include <cstddef>
#include <cstdint>

// Minimal ABI declarations for dynamically calling the user-provided NVIDIA
// Optical Flow FRUC runtime. Streamee does not compile or redistribute the SDK.
namespace nvfruc {

constexpr std::size_t max_resources = 10;

enum class CudaResourceType : int {
    Undefined = -1,
    DevicePointer = 0,
    Array = 1,
};

enum class ResourceType : int {
    Undefined = -1,
    Cuda = 0,
    DirectX11 = 1,
};

enum class SurfaceFormat : int {
    Undefined = -1,
    NV12 = 0,
    ARGB = 1,
};

enum class Status : int {
    Success = 0,
};

struct HandleData;
using Handle = HandleData *;

union SyncWait {
    struct {
        std::uint64_t fence_value;
    } fence;
    struct {
        std::uint64_t render_acquire_key;
        std::uint64_t interpolation_acquire_key;
    } mutex;
};

union SyncSignal {
    struct {
        std::uint64_t fence_value;
    } fence;
    struct {
        std::uint64_t render_release_key;
        std::uint64_t interpolation_release_key;
    } mutex;
};

struct CreateParams {
    std::uint32_t width;
    std::uint32_t height;
    void *device;
    ResourceType resource_type;
    SurfaceFormat surface_format;
    CudaResourceType cuda_resource_type;
    std::uint32_t reserved[32];
};

struct FrameData {
    void *frame;
    double timestamp;
    std::size_t cuda_surface_pitch;
    bool *frame_repeated;
    std::uint32_t reserved[32];
};

struct ProcessInParams {
    FrameData input;
    std::uint32_t skip_warp : 1;
    SyncWait wait;
    std::uint32_t reserved[32];
};

struct ProcessOutParams {
    FrameData output;
    SyncSignal signal;
    std::uint32_t reserved[32];
};

struct RegisterResourceParams {
    void *resources[max_resources];
    void *d3d11_fence;
    std::uint32_t count;
};

struct UnregisterResourceParams {
    void *resources[max_resources];
    std::uint32_t count;
};

using CreateFn = Status(CALLBACK *)(const CreateParams *, Handle *);
using RegisterFn = Status(CALLBACK *)(Handle, const RegisterResourceParams *);
using UnregisterFn = Status(CALLBACK *)(Handle, const UnregisterResourceParams *);
using ProcessFn = Status(CALLBACK *)(Handle, const ProcessInParams *, const ProcessOutParams *);
using DestroyFn = Status(CALLBACK *)(Handle);

} // namespace nvfruc
