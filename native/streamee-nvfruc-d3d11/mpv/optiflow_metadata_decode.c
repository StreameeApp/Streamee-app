/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Bounded software decode of user-supplied samples. Never creates a GPU device. */
#include <stdio.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include "video/filter/optiflow_metadata.h"
#define REQUIRE(c) do { if(!(c)) { fprintf(stderr,"Decode metadata check failed at %d\n",__LINE__); goto end; } } while(0)
int main(int argc,char **argv) {
    AVFormatContext *format=NULL;AVCodecContext *decoder=NULL;
    AVPacket *packet=av_packet_alloc();AVFrame *frame=av_frame_alloc();
    struct mp_image *previous=NULL,*current=NULL,*held=NULL;
    int result=1,frames=0,dovi=0,hdr_plus=0,compatible=0,changed=0,unsupported=0;
    if(argc!=2) {fprintf(stderr,"Usage: optiflow-metadata-decode local-video\n");goto end;}
    REQUIRE(packet && frame);
    REQUIRE(avformat_open_input(&format,argv[1],NULL,NULL)>=0);
    REQUIRE(avformat_find_stream_info(format,NULL)>=0);
    int video=av_find_best_stream(format,AVMEDIA_TYPE_VIDEO,-1,-1,NULL,0);REQUIRE(video>=0);
    const AVCodec *codec=avcodec_find_decoder(format->streams[video]->codecpar->codec_id);REQUIRE(codec);
    decoder=avcodec_alloc_context3(codec);REQUIRE(decoder);
    REQUIRE(avcodec_parameters_to_context(decoder,format->streams[video]->codecpar)>=0);
    decoder->thread_count=2;
    REQUIRE(avcodec_open2(decoder,codec,NULL)>=0);
    bool eof=false;
    while(frames<120 && !eof) {
        int read=av_read_frame(format,packet);
        eof=read==AVERROR_EOF;REQUIRE(read>=0 || eof);
        if(!eof && packet->stream_index!=video) {av_packet_unref(packet);continue;}
        REQUIRE(avcodec_send_packet(decoder,eof?NULL:packet)>=0);av_packet_unref(packet);
        while(frames<120) {
            int decoded=avcodec_receive_frame(decoder,frame);
            if(decoded==AVERROR(EAGAIN) || decoded==AVERROR_EOF) break;
            REQUIRE(decoded>=0 && !decoder->hw_device_ctx && !frame->hw_frames_ctx);
            current=mp_image_from_av_frame(frame);REQUIRE(current);av_frame_unref(frame);
            frames++;dovi+=current->params.repr.dovi!=NULL;
            hdr_plus+=side_data(current,AV_FRAME_DATA_DYNAMIC_HDR_PLUS)!=NULL;
            if(previous) {
                bool supported=metadata_equal(previous,previous) && metadata_equal(current,current);
                if(!supported) unsupported++;
                else if(metadata_equal(previous,current)) compatible++;
                else changed++;
                held=mp_image_new_ref(previous);REQUIRE(held);
                bool held_supported=metadata_equal(previous,previous);
                talloc_free(previous);previous=NULL;
                // Actual MPV/AVBuffer ownership must survive source release.
                REQUIRE(metadata_equal(held,held)==held_supported);
                if(held->dovi) REQUIRE(held->params.repr.dovi==(void *)held->dovi->data);
                talloc_free(held);held=NULL;
            }
            previous=current;current=NULL;
        }
    }
    REQUIRE(frames>=2 && dovi+hdr_plus>0 && compatible+changed+unsupported==frames-1);
    printf("{\"softwareDecode\":true,\"frames\":%d,\"dovi\":%d,\"hdr10plus\":%d,"
           "\"compatiblePairs\":%d,\"metadataChanges\":%d,\"unsupportedPairs\":%d}\n",
           frames,dovi,hdr_plus,compatible,changed,unsupported);
    result=0;
end:
    talloc_free(held);talloc_free(previous);talloc_free(current);
    av_frame_free(&frame);av_packet_free(&packet);avcodec_free_context(&decoder);avformat_close_input(&format);
    return result;
}
