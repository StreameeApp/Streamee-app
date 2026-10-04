// SPDX-License-Identifier: GPL-3.0-or-later
// Output samples the original signal, never the 8-bit analysis image.
cbuffer Parameters : register(b0) {
    uint2 extent; uint2 visible; uint2 origin; uint2 gridExtent;
    uint stepSize; uint tenBit; uint plane; uint level;
    float2 chromaOffset; float2 spare;
};
SamplerState linearClamp : register(s0);
Texture2D<float> srcY : register(t0);
Texture2D<float2> srcUV : register(t1);
Texture2D<float> nextY : register(t2);
Texture2D<float2> nextUV : register(t3);
Texture2D<int2> rawForward : register(t4);
Texture2D<int2> rawBackward : register(t5);
Texture2D<uint> costForward : register(t6);
Texture2D<uint> costBackward : register(t7);
Texture2D<float4> fieldA : register(t8);
Texture2D<float4> fieldB : register(t9);
Texture2D<float4> imageA : register(t10);
Texture2D<float4> imageB : register(t11);
RWTexture2D<float4> dstA : register(u0);
RWTexture2D<float4> dstB : register(u1);
RWTexture2D<uint> dstY : register(u2);
RWTexture2D<uint2> dstUV : register(u3);
RWStructuredBuffer<uint> reduction : register(u4);
RWTexture2D<int2> refinedA : register(u5);
RWTexture2D<int2> refinedB : register(u6);
float signalScale() { return tenBit != 0 ? 65535.0 / 65472.0 : 1.0; }
bool inside(float2 p) { return all(p >= float2(origin)) && all(p <= float2(origin + visible - 1)); }
float2 uv(float2 p) { return (p + 0.5) / extent; }
float guide(float2 p, bool back) {
    return (back ? nextY.SampleLevel(linearClamp, uv(p), 0) :
                   srcY.SampleLevel(linearClamp, uv(p), 0)) * signalScale();
}
[numthreads(8,8,1)]
void Analysis(uint3 id : SV_DispatchThreadID) {
    if (any(id.xy >= extent)) return;
    float2 p = clamp(float2(id.xy), float2(origin), float2(origin + visible - 1));
    float y = saturate(guide(p, false));
    dstA[id.xy] = float4(y,y,y,1);
}
// Small control reduction. Only these scalar counters are read by the host.
groupshared uint3 cutPartial[64];
[numthreads(8,8,1)]
void Cut(uint3 id : SV_DispatchThreadID, uint lane : SV_GroupIndex) {
    uint2 p = origin + id.xy * 8;
    bool valid = all(p < origin + visible);
    float d = valid ? abs(guide(p, false) - guide(p, true)) : 0;
    cutPartial[lane] = uint3(uint(d * 4095.0), valid ? 1 : 0, d > 0.20 ? 1 : 0);
    GroupMemoryBarrierWithGroupSync();
    [unroll] for(uint stride=32; stride>0; stride>>=1) {
        if(lane<stride) cutPartial[lane] += cutPartial[lane+stride];
        GroupMemoryBarrierWithGroupSync();
    }
    if(lane==0) {
        InterlockedAdd(reduction[0], cutPartial[0].x);
        InterlockedAdd(reduction[1], cutPartial[0].y);
        InterlockedAdd(reduction[2], cutPartial[0].z);
    }
}
float2 rawAt(float2 p, bool back) {
    int2 q = clamp(int2(p / 4), 0, int2(gridExtent)-1);
    return (back ? rawBackward.Load(int3(q,0)) : rawForward.Load(int3(q,0))) / 32.0;
}
float matchError(float2 p,float2 flow,bool back) {
    if(!inside(p+flow)) return 1e5;
    float err=0;
    [unroll] for(int y=-1;y<=1;y++) [unroll] for(int x=-1;x<=1;x++)
        err+=abs(guide(p+float2(x,y)*3,back)-guide(p+float2(x,y)*3+flow,!back));
    return err/9;
}
float2 refineCandidate(float2 p,float2 best,bool back) {
    float error=matchError(p,best,back);
    [loop] for(float step=2;step>=0.25;step*=0.5) {
        float2 center=best;
        [unroll] for(int y=-1;y<=1;y++) [unroll] for(int x=-1;x<=1;x++) {
            float2 c=center+float2(x,y)*step;float e=matchError(p,c,back);
            if(e<error-0.00001 || (e<=error+0.00001 && dot(c,c)<dot(best,best))) {best=c;error=e;}
        }
    }
    return best;
}
float2 refine(float2 p,bool back) {
    float2 hardware=rawAt(p,back);
    float hardwareError=matchError(p,hardware,back);
    float2 best=0;
    float error=matchError(p,best,back);
    // Resolve repeated texture ambiguity in favour of an equally good short motion.
    [loop] for(int y=-8;y<=8;y+=4) [loop] for(int x=-8;x<=8;x+=4) {
        float2 c=float2(x,y); float e=matchError(p,c,back);
        if(e<error-0.00001 || (e<=error+0.00001 && dot(c,c)<dot(best,best))) {best=c;error=e;}
    }
    // Refine the independent short-motion candidate to subpixel precision.
    // Starting this search at the hardware vector can trap repeated textures
    // in an equally plausible but distant match.
    bool needsLocal=any(best!=0);
    best=refineCandidate(p,best,back);
    error=matchError(p,best,back);
    // A coarse winner on a neighbouring texture can trap the subpixel search.
    // Also refine from zero so small motion retains its own local minimum.
    if(needsLocal) {
        float2 local=refineCandidate(p,0,back);
        float localError=matchError(p,local,back);
        if(localError<error-0.00001 || (localError<=error+0.00001 && dot(local,local)<dot(best,best))) {
            best=local;error=localError;
        }
    }
    return error<0.003 || error<hardwareError-0.001 ||
        (error<=hardwareError+0.001 && dot(best,best)<dot(hardware,hardware)) ? best : hardware;
}
[numthreads(8,8,1)]
void Refine(uint3 id : SV_DispatchThreadID) {
    if(any(id.xy>=gridExtent)) return;
    float2 p=min(float2(id.xy*4+2),float2(extent-1));
    refinedA[id.xy]=int2(round(refine(p,false)*32));
    refinedB[id.xy]=int2(round(refine(p,true)*32));
}
float4 validate(uint2 q, bool back) {
    float2 p = min(float2(q * 4 + 2), float2(extent - 1));
    float2 f = rawAt(p, back), end = p + f;
    float error = length(f + rawAt(end, !back));
    uint cost = back ? costBackward.Load(int3(q,0)) : costForward.Load(int3(q,0));
    float photometric = abs(guide(p,back)-guide(end,!back));
    float confidence = inside(p) && inside(end) && cost < 100 && photometric < 0.035 &&
        error <= 1.0 + 0.05 * length(f) ? (1.0 - min(cost/100.0, 0.95)) : 0;
    return float4(float2(q), confidence, guide(p, back));
}
[numthreads(8,8,1)]
void Validate(uint3 id : SV_DispatchThreadID, uint lane : SV_GroupIndex) {
    float4 a=0,b=0;
    if(all(id.xy<gridExtent)) {
        a=validate(id.xy,false);b=validate(id.xy,true);
        dstA[id.xy]=a;dstB[id.xy]=b;
    }
    cutPartial[lane]=uint3(a.z>0 || b.z>0 ? 1 : 0,0,0);
    GroupMemoryBarrierWithGroupSync();
    [unroll] for(uint stride=32;stride>0;stride>>=1) {
        if(lane<stride) cutPartial[lane].x+=cutPartial[lane+stride].x;
        GroupMemoryBarrierWithGroupSync();
    }
    if(lane==0) InterlockedAdd(reduction[3],cutPartial[0].x);
}
float4 nearestSeed(uint2 q, bool back) {
    float4 best = back ? fieldB.Load(int3(q,0)) : fieldA.Load(int3(q,0));
    float guidance = guide(min(float2(q*4+2),float2(extent-1)), back);
    float stationaryError=-1;
    float score = best.z > 0 ? length(best.xy - q) + 80 * abs(best.w-guidance) : 1e10;
    [unroll] for(int y=-1;y<=1;y++) [unroll] for(int x=-1;x<=1;x++) {
        int2 n = int2(q) + int2(x,y)*int(stepSize);
        if (any(n<0) || any(n>=int2(gridExtent))) continue;
        float4 c = back ? fieldB.Load(int3(n,0)) : fieldA.Load(int3(n,0));
        float s = length(c.xy-q) + 80 * abs(c.w-guidance);
        // A distant seed must explain motion at this pixel too. Similar luma
        // alone can copy a foreground vector onto an unrelated background.
        if(c.z>0 && abs(c.w-guidance)<0.12 && s<score) {
            float2 p=min(float2(q*4+2),float2(extent-1));
            if(stationaryError<0) stationaryError=matchError(p,0,back);
            if(length(c.xy-q)<=2 || matchError(p,rawAt(c.xy*4+2,back),back)<stationaryError+0.001) {
                best=c;score=s;
            }
        }
    }
    return best;
}
[numthreads(8,8,1)]
void Repair(uint3 id : SV_DispatchThreadID) {
    if(any(id.xy>=gridExtent)) return;
    dstA[id.xy]=nearestSeed(id.xy,false); dstB[id.xy]=nearestSeed(id.xy,true);
}
float4 expandFlow(float2 p, bool back) {
    float2 g = p / 4 - 0.5;
    int2 base = int2(floor(g));
    float guidance=guide(p,back), weight=0; float3 sum=0;
    [unroll] for(int y=0;y<2;y++) [unroll] for(int x=0;x<2;x++) {
        int2 n=clamp(base+int2(x,y),0,int2(gridExtent)-1);
        float4 c=back ? fieldB.Load(int3(n,0)) : fieldA.Load(int3(n,0));
        float w=max(0.001,1-abs(g.x-(base.x+x)))*max(0.001,1-abs(g.y-(base.y+y)));
        w*=exp(-40*abs(c.w-guidance))*c.z;
        sum+=float3(rawAt(c.xy*4+2,back),c.z)*w; weight+=w;
    }
    return weight>1e-6 ? float4(sum/weight,1) : 0;
}
[numthreads(8,8,1)]
void Dense(uint3 id : SV_DispatchThreadID) {
    if(any(id.xy>=extent)) return;
    dstA[id.xy]=expandFlow(id.xy,false); dstB[id.xy]=expandFlow(id.xy,true);
}
float4 dense(float2 p, bool back) {
    return back ? fieldB.SampleLevel(linearClamp,uv(p),0) :
                  fieldA.SampleLevel(linearClamp,uv(p),0);
}
float3 colour(float2 p, bool back) {
    float2 cuv=((p-chromaOffset)*0.5+0.5)/(extent*0.5);
    float2 c=(back ? nextUV.SampleLevel(linearClamp,cuv,0) :
                     srcUV.SampleLevel(linearClamp,cuv,0))*signalScale();
    return float3(guide(p,back),c);
}
float4 reconstruct(float2 p) {
    if(!inside(p)) return float4(colour(clamp(p,float2(origin),float2(origin+visible-1)),false),1);
    float2 a=p,b=p;
    [unroll] for(int i=0;i<3;i++) { a=p-0.5*dense(a,false).xy; b=p-0.5*dense(b,true).xy; }
    float4 fa=dense(a,false), fb=dense(b,true);
    float wa=inside(a) && length(a+fa.xy*0.5-p)<1.5 ? fa.z : 0;
    float wb=inside(b) && length(b+fb.xy*0.5-p)<1.5 ? fb.z : 0;
    float3 ca=colour(a,false),cb=colour(b,true);
    // Opposing warps must describe the same surface before they are blended.
    // Near occlusion boundaries, prefer the source with the better endpoint
    // match instead of averaging a foreground edge with uncovered background.
    if(wa>0 && wb>0 && any(abs(ca-cb)>0.12)) {
        float ea=matchError(a,fa.xy,false)+(1-wa)*0.005;
        float eb=matchError(b,fb.xy,true)+(1-wb)*0.005;
        if(ea<eb || (ea==eb && wa>=wb)) wb=0; else wa=0;
    }
    float w=wa+wb;
    if(w<=1e-6) {
        float3 sa=colour(p,false),sb=colour(p,true);
        // Preserve stable uncovered detail instead of filling it with a distant
        // colour average from the hole pyramid.
        if(all(abs(sa-sb)<0.0005)) return float4((sa+sb)*0.5,1);
    }
    return w>1e-6 ? float4((ca*wa+cb*wb)/w,1) : 0;
}
[numthreads(8,8,1)]
void Warp(uint3 id : SV_DispatchThreadID) {
    if(any(id.xy>=extent)) return;
    dstA[id.xy]=reconstruct(float2(id.xy));
}
[numthreads(8,8,1)]
void Down(uint3 id : SV_DispatchThreadID) {
    uint w,h; dstA.GetDimensions(w,h); if(any(id.xy>=uint2(w,h))) return;
    uint iw,ih; imageA.GetDimensions(iw,ih); float4 sum=0;
    [unroll] for(uint y=0;y<2;y++) [unroll] for(uint x=0;x<2;x++) {
        float4 c=imageA.Load(int3(min(id.xy*2+uint2(x,y),uint2(iw,ih)-1),0));
        sum+=float4(c.xyz*c.w,c.w);
    }
    dstA[id.xy]=sum.w>0 ? float4(sum.xyz/sum.w,1) : 0;
}
[numthreads(8,8,1)]
void Up(uint3 id : SV_DispatchThreadID) {
    uint w,h; dstA.GetDimensions(w,h); if(any(id.xy>=uint2(w,h))) return;
    float4 c=imageA.Load(int3(id.xy,0));
    if(c.w==0) {
        c=imageB.SampleLevel(linearClamp,(float2(id.xy)+0.5)/float2(w,h),0);
        c.w*=0.5;
    }
    dstA[id.xy]=c;
}
uint packSignal(float v) {
    return tenBit != 0 ? uint(round(saturate(v)*1023.0))*64 : uint(round(saturate(v)*255.0));
}
float3 resolved(int2 p) {
    p=clamp(p,0,int2(extent)-1); float4 c=imageA.Load(int3(p,0));
    // Fuse the final pyramid upsample with packing. Each lookup resolves the
    // same fine pixel/coarse sample without another full-resolution texture.
    if(c.w==0) {
        c=imageB.SampleLevel(linearClamp,uv(float2(p)),0);
        c.w*=0.5;
    }
    return c.w>=0.0625 ? c.xyz : colour(float2(p),false);
}
[numthreads(8,8,1)]
void Pack(uint3 id : SV_DispatchThreadID) {
    if(any(id.xy>=extent)) return;
    dstY[id.xy]=packSignal(resolved(id.xy).x);
    if(all(id.xy<extent/2)) {
        float2 p=float2(id.xy*2)+chromaOffset;
        int2 q=int2(floor(p)); float2 f=frac(p);
        float2 c=lerp(lerp(resolved(q).yz,resolved(q+int2(1,0)).yz,f.x),
                      lerp(resolved(q+int2(0,1)).yz,resolved(q+1).yz,f.x),f.y);
        // Reconstruct at the actual chroma site. Downsampling the full-resolution
        // colour pyramid alone would blur even stationary chroma.
        float4 direct=reconstruct(p);
        if(direct.w>0) c=direct.yz;
        dstUV[id.xy]=uint2(packSignal(c.x),packSignal(c.y));
    }
}
