/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "pipeline.hpp"
#include <dxgi1_2.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>
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
        bool silhouette=argc>6 && !std::strcmp(argv[6],"--silhouette");
        double motion=identity?0.0:4.0;
        double vertical_motion=0;
        bool varying_chroma=false, require_better_than_blend=false;
        if(occlusion) motion=8;
        if(silhouette) motion=12;
        if(argc>7 && !std::strcmp(argv[6],"--motion")) motion=std::stod(argv[7]);
        std::string dump_prefix;
        std::string raw_path;
        UINT dump_pair=2;
        for(int i=6;i<argc;i++) {
            if(!std::strcmp(argv[i],"--dump-prefix") && i+1<argc) dump_prefix=argv[++i];
            else if(!std::strcmp(argv[i],"--input-raw") && i+1<argc) raw_path=argv[++i];
            else if(!std::strcmp(argv[i],"--dump-pair") && i+1<argc) dump_pair=UINT(std::stoul(argv[++i]));
            else if(!std::strcmp(argv[i],"--motion-y") && i+1<argc) vertical_motion=std::stod(argv[++i]);
            else if(!std::strcmp(argv[i],"--varying-chroma")) varying_chroma=true;
            else if(!std::strcmp(argv[i],"--require-better-than-blend")) require_better_than_blend=true;
        }
        if(!std::isfinite(motion) || std::abs(motion)>64 || !std::isfinite(vertical_motion) ||
           std::abs(vertical_motion)>64) throw std::runtime_error("Invalid motion");
        if((bits!=8 && bits!=10) || !w || !h || (w|h)&1 || count<12) throw std::runtime_error("Invalid arguments");
        UINT rh=(h+15)&~15u, bytes=bits==10?2:1, peak=bits==10?1023:255;
        size_t raw_frame_bytes=size_t(w)*h*3/2*bytes;
        std::vector<unsigned char> raw_frames;
        if(!raw_path.empty()) {
            std::ifstream file(raw_path,std::ios::binary);
            raw_frames.resize(raw_frame_bytes*(2*size_t(count)-1));
            if(!file.read(reinterpret_cast<char *>(raw_frames.data()),std::streamsize(raw_frames.size())))
                throw std::runtime_error("Raw sequence needs 2N-1 NV12/P010 frames");
            varying_chroma=true;
        }
        auto raw_signal=[&](UINT row,UINT x,double t) {
            size_t frame=size_t(std::llround(t*2));
            size_t offset=frame*raw_frame_bytes+(size_t(row)*w+x)*bytes;
            if(bits==8) return UINT(raw_frames[offset]);
            uint16_t v;std::memcpy(&v,raw_frames.data()+offset,2);return UINT(v>>6);
        };
        auto foreground=[&](double x,double y,double t) {
            double local=x-w*.35-t*motion;
            double dx=(local-w*.06)/(w*.08),dy=(y-h*.3)/(h*.18);
            bool torso=dx*dx+dy*dy<1;
            bool legs=y>=h*.40 && y<h*.9 &&
                (std::abs(local-w*.02-(y-h*.40)*.17)<w*.022 ||
                 std::abs(local-w*.10+(y-h*.40)*.13)<w*.019);
            return torso || legs;
        };
        auto luma=[&](double x,double y,double t) {
            if(!raw_frames.empty()) return raw_signal(UINT(y),UINT(x),t);
            double value=pattern(x-t*motion,y-t*vertical_motion);
            if(occlusion) {
                value=pattern(x,y);
                double local=x-w*.3-t*motion;
                if(local>=0 && local<w*.2 && y>=h*.25 && y<h*.75)
                    value=.75+.08*std::sin(local*.3)*std::cos(y*.2);
                if(local>=-12 && local<-10 && y>=h*.15 && y<h*.85) value=.9;
            }
            if(silhouette) {
                double coverage=0;
                for(double yy : {-.25,.25}) for(double xx : {-.25,.25})
                    coverage+=foreground(x+xx,y+yy,t)?.25:0;
                double background=.72+.05*std::sin(x*.043)*std::cos(y*.073);
                if(std::fmod(x,97)<3 || std::fmod(y,139)<2) background=.28;
                double object=.14+.025*std::sin((x-t*motion)*.22)*std::cos(y*.28);
                value=background*(1-coverage)+object*coverage;
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
        auto chroma=[&](UINT row,UINT x,double t) {
            if(!raw_frames.empty()) return raw_signal(h+std::min(row-rh,h/2-1),x,t);
            if(varying_chroma) {
                double px=double(x/2)*2-t*motion;
                double py=double(row-rh)*2+.5-t*vertical_motion;
                double value=(x&1)? .6+.12*std::cos(px*.047+py*.033) :
                    .4+.13*std::sin(px*.053)*std::cos(py*.037);
                return UINT(std::round(value*peak));
            }
            return identity ? UINT((x*7+row*13) % (peak-64)+32) :
                bits==10?((x&1)?641u:385u):((x&1)?160u:96u);
        };
        std::vector<double> times,flowTimes,repairTimes,warpTimes;
        double error=0,repeat_error=0,blend_error=0;uint64_t samples=0,bad_uv=0,bad_low=0;
        double moving_error=0,moving_repeat=0,moving_blend=0;uint64_t moving_samples=0;
        uint64_t severe_errors=0;
        double uv_error=0,uv_repeat=0,uv_blend=0;uint64_t uv_samples=0;
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
                encode(y,x,chroma(y,x,n));
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
            // The same midpoint and analytic truth make visual A/B comparisons
            // repeatable; independently timed player screenshots cannot do this.
            if(n==dump_pair && !dump_prefix.empty()) {
                for(bool truth : {false,true}) {
                    std::ofstream image(dump_prefix+(truth?"-truth.pgm":"-generated.pgm"),std::ios::binary);
                    image << "P5\n" << w << ' ' << h << "\n65535\n";
                    for(UINT y=0;y<h;y++) for(UINT x=0;x<w;x++) {
                        UINT value=truth?luma(x,y,n-0.5):read(m,y,x);
                        uint16_t v=uint16_t(std::round(double(value)*65535/peak));
                        image.put(char(v>>8));image.put(char(v&255));
                    }
                    if(!image) {context->Unmap(readback.Get(),0);throw std::runtime_error("Cannot write midpoint image");}
                }
            }
            double pair_error=0,pair_repeat=0,pair_blend=0;
            uint64_t pair_severe=0;
            for(UINT y=0;y<h;y++) for(UINT x=0;x<w;x++) {
                double actual=read(m,y,x), gt=luma(x,y,n-0.5);
                double a=luma(x,y,n-1),b=luma(x,y,n);
                if(n==5) {if(actual!=a) {context->Unmap(readback.Get(),0);throw std::runtime_error("Held pixels changed");}}
                else {
                    error+=std::abs(actual-gt);repeat_error+=std::abs(a-gt);blend_error+=std::abs((a+b)*0.5-gt);samples++;
                    pair_error+=std::abs(actual-gt);pair_repeat+=std::abs(a-gt);pair_blend+=std::abs((a+b)*.5-gt);
                    pair_severe+=std::abs(actual-gt)>peak*.08;
                    if(gt!=a || gt!=b) {
                        moving_error+=std::abs(actual-gt);moving_repeat+=std::abs(a-gt);
                        moving_blend+=std::abs((a+b)*.5-gt);moving_samples++;
                        severe_errors+=std::abs(actual-gt)>peak*.08;
                    }
                }
            }
            if(!raw_frames.empty() && n!=5)
                printf("RAW_PAIR n=%u mae=%.5f repeat=%.5f blend=%.5f held=%u severe=%llu\n",n,
                    pair_error/(double(w)*h),pair_repeat/(double(w)*h),pair_blend/(double(w)*h),result.repeated?1:0,pair_severe);
            for(UINT y=rh;y<rh+h/2;y++) for(UINT x=0;x<w;x++) {
                UINT actual=read(m,y,x);
                if(varying_chroma && n!=5) {
                    double gt=chroma(y,x,n-.5),a=chroma(y,x,n-1),b=chroma(y,x,n);
                    uv_error+=std::abs(actual-gt);uv_repeat+=std::abs(a-gt);
                    uv_blend+=std::abs((a+b)*.5-gt);uv_samples++;
                } else bad_uv+=actual!=chroma(y,x,n==5?n-1:n);
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
        // Most of the picture changes by 22% of encoded range while a narrow
        // textured strip remains stable. The former bright-cut thresholds miss
        // this case, despite its very low reliable-flow coverage.
        for(UINT y=0;y<rh;y++) for(UINT x=0;x<w;x++)
            encode(y,x,UINT(std::round((x<w/16?pattern(x,std::min(y,h-1)):.2)*peak)));
        context->UpdateSubresource(input.Get(),1,nullptr,data.data(),w*bytes,0);
        pipeline.submit(input.Get(),1,(count+1)*(1001.0/30000.0));
        for(UINT y=0;y<rh;y++) for(UINT x=0;x<w;x++)
            encode(y,x,UINT(std::round((x<w/16?pattern(x,std::min(y,h-1)):.42)*peak)));
        context->UpdateSubresource(input.Get(),1,nullptr,data.data(),w*bytes,0);
        auto moderate_cut=pipeline.submit(input.Get(),1,(count+2)*(1001.0/30000.0));
        if(!moderate_cut.repeated || moderate_cut.reason!=STREAMEE_OPTIFLOW_SCENE_CUT)
            throw std::runtime_error("Moderate-range scene cut not held");
        auto percentile=[](std::vector<double> v,double q) {std::sort(v.begin(),v.end());return v[std::min(v.size()-1,size_t(q*v.size()))];};
        auto s=pipeline.stats();
        printf("{\"width\":%u,\"height\":%u,\"resourceHeight\":%u,\"bits\":%u,\"mae\":%.5f,\"repeatMae\":%.5f,\"blendMae\":%.5f,\"badChroma\":%llu,\"badPacking\":%llu,\"gpuP50Ms\":%.3f,\"gpuP95Ms\":%.3f,\"gpuP99Ms\":%.3f,\"flowP50Ms\":%.3f,\"repairP50Ms\":%.3f,\"synthesisP50Ms\":%.3f,\"allocatedBytes\":%llu,\"synthesized\":%llu,\"held\":%llu}\n",
          w,h,rh,bits,error/samples,repeat_error/samples,blend_error/samples,bad_uv,bad_low,
          percentile(times,.5),percentile(times,.95),percentile(times,.99),percentile(flowTimes,.5),percentile(repairTimes,.5),percentile(warpTimes,.5),
          s.allocated_bytes,s.synthesized,s.held);
        if(moving_samples) printf("{\"movingMae\":%.5f,\"movingRepeatMae\":%.5f,\"movingBlendMae\":%.5f}\n",
            moving_error/moving_samples,moving_repeat/moving_samples,moving_blend/moving_samples);
        if(silhouette) printf("{\"silhouetteSeverePixels\":%llu,\"silhouetteMovingPixels\":%llu}\n",severe_errors,moving_samples);
        if(uv_samples) printf("{\"chromaMae\":%.5f,\"chromaRepeatMae\":%.5f,\"chromaBlendMae\":%.5f}\n",
            uv_error/uv_samples,uv_repeat/uv_samples,uv_blend/uv_samples);
        // A held-out decoded sequence is diagnostic: real cuts, nonlinear motion
        // and exposure changes need review instead of an analytic-motion gate.
        if(bad_uv || bad_low || (raw_frames.empty() && (identity?error!=0:error>=repeat_error)))
            throw std::runtime_error("Pixel/known-motion acceptance failed");
        if(raw_frames.empty() && uv_samples && uv_error>=uv_repeat) throw std::runtime_error("Moving chroma did not improve on repetition");
        if(require_better_than_blend && error>=blend_error) throw std::runtime_error("Midpoint did not improve on blending");
        return 0;
    } catch(const std::exception &e) {fprintf(stderr,"%s\n",e.what());return 1;}
}
