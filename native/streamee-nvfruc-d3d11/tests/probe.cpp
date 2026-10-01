#include "pipeline.hpp"
#include "bridge.h"
#include <dxgi1_2.h>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>
#include <cstdint>

using namespace streamee::optiflow;
static std::uint64_t checksum_rows(const unsigned char *data, UINT pitch, UINT width, UINT height) {
    std::uint64_t hash = 1469598103934665603ull;
    for (UINT y = 0; y < height * 3 / 2; ++y)
        for (UINT x = 0; x < width; ++x) { hash ^= data[y * pitch + x]; hash *= 1099511628211ull; }
    return hash;
}
int wmain(int argc, wchar_t **argv) {
    if((argc != 3 && argc != 5) || std::wstring(argv[1]) != L"--run-gpu-probe") {
        std::puts("Isolated prototype, not integrated with MPV.\n"
                  "Explicit hardware probe: nvfruc_d3d11_probe --run-gpu-probe <absolute-runtime-directory> [width height]\n"
                  "Checks constant chroma, input upload and shared copies at the requested dimensions.\n"
                  "No GPU work is performed without that flag. This does not test overall visual quality.");
        return argc == 1 ? 0 : 2;
    }
    try {
        ComPtr<IDXGIFactory1> factory;
        if(FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) throw std::runtime_error("DXGI factory unavailable");
        ComPtr<IDXGIAdapter1> adapter;
        for(UINT index=0; ; ++index) {
            ComPtr<IDXGIAdapter1> candidate;
            const auto status = factory->EnumAdapters1(index, &candidate);
            if(status == DXGI_ERROR_NOT_FOUND) break;
            if(FAILED(status)) throw std::runtime_error("DXGI adapter enumeration failed");
            DXGI_ADAPTER_DESC1 d{};
            if(candidate && SUCCEEDED(candidate->GetDesc1(&d)) && d.VendorId == 0x10de) { adapter=candidate; break; }
        }
        if(!adapter) throw std::runtime_error("No NVIDIA D3D11 adapter");
        ComPtr<ID3D11Device> device;
        ComPtr<ID3D11DeviceContext> context;
        if(FAILED(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0,
                                   nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context)))
            throw std::runtime_error("D3D11 device creation failed");
        const UINT width=argc == 5 ? std::stoul(argv[3]) : 640;
        const UINT height=argc == 5 ? std::stoul(argv[4]) : 360;
        streamee_optiflow_api api{};
        if (streamee_optiflow_d3d11_get_api(STREAMEE_OPTIFLOW_D3D11_ABI, &api, sizeof(api)) != STREAMEE_OPTIFLOW_OK)
            throw std::runtime_error("Prototype DLL ABI unavailable");
        struct Session {
            streamee_optiflow_api &api;
            void *handle{};
            ~Session() { api.destroy(handle); }
        } session{api};
        char error[512]{};
        streamee_optiflow_config config{sizeof(config), DXGI_FORMAT_NV12, width, height,
            0, 0, width, height, 0, 0.5f, 0, 0, 0, 0};
        if (api.create(device.Get(), &config, &session.handle, error, sizeof(error)) != STREAMEE_OPTIFLOW_OK)
            throw std::runtime_error(error);
        // Only fixture creation uploads CPU bytes. The pipeline must never map,
        // upload, or read back pixels; a future host supplies decoded GPU textures.
        std::vector<unsigned char> seed(width*height*3/2, 128);
        D3D11_SUBRESOURCE_DATA initial{};
        initial.pSysMem=seed.data(); initial.SysMemPitch=width;
        D3D11_TEXTURE2D_DESC description{};
        description.Width=width; description.Height=height; description.MipLevels=1;
        description.ArraySize=1; description.Format=DXGI_FORMAT_NV12; description.SampleDesc.Count=1;
        ComPtr<ID3D11Texture2D> fixture;
        if(FAILED(device->CreateTexture2D(&description,&initial,&fixture))) throw std::runtime_error("Fixture allocation failed");
        auto shared_desc = description;
        shared_desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
        ComPtr<ID3D11Texture2D> shared_fixture;
        if (FAILED(device->CreateTexture2D(&shared_desc,nullptr,&shared_fixture))) throw std::runtime_error("Shared fixture allocation failed");
        D3D11_TEXTURE2D_DESC staging_description = description;
        staging_description.Usage = D3D11_USAGE_STAGING;
        staging_description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> staging;
        if(FAILED(device->CreateTexture2D(&staging_description,nullptr,&staging))) throw std::runtime_error("Readback fixture allocation failed");
        UINT delivered=0, repeated=0, synthesized=0;
        std::uint64_t prior_input=0;
        // Keep all outputs alive to exercise ownership across subsequent submits.
        std::vector<ComPtr<ID3D11Texture2D>> retained;
        for(int n=0; n<6; ++n) {
            for (UINT y=0; y<height; ++y) for (UINT x=0; x<width; ++x)
                seed[y*width+x] = static_cast<unsigned char>(16 + ((x + y + n*29) % 220));
            for (UINT y=height; y<height*3/2; ++y) for (UINT x=0; x<width; x+=2) {
                seed[y*width+x] = 96;
                seed[y*width+x+1] = 160;
            }
            const auto input_checksum = checksum_rows(seed.data(), width, width, height);
            context->UpdateSubresource(fixture.Get(), 0, nullptr, seed.data(), width, 0);
            context->CopyResource(staging.Get(), fixture.Get());
            D3D11_MAPPED_SUBRESOURCE source_map{};
            if (FAILED(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&source_map))) throw std::runtime_error("Input readback failed");
            const auto source_hash = checksum_rows(static_cast<unsigned char *>(source_map.pData), source_map.RowPitch, width, height);
            context->Unmap(staging.Get(),0);
            if (source_hash != input_checksum) throw std::runtime_error("Input upload was corrupted");
            context->CopySubresourceRegion(shared_fixture.Get(),0,0,0,0,fixture.Get(),0,nullptr);
            context->CopyResource(staging.Get(),shared_fixture.Get());
            if (FAILED(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&source_map))) throw std::runtime_error("Shared readback failed");
            const auto shared_hash = checksum_rows(static_cast<unsigned char *>(source_map.pData), source_map.RowPitch, width, height);
            context->Unmap(staging.Get(),0);
            if (shared_hash != input_checksum) throw std::runtime_error("Shared input copy was corrupted");
            streamee_optiflow_output result{};
            if (api.submit(session.handle, fixture.Get(), 0, static_cast<double>(n)/24.0, 1,
                           &result, error, sizeof(error)) != STREAMEE_OPTIFLOW_OK)
                throw std::runtime_error(error);
            if(result.texture) {
                ComPtr<ID3D11Texture2D> owned;
                owned.Attach(static_cast<ID3D11Texture2D *>(result.texture));
                D3D11_TEXTURE2D_DESC output{}; owned->GetDesc(&output);
                if(output.CPUAccessFlags || output.Usage != D3D11_USAGE_DEFAULT || output.Format != DXGI_FORMAT_NV12)
                    throw std::runtime_error("Output residency contract failed");
                for(const auto &prior : retained)
                    if(prior.Get() == owned.Get()) throw std::runtime_error("Output reused while retained");
                retained.push_back(owned);
                context->CopyResource(staging.Get(), owned.Get());
                D3D11_MAPPED_SUBRESOURCE mapped{};
                if(FAILED(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped))) throw std::runtime_error("Probe readback failed");
                const auto output_checksum = checksum_rows(static_cast<unsigned char *>(mapped.pData), mapped.RowPitch, width, height);
                unsigned bad_chroma = 0;
                const auto pixels = static_cast<unsigned char *>(mapped.pData);
                for (UINT y=height; y<height*3/2; ++y) for (UINT x=0; x<width; ++x) {
                    const int expected = (x & 1) ? 160 : 96;
                    if (std::abs(int(pixels[y*mapped.RowPitch+x]) - expected) > 2) ++bad_chroma;
                }
                context->Unmap(staging.Get(),0);
                std::printf("Frame %d: bad chroma bytes=%u / %u\n", n, bad_chroma, width*height/2);
                if (bad_chroma) throw std::runtime_error("Constant chroma was corrupted");
                if(output_checksum != prior_input && output_checksum != input_checksum) ++synthesized;
                ++delivered;
                if(result.repeated) ++repeated;
            } else if(n != 0) throw std::runtime_error("Unexpected missing output");
            prior_input = input_checksum;
        }
        std::printf("GPU moving-pattern probe through C DLL ABI returned %u textures (%u distinct from both inputs, %u driver repeats). Readback is probe-only.\n", delivered,synthesized,repeated);
        // Explicit sizes test colour integrity even when FRUC repeats the input.
        // The default moving-pattern test additionally requires synthesis.
        return delivered == 5 && (argc == 5 || synthesized > 0) ? 0 : 1;
    } catch(const std::exception &error) {
        std::fprintf(stderr,"Prototype unavailable: %s\n",error.what());
        return 1;
    }
}
