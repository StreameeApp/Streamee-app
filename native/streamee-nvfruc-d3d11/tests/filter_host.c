/* SPDX-License-Identifier: GPL-3.0-or-later */
#define STREAMEE_OPTIFLOW_HOST_TEST
#include "../mpv/vf_streamee_optiflow.c"

static int opens,closes,fail_submit,fail_alloc;
static bool fail_open;
static AVBufferRef device_a={.data=(void *)1},device_b={.data=(void *)2},captions={0};
struct fake_session { double previous; bool primed; struct streamee_optiflow_stats stats; };
static void no_lock(void *ctx) { (void)ctx; }
static AVD3D11VADeviceContext context={no_lock,no_lock,NULL};
static AVD3D11VADeviceContext *device_context(struct priv *p) { (void)p;return &context; }
static void fake_destroy(void *value) { closes++;free(value); }
static int fake_stats(void *value,struct streamee_optiflow_stats *out) { *out=((struct fake_session *)value)->stats;return 0; }
static int fake_submit(void *value,void *input,uint32_t slice,double pts,uint32_t eligible,
    void *target,uint32_t target_slice,struct streamee_optiflow_output *out,char *error,size_t size) {
    (void)input;(void)slice;(void)target_slice;(void)error;(void)size;
    struct fake_session *s=value;
    if(fail_submit && --fail_submit==0) return STREAMEE_OPTIFLOW_RUNTIME_ERROR;
    *out=(struct streamee_optiflow_output){.priming=!s->primed,.timestamp=s->primed?s->previous/2+pts/2:pts};
    if(s->primed) {
        assert(target);out->repeated=!eligible;
        out->reason=eligible?STREAMEE_OPTIFLOW_SYNTHESIZED:STREAMEE_OPTIFLOW_METADATA_HOLD;
        if(eligible) s->stats.synthesized++;else {s->stats.held++;s->stats.metadata_holds++;}
    }
    s->stats.inputs++;s->stats.allocated_bytes=4096;s->previous=pts;s->primed=true;return 0;
}
static bool supported(struct mp_image *img,D3D11_TEXTURE2D_DESC *d) {
    d->Width=img->width;d->Height=img->height;d->Format=img->format;
    return img->usable && isfinite(img->pts) && img->pts!=MP_NOPTS_VALUE;
}
static bool open_session(struct mp_filter *f,struct mp_image *img,const D3D11_TEXTURE2D_DESC *d) {
    struct priv *p=f->priv;opens++;if(fail_open) return false;
    p->session=calloc(1,sizeof(struct fake_session));assert(p->session);
    p->frames=img->hwctx;p->frames->refs++;p->params=img->params;
    p->width=d->Width;p->height=d->Height;p->format=d->Format;
    p->api=(struct streamee_optiflow_api){.destroy=fake_destroy,.submit_into=fake_submit,.get_stats=fake_stats};
    return true;
}
static struct mp_image *allocate_output(struct priv *p,struct mp_image *img) {
    (void)p;if(fail_alloc && --fail_alloc==0) return NULL;
    struct mp_image *out=mp_image_new_ref(img);out->id=-1;return out;
}
static struct mp_image *frame(int id,double pts) {
    struct mp_image *img=calloc(1,sizeof(*img));assert(img);live_images++;
    *img=(struct mp_image){.id=id,.pts=pts,.pkt_duration=0.04,.nominal_fps=25,
        .usable=true,.width=1920,.height=1088,.format=DXGI_FORMAT_NV12,.hwctx=&device_a};
    img->planes[0]=(void *)1;device_a.refs++;return img;
}
struct fixture { struct priv state; struct mp_pin in,out; struct mp_filter filter; };
static void init(struct fixture *t) {
    assert(!live_images && !device_a.refs && !device_b.refs && !captions.refs);
    memset(t,0,sizeof(*t));opens=closes=fail_submit=fail_alloc=0;fail_open=false;
    t->out.wants=true;t->filter=(struct mp_filter){.priv=&t->state,.ppins={&t->in,&t->out}};
}
static void add(struct fixture *t,struct mp_image *img) { mp_pin_in_write(&t->in,(struct mp_frame){MP_FRAME_VIDEO,img}); }
static void pump(struct fixture *t,bool eof) {
    if(eof) mp_pin_in_write(&t->in,(struct mp_frame){MP_FRAME_EOF,NULL});
    for(int i=0;i<2048 && (t->in.count || t->state.midpoint);i++) process(&t->filter);
    assert(!t->in.count && !t->state.midpoint);
}
static void finish(struct fixture *t) {
    destroy(&t->filter);
    for(unsigned i=0;i<t->out.count;i++) if(t->out.queue[i].type==MP_FRAME_VIDEO) image_free(t->out.queue[i].data);
    for(unsigned i=0;i<t->in.count;i++) if(t->in.queue[i].type==MP_FRAME_VIDEO) image_free(t->in.queue[i].data);
    assert(!live_images && !device_a.refs && !device_b.refs && !captions.refs);
    assert(opens>=closes);
}
static struct mp_image *at(struct fixture *t,int n) { assert(t->out.queue[n].type==MP_FRAME_VIDEO);return t->out.queue[n].data; }
static void cadence(const double *times,int count) {
    struct fixture t;init(&t);
    for(int i=0;i<count;i++) add(&t,frame(i,times[i]));
    pump(&t,true);
    assert(t.out.count==(unsigned)(count?2*count:1)); // Includes EOF.
    if(count) {
        assert(t.state.inputs==count && t.state.outputs==2*count-1);
        assert(t.state.stats.synthesized==count-1);
        for(int i=0;i<count;i++) {
            struct mp_image *original=at(&t,2*i);assert(original->id==i && original->pts==times[i]);
            if(i+1<count) {
                struct mp_image *mid=at(&t,2*i+1);
                assert(mid->pts==times[i]/2+times[i+1]/2);
                assert(fabs(original->pkt_duration+mid->pkt_duration-(times[i+1]-times[i]))<1e-12);
            } else assert(original->pkt_duration==0.04);
        }
    }
    assert(t.out.queue[t.out.count-1].type==MP_FRAME_EOF);finish(&t);
}
int main(void) {
    double times[31];cadence(times,0);times[0]=0;cadence(times,1);
    const double rates[]={24000.0/1001,24,25,30000.0/1001,30};
    for(int r=0;r<5;r++) {for(int i=0;i<31;i++) times[i]=i/rates[r];cadence(times,31);}
    const double variable[]={-0.03,0,0.041,0.09,0.13,0.229,0.24};cadence(variable,7);
    struct fixture t;
    // Dynamic metadata change holds pixels/metadata, strips caption events, and does not reopen.
    init(&t);struct mp_image *a=frame(0,0),*b=frame(1,0.04);a->metadata=1;b->metadata=2;
    a->a53_cc=&captions;captions.refs++;
    a->num_ff_side_data=1;a->ff_side_data=calloc(1,sizeof(*a->ff_side_data));
    a->ff_side_data[0]=(struct mp_ff_side_data){AV_FRAME_DATA_A53_CC,&captions};captions.refs++;
    add(&t,a);add(&t,b);pump(&t,true);
    assert(opens==1 && t.state.stats.metadata_holds==1 && at(&t,1)->id==0 && at(&t,1)->metadata==1);
    assert(at(&t,0)->a53_cc && !at(&t,1)->a53_cc && !at(&t,1)->num_ff_side_data);finish(&t);
    for(int metadata=-1;metadata<=0;metadata++) {
        init(&t);a=frame(0,0);b=frame(1,.04);a->metadata=1;b->metadata=metadata;
        add(&t,a);add(&t,b);pump(&t,true);
        assert(opens==1 && t.state.stats.metadata_holds==1 && at(&t,1)->metadata==1);
        assert(!strcmp(t.state.reason,metadata<0?"unsupported-dynamic-metadata":"metadata-change"));
        assert(t.state.stats.allocated_bytes==0);finish(&t);
    }
    // Format, colour, device and timestamp discontinuities never synthesize across the boundary.
    for(int mode=0;mode<8;mode++) {
        init(&t);a=frame(0,0);b=frame(1,0.04);
        switch(mode) {
        case 0:b->format=DXGI_FORMAT_P010;break;
        case 1:b->width=3840;b->height=2176;break;
        case 2:b->params.interpretation=1;break;
        case 3:device_a.refs--;b->hwctx=&device_b;device_b.refs++;break;
        case 4:b->pts=0;break;
        case 5:b->pts=-1;break;
        case 6:b->pts=1;break;
        case 7:b->usable=false;break;
        }
        add(&t,a);add(&t,b);pump(&t,true);
        assert(t.state.outputs==2 && at(&t,0)->id==0 && at(&t,1)->id==1);
        assert(t.state.stats.synthesized==0);assert(opens==(mode==7?1:2));finish(&t);
    }
    init(&t);
    for(int i=0;i<4;i++) { a=frame(i,i*.04);if(i>=2)a->format=DXGI_FORMAT_P010;add(&t,a); }
    pump(&t,true);assert(opens==2 && closes==2 && t.state.outputs==6 && t.state.stats.synthesized==2);
    assert(t.state.stats.allocated_bytes==0);finish(&t);
    // Unsupported input can recover; initialization failure retries only after reset.
    init(&t);a=frame(0,0);a->usable=false;add(&t,a);add(&t,frame(1,.04));add(&t,frame(2,.08));pump(&t,true);
    assert(t.state.bypassed==1 && t.state.outputs==4 && opens==1);finish(&t);
    init(&t);fail_open=true;for(int i=0;i<3;i++) add(&t,frame(i,i*.04));pump(&t,true);
    assert(opens==1 && closes==0 && t.state.bypassed==3);reset(&t.filter);
    fail_open=false;add(&t,frame(3,0));add(&t,frame(4,.04));pump(&t,true);assert(opens==2);finish(&t);
    // Processing and allocation failure drain queued originals exactly once.
    for(int mode=0;mode<3;mode++) {
        init(&t);if(mode==2)fail_alloc=1;else fail_submit=mode+1;
        for(int i=0;i<4;i++) add(&t,frame(i,i*.04));pump(&t,true);
        assert(t.state.outputs==4 && t.state.disabled && opens==1 && closes==1);
        for(int i=0;i<4;i++) assert(at(&t,i)->id==i);finish(&t);
    }
    // Downstream backpressure and reset release both pending image references.
    init(&t);add(&t,frame(0,0));add(&t,frame(1,.04));t.out.wants=false;
    process(&t.filter);assert(t.in.count==2 && !opens);t.out.wants=true;
    process(&t.filter);process(&t.filter);assert(t.state.midpoint && t.state.held);
    reset(&t.filter);assert(!t.state.midpoint && !t.state.held && !t.state.session);
    add(&t,frame(2,3));add(&t,frame(3,3.04));pump(&t,true);assert(opens==2);finish(&t);
    for(int cycle=0;cycle<64;cycle++) { times[0]=0;times[1]=0.04;cadence(times,2); }
    puts("Actual filter host scheduling: rational/VFR cadence, EOF, holds, transitions, failures, backpressure and reset passed; no GPU calls");
    return 0;
}
