/* SPDX-License-Identifier: GPL-3.0-or-later */
#include <stdio.h>
#include "video/filter/optiflow_metadata.h"
#define CHECK(value) do { if(!(value)) { fprintf(stderr,"Metadata check failed at %d\n",__LINE__); return 1; } } while(0)
int main(void) {
    struct pl_dovi_metadata a={0},b={0};
    for(int c=0;c<3;c++) {
        a.comp[c].num_pivots=b.comp[c].num_pivots=2;
        a.comp[c].pivots[1]=b.comp[c].pivots[1]=1;
        a.comp[c].poly_coeffs[0][1]=b.comp[c].poly_coeffs[0][1]=1;
    }
    CHECK(dovi_equal(&a,&b));
    b.comp[0].poly_coeffs[4][2]=1; // Inactive segment data is not meaningful.
    CHECK(dovi_equal(&a,&b));
    b.comp[0].poly_coeffs[0][1]=0.9;
    CHECK(!dovi_equal(&a,&b));
    b=a;b.nlq_active=true;CHECK(!dovi_equal(&a,&b));
    b=a;b.comp[0].num_pivots=10;CHECK(!dovi_equal(&a,&b));
    CHECK(!dovi_equal(&a,NULL));
    b=a;b.nonlinear_offset[0]=INFINITY;CHECK(!dovi_equal(&b,&b));
    b=a;b.comp[0].pivots[1]=NAN;CHECK(!dovi_equal(&b,&b));
    b=a;b.comp[0].pivots[1]=0;CHECK(!dovi_equal(&b,&b));
    b=a;b.comp[0].method[0]=2;CHECK(!dovi_equal(&b,&b));
    b=a;b.comp[0].poly_coeffs[0][0]=INFINITY;CHECK(!dovi_equal(&b,&b));
    struct pl_dovi_metadata mmr=a;
    mmr.comp[0].method[0]=1;mmr.comp[0].mmr_order[0]=2;b=mmr;
    CHECK(dovi_equal(&mmr,&b));
    b.comp[0].mmr_coeffs[0][2][0]=99;CHECK(dovi_equal(&mmr,&b));
    b.comp[0].mmr_coeffs[0][1][6]=1;CHECK(!dovi_equal(&mmr,&b));
    b=mmr;b.comp[0].mmr_order[0]=4;CHECK(!dovi_equal(&b,&b));
    b=mmr;b.comp[0].mmr_constant[0]=INFINITY;CHECK(!dovi_equal(&b,&b));

    size_t size=0;AVDynamicHDRPlus *x=av_dynamic_hdr_plus_alloc(&size);
    CHECK(x);
    x->itu_t_t35_country_code=0xb5;x->application_version=1;x->num_windows=1;
    x->targeted_system_display_maximum_luminance=(AVRational){1000,1};
    for(int c=0;c<3;c++) x->params[0].maxscl[c]=(AVRational){1,2};
    x->params[0].average_maxrgb=(AVRational){1,4};
    x->params[0].fraction_bright_pixels=(AVRational){0,1};
    AVBufferRef *ax=av_buffer_alloc(size),*by=av_buffer_alloc(size);
    CHECK(ax && by);memcpy(ax->data,x,size);memcpy(by->data,x,size);av_free(x);
    AVDynamicHDRPlus *y=(void *)by->data;
    CHECK(hdr_plus_equal(ax,by));
    y->params[0].maxscl[0]=(AVRational){2,4};
    y->params[2].num_bezier_curve_anchors=9;
    CHECK(hdr_plus_equal(ax,by)); // Equivalent rationals and inactive storage.
    y->params[0].average_maxrgb=(AVRational){1,3};CHECK(!hdr_plus_equal(ax,by));
    memcpy(by->data,ax->data,size);y->application_version=2;CHECK(!hdr_plus_equal(ax,by));
    memcpy(by->data,ax->data,size);y->num_windows=2;CHECK(!hdr_plus_equal(ax,by));
    memcpy(by->data,ax->data,size);y->params[0].num_distribution_maxrgb_percentiles=255;
    CHECK(!hdr_plus_equal(ax,by));CHECK(!hdr_plus_equal(ax,NULL));
    memcpy(by->data,ax->data,size);y->params[0].maxscl[0]=(AVRational){1000000000,2000000000};
    CHECK(hdr_plus_equal(ax,by)); // Large equivalent rationals must not overflow.
    y->params[0].num_bezier_curve_anchors=255;CHECK(hdr_plus_equal(ax,by)); // Inactive tone map.
    y->itu_t_t35_country_code=0;CHECK(hdr_plus_equal(ax,by)); // Pinned decoder omits the outer header member.
    for(int fault=0;fault<10;fault++) {
        memcpy(by->data,ax->data,size);
        switch(fault) {
        case 0:y->params[0].maxscl[0].den=0;break;
        case 1:y->params[0].fraction_bright_pixels=(AVRational){-1,1000};break;
        case 2:y->params[0].average_maxrgb=(AVRational){2,1};break;
        case 3:y->targeted_system_display_actual_peak_luminance_flag=1;break;
        case 4:y->mastering_display_actual_peak_luminance_flag=1;break;
        case 5:y->itu_t_t35_country_code=1;break;
        case 6:y->params[0].tone_mapping_flag=2;break;
        case 7:y->params[0].color_saturation_mapping_flag=1;break;
        case 8:y->params[0].maxscl[0]=(AVRational){1,3};break; // Not representable without truncation.
        case 9:y->params[0].average_maxrgb.den=-1;break;
        }
        CHECK(!hdr_plus_equal(by,by));
    }
    memcpy(by->data,ax->data,size);
    y->params[0].tone_mapping_flag=1;
    y->params[0].knee_point_x=y->params[0].knee_point_y=(AVRational){2048,4095};
    y->params[0].num_bezier_curve_anchors=1;y->params[0].bezier_curve_anchors[0]=(AVRational){512,1023};
    CHECK(hdr_plus_equal(by,by));
    y->params[0].bezier_curve_anchors[0].den=0;CHECK(!hdr_plus_equal(by,by));
    AVBufferRef *short_data=av_buffer_alloc(1);CHECK(short_data);
    CHECK(!hdr_plus_equal(short_data,short_data));av_buffer_unref(&short_data);
    av_buffer_unref(&ax);av_buffer_unref(&by);

    struct mp_image first={0},second={0};
    CHECK(metadata_equal(&first,&second));
    second.params.color.hdr.max_cll=1000;CHECK(!metadata_equal(&first,&second));
    CHECK(static_equal(first.params,second.params));
    second.params.color.transfer=PL_COLOR_TRC_PQ;CHECK(!static_equal(first.params,second.params));
    second=first;second.params.crop.x0=2;CHECK(!static_equal(first.params,second.params));
    second=first;second.params.repr.levels=PL_COLOR_LEVELS_LIMITED;CHECK(!static_equal(first.params,second.params));
    second=first;second.params.color.primaries=PL_COLOR_PRIM_BT_2020;CHECK(!static_equal(first.params,second.params));
    first=(struct mp_image){0};second=(struct mp_image){0};
    second.params.repr.sys=PL_COLOR_SYSTEM_BT_2020_NC;
    second.params.color.primaries=PL_COLOR_PRIM_BT_2020;second.params.color.transfer=PL_COLOR_TRC_PQ;
    first.params=second.params;first.params.repr.sys=PL_COLOR_SYSTEM_DOLBYVISION;first.params.repr.dovi=&a;
    first.params.sys_orig=second.params.repr.sys;
    first.params.primaries_orig=second.params.color.primaries;first.params.transfer_orig=second.params.color.transfer;
    CHECK(static_equal(first.params,second.params)); // Metadata loss keeps decoder resources.
    CHECK(!metadata_equal(&first,&second)); // But must hold the midpoint with earlier interpretation.
    const int unsupported[]={AV_FRAME_DATA_DOVI_RPU_BUFFER,AV_FRAME_DATA_DYNAMIC_HDR_VIVID,
        AV_FRAME_DATA_DYNAMIC_HDR_SMPTE_2094_APP5};
    for(int i=0;i<3;i++) {
        struct mp_ff_side_data data={.type=unsupported[i],.buf=av_buffer_alloc(16)};CHECK(data.buf);
        first=(struct mp_image){.num_ff_side_data=1,.ff_side_data=&data};
        CHECK(!metadata_equal(&first,&first));
        av_buffer_unref(&data.buf);
    }
    struct mp_image *source=mp_image_alloc(IMGFMT_NV12,16,16);
    struct mp_image *generated=mp_image_alloc(IMGFMT_NV12,16,16);
    CHECK(source && generated);
    source->dovi=av_buffer_alloc(sizeof(a));CHECK(source->dovi);
    memcpy(source->dovi->data,&a,sizeof(a));source->params.repr.dovi=(void *)source->dovi->data;
    source->params.color.hdr.max_cll=1000;
    source->num_ff_side_data=1;
    source->ff_side_data=talloc_zero_array(NULL,struct mp_ff_side_data,1);
    source->ff_side_data[0].type=AV_FRAME_DATA_DYNAMIC_HDR_SMPTE_2094_APP5;
    source->ff_side_data[0].buf=av_buffer_alloc(16);CHECK(source->ff_side_data[0].buf);
    memset(source->ff_side_data[0].buf->data,0x5a,16);
    CHECK(!metadata_equal(source,source));
    mp_image_copy_attributes(generated,source);
    struct mp_image *held=mp_image_new_ref(source);CHECK(held);
    talloc_free(source);
    CHECK(generated->params.repr.dovi==(void *)generated->dovi->data);
    CHECK(dovi_equal(generated->params.repr.dovi,&a));
    CHECK(held->params.color.hdr.max_cll==1000);
    CHECK(side_data(held,AV_FRAME_DATA_DYNAMIC_HDR_SMPTE_2094_APP5)->data[0]==0x5a);
    talloc_free(generated);
    CHECK(dovi_equal(held->params.repr.dovi,&a));
    talloc_free(held);
    puts("OptiFlow metadata semantics, missing metadata, unsupported versions and bounds passed");
    return 0;
}
