#include "pipeline.hpp"
#include <cmath>
#include <cstdio>
#include <limits>
#include <stdexcept>

using namespace streamee::optiflow;
int main() {
    D3D11_TEXTURE2D_DESC base{};
    base.Width=1920; base.Height=1080; base.ArraySize=4; base.MipLevels=1;
    base.Format=DXGI_FORMAT_NV12; base.SampleDesc.Count=1;
    int cases=0;
    auto verify = [&](D3D11_TEXTURE2D_DESC d, UINT slice, double time,
                      std::optional<double> previous, bool expected) {
        bool accepted=true;
        try { validate_frame(d, slice, 1920, 1080, time, previous); }
        catch(const std::invalid_argument &) { accepted=false; }
        if(accepted != expected) throw std::runtime_error("Contract case mismatch");
        ++cases;
    };
    verify(base,0,0,std::nullopt,true);
    verify(base,3,1,0,true);
    verify(base,4,1,0,false);
    verify(base,0,0,0,false);
    verify(base,0,-1,0,false);
    verify(base,0,std::numeric_limits<double>::infinity(),0,false);
    verify(base,0,std::numeric_limits<double>::quiet_NaN(),0,false);
    verify(base,0,1,std::numeric_limits<double>::quiet_NaN(),false);
    for(auto format : {DXGI_FORMAT_R8G8B8A8_UNORM}) {
        auto d=base; d.Format=format; verify(d,0,1,0,false);
    }
    auto p010=base; p010.Format=DXGI_FORMAT_P010; verify(p010,0,1,0,true);
    auto d=base; d.MipLevels=2; verify(d,0,1,0,false);
    d=base; d.ArraySize=0; verify(d,0,1,0,false);
    d=base; d.SampleDesc.Count=2; verify(d,0,1,0,false);
    d=base; d.CPUAccessFlags=D3D11_CPU_ACCESS_READ; verify(d,0,1,0,false);
    d=base; d.Usage=D3D11_USAGE_STAGING; verify(d,0,1,0,false);
    d=base; d.Height=1088; verify(d,0,1,0,false);
    bool rejected=false;
    try { validate_frame(base,0,1919,1080,0,std::nullopt); }
    catch(const std::invalid_argument &) { rejected=true; }
    if(!rejected) return 1;
    streamee_optiflow_config config{sizeof(config),DXGI_FORMAT_P010,1920,1088,2,2,1918,1080,0,0.5f};
    auto verify_config=[&](streamee_optiflow_config c,bool expected) {
        bool accepted=true;
        try { validate_config(c); } catch(const std::invalid_argument &) { accepted=false; }
        if(accepted!=expected) throw std::runtime_error("Configuration contract mismatch");
        cases++;
    };
    verify_config(config,true);
    auto invalid=config;invalid.size--;verify_config(invalid,false);
    invalid=config;invalid.left=UINT_MAX;verify_config(invalid,false);
    invalid=config;invalid.visible_width=UINT_MAX;verify_config(invalid,false);
    invalid=config;invalid.visible_height=0;verify_config(invalid,false);
    invalid=config;invalid.top=9;verify_config(invalid,false);
    invalid=config;invalid.width=1919;verify_config(invalid,false);
    invalid=config;invalid.chroma_x=std::numeric_limits<float>::quiet_NaN();verify_config(invalid,false);
    invalid=config;invalid.chroma_y=1.5f;verify_config(invalid,false);
    std::printf("%d frame contracts and odd-extent rejection passed; no GPU/runtime calls\n", cases);
}
