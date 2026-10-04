/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "pipeline.hpp"
#include "nvof/nvOpticalFlowD3D11.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>
#include "Analysis.h"
#include "Cut.h"
#include "Validate.h"
#include "Repair.h"
#include "Warp.h"
#include "Down.h"
#include "Up.h"
#include "Pack.h"
#include "Dense.h"
#include "Refine.h"
namespace streamee::optiflow {
namespace {
void check(HRESULT r, const char *op) {
    if (FAILED(r)) throw std::runtime_error(std::string(op)+" HRESULT="+std::to_string(r));
}
void ofcheck(NV_OF_STATUS r, const char *op) {
    if(r!=NV_OF_SUCCESS) throw std::runtime_error(std::string(op)+" NVOF="+std::to_string(r));
}
struct Module {
    HMODULE value{};
    ~Module() { if(value) FreeLibrary(value); }
};
struct Surface {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<ID3D11ShaderResourceView> srv, uv;
    ComPtr<ID3D11UnorderedAccessView> uav, uav_uv;
    UINT width{}, height{};
};
struct alignas(16) Parameters {
    UINT width, height, visible_width, visible_height, left, top, gw, gh;
    UINT step, ten_bit, plane, level;
    float chroma_x, chroma_y, spare[2];
};
}
void validate_config(const streamee_optiflow_config &c) {
    if(c.size!=sizeof(c) || (c.format!=DXGI_FORMAT_NV12 && c.format!=DXGI_FORMAT_P010) ||
       !c.width || !c.height || ((c.width|c.height)&1) ||
       c.width>D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION || c.height>D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION ||
       !c.visible_width || !c.visible_height || c.left>=c.width || c.top>=c.height ||
       c.visible_width>c.width-c.left || c.visible_height>c.height-c.top ||
       !std::isfinite(c.chroma_x) || !std::isfinite(c.chroma_y) ||
       c.chroma_x<0 || c.chroma_x>1 || c.chroma_y<0 || c.chroma_y>1)
        throw std::invalid_argument("Invalid NV12/P010 surface, crop or chroma siting");
}
void validate_frame(const D3D11_TEXTURE2D_DESC &d, UINT slice, UINT w, UINT h,
                    double time, std::optional<double> previous) {
    if(!w || !h || ((w|h)&1) || w>16384 || h>16384 ||
       (d.Format!=DXGI_FORMAT_NV12 && d.Format!=DXGI_FORMAT_P010) ||
       d.Width!=w || d.Height!=h || d.MipLevels!=1 || slice>=d.ArraySize ||
       d.SampleDesc.Count!=1 || d.Usage!=D3D11_USAGE_DEFAULT || d.CPUAccessFlags ||
       !std::isfinite(time) || (previous && (!std::isfinite(*previous) || time<=*previous)))
        throw std::invalid_argument("Invalid GPU surface/slice or non-increasing timestamp");
}
struct Pipeline::Impl {
    Module module;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    NV_OF_D3D11_API_FUNCTION_LIST api{};
    NvOFHandle handle{};
    std::vector<NvOFGPUBufferHandle> registrations;
    std::array<Surface,2> sources, analysis, flow, cost;
    std::array<Surface,2> registered_flow, registered_cost;
    std::array<Surface,2> refined_flow;
    std::array<std::array<Surface,2>,2> repaired;
    std::array<Surface,2> dense;
    Surface output;
    std::vector<Surface> pyramid, filled;
    std::array<NvOFGPUBufferHandle,2> analysis_handles{}, flow_handles{}, cost_handles{};
    std::array<ComPtr<ID3D11ComputeShader>,10> shaders;
    ComPtr<ID3D11Buffer> constants, reduction, readback;
    ComPtr<ID3D11UnorderedAccessView> reduction_uav;
    ComPtr<ID3D11SamplerState> sampler;
    ComPtr<ID3D11Query> disjoint, ready;
    std::array<ComPtr<ID3D11Query>,5> stamps;
    streamee_optiflow_config config{};
    streamee_optiflow_caps capabilities{};
    streamee_optiflow_stats statistics{};
    Parameters params{};
    UINT next{};
    bool poisoned{}, reset_hints{true};
    std::optional<double> previous;
    ~Impl() {
        if(handle) {
            for(auto r: registrations) api.nvOFUnregisterResourceD3D11(r);
            api.nvOFDestroy(handle);
        }
    }
    void unbind() {
        ID3D11ShaderResourceView *srvs[12]{};
        ID3D11UnorderedAccessView *uavs[7]{};
        context->CSSetShaderResources(0,12,srvs);
        context->CSSetUnorderedAccessViews(0,7,uavs,nullptr);
    }
    Surface surface(UINT w,UINT h,DXGI_FORMAT format,bool writable=true,bool planar=false) {
        Surface s; s.width=w; s.height=h;
        D3D11_TEXTURE2D_DESC d{};
        d.Width=w;d.Height=h;d.MipLevels=d.ArraySize=d.SampleDesc.Count=1;
        d.Format=format;d.BindFlags=D3D11_BIND_SHADER_RESOURCE|(writable?D3D11_BIND_UNORDERED_ACCESS|D3D11_BIND_RENDER_TARGET:0);
        check(device->CreateTexture2D(&d,nullptr,&s.texture),"Create GPU texture");
        D3D11_SHADER_RESOURCE_VIEW_DESC v{};
        v.ViewDimension=D3D11_SRV_DIMENSION_TEXTURE2D;v.Texture2D.MipLevels=1;
        v.Format=planar?(format==DXGI_FORMAT_P010?DXGI_FORMAT_R16_UNORM:DXGI_FORMAT_R8_UNORM):format;
        check(device->CreateShaderResourceView(s.texture.Get(),&v,&s.srv),"Create SRV");
        if(planar) {
            v.Format=format==DXGI_FORMAT_P010?DXGI_FORMAT_R16G16_UNORM:DXGI_FORMAT_R8G8_UNORM;
            check(device->CreateShaderResourceView(s.texture.Get(),&v,&s.uv),"Create UV SRV");
        }
        if(writable) {
            D3D11_UNORDERED_ACCESS_VIEW_DESC u{};
            u.ViewDimension=D3D11_UAV_DIMENSION_TEXTURE2D;
            u.Format=planar?(format==DXGI_FORMAT_P010?DXGI_FORMAT_R16_UINT:DXGI_FORMAT_R8_UINT):format;
            check(device->CreateUnorderedAccessView(s.texture.Get(),&u,&s.uav),"Create UAV");
            if(planar) {
                u.Format=format==DXGI_FORMAT_P010?DXGI_FORMAT_R16G16_UINT:DXGI_FORMAT_R8G8_UINT;
                check(device->CreateUnorderedAccessView(s.texture.Get(),&u,&s.uav_uv),"Create UV UAV");
            }
        }
        UINT bytes=16;
        if(planar) bytes=format==DXGI_FORMAT_P010?3:0;
        else if(format==DXGI_FORMAT_R8G8B8A8_UNORM || format==DXGI_FORMAT_R16G16_SINT || format==DXGI_FORMAT_R32_UINT) bytes=4;
        else if(format==DXGI_FORMAT_R8_UINT || format==DXGI_FORMAT_R8_UNORM) bytes=1;
        statistics.allocated_bytes+=bytes?uint64_t(w)*h*bytes:uint64_t(w)*h*3/2;
        return s;
    }
    std::vector<UINT> cap(NV_OF_CAPS key) {
        UINT count=0;ofcheck(api.nvOFGetCaps(handle,key,nullptr,&count),"Count capabilities");
        if(!count || count>128) throw std::runtime_error("Invalid NVOFA capability count");
        std::vector<UINT> values(count);
        ofcheck(api.nvOFGetCaps(handle,key,values.data(),&count),"Query capabilities");return values;
    }
    std::vector<DXGI_FORMAT> formats(NV_OF_BUFFER_USAGE usage) {
        UINT count=0;ofcheck(api.nvOFGetSurfaceFormatCountD3D11(handle,usage,NV_OF_MODE_OPTICALFLOW,&count),"Count NVOFA formats");
        if(!count || count>128) throw std::runtime_error("Invalid NVOFA format count");
        std::vector<DXGI_FORMAT> values(count);
        ofcheck(api.nvOFGetSurfaceFormatD3D11(handle,usage,NV_OF_MODE_OPTICALFLOW,values.data()),"Query NVOFA formats");
        return values;
    }
    NvOFGPUBufferHandle register_surface(Surface &s) {
        NvOFGPUBufferHandle r{};
        ofcheck(api.nvOFRegisterResourceD3D11(handle,s.texture.Get(),&r),"Register NVOFA texture");
        registrations.push_back(r);return r;
    }
    void initialize(ID3D11Device *borrowed,const streamee_optiflow_config &c) {
        if(!borrowed) throw std::invalid_argument("D3D11 device required");
        validate_config(c);config=c;device=borrowed;device->GetImmediateContext(&context);
        ComPtr<IDXGIDevice> dxgi;check(device.As(&dxgi),"DXGI device");
        ComPtr<IDXGIAdapter> adapter;check(dxgi->GetAdapter(&adapter),"DXGI adapter");
        DXGI_ADAPTER_DESC desc{};check(adapter->GetDesc(&desc),"Adapter description");
        if(desc.VendorId!=0x10de) throw std::runtime_error("NVOFA requires an NVIDIA decoder device");
        module.value=LoadLibraryExW(L"nvofapi64.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
        if(!module.value) throw std::runtime_error("NVIDIA driver optical-flow API unavailable");
        using MaxVersion=NV_OF_STATUS(NVOFAPI *)(uint32_t *);
        using Create=NV_OF_STATUS(NVOFAPI *)(uint32_t,NV_OF_D3D11_API_FUNCTION_LIST *);
        auto max_version=reinterpret_cast<MaxVersion>(GetProcAddress(module.value,"NvOFGetMaxSupportedApiVersion"));
        auto create=reinterpret_cast<Create>(GetProcAddress(module.value,"NvOFAPICreateInstanceD3D11"));
        UINT version=0;
        if(!max_version || !create) throw std::runtime_error("NVOFA API exports unavailable");
        ofcheck(max_version(&version),"Query NVOFA version");
        if(version<NV_OF_API_VERSION) throw std::runtime_error("NVOFA driver API is older than the build interface");
        ofcheck(create(NV_OF_API_VERSION,&api),"Create NVOFA API");
        ofcheck(api.nvCreateOpticalFlowD3D11(device.Get(),context.Get(),&handle),"Create NVOFA session");
        capabilities={sizeof(capabilities),version,cap(NV_OF_CAPS_WIDTH_MIN)[0],cap(NV_OF_CAPS_HEIGHT_MIN)[0],
                      cap(NV_OF_CAPS_WIDTH_MAX)[0],cap(NV_OF_CAPS_HEIGHT_MAX)[0],4,1,1};
        if(c.width<capabilities.min_width || c.height<capabilities.min_height ||
           c.width>capabilities.max_width || c.height>capabilities.max_height)
            throw std::runtime_error("Dimensions outside NVOFA capabilities");
        auto grids=cap(NV_OF_CAPS_SUPPORTED_OUTPUT_GRID_SIZES);
        if(std::find(grids.begin(),grids.end(),4u)==grids.end()) throw std::runtime_error("NVOFA 4x4 flow unavailable");
        auto require=[&](NV_OF_BUFFER_USAGE usage,DXGI_FORMAT f) {
            auto list=formats(usage);
            if(std::find(list.begin(),list.end(),f)==list.end()) {
                std::string values;
                for(auto value:list) values += " " + std::to_string(value);
                throw std::runtime_error("NVOFA format " + std::to_string(f) + " usage " +
                    std::to_string(usage) + " unavailable; supported:" + values);
            }
        };
        require(NV_OF_BUFFER_USAGE_INPUT,DXGI_FORMAT_R8_UNORM);
        require(NV_OF_BUFFER_USAGE_OUTPUT,DXGI_FORMAT_R16G16_SINT);
        auto costs=formats(NV_OF_BUFFER_USAGE_COST);
        DXGI_FORMAT cost_format=std::find(costs.begin(),costs.end(),DXGI_FORMAT_R8_UINT)!=costs.end()?DXGI_FORMAT_R8_UINT:DXGI_FORMAT_R32_UINT;
        require(NV_OF_BUFFER_USAGE_COST,cost_format);
        NV_OF_INIT_PARAMS init{};
        init.width=c.width;init.height=c.height;init.outGridSize=NV_OF_OUTPUT_VECTOR_GRID_SIZE_4;
        init.mode=NV_OF_MODE_OPTICALFLOW;init.perfLevel=NV_OF_PERF_LEVEL_SLOW;
        init.enableOutputCost=NV_OF_TRUE;init.predDirection=NV_OF_PRED_DIRECTION_BOTH;
        init.inputBufferFormat=NV_OF_BUFFER_FORMAT_GRAYSCALE8;
        ofcheck(api.nvOFInit(handle,&init),"Initialize bidirectional NVOFA");
        params={c.width,c.height,c.visible_width,c.visible_height,c.left,c.top,(c.width+3)/4,(c.height+3)/4,
                0,c.format==DXGI_FORMAT_P010?1u:0u,0,0,c.chroma_x,c.chroma_y,{0,0}};
        for(UINT i=0;i<2;i++) {
            sources[i]=surface(c.width,c.height,DXGI_FORMAT(c.format),false,true);
            analysis[i]=surface(c.width,c.height,DXGI_FORMAT_R8_UNORM);
            flow[i]=surface(params.gw,params.gh,DXGI_FORMAT_R16G16_SINT);
            refined_flow[i]=surface(params.gw,params.gh,DXGI_FORMAT_R16G16_SINT);
            cost[i]=surface(params.gw,params.gh,cost_format);
            registered_flow[i]=surface(params.gw,params.gh,DXGI_FORMAT_R16G16_SINT);
            registered_cost[i]=surface(params.gw,params.gh,cost_format);
            analysis_handles[i]=register_surface(analysis[i]);
            flow_handles[i]=register_surface(registered_flow[i]);cost_handles[i]=register_surface(registered_cost[i]);
            for(UINT j=0;j<2;j++) repaired[i][j]=surface(params.gw,params.gh,DXGI_FORMAT_R32G32B32A32_FLOAT);
            dense[i]=surface(c.width,c.height,DXGI_FORMAT_R32G32B32A32_FLOAT);
        }
        output=surface(c.width,c.height,DXGI_FORMAT(c.format),true,true);
        for(UINT w=c.width,h=c.height;;w=(w+1)/2,h=(h+1)/2) {
            pyramid.push_back(surface(w,h,DXGI_FORMAT_R32G32B32A32_FLOAT));
            // Packing resolves level zero directly from the warped image and
            // filled level one, avoiding a redundant full-resolution surface.
            filled.push_back(pyramid.size()==1 ? Surface{} : surface(w,h,DXGI_FORMAT_R32G32B32A32_FLOAT));
            if(w==1 && h==1) break;
        }
        const unsigned char *code[]={g_Analysis,g_Cut,g_Validate,g_Repair,g_Warp,g_Down,g_Up,g_Pack,g_Dense,g_Refine};
        const size_t sizes[]={sizeof(g_Analysis),sizeof(g_Cut),sizeof(g_Validate),sizeof(g_Repair),sizeof(g_Warp),sizeof(g_Down),sizeof(g_Up),sizeof(g_Pack),sizeof(g_Dense),sizeof(g_Refine)};
        for(size_t i=0;i<10;i++) check(device->CreateComputeShader(code[i],sizes[i],nullptr,&shaders[i]),"Create interpolation shader");
        D3D11_BUFFER_DESC b{};b.ByteWidth=sizeof(params);b.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
        check(device->CreateBuffer(&b,nullptr,&constants),"Create constants");
        b={};b.ByteWidth=16;b.BindFlags=D3D11_BIND_UNORDERED_ACCESS;b.MiscFlags=D3D11_RESOURCE_MISC_BUFFER_STRUCTURED;b.StructureByteStride=4;
        check(device->CreateBuffer(&b,nullptr,&reduction),"Create control counters");
        D3D11_UNORDERED_ACCESS_VIEW_DESC u{};u.ViewDimension=D3D11_UAV_DIMENSION_BUFFER;u.Buffer.NumElements=4;
        check(device->CreateUnorderedAccessView(reduction.Get(),&u,&reduction_uav),"Create control UAV");
        b={};b.ByteWidth=16;b.Usage=D3D11_USAGE_STAGING;b.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
        check(device->CreateBuffer(&b,nullptr,&readback),"Create scalar readback");
        D3D11_SAMPLER_DESC s{};s.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        s.AddressU=s.AddressV=s.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;s.MaxLOD=D3D11_FLOAT32_MAX;
        check(device->CreateSamplerState(&s,&sampler),"Create sampler");
        D3D11_QUERY_DESC q{D3D11_QUERY_TIMESTAMP_DISJOINT,0};check(device->CreateQuery(&q,&disjoint),"Create timer");
        q.Query=D3D11_QUERY_EVENT;check(device->CreateQuery(&q,&ready),"Create completion query");
        q.Query=D3D11_QUERY_TIMESTAMP;
        for(auto &stamp:stamps) check(device->CreateQuery(&q,&stamp),"Create timestamp");
    }
    void bind_source(UINT a,UINT b) {
        ID3D11ShaderResourceView *v[]={sources[a].srv.Get(),sources[a].uv.Get(),sources[b].srv.Get(),sources[b].uv.Get(),
            flow[0].srv.Get(),flow[1].srv.Get(),cost[0].srv.Get(),cost[1].srv.Get()};
        context->CSSetShaderResources(0,8,v);
    }
    void fields(UINT slot) {
        ID3D11ShaderResourceView *v[]={repaired[slot][0].srv.Get(),repaired[slot][1].srv.Get()};
        context->CSSetShaderResources(8,2,v);
    }
    void images(Surface &a,Surface *b=nullptr) {
        ID3D11ShaderResourceView *v[]={a.srv.Get(),b?b->srv.Get():nullptr};context->CSSetShaderResources(10,2,v);
    }
    void dispatch(UINT shader,UINT w,UINT h,Surface *a=nullptr,Surface *b=nullptr,bool pack=false) {
        context->UpdateSubresource(constants.Get(),0,nullptr,&params,0,0);
        ID3D11Buffer *cb=constants.Get();context->CSSetConstantBuffers(0,1,&cb);
        ID3D11SamplerState *ss=sampler.Get();context->CSSetSamplers(0,1,&ss);
        ID3D11UnorderedAccessView *u[]={a?a->uav.Get():nullptr,b?b->uav.Get():nullptr,
            pack?output.uav.Get():nullptr,pack?output.uav_uv.Get():nullptr,(shader==1 || shader==2)?reduction_uav.Get():nullptr,
            shader==9?refined_flow[0].uav.Get():nullptr,shader==9?refined_flow[1].uav.Get():nullptr};
        context->CSSetUnorderedAccessViews(0,7,u,nullptr);
        context->CSSetShader(shaders[shader].Get(),nullptr,0);context->Dispatch((w+7)/8,(h+7)/8,1);
        unbind();
    }
    void wait() {
        context->End(ready.Get());context->Flush();
        const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
        BOOL done=FALSE;
        while(true) {
            auto r=context->GetData(ready.Get(),&done,sizeof(done),D3D11_ASYNC_GETDATA_DONOTFLUSH);
            check(r,"GPU completion");
            if(r==S_OK && done) break;
            check(device->GetDeviceRemovedReason(),"D3D11 device health");
            if(std::chrono::steady_clock::now()>deadline) throw std::runtime_error("OptiFlow GPU completion timeout");
            Sleep(0);
        }
    }
    void queue_scene_cut(UINT a,UINT b) {
        UINT zero[4]{};context->ClearUnorderedAccessViewUint(reduction_uav.Get(),zero);
        bind_source(a,b);dispatch(1,(config.visible_width+7)/8,(config.visible_height+7)/8);
    }
    std::array<UINT,4> read_control() {
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check(context->Map(readback.Get(),0,D3D11_MAP_READ,0,&mapped),"Read control counters");
        std::array<UINT,4> v{};std::copy_n(static_cast<UINT *>(mapped.pData),4,v.begin());context->Unmap(readback.Get(),0);
        return v;
    }
    void check_texture(ID3D11Texture2D *t,UINT slice,double time) {
        if(!t) throw std::invalid_argument("Input texture required");
        D3D11_TEXTURE2D_DESC d{};t->GetDesc(&d);validate_frame(d,slice,config.width,config.height,time,previous);
        if(uint32_t(d.Format)!=config.format) throw std::invalid_argument("Surface format changed");
        ComPtr<ID3D11Device> owner;t->GetDevice(&owner);
        ComPtr<IUnknown> a,b;check(owner.As(&a),"Surface device identity");check(device.As(&b),"Session device identity");
        if(a.Get()!=b.Get()) throw std::invalid_argument("Texture belongs to another D3D11 device");
    }
    Output submit(ID3D11Texture2D *input,UINT slice,double time,bool allow,ID3D11Texture2D *destination,UINT output_slice,bool allocate) {
        if(poisoned) throw std::runtime_error("Failed OptiFlow session requires reconstruction");
        check_texture(input,slice,time);
        if(destination) check_texture(destination,output_slice,time);
        else if(previous && !allocate) throw std::invalid_argument("Destination required after priming");
        poisoned=true;statistics.inputs++;
        UINT b=next,a=next^1;
        context->Begin(disjoint.Get());context->End(stamps[0].Get());
        context->CopySubresourceRegion(sources[b].texture.Get(),0,0,0,0,input,slice,nullptr);
        bind_source(b,b);dispatch(0,config.width,config.height,&analysis[b]);
        Output result{};result.priming=!previous;result.timestamp=previous?(*previous/2+time/2):time;
        if(previous && allow) queue_scene_cut(a,b);
        context->End(stamps[1].Get());
        if(previous && allow) {
            NV_OF_EXECUTE_INPUT_PARAMS in{};in.inputFrame=analysis_handles[a];in.referenceFrame=analysis_handles[b];
            in.disableTemporalHints=reset_hints?NV_OF_TRUE:NV_OF_FALSE;
            NV_OF_EXECUTE_OUTPUT_PARAMS out{};out.outputBuffer=flow_handles[0];out.bwdOutputBuffer=flow_handles[1];
            out.outputCostBuffer=cost_handles[0];out.bwdOutputCostBuffer=cost_handles[1];
            ofcheck(api.nvOFExecute(handle,&in,&out),"Execute bidirectional optical flow");
            for(UINT i=0;i<2;i++) {
                context->CopyResource(flow[i].texture.Get(),registered_flow[i].texture.Get());
                context->CopyResource(cost[i].texture.Get(),registered_cost[i].texture.Get());
            }
            wait();
            reset_hints=false;
        } else reset_hints=true;
        context->End(stamps[2].Get());
        UINT field_slot=0;
        if(previous && allow) {
            bind_source(a,b);dispatch(9,params.gw,params.gh);
            for(UINT i=0;i<2;i++) context->CopyResource(flow[i].texture.Get(),refined_flow[i].texture.Get());
            bind_source(a,b);dispatch(2,params.gw,params.gh,&repaired[0][0],&repaired[0][1]);
            UINT start=1;while(start<std::max(params.gw,params.gh)) start<<=1;
            for(UINT step=start/2;step;step>>=1) {
                params.step=step;bind_source(a,b);fields(field_slot);
                dispatch(3,params.gw,params.gh,&repaired[field_slot^1][0],&repaired[field_slot^1][1]);field_slot^=1;
            }
            bind_source(a,b);fields(field_slot);
            dispatch(8,config.width,config.height,&dense[0],&dense[1]);
        }
        context->End(stamps[3].Get());
        if(previous) {
            result.repeated=!allow;result.reason=!allow?STREAMEE_OPTIFLOW_METADATA_HOLD:STREAMEE_OPTIFLOW_SYNTHESIZED;
            if(result.repeated) {
                context->CopyResource(output.texture.Get(),sources[a].texture.Get());
                statistics.held++;statistics.metadata_holds++;
            } else {
                bind_source(a,b);
                ID3D11ShaderResourceView *v[]={dense[0].srv.Get(),dense[1].srv.Get()};
                context->CSSetShaderResources(8,2,v);
                dispatch(4,config.width,config.height,&pyramid[0]);
                for(size_t i=1;i<pyramid.size();i++) {images(pyramid[i-1]);dispatch(5,pyramid[i].width,pyramid[i].height,&pyramid[i]);}
                context->CopyResource(filled.back().texture.Get(),pyramid.back().texture.Get());
                for(size_t i=pyramid.size()-1;i>1;i--) {images(pyramid[i-1],&filled[i]);dispatch(6,filled[i-1].width,filled[i-1].height,&filled[i-1]);}
                bind_source(a,b);images(pyramid[0],&filled[1]);
                context->CSSetShaderResources(8,2,v);
                dispatch(7,config.width,config.height,nullptr,nullptr,true);
                statistics.synthesized++;
            }
            if(allocate) {
                D3D11_TEXTURE2D_DESC d{};output.texture->GetDesc(&d);
                d.BindFlags=D3D11_BIND_SHADER_RESOURCE|D3D11_BIND_RENDER_TARGET;
                check(device->CreateTexture2D(&d,nullptr,&result.texture),"Owned midpoint");
                destination=result.texture.Get();output_slice=0;
            }
            context->CopySubresourceRegion(destination,output_slice,0,0,0,output.texture.Get(),0,nullptr);
        }
        if(previous && allow) context->CopyResource(readback.Get(),reduction.Get());
        context->End(stamps[4].Get());context->End(disjoint.Get());wait();
        D3D11_QUERY_DATA_TIMESTAMP_DISJOINT timing{};
        if(context->GetData(disjoint.Get(),&timing,sizeof(timing),0)==S_OK && !timing.Disjoint && timing.Frequency) {
            UINT64 t[5]{};bool valid=true;
            for(size_t i=0;i<5;i++) valid &= context->GetData(stamps[i].Get(),&t[i],sizeof(t[i]),0)==S_OK;
            if(valid) {
                double factor=1000.0/double(timing.Frequency);
                statistics.analysis_ms=(t[1]-t[0])*factor;statistics.flow_ms=(t[2]-t[1])*factor;
                statistics.repair_ms=(t[3]-t[2])*factor;statistics.synthesis_ms=(t[4]-t[3])*factor;
                statistics.total_ms=(t[4]-t[0])*factor;
            }
        }
        auto control=previous && allow?read_control():std::array<UINT,4>{};
        double difference=double(control[0])/std::max(1u,control[1])/4095.0;
        double large_change=double(control[2])/std::max(1u,control[1]);
        double coverage=double(control[3])/(params.gw*params.gh);
        // A broad change with almost no bidirectionally reliable flow is also a
        // cut, even when its encoded luma range misses the bright-cut thresholds.
        bool cut=control[1] && ((difference>0.25 && large_change>0.65) ||
            (difference>0.10 && large_change>0.30 && coverage<0.10));
        if(previous && allow && (cut || !control[3])) {
            // Read only scalar control data after the existing completion boundary.
            // A cut discards synthesis and resets hints for the following pair.
            context->CopySubresourceRegion(destination,output_slice,0,0,0,sources[a].texture.Get(),0,nullptr);
            wait();
            result.repeated=true;result.reason=cut?STREAMEE_OPTIFLOW_SCENE_CUT:STREAMEE_OPTIFLOW_UNRELIABLE_FLOW;
            statistics.synthesized--;statistics.held++;statistics.scene_cuts+=cut;reset_hints=true;
        }
        previous=time;next^=1;poisoned=false;return result;
    }
};
Pipeline::Pipeline(ID3D11Device *d,const streamee_optiflow_config &c):impl_(std::make_unique<Impl>()) {impl_->initialize(d,c);}
Pipeline::~Pipeline()=default;
Output Pipeline::submit(ID3D11Texture2D *i,UINT s,double t,bool a) {return impl_->submit(i,s,t,a,nullptr,0,true);}
Output Pipeline::submit_into(ID3D11Texture2D *i,UINT s,double t,ID3D11Texture2D *o,UINT os,bool a) {return impl_->submit(i,s,t,a,o,os,false);}
streamee_optiflow_caps Pipeline::caps() const {return impl_->capabilities;}
streamee_optiflow_stats Pipeline::stats() const {return impl_->statistics;}
}
