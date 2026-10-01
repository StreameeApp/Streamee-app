/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "pipeline.hpp"
#include <dxgi1_2.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <vector>
using namespace streamee::optiflow;
static void check(HRESULT r) { if(FAILED(r)) throw std::runtime_error("Probe D3D11 failure "+std::to_string(r)); }
static double pattern(double x,double y) {
    return 0.48+0.12*std::sin(x*0.071)+0.10*std::cos(y*0.093)+0.06*std::sin((x+y)*0.19);
}
int main(int argc,char **argv) {
    if(argc<2 || std::strcmp(argv[1],"--run-gpu-probe")) {
        puts("Explicit GPU validation: optiflow_pixels --run-gpu-probe [width height bits frames]");return argc==1?0:2;
    }
    try {
        UINT w=argc>2?std::stoul(argv[2]):1920, h=argc>3?std::stoul(argv[3]):1080;
        UINT bits=argc>4?std::stoul(argv[4]):10, count=argc>5?std::stoul(argv[5]):16;
        bool identity=argc>6 && !std::strcmp(argv[6],"--identity-chroma");
        bool occlusion=argc>6 && !std::strcmp(argv[6],"--occlusion");
        double motion=identity?0.0:4.0;
        if(occlusion) motion=8;
        if(argc>7 && !std::strcmp(argv[6],"--motion")) motion=std::stod(argv[7]);
        if(!std::isfinite(motion) || std::abs(motion)>64) throw std::runtime_error("Invalid motion");
        if((bits!=8 && bits!=10) || !w || !h || (w|h)&1 || count<12) throw std::runtime_error("Invalid arguments");
        UINT rh=(h+15)&~15u, bytes=bits==10?2:1, peak=bits==10?1023:255;
        auto luma=[&](double x,double y,double t) {
            double value=pattern(x-t*motion,y);
            if(occlusion) {
                value=pattern(x,y);
                double local=x-w*.3-t*motion;
                if(local>=0 && local<w*.2 && y>=h*.25 && y<h*.75)
                    value=.75+.08*std::sin(local*.3)*std::cos(y*.2);
                if(local>=-12 && local<-10 && y>=h*.15 && y<h*.85) value=.9;
            }
            return UINT(std::round(value*peak));
        };
        DXGI_FORMAT format=bits==10?DXGI_FORMAT_P010:DXGI_FORMAT_NV12;
        ComPtr<IDXGIFactory1> factory;check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)));
        ComPtr<IDXGIAdapter1> adapter;
        for(UINT i=0;;i++) {
            ComPtr<IDXGIAdapter1> c;if(factory->EnumAdapters1(i,&c)==DXGI_ERROR_NOT_FOUND) break;
            DXGI_ADAPTER_DESC1 d{};check(c->GetDesc1(&d));if(d.VendorId==0x10de) {adapter=c;break;}
        }
        if(!adapter) throw std::runtime_error("No NVIDIA adapter");
        ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;
        check(D3D11CreateDevice(adapter.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context));
        streamee_optiflow_config c{sizeof(c),uint32_t(format),w,rh,0,0,w,h,0,0.5f,0,0,0,0};
        Pipeline pipeline(device.Get(),c);
        D3D11_TEXTURE2D_DESC d{};d.Width=w;d.Height=rh;d.ArraySize=2;d.MipLevels=d.SampleDesc.Count=1;d.Format=format;
        ComPtr<ID3D11Texture2D> input;check(device->CreateTexture2D(&d,nullptr,&input));
        d.ArraySize=1;d.Usage=D3D11_USAGE_STAGING;d.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> readback;check(device->CreateTexture2D(&d,nullptr,&readback));
        std::vector<unsigned char> data(size_t(w)*rh*3/2*bytes);
        auto chroma=[&](UINT row,UINT x) {
            return identity ? UINT((x*7+row*13) % (peak-64)+32) :
                bits==10?((x&1)?641u:385u):((x&1)?160u:96u);
        };
        std::vector<double> times,flowTimes,repairTimes,warpTimes;
        double error=0,repeat_error=0,blend_error=0;uint64_t samples=0,bad_uv=0,bad_low=0;
        double moving_error=0,moving_repeat=0,moving_blend=0;uint64_t moving_samples=0;
        auto encode=[&](UINT row,UINT x,UINT value) {
            size_t offset=(size_t(row)*w+x)*bytes;
            if(bits==10) {uint16_t v=uint16_t(value<<6);std::memcpy(data.data()+offset,&v,2);}
            else data[offset]=static_cast<unsigned char>(value);
        };
        auto read=[&](const D3D11_MAPPED_SUBRESOURCE &m,UINT row,UINT x) {
            auto p=static_cast<const unsigned char *>(m.pData)+size_t(row)*m.RowPitch+x*bytes;
            if(bits==8) return UINT(*p);
            uint16_t v;std::memcpy(&v,p,2);bad_low+=(v&63)!=0;return UINT(v>>6);
        };
        if(argc>6 && !std::strcmp(argv[6],"--performance-only")) {
            // Preload fixtures to exclude CPU generation/readback and avoid idle
            // power transitions between submissions. No clock settings are changed.
            std::vector<ComPtr<ID3D11Texture2D>> fixtures(16);
            d.Usage=D3D11_USAGE_DEFAULT;d.CPUAccessFlags=0;
            for(UINT n=0;n<fixtures.size();n++) {
                for(UINT y=0;y<rh;y++) for(UINT x=0;x<w;x++)
                    encode(y,x,UINT(std::round(pattern(double(x)-n*4.0,double(std::min(y,h-1)))*peak)));
                for(UINT y=rh;y<rh*3/2;y++) for(UINT x=0;x<w;x++)
                    encode(y,x,bits==10?((x&1)?641:385):((x&1)?160:96));
                D3D11_SUBRESOURCE_DATA initial{data.data(),w*bytes,0};
                check(device->CreateTexture2D(&d,&initial,&fixtures[n]));
            }
            ComPtr<ID3D11Texture2D> target;check(device->CreateTexture2D(&d,nullptr,&target));
            std::vector<double> walls;
            for(UINT n=0;n<count+32;n++) {
                auto begin=std::chrono::steady_clock::now();
                pipeline.submit_into(fixtures[n%16].Get(),0,n/30.0,n?target.Get():nullptr,0);
                double elapsed=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin).count();
                if(n>=32) {
                    auto stats=pipeline.stats();walls.push_back(elapsed);times.push_back(stats.total_ms);
                    flowTimes.push_back(stats.flow_ms);repairTimes.push_back(stats.repair_ms);warpTimes.push_back(stats.synthesis_ms);
                }
            }
            std::sort(walls.begin(),walls.end());std::sort(times.begin(),times.end());
            printf("{\"performanceOnly\":true,\"width\":%u,\"height\":%u,\"bits\":%u,\"samples\":%u,\"wallP50Ms\":%.3f,\"wallP95Ms\":%.3f,\"wallP99Ms\":%.3f,\"gpuSpanP95Ms\":%.3f}\n",
                w,h,bits,count,walls[count/2],walls[size_t(count*.95)],walls[size_t(count*.99)],times[size_t(count*.95)]);
            printf("Last stages: analysis=%.3f flow=%.3f repair=%.3f synthesis=%.3f\n",pipeline.stats().analysis_ms,
                flowTimes.back(),repairTimes.back(),warpTimes.back());
            return 0;
        }
        for(UINT n=0;n<count;n++) {
            for(UINT y=0;y<rh;y++) for(UINT x=0;x<w;x++)
                encode(y,x,luma(x,std::min(y,h-1),n));
            for(UINT y=rh;y<rh*3/2;y++) for(UINT x=0;x<w;x++)
                encode(y,x,chroma(y,x));
            context->UpdateSubresource(input.Get(),1,nullptr,data.data(),w*bytes,0);
            auto result=pipeline.submit(input.Get(),1,n*(1001.0/30000.0),n!=5);
            // Verify the borrowed original is still bit exact, including padding.
            context->CopySubresourceRegion(readback.Get(),0,0,0,0,input.Get(),1,nullptr);
            D3D11_MAPPED_SUBRESOURCE m{};check(context->Map(readback.Get(),0,D3D11_MAP_READ,0,&m));
            bool exact=true;
            for(UINT y=0;y<rh*3/2;y++) exact &= std::memcmp(static_cast<unsigned char *>(m.pData)+size_t(y)*m.RowPitch,data.data()+size_t(y)*w*bytes,w*bytes)==0;
            context->Unmap(readback.Get(),0);if(!exact) throw std::runtime_error("Original changed");
            if(!n) {if(!result.priming || result.texture) throw std::runtime_error("Invalid priming");continue;}
            if(std::abs(result.timestamp-(n-0.5)*(1001.0/30000.0))>1e-10) throw std::runtime_error("Wrong midpoint timestamp");
            if(n==5 && (!result.repeated || result.reason!=STREAMEE_OPTIFLOW_METADATA_HOLD)) throw std::runtime_error("Metadata hold failed");
            context->CopyResource(readback.Get(),result.texture.Get());
            check(context->Map(readback.Get(),0,D3D11_MAP_READ,0,&m));
            for(UINT y=0;y<h;y++) for(UINT x=0;x<w;x++) {
                double actual=read(m,y,x), gt=luma(x,y,n-0.5);
                double a=luma(x,y,n-1),b=luma(x,y,n);
                if(n==5) {if(actual!=a) {context->Unmap(readback.Get(),0);throw std::runtime_error("Held pixels changed");}}
                else {
                    error+=std::abs(actual-gt);repeat_error+=std::abs(a-gt);blend_error+=std::abs((a+b)*0.5-gt);samples++;
                    if(gt!=a || gt!=b) {
                        moving_error+=std::abs(actual-gt);moving_repeat+=std::abs(a-gt);
                        moving_blend+=std::abs((a+b)*.5-gt);moving_samples++;
                    }
                }
            }
            for(UINT y=rh;y<rh+h/2;y++) for(UINT x=0;x<w;x++) {
                UINT expected=chroma(y,x);
                bad_uv+=read(m,y,x)!=expected;
            }
            context->Unmap(readback.Get(),0);
            if(n>3) {
                auto s=pipeline.stats();times.push_back(s.total_ms);flowTimes.push_back(s.flow_ms);
                repairTimes.push_back(s.repair_ms);warpTimes.push_back(s.synthesis_ms);
            }
        }
        // Hard cut: bright frame after unrelated motion must hold, with no morph.
        for(UINT y=0;y<rh;y++) for(UINT x=0;x<w;x++) encode(y,x,peak);
        context->UpdateSubresource(input.Get(),1,nullptr,data.data(),w*bytes,0);
        auto cut=pipeline.submit(input.Get(),1,count*(1001.0/30000.0));
        if(!cut.repeated || cut.reason!=STREAMEE_OPTIFLOW_SCENE_CUT) throw std::runtime_error("Scene cut not held");
        auto percentile=[](std::vector<double> v,double q) {std::sort(v.begin(),v.end());return v[std::min(v.size()-1,size_t(q*v.size()))];};
        auto s=pipeline.stats();
        printf("{\"width\":%u,\"height\":%u,\"resourceHeight\":%u,\"bits\":%u,\"mae\":%.5f,\"repeatMae\":%.5f,\"blendMae\":%.5f,\"badChroma\":%llu,\"badPacking\":%llu,\"gpuP50Ms\":%.3f,\"gpuP95Ms\":%.3f,\"gpuP99Ms\":%.3f,\"flowP50Ms\":%.3f,\"repairP50Ms\":%.3f,\"synthesisP50Ms\":%.3f,\"allocatedBytes\":%llu,\"synthesized\":%llu,\"held\":%llu}\n",
          w,h,rh,bits,error/samples,repeat_error/samples,blend_error/samples,bad_uv,bad_low,
          percentile(times,.5),percentile(times,.95),percentile(times,.99),percentile(flowTimes,.5),percentile(repairTimes,.5),percentile(warpTimes,.5),
          s.allocated_bytes,s.synthesized,s.held);
        if(moving_samples) printf("{\"movingMae\":%.5f,\"movingRepeatMae\":%.5f,\"movingBlendMae\":%.5f}\n",
            moving_error/moving_samples,moving_repeat/moving_samples,moving_blend/moving_samples);
        if(bad_uv || bad_low || (identity?error!=0:error>=repeat_error)) throw std::runtime_error("Pixel/known-motion acceptance failed");
        return 0;
    } catch(const std::exception &e) {fprintf(stderr,"%s\n",e.what());return 1;}
}
