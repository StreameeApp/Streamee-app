#include "nvfruc_abi.hpp"
#include "nv12_rows.hpp"

#include <VapourSynth4.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <limits>
#include <memory>
#include <mutex>
#include <sstream>
#include <locale>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;
double elapsed_ms(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

void report_state(const char *state, const VSAPI *vsapi, VSCore *core) {
    vsapi->logMessage(mtInformation,
        (std::string("STREAMEE_OPTIFLOW {\"state\":\"") + state + "\"}").c_str(), core);
}

void require_status(nvfruc::Status status, const char *operation) {
    if (status != nvfruc::Status::Success) {
        throw std::runtime_error(std::string(operation) + " failed (NvOFFRUC status " +
                                 std::to_string(static_cast<int>(status)) + ")");
    }
}

class RuntimeLibrary {
  public:
    explicit RuntimeLibrary(const std::filesystem::path &runtime_dir) {
        const auto dll_path = runtime_dir / L"NvOFFRUC.dll";
        if (!std::filesystem::is_regular_file(dll_path)) {
            throw std::runtime_error("NvOFFRUC.dll is missing from the imported runtime directory");
        }

        module_ = LoadLibraryExW(dll_path.c_str(), nullptr,
                                 LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        if (!module_) {
            throw std::runtime_error("Windows could not load the imported NvOFFRUC.dll");
        }

        create = load<nvfruc::CreateFn>("NvOFFRUCCreate");
        register_resources = load<nvfruc::RegisterFn>("NvOFFRUCRegisterResource");
        unregister_resources = load<nvfruc::UnregisterFn>("NvOFFRUCUnregisterResource");
        process = load<nvfruc::ProcessFn>("NvOFFRUCProcess");
        destroy = load<nvfruc::DestroyFn>("NvOFFRUCDestroy");
    }

    ~RuntimeLibrary() {
        if (module_) {
            FreeLibrary(module_);
        }
    }

    RuntimeLibrary(const RuntimeLibrary &) = delete;
    RuntimeLibrary &operator=(const RuntimeLibrary &) = delete;

    nvfruc::CreateFn create{};
    nvfruc::RegisterFn register_resources{};
    nvfruc::UnregisterFn unregister_resources{};
    nvfruc::ProcessFn process{};
    nvfruc::DestroyFn destroy{};

  private:
    template <typename T> T load(const char *name) {
        const auto address = GetProcAddress(module_, name);
        if (!address) {
            throw std::runtime_error(std::string("NvOFFRUC.dll does not export ") + name);
        }
        return reinterpret_cast<T>(address);
    }

    HMODULE module_{};
};

using CUdevice = int;
using CUcontext = void *;
using CUdeviceptr = unsigned long long;
using CUresult = int;
constexpr CUresult cuda_success = 0;

class CudaDriver {
  public:
    CudaDriver() {
        module_ = LoadLibraryExW(L"nvcuda.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!module_) {
            throw std::runtime_error("The NVIDIA CUDA display driver is unavailable");
        }
        init = load<InitFn>("cuInit");
        device_count = load<DeviceCountFn>("cuDeviceGetCount");
        device_get = load<DeviceGetFn>("cuDeviceGet");
        context_create = load<ContextCreateFn>("cuCtxCreate_v2");
        context_set_current = load<ContextSetCurrentFn>("cuCtxSetCurrent");
        context_get_current = load<ContextGetCurrentFn>("cuCtxGetCurrent");
        context_destroy = load<ContextDestroyFn>("cuCtxDestroy_v2");
        memory_allocate = load<MemoryAllocateFn>("cuMemAlloc_v2");
        memory_free = load<MemoryFreeFn>("cuMemFree_v2");
        host_register = load<HostRegisterFn>("cuMemHostRegister_v2");
        host_unregister = load<HostUnregisterFn>("cuMemHostUnregister");
        copy_host_to_device = load<CopyHostToDeviceFn>("cuMemcpyHtoD_v2");
        copy_device_to_host = load<CopyDeviceToHostFn>("cuMemcpyDtoH_v2");
        synchronize = load<SynchronizeFn>("cuCtxSynchronize");
    }

    ~CudaDriver() {
        if (module_) {
            FreeLibrary(module_);
        }
    }

    using InitFn = CUresult(CALLBACK *)(unsigned int);
    using DeviceCountFn = CUresult(CALLBACK *)(int *);
    using DeviceGetFn = CUresult(CALLBACK *)(CUdevice *, int);
    using ContextCreateFn = CUresult(CALLBACK *)(CUcontext *, unsigned int, CUdevice);
    using ContextSetCurrentFn = CUresult(CALLBACK *)(CUcontext);
    using ContextGetCurrentFn = CUresult(CALLBACK *)(CUcontext *);
    using ContextDestroyFn = CUresult(CALLBACK *)(CUcontext);
    using MemoryAllocateFn = CUresult(CALLBACK *)(CUdeviceptr *, std::size_t);
    using MemoryFreeFn = CUresult(CALLBACK *)(CUdeviceptr);
    using HostRegisterFn = CUresult(CALLBACK *)(void *, std::size_t, unsigned int);
    using HostUnregisterFn = CUresult(CALLBACK *)(void *);
    using CopyHostToDeviceFn = CUresult(CALLBACK *)(CUdeviceptr, const void *, std::size_t);
    using CopyDeviceToHostFn = CUresult(CALLBACK *)(void *, CUdeviceptr, std::size_t);
    using SynchronizeFn = CUresult(CALLBACK *)();

    InitFn init{};
    DeviceCountFn device_count{};
    DeviceGetFn device_get{};
    ContextCreateFn context_create{};
    ContextSetCurrentFn context_set_current{};
    ContextGetCurrentFn context_get_current{};
    ContextDestroyFn context_destroy{};
    MemoryAllocateFn memory_allocate{};
    MemoryFreeFn memory_free{};
    HostRegisterFn host_register{};
    HostUnregisterFn host_unregister{};
    CopyHostToDeviceFn copy_host_to_device{};
    CopyDeviceToHostFn copy_device_to_host{};
    SynchronizeFn synchronize{};

  private:
    template <typename T> T load(const char *name) {
        const auto address = GetProcAddress(module_, name);
        if (!address) {
            throw std::runtime_error(std::string("nvcuda.dll does not export ") + name);
        }
        return reinterpret_cast<T>(address);
    }

    HMODULE module_{};
};

void require_cuda(CUresult result, const char *operation) {
    if (result != cuda_success) {
        throw std::runtime_error(std::string(operation) + " failed (CUDA status " +
                                 std::to_string(result) + ")");
    }
}

struct CudaSurface {
    CUdeviceptr pointer{};
};

// VapourSynth workers may also host other CUDA plugins. Never leave our context
// installed on their thread after a callback, including exceptional exits.
struct RestoreCudaContext {
    CudaDriver &driver;
    CUcontext previous{};
    explicit RestoreCudaContext(CudaDriver &value) : driver(value) {
        require_cuda(driver.context_get_current(&previous), "cuCtxGetCurrent");
    }
    ~RestoreCudaContext() { driver.context_set_current(previous); }
};

class FrucPipeline {
  public:
    FrucPipeline(const std::filesystem::path &runtime_dir, int width, int height)
        : runtime_(runtime_dir), width_(width), height_(height), bytes_(static_cast<std::size_t>(width) *
                                                                       static_cast<std::size_t>(height) * 3 / 2),
          host_buffer_(bytes_) {
        try {
            require_cuda(cuda_.init(0), "cuInit");
            RestoreCudaContext restore(cuda_);
            create_context();
            // Register once for the filter lifetime. Allocation/resource limits
            // must not prevent playback: ordinary staging remains valid.
            host_registered_ = cuda_.host_register(host_buffer_.data(), bytes_, 0) == cuda_success;
            create_surfaces();
            create_fruc();
        } catch (...) {
            cleanup();
            throw;
        }
    }

    ~FrucPipeline() { cleanup(); }

    FrucPipeline(const FrucPipeline &) = delete;
    FrucPipeline &operator=(const FrucPipeline &) = delete;

    void submit(const VSFrame *frame, double input_timestamp, double output_timestamp,
                bool read_output, VSFrame *destination, const VSAPI *vsapi) {
        const unsigned render_index = next_render_;
        next_render_ ^= 1U;
        RestoreCudaContext restore(cuda_);
        require_cuda(cuda_.context_set_current(context_), "cuCtxSetCurrent");
        upload(render_[render_index], frame, vsapi);

        nvfruc::ProcessInParams input{};
        input.input.frame = &render_[render_index].pointer;
        input.input.timestamp = input_timestamp;

        nvfruc::ProcessOutParams output{};
        output.output.frame = &interpolation_.pointer;
        output.output.timestamp = output_timestamp;
        bool repeated = false;
        output.output.frame_repeated = &repeated;
        auto started = Clock::now();
        const auto process_status = runtime_.process(handle_, &input, &output);
        process_ms_ += elapsed_ms(started);
        if (process_status != nvfruc::Status::Success) {
            throw std::runtime_error("NvOFFRUCProcess failed for input " + std::to_string(input_timestamp) +
                                     " and output " + std::to_string(output_timestamp) + " (status " +
                                     std::to_string(static_cast<int>(process_status)) + ")");
        }

        if (read_output) {
            unpack(destination, vsapi);
            ++outputs_;
            if (repeated) ++repeated_;
        }
        started = Clock::now();
        require_cuda(cuda_.synchronize(), "cuCtxSynchronize");
        sync_ms_ += elapsed_ms(started);
        ++inputs_;
    }

    void report(const VSAPI *vsapi, VSCore *core) const {
        if (outputs_ != 1 && outputs_ % 60 != 0) return;
        // Host wall times include driver waits; these are not GPU kernel timings.
        std::ostringstream json;
        json.imbue(std::locale::classic());
        json << "STREAMEE_OPTIFLOW {\"state\":\"active\",\"inputs\":" << inputs_
             << ",\"outputs\":" << outputs_ << ",\"repeated\":" << repeated_
             << ",\"width\":" << width_ << ",\"height\":" << height_
             << ",\"pinned\":" << (host_registered_ ? "true" : "false")
             << ",\"packMs\":" << pack_ms_ / inputs_
             << ",\"uploadMs\":" << upload_ms_ / inputs_
             << ",\"processMs\":" << process_ms_ / inputs_
             << ",\"downloadMs\":" << download_ms_ / outputs_
             << ",\"unpackMs\":" << unpack_ms_ / outputs_
             << ",\"syncMs\":" << sync_ms_ / inputs_ << "}";
        vsapi->logMessage(mtInformation, json.str().c_str(), core);
    }

  private:
    void cleanup() noexcept {
        CUcontext previous{};
        cuda_.context_get_current(&previous);
        if (previous == context_) {
            previous = nullptr;
        }
        set_context();
        if (handle_) {
            nvfruc::UnregisterResourceParams unregister{};
            unregister.resources[0] = &interpolation_.pointer;
            unregister.resources[1] = &render_[0].pointer;
            unregister.resources[2] = &render_[1].pointer;
            unregister.count = 3;
            runtime_.unregister_resources(handle_, &unregister);
            runtime_.destroy(handle_);
            handle_ = nullptr;
        }
        for (auto &surface : render_) {
            if (surface.pointer) {
                cuda_.memory_free(surface.pointer);
                surface.pointer = 0;
            }
        }
        if (interpolation_.pointer) {
            cuda_.memory_free(interpolation_.pointer);
            interpolation_.pointer = 0;
        }
        if (host_registered_) {
            cuda_.host_unregister(host_buffer_.data());
            host_registered_ = false;
        }
        if (context_) {
            cuda_.context_destroy(context_);
            context_ = nullptr;
        }
        cuda_.context_set_current(previous);
    }
    void create_context() {
        require_cuda(cuda_.init(0), "cuInit");
        int count = 0;
        require_cuda(cuda_.device_count(&count), "cuDeviceGetCount");
        if (count < 1) {
            throw std::runtime_error("No CUDA-capable NVIDIA GPU is available");
        }
        CUdevice device{};
        require_cuda(cuda_.device_get(&device, 0), "cuDeviceGet");
        require_cuda(cuda_.context_create(&context_, 0, device), "cuCtxCreate");
    }

    void create_surfaces() {
        for (auto &surface : render_) {
            require_cuda(cuda_.memory_allocate(&surface.pointer, bytes_), "cuMemAlloc input");
        }
        require_cuda(cuda_.memory_allocate(&interpolation_.pointer, bytes_), "cuMemAlloc output");
    }

    void create_fruc() {
        nvfruc::CreateParams create{};
        create.width = static_cast<std::uint32_t>(width_);
        create.height = static_cast<std::uint32_t>(height_);
        create.device = nullptr;
        create.resource_type = nvfruc::ResourceType::Cuda;
        create.surface_format = nvfruc::SurfaceFormat::NV12;
        create.cuda_resource_type = nvfruc::CudaResourceType::DevicePointer;
        require_status(runtime_.create(&create, &handle_), "NvOFFRUCCreate");

        nvfruc::RegisterResourceParams registration{};
        registration.resources[0] = &interpolation_.pointer;
        registration.resources[1] = &render_[0].pointer;
        registration.resources[2] = &render_[1].pointer;
        registration.count = 3;
        require_status(runtime_.register_resources(handle_, &registration), "NvOFFRUCRegisterResource");
    }

    void upload(CudaSurface &surface, const VSFrame *frame, const VSAPI *vsapi) {
        auto started = Clock::now();
        const auto *source_y = vsapi->getReadPtr(frame, 0);
        const auto *source_u = vsapi->getReadPtr(frame, 1);
        const auto *source_v = vsapi->getReadPtr(frame, 2);
        const auto stride_y = vsapi->getStride(frame, 0);
        const auto stride_u = vsapi->getStride(frame, 1);
        const auto stride_v = vsapi->getStride(frame, 2);
        auto *target_y = host_buffer_.data();
        auto *target_uv = target_y + static_cast<std::size_t>(width_) * height_;

        nv12::copy_plane(source_y, stride_y, target_y, width_, width_, height_);
        for (int y = 0; y < height_ / 2; ++y) {
            auto *row = target_uv + static_cast<std::size_t>(y) * width_;
            nv12::interleave(source_u + y * stride_u, source_v + y * stride_v, row, width_ / 2);
        }

        pack_ms_ += elapsed_ms(started);
        started = Clock::now();
        require_cuda(cuda_.copy_host_to_device(surface.pointer, host_buffer_.data(), bytes_),
                     "cuMemcpyHtoD");
        upload_ms_ += elapsed_ms(started);
    }

    void unpack(VSFrame *frame, const VSAPI *vsapi) {
        auto started = Clock::now();
        require_cuda(cuda_.copy_device_to_host(host_buffer_.data(), interpolation_.pointer, bytes_),
                     "cuMemcpyDtoH");
        download_ms_ += elapsed_ms(started);
        started = Clock::now();

        auto *target_y = vsapi->getWritePtr(frame, 0);
        auto *target_u = vsapi->getWritePtr(frame, 1);
        auto *target_v = vsapi->getWritePtr(frame, 2);
        const auto stride_y = vsapi->getStride(frame, 0);
        const auto stride_u = vsapi->getStride(frame, 1);
        const auto stride_v = vsapi->getStride(frame, 2);
        const auto *source_y = host_buffer_.data();
        const auto *source_uv = source_y + static_cast<std::size_t>(width_) * height_;

        nv12::copy_plane(source_y, width_, target_y, stride_y, width_, height_);
        for (int y = 0; y < height_ / 2; ++y) {
            const auto *row = source_uv + static_cast<std::size_t>(y) * width_;
            nv12::deinterleave(row, target_u + y * stride_u, target_v + y * stride_v, width_ / 2);
        }
        unpack_ms_ += elapsed_ms(started);
    }

    void set_context() noexcept {
        if (context_) {
            cuda_.context_set_current(context_);
        }
    }

    RuntimeLibrary runtime_;
    CudaDriver cuda_;
    int width_{};
    int height_{};
    std::size_t bytes_{};
    std::vector<std::uint8_t> host_buffer_;
    CUcontext context_{};
    bool host_registered_{};
    std::array<CudaSurface, 2> render_{};
    CudaSurface interpolation_{};
    nvfruc::Handle handle_{};
    unsigned next_render_{1};
    std::uint64_t inputs_{}, outputs_{}, repeated_{};
    double pack_ms_{}, upload_ms_{}, process_ms_{}, download_ms_{}, unpack_ms_{}, sync_ms_{};
};

struct FilterData {
    VSNode *node{};
    VSVideoInfo output_info{};
    std::filesystem::path runtime_dir;
    std::unique_ptr<FrucPipeline> pipeline;
    int last_submitted{-1};
    bool bypassed{false};
    std::mutex lock;
};

void halve_duration(VSFrame *frame, const VSAPI *vsapi) {
    VSMap *properties = vsapi->getFramePropertiesRW(frame);
    int numerator_error = 0;
    int denominator_error = 0;
    const auto numerator = vsapi->mapGetInt(properties, "_DurationNum", 0, &numerator_error);
    const auto denominator = vsapi->mapGetInt(properties, "_DurationDen", 0, &denominator_error);
    if (!numerator_error && !denominator_error && numerator > 0 && denominator > 0 &&
        denominator <= std::numeric_limits<std::int64_t>::max() / 2) {
        vsapi->mapSetInt(properties, "_DurationDen", denominator * 2, maReplace);
    }
}

void ensure_pipeline(FilterData &data) {
    if (!data.pipeline) {
        data.pipeline = std::make_unique<FrucPipeline>(data.runtime_dir, data.output_info.width,
                                                       data.output_info.height);
        data.last_submitted = -1;
    }
}

const VSFrame *VS_CC get_frame(int n, int activation_reason, void *instance_data, void **,
                               VSFrameContext *frame_context, VSCore *core, const VSAPI *vsapi) {
    auto &data = *static_cast<FilterData *>(instance_data);
    const int source_index = n / 2;

    if (activation_reason == arInitial) {
        vsapi->requestFrameFilter(source_index, data.node, frame_context);
        if ((n & 1) != 0) {
            vsapi->requestFrameFilter(source_index + 1, data.node, frame_context);
        }
        return nullptr;
    }
    if (activation_reason != arAllFramesReady) {
        return nullptr;
    }

    const VSFrame *left = vsapi->getFrameFilter(source_index, data.node, frame_context);
    const VSFrame *right = nullptr;
    VSFrame *output = nullptr;
    if ((n & 1) != 0) {
        right = vsapi->getFrameFilter(source_index + 1, data.node, frame_context);
    }

    std::scoped_lock guard(data.lock);
    try {
        if (data.bypassed) {
            output = vsapi->copyFrame(left, core);
            halve_duration(output, vsapi);
            vsapi->freeFrame(left);
            if (right) vsapi->freeFrame(right);
            return output;
        }
        ensure_pipeline(data);

        if (data.last_submitted != source_index) {
            if (data.last_submitted >= 0 && data.last_submitted + 1 != source_index) {
                data.pipeline.reset();
                ensure_pipeline(data);
            }
            const double input_time = static_cast<double>(source_index) + 1.0;
            data.pipeline->submit(left, input_time, input_time - 0.5, false, nullptr, vsapi);
            data.last_submitted = source_index;
        }

        if ((n & 1) == 0) {
            output = vsapi->copyFrame(left, core);
            halve_duration(output, vsapi);
            vsapi->freeFrame(left);
            return output;
        }

        output = vsapi->newVideoFrame(&data.output_info.format, data.output_info.width,
                                      data.output_info.height, left, core);
        data.pipeline->submit(right, static_cast<double>(source_index) + 2.0,
                              static_cast<double>(source_index) + 1.5, true, output, vsapi);
        data.pipeline->report(vsapi, core);
        data.last_submitted = source_index + 1;
        halve_duration(output, vsapi);
        vsapi->freeFrame(left);
        vsapi->freeFrame(right);
        return output;
    } catch (const std::exception &error) {
        data.bypassed = true;
        report_state("fallback-processing", vsapi, core);
        data.pipeline.reset();
        vsapi->logMessage(mtWarning,
            (std::string("Streamee NVFRUC disabled for this filter; repeating source frames: ") +
             error.what()).c_str(), core);
        if (output) {
            vsapi->freeFrame(output);
        }
        // The output rate is already negotiated. Repeat source frames at that
        // rate rather than changing timestamps or terminating video playback.
        output = vsapi->copyFrame(left, core);
        halve_duration(output, vsapi);
        if (left) {
            vsapi->freeFrame(left);
        }
        if (right) {
            vsapi->freeFrame(right);
        }
        return output;
    }
}

void VS_CC free_filter(void *instance_data, VSCore *, const VSAPI *vsapi) {
    auto *data = static_cast<FilterData *>(instance_data);
    vsapi->freeNode(data->node);
    delete data;
}

void VS_CC create_filter(const VSMap *input, VSMap *output, void *, VSCore *core, const VSAPI *vsapi) {
    int error = 0;
    VSNode *node = vsapi->mapGetNode(input, "clip", 0, &error);
    if (error || !node) {
        vsapi->mapSetError(output, "Streamee NVFRUC: clip is required");
        return;
    }

    const VSVideoInfo *input_info = vsapi->getVideoInfo(node);
    const auto &format = input_info->format;
    if (format.colorFamily != cfYUV || format.sampleType != stInteger || format.bitsPerSample != 8 ||
        format.bytesPerSample != 1 || format.subSamplingW != 1 || format.subSamplingH != 1 ||
        format.numPlanes != 3 || input_info->width <= 0 || input_info->height <= 0 ||
        (input_info->width & 1) || (input_info->height & 1)) {
        vsapi->freeNode(node);
        vsapi->mapSetError(output, "Streamee NVFRUC WIP supports constant-format 8-bit YUV 4:2:0 video only");
        return;
    }

    int runtime_error = 0;
    const char *runtime = vsapi->mapGetData(input, "runtime", 0, &runtime_error);
    if (runtime_error || !runtime || !*runtime) {
        vsapi->freeNode(node);
        vsapi->mapSetError(output, "Streamee NVFRUC: runtime directory is required");
        return;
    }

    auto data = std::make_unique<FilterData>();
    data->node = node;
    data->output_info = *input_info;
    data->runtime_dir = std::filesystem::u8path(runtime);
    try {
        // Probe the actual runtime, GPU, allocations and resource registration
        // before advertising a doubled frame rate to the caller.
        ensure_pipeline(*data);
    } catch (const std::exception &error) {
        vsapi->logMessage(mtWarning,
            (std::string("Streamee NVFRUC initialization failed; using original video: ") +
             error.what()).c_str(), core);
        report_state("fallback-initialization", vsapi, core);
        vsapi->mapSetNode(output, "clip", node, maReplace);
        vsapi->freeNode(node);
        return;
    }
    report_state("ready", vsapi, core);
    if (data->output_info.fpsNum > 0 &&
        data->output_info.fpsNum <= std::numeric_limits<std::int64_t>::max() / 2) {
        data->output_info.fpsNum *= 2;
    }
    if (data->output_info.numFrames > 0) {
        const auto doubled = static_cast<std::int64_t>(data->output_info.numFrames) * 2 - 1;
        data->output_info.numFrames = static_cast<int>(std::min<std::int64_t>(doubled, std::numeric_limits<int>::max()));
    }

    VSFilterDependency dependencies[] = {{node, rpFrameReuseLastOnly}};
    FilterData *filter_data = data.release();
    vsapi->createVideoFilter(output, "FrameRate2x", &filter_data->output_info, get_frame, free_filter,
                             fmFrameState, dependencies, 1, filter_data, core);
}

} // namespace

VS_EXTERNAL_API(void) VapourSynthPluginInit2(VSPlugin *plugin, const VSPLUGINAPI *vspapi) {
    vspapi->configPlugin("app.streamee.nvfruc", "streamee_nvfruc",
                         "Streamee NVIDIA Optical Flow FRUC adapter (WIP)", VS_MAKE_VERSION(0, 1),
                         VAPOURSYNTH_API_VERSION, 0, plugin);
    vspapi->registerFunction("FrameRate2x", "clip:vnode;runtime:data;", "clip:vnode;", create_filter,
                             nullptr, plugin);
}
