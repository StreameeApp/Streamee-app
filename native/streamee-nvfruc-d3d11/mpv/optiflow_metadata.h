/* SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef STREAMEE_OPTIFLOW_METADATA_H
#define STREAMEE_OPTIFLOW_METADATA_H
#include <string.h>
#include <math.h>
#include <libavutil/hdr_dynamic_metadata.h>
#include "video/mp_image.h"
static bool static_equal(struct mp_image_params a,struct mp_image_params b) {
    // A missing/changing Dolby Vision mapping is a pair hold, not a decoder
    // resource change. Compare the underlying source interpretation here.
    mp_image_params_restore_dovi_mapping(&a);
    mp_image_params_restore_dovi_mapping(&b);
    a.color.hdr=b.color.hdr=(struct pl_hdr_metadata){0};
    a.repr.dovi=b.repr.dovi=NULL;
    return mp_image_params_equal(&a,&b);
}
static bool dovi_equal(const struct pl_dovi_metadata *a,const struct pl_dovi_metadata *b) {
    if(!a || !b) return a==b;
    // Enhancement-layer reconstruction is outside this filter.
    if(a->nlq_active || b->nlq_active) return false;
    for(int c=0;c<3;c++) {
        if(!isfinite(a->nonlinear_offset[c]) || a->nonlinear_offset[c]!=b->nonlinear_offset[c]) return false;
        for(int j=0;j<3;j++)
            if(!isfinite(a->nonlinear.m[c][j]) || !isfinite(a->linear.m[c][j]) ||
               a->nonlinear.m[c][j]!=b->nonlinear.m[c][j] || a->linear.m[c][j]!=b->linear.m[c][j]) return false;
        const struct pl_reshape_data *x=&a->comp[c],*y=&b->comp[c];
        if(x->num_pivots!=y->num_pivots || x->num_pivots<2 || x->num_pivots>9) return false;
        for(int j=0;j<x->num_pivots;j++)
            if(!isfinite(x->pivots[j]) || x->pivots[j]<0 || x->pivots[j]>1 ||
               (j && x->pivots[j]<=x->pivots[j-1]) || x->pivots[j]!=y->pivots[j]) return false;
        for(int j=0;j<x->num_pivots-1;j++) {
            if(x->method[j]!=y->method[j]) return false;
            if(x->method[j]==0) {
                for(int k=0;k<3;k++)
                    if(!isfinite(x->poly_coeffs[j][k]) || x->poly_coeffs[j][k]!=y->poly_coeffs[j][k]) return false;
            } else if(x->method[j]==1) {
                if(x->mmr_order[j]!=y->mmr_order[j] || x->mmr_order[j]<1 || x->mmr_order[j]>3 ||
                   !isfinite(x->mmr_constant[j]) || x->mmr_constant[j]!=y->mmr_constant[j]) return false;
                for(int k=0;k<x->mmr_order[j];k++) for(int l=0;l<7;l++)
                    if(!isfinite(x->mmr_coeffs[j][k][l]) || x->mmr_coeffs[j][k][l]!=y->mmr_coeffs[j][k][l]) return false;
            } else return false;
        }
    }
    return true;
}
static AVBufferRef *side_data(struct mp_image *img,int type) {
    for(int n=0;n<img->num_ff_side_data;n++) if(img->ff_side_data[n].type==type) return img->ff_side_data[n].buf;
    return NULL;
}
static bool normalize_hdr_rational(AVRational *q,int maximum,int scale) {
    if(q->den<=0 || q->num<0) return false;
    int64_t scaled=(int64_t)q->num*scale;
    if(scaled%q->den || scaled/q->den>(int64_t)maximum*scale) return false;
    // The serializer uses integer multiplication/division. Normalize first to
    // avoid overflow with equivalent rationals and reject lossy truncation.
    *q=(AVRational){(int)(scaled/q->den),scale};return true;
}
static bool normalize_hdr_plus(AVDynamicHDRPlus *x) {
    // Spatial metadata cannot simply be carried across spatial warping.
    // The pinned decoder validates the outer T.35 header but leaves this
    // unused struct member zero; the serializer also omits it.
    if(x->num_windows!=1 || x->application_version!=1 ||
       (x->itu_t_t35_country_code && x->itu_t_t35_country_code!=0xb5) ||
       x->targeted_system_display_actual_peak_luminance_flag || x->mastering_display_actual_peak_luminance_flag ||
       !normalize_hdr_rational(&x->targeted_system_display_maximum_luminance,10000,1))
        return false;
    AVHDRPlusColorTransformParams *p=&x->params[0];
    if(p->num_distribution_maxrgb_percentiles>15 || p->tone_mapping_flag>1 ||
       p->color_saturation_mapping_flag || !normalize_hdr_rational(&p->average_maxrgb,1,100000) ||
       !normalize_hdr_rational(&p->fraction_bright_pixels,1,1000)) return false;
    for(int c=0;c<3;c++) if(!normalize_hdr_rational(&p->maxscl[c],1,100000)) return false;
    for(int i=0;i<p->num_distribution_maxrgb_percentiles;i++) {
        if(p->distribution_maxrgb[i].percentage>100 ||
           !normalize_hdr_rational(&p->distribution_maxrgb[i].percentile,1,100000)) return false;
    }
    if(p->tone_mapping_flag) {
        if(p->num_bezier_curve_anchors>15 || !normalize_hdr_rational(&p->knee_point_x,1,4095) ||
           !normalize_hdr_rational(&p->knee_point_y,1,4095) || !p->knee_point_x.num || !p->knee_point_y.num) return false;
        for(int i=0;i<p->num_bezier_curve_anchors;i++)
            if(!normalize_hdr_rational(&p->bezier_curve_anchors[i],1,1023)) return false;
    }
    return true;
}
static bool hdr_plus_equal(AVBufferRef *a,AVBufferRef *b) {
    if(!a || !b) return a==b;
    if(!a->data || !b->data || a->size<sizeof(AVDynamicHDRPlus) || b->size<sizeof(AVDynamicHDRPlus)) return false;
    AVDynamicHDRPlus x=*(AVDynamicHDRPlus *)a->data,y=*(AVDynamicHDRPlus *)b->data;
    if(!normalize_hdr_plus(&x) || !normalize_hdr_plus(&y)) return false;
    uint8_t *cx=NULL,*cy=NULL;size_t nx=0,ny=0;
    bool equal=av_dynamic_hdr_plus_to_t35(&x,&cx,&nx)>=0 &&
        av_dynamic_hdr_plus_to_t35(&y,&cy,&ny)>=0 && nx==ny && !memcmp(cx,cy,nx);
    av_free(cx);av_free(cy);return equal;
}
static bool metadata_equal(struct mp_image *a,struct mp_image *b) {
    // Synthesis additionally requires the effective renderer interpretation.
    if(!mp_image_params_static_equal(&a->params,&b->params) ||
       !pl_hdr_metadata_equal(&a->params.color.hdr,&b->params.color.hdr) ||
       !dovi_equal(a->params.repr.dovi,b->params.repr.dovi) ||
       !hdr_plus_equal(side_data(a,AV_FRAME_DATA_DYNAMIC_HDR_PLUS),side_data(b,AV_FRAME_DATA_DYNAMIC_HDR_PLUS)))
        return false;
    if(side_data(a,AV_FRAME_DATA_DYNAMIC_HDR_VIVID) || side_data(b,AV_FRAME_DATA_DYNAMIC_HDR_VIVID) ||
        side_data(a,AV_FRAME_DATA_DYNAMIC_HDR_SMPTE_2094_APP5) || side_data(b,AV_FRAME_DATA_DYNAMIC_HDR_SMPTE_2094_APP5))
        return false;
    if((side_data(a,AV_FRAME_DATA_DOVI_RPU_BUFFER) && !a->params.repr.dovi) ||
       (side_data(b,AV_FRAME_DATA_DOVI_RPU_BUFFER) && !b->params.repr.dovi))
        return false;
    return true;
}

#endif
