/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Test doubles for host ownership and pins. No D3D device or driver is opened. */
#include <assert.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stdio.h>
#include <d3d11.h>
#include "bridge.h"
#define MP_NOPTS_VALUE (-1e20)
#define MP_FRAME_VIDEO 1
#define MP_FRAME_EOF 2
#define AV_FRAME_DATA_A53_CC 1
#define MP_HANDLE_OOM(p) assert(p)
#define MP_INFO(...) ((void)0)
#define MP_WARN(...) ((void)0)
#define TA_FREEP(p) do { image_free(*(p)); *(p)=NULL; } while(0)

typedef struct AVBufferRef { void *data; int refs; } AVBufferRef;
struct mp_image_params { int interpretation; };
struct mp_ff_side_data { int type; AVBufferRef *buf; };
struct mp_image {
    double pts,dts,pkt_duration,nominal_fps;
    int id,metadata;
    bool usable;
    unsigned width,height,format;
    struct mp_image_params params;
    AVBufferRef *hwctx,*a53_cc;
    void *planes[2];
    int num_ff_side_data;
    struct mp_ff_side_data *ff_side_data;
};
struct mp_frame { int type; void *data; };
struct mp_pin { struct mp_frame queue[512]; unsigned count; bool wants; };
struct mp_filter { void *priv; struct mp_pin *ppins[2]; };
typedef struct AVD3D11VADeviceContext {
    void (*lock)(void *); void (*unlock)(void *); void *lock_ctx;
} AVD3D11VADeviceContext;
struct priv;
static AVD3D11VADeviceContext *device_context(struct priv *p);
static bool supported(struct mp_image *img,D3D11_TEXTURE2D_DESC *d);
static bool open_session(struct mp_filter *f,struct mp_image *img,const D3D11_TEXTURE2D_DESC *d);
static struct mp_image *allocate_output(struct priv *p,struct mp_image *img);
static int live_images;
static void av_buffer_unref(AVBufferRef **p) { if(*p) (*p)->refs--; *p=NULL; }
static void image_free(struct mp_image *img) {
    if(!img) return;
    av_buffer_unref(&img->hwctx);av_buffer_unref(&img->a53_cc);
    for(int i=0;i<img->num_ff_side_data;i++) av_buffer_unref(&img->ff_side_data[i].buf);
    free(img->ff_side_data);free(img);live_images--;
}
static struct mp_image *mp_image_new_ref(struct mp_image *img) {
    struct mp_image *copy=malloc(sizeof(*copy));assert(copy);*copy=*img;live_images++;
    if(copy->hwctx) copy->hwctx->refs++;
    if(copy->a53_cc) copy->a53_cc->refs++;
    if(copy->num_ff_side_data) {
        copy->ff_side_data=malloc(sizeof(*copy->ff_side_data)*copy->num_ff_side_data);
        memcpy(copy->ff_side_data,img->ff_side_data,sizeof(*copy->ff_side_data)*copy->num_ff_side_data);
        for(int i=0;i<copy->num_ff_side_data;i++) copy->ff_side_data[i].buf->refs++;
    }
    return copy;
}
static bool static_equal(struct mp_image_params a,struct mp_image_params b) { return a.interpretation==b.interpretation; }
static bool metadata_equal(struct mp_image *a,struct mp_image *b) {
    return a->metadata>=0 && a->metadata==b->metadata && static_equal(a->params,b->params);
}
static bool mp_pin_in_needs_data(struct mp_pin *pin) { return pin->wants; }
static struct mp_frame mp_pin_out_read(struct mp_pin *pin) {
    if(!pin->count) return (struct mp_frame){0};
    struct mp_frame result=pin->queue[0];
    memmove(pin->queue,pin->queue+1,--pin->count*sizeof(result));return result;
}
static void mp_pin_out_unread(struct mp_pin *pin,struct mp_frame frame) {
    assert(pin->count<511);memmove(pin->queue+1,pin->queue,pin->count++*sizeof(frame));pin->queue[0]=frame;
}
static void mp_pin_in_write(struct mp_pin *pin,struct mp_frame frame) {
    assert(pin->count<512);pin->queue[pin->count++]=frame;
}
static void mp_pin_out_request_data_next(struct mp_pin *pin) { (void)pin; }
