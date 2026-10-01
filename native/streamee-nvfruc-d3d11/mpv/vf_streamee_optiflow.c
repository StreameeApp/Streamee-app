/* SPDX-License-Identifier: GPL-3.0-or-later */
#include <windows.h>
#include <math.h>
#include <string.h>
#ifdef STREAMEE_OPTIFLOW_HOST_TEST
#include "filter_test_support.h"
#else
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_d3d11va.h>
#include <libavutil/hdr_dynamic_metadata.h>
#include "common/common.h"
#include "common/msg.h"
#include "common/tags.h"
#include "filters/filter.h"
#include "filters/filter_internal.h"
#include "filters/user_filters.h"
#include "video/mp_image.h"
#include "streamee_optiflow_bridge.h"
#endif

struct priv {
    HMODULE module;
    struct streamee_optiflow_api api;
    void *session;
    AVBufferRef *frames;
    struct mp_image *held, *midpoint;
    struct mp_image_params params;
    struct streamee_optiflow_stats stats;
    struct streamee_optiflow_stats completed;
    unsigned width, height, format;
    bool disabled;
    uint64_t inputs, outputs, bypassed;
    const char *state, *reason;
};

#ifndef STREAMEE_OPTIFLOW_HOST_TEST
static AVD3D11VADeviceContext *device_context(struct priv *p) {
    AVHWFramesContext *frames=(void *)p->frames->data;
    return frames->device_ctx->hwctx;
}
#endif
static void close_session(struct priv *p) {
    if(p->session) {
        AVD3D11VADeviceContext *ctx=device_context(p);
        ctx->lock(ctx->lock_ctx);p->api.destroy(p->session);ctx->unlock(ctx->lock_ctx);
        p->session=NULL;
        p->completed=p->stats;
        p->stats.allocated_bytes=0;
    }
    av_buffer_unref(&p->frames);
}
static void reset(struct mp_filter *f) {
    struct priv *p=f->priv;
    TA_FREEP(&p->held);TA_FREEP(&p->midpoint);close_session(p);
    p->disabled=false;p->state="waiting";p->reason="";
    p->stats=(struct streamee_optiflow_stats){0};
    p->completed=(struct streamee_optiflow_stats){0};
    p->inputs=p->outputs=p->bypassed=0;
}
static void destroy(struct mp_filter *f) {
    struct priv *p=f->priv;
    MP_INFO(f,"OptiFlow totals: inputs=%llu outputs=%llu synthesized=%llu held=%llu bypassed=%llu\n",
        (unsigned long long)p->inputs,(unsigned long long)p->outputs,
        (unsigned long long)p->stats.synthesized,(unsigned long long)p->stats.held,
        (unsigned long long)p->bypassed);
    reset(f);
    if(p->module) FreeLibrary(p->module);
}
#ifndef STREAMEE_OPTIFLOW_HOST_TEST
static bool absolute_environment(const wchar_t *key,wchar_t *out,DWORD capacity) {
    DWORD n=GetEnvironmentVariableW(key,out,capacity);
    return n>3 && n<capacity && ((out[1]==L':' && (out[2]==L'\\' || out[2]==L'/')) ||
        (out[0]==L'\\' && out[1]==L'\\'));
}
#include "optiflow_metadata.h"
static bool supported(struct mp_image *img,D3D11_TEXTURE2D_DESC *d) {
    if(img->imgfmt!=IMGFMT_D3D11 || (img->params.hw_subfmt!=IMGFMT_NV12 && img->params.hw_subfmt!=IMGFMT_P010) ||
       !img->hwctx || !img->planes[0] || img->pts==MP_NOPTS_VALUE || !isfinite(img->pts) ||
       (img->fields&MP_IMGFIELD_INTERLACED)) return false;
    AVHWFramesContext *frames=(void *)img->hwctx->data;
    if(frames->device_ctx->type!=AV_HWDEVICE_TYPE_D3D11VA) return false;
    ID3D11Texture2D_GetDesc((ID3D11Texture2D *)img->planes[0],d);
    return d->Format==DXGI_FORMAT_NV12 || d->Format==DXGI_FORMAT_P010;
}
static bool open_session(struct mp_filter *f,struct mp_image *img,const D3D11_TEXTURE2D_DESC *d) {
    struct priv *p=f->priv;wchar_t path[32768];
    if(!absolute_environment(L"STREAMEE_OPTIFLOW_D3D11_BRIDGE",path,MP_ARRAY_SIZE(path))) return false;
    if(!p->module) {
        p->module=LoadLibraryExW(path,NULL,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
        streamee_optiflow_get_api_fn get=p->module?(streamee_optiflow_get_api_fn)GetProcAddress(p->module,"streamee_optiflow_d3d11_get_api"):NULL;
        if(!get || get(STREAMEE_OPTIFLOW_D3D11_ABI,&p->api,sizeof(p->api)) ||
           p->api.abi!=STREAMEE_OPTIFLOW_D3D11_ABI || p->api.size!=sizeof(p->api) ||
           !p->api.create || !p->api.submit_into || !p->api.destroy || !p->api.get_stats || !p->api.get_caps) {
            if(p->module) FreeLibrary(p->module);
            p->module=NULL;
            MP_WARN(f,"OptiFlow bridge unavailable or ABI mismatch; passing originals\n");return false;
        }
    }
    p->frames=av_buffer_ref(img->hwctx);MP_HANDLE_OOM(p->frames);
    AVD3D11VADeviceContext *ctx=device_context(p);
    HMODULE d3d11;
    if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN,L"d3d11.dll",&d3d11)) {close_session(p);return false;}
    float x=0,y=0;pl_chroma_location_offset(img->params.chroma_location,&x,&y);
    struct streamee_optiflow_config c={
        .size=sizeof(c),.format=d->Format,.width=d->Width,.height=d->Height,
        .visible_width=img->w,.visible_height=img->h,
        .chroma_x=x+0.5f,.chroma_y=y+0.5f,
        .matrix=img->params.repr.sys,.transfer=img->params.color.transfer,
        .primaries=img->params.color.primaries,.range=img->params.repr.levels,
    };
    if(img->params.crop.x1>img->params.crop.x0 && img->params.crop.y1>img->params.crop.y0) {
        c.left=img->params.crop.x0;c.top=img->params.crop.y0;
        c.visible_width=img->params.crop.x1-c.left;c.visible_height=img->params.crop.y1-c.top;
    }
    char error[512]={0};ctx->lock(ctx->lock_ctx);
    int status=p->api.create(ctx->device,&c,&p->session,error,sizeof(error));
    ctx->unlock(ctx->lock_ctx);
    if(status) {MP_WARN(f,"OptiFlow unavailable: %s; passing originals\n",error);close_session(p);return false;}
    p->width=d->Width;p->height=d->Height;p->format=d->Format;p->params=img->params;
    p->state="ready";p->reason="";
    MP_INFO(f,"OptiFlow NVOFA + custom shaders: visible=%dx%d resource=%ux%u format=%s\n",
        img->w,img->h,p->width,p->height,p->format==DXGI_FORMAT_P010?"P010":"NV12");
    return true;
}
static struct mp_image *allocate_output(struct priv *p,struct mp_image *input) {
    AVFrame *av=av_frame_alloc();
    if(!av || av_hwframe_get_buffer(p->frames,av,0)<0) {av_frame_free(&av);return NULL;}
    struct mp_image *img=mp_image_from_av_frame(av);av_frame_free(&av);
    if(img) {mp_image_copy_attributes(img,input);mp_image_set_size(img,input->w,input->h);}
    return img;
}
#endif
static void emit(struct mp_filter *f,struct mp_image *img) {
    struct priv *p=f->priv;p->outputs++;
    mp_pin_in_write(f->ppins[1],(struct mp_frame){MP_FRAME_VIDEO,img});
}
static void process(struct mp_filter *f) {
    struct priv *p=f->priv;
    if(!mp_pin_in_needs_data(f->ppins[1])) return;
    if(p->midpoint) {struct mp_image *img=p->midpoint;p->midpoint=NULL;emit(f,img);return;}
    struct mp_frame frame=mp_pin_out_read(f->ppins[0]);if(!frame.type) return;
    if(frame.type!=MP_FRAME_VIDEO) {
        if(p->held) {
            struct mp_image *last=p->held;p->held=NULL;
            // The final original retains its full source duration.
            mp_pin_out_unread(f->ppins[0],frame);emit(f,last);return;
        }
        close_session(p);mp_pin_in_write(f->ppins[1],frame);return;
    }
    struct mp_image *img=frame.data;D3D11_TEXTURE2D_DESC d={0};
    bool usable=supported(img,&d);
    bool discontinuity=p->session && (!usable || p->frames->data!=img->hwctx->data ||
        p->width!=d.Width || p->height!=d.Height || p->format!=d.Format ||
        !static_equal(p->params,img->params) || (p->held && (img->pts<=p->held->pts || img->pts-p->held->pts>0.5)));
    if(discontinuity) {
        close_session(p);
        if(p->held) {
            struct mp_image *last=p->held;p->held=NULL;
            mp_pin_out_unread(f->ppins[0],frame);emit(f,last);return;
        }
    }
    p->inputs++;
    if(!p->disabled && usable && !p->session && !open_session(f,img,&d))
        p->disabled=true;
    if(p->disabled || !usable) {
        p->state="bypassed";p->reason=usable?"engine-unavailable":"unsupported-input";
        // Unsupported format can recover after a format change; driver failure waits for reset.
        p->bypassed++;emit(f,img);return;
    }
    struct mp_image *mid=p->held?allocate_output(p,p->held):NULL;
    bool eligible=!p->held || metadata_equal(p->held,img);
    const char *metadata_reason=eligible?"":
        (!metadata_equal(p->held,p->held) || !metadata_equal(img,img))?
        "unsupported-dynamic-metadata":"metadata-change";
    struct streamee_optiflow_output output={0};char error[512]={0};
    int status=STREAMEE_OPTIFLOW_RUNTIME_ERROR;
    AVD3D11VADeviceContext *ctx=device_context(p);
    if(!p->held || mid) {
        ctx->lock(ctx->lock_ctx);
        status=p->api.submit_into(p->session,img->planes[0],(uintptr_t)img->planes[1],img->pts,
            eligible,mid?mid->planes[0]:NULL,
            mid?(uintptr_t)mid->planes[1]:0,&output,error,sizeof(error));
        if(!status) {
            p->api.get_stats(p->session,&p->stats);
            p->stats.inputs+=p->completed.inputs;
            p->stats.synthesized+=p->completed.synthesized;
            p->stats.held+=p->completed.held;
            p->stats.metadata_holds+=p->completed.metadata_holds;
            p->stats.scene_cuts+=p->completed.scene_cuts;
        }
        ctx->unlock(ctx->lock_ctx);
    }
    if(status) {
        TA_FREEP(&mid);close_session(p);p->disabled=true;p->state="bypassed";p->reason="processing-failed";
        MP_WARN(f,"OptiFlow processing failed: %s; passing originals until reset\n",error);
        if(p->held) {struct mp_image *last=p->held;p->held=NULL;
            p->inputs--;mp_pin_out_unread(f->ppins[0],frame);emit(f,last);return;}
        p->bypassed++;emit(f,img);return;
    }
    if(!p->held) {
        p->held=img;mp_pin_out_request_data_next(f->ppins[0]);return;
    }
    struct mp_image *original=p->held;
    if(output.repeated) {TA_FREEP(&mid);mid=mp_image_new_ref(original);MP_HANDLE_OOM(mid);}
    mid->pts=output.timestamp;mid->dts=MP_NOPTS_VALUE;
    mid->pkt_duration=(img->pts-original->pts)/2;mid->nominal_fps=img->nominal_fps*2;
    // Captions are events, not pixel metadata; don't deliver them twice.
    av_buffer_unref(&mid->a53_cc);
    for(int n=0;n<mid->num_ff_side_data;n++) {
        if(mid->ff_side_data[n].type!=AV_FRAME_DATA_A53_CC) continue;
        av_buffer_unref(&mid->ff_side_data[n].buf);
        memmove(&mid->ff_side_data[n],&mid->ff_side_data[n+1],
            (mid->num_ff_side_data-n-1)*sizeof(mid->ff_side_data[0]));
        mid->num_ff_side_data--;n--;
    }
    original->pkt_duration=mid->pkt_duration;original->nominal_fps*=2;
    p->held=img;p->midpoint=mid;p->state="active";
    p->reason=output.reason==STREAMEE_OPTIFLOW_METADATA_HOLD?metadata_reason:
              output.reason==STREAMEE_OPTIFLOW_SCENE_CUT?"scene-cut":
              output.reason==STREAMEE_OPTIFLOW_UNRELIABLE_FLOW?"unreliable-flow":"";
    emit(f,original);
}
#ifndef STREAMEE_OPTIFLOW_HOST_TEST
static bool command(struct mp_filter *f,struct mp_filter_command *cmd) {
    struct priv *p=f->priv;
    if(cmd->type!=MP_FILTER_COMMAND_GET_META) return false;
    struct mp_tags *tags=talloc_zero(NULL,struct mp_tags);
    mp_tags_set_str(tags,"state",p->state?p->state:"waiting");
    mp_tags_set_str(tags,"reason",p->reason?p->reason:"");
    mp_tags_set_str(tags,"format",p->format==DXGI_FORMAT_P010?"P010":p->format==DXGI_FORMAT_NV12?"NV12":"unknown");
#define COUNT(key,value) mp_tags_set_str(tags,key,talloc_asprintf(tags,"%llu",(unsigned long long)(value)))
#define TIME(key,value) mp_tags_set_str(tags,key,talloc_asprintf(tags,"%.4f",(double)(value)))
    COUNT("inputs",p->inputs);COUNT("outputs",p->outputs);COUNT("synthesized",p->stats.synthesized);
    COUNT("held",p->stats.held);COUNT("metadataHolds",p->stats.metadata_holds);COUNT("sceneCuts",p->stats.scene_cuts);
    COUNT("bypassed",p->bypassed);COUNT("allocatedBytes",p->stats.allocated_bytes);
    TIME("analysisMs",p->stats.analysis_ms);TIME("flowMs",p->stats.flow_ms);TIME("repairMs",p->stats.repair_ms);
    TIME("synthesisMs",p->stats.synthesis_ms);TIME("gpuSpanMs",p->stats.total_ms);
#undef COUNT
#undef TIME
    *(struct mp_tags **)cmd->res=tags;return true;
}
static const struct mp_filter_info filter_info={
    .name="streamee-optiflow",.priv_size=sizeof(struct priv),
    .process=process,.reset=reset,.destroy=destroy,.command=command,
};
static struct mp_filter *create(struct mp_filter *parent,void *options) {
    talloc_free(options);struct mp_filter *f=mp_filter_create(parent,&filter_info);
    if(!f) return NULL;
    mp_filter_add_pin(f,MP_PIN_IN,"in");mp_filter_add_pin(f,MP_PIN_OUT,"out");
    struct priv *p=f->priv;p->state="waiting";p->reason="";return f;
}
const struct mp_user_filter_entry vf_streamee_optiflow={
    .desc={.name="streamee-optiflow",.description="OptiFlow GPU interpolation (NV12/P010)"},
    .create=create,
};
#endif
