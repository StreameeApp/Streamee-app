#pragma once

#include <cstdint>
#include <cstddef>
#include <cstring>
#include <emmintrin.h>

// SSE2 is part of the Windows x64 baseline. Unaligned loads support arbitrary
// VapourSynth row strides; the scalar tail handles widths not divisible by 16.
namespace nv12 {
// Contiguous planes need one bulk copy, not thousands of short row copies.
// Padded or negative strides retain the row path without touching padding.
inline void copy_plane(const std::uint8_t *source, std::ptrdiff_t source_stride,
                       std::uint8_t *target, std::ptrdiff_t target_stride,
                       int width, int height) {
    if (width <= 0 || height <= 0) return;
    if (source_stride == width && target_stride == width) {
        std::memcpy(target, source, static_cast<std::size_t>(width) * height);
    } else {
        for (int y = 0; y < height; ++y) {
            std::memcpy(target + y * target_stride, source + y * source_stride, width);
        }
    }
}

inline void interleave(const std::uint8_t *u, const std::uint8_t *v,
                       std::uint8_t *uv, int count) {
    int x = 0;
    for (; x + 16 <= count; x += 16) {
        const auto a = _mm_loadu_si128(reinterpret_cast<const __m128i *>(u + x));
        const auto b = _mm_loadu_si128(reinterpret_cast<const __m128i *>(v + x));
        _mm_storeu_si128(reinterpret_cast<__m128i *>(uv + 2 * x), _mm_unpacklo_epi8(a, b));
        _mm_storeu_si128(reinterpret_cast<__m128i *>(uv + 2 * x + 16), _mm_unpackhi_epi8(a, b));
    }
    for (; x < count; ++x) {
        uv[2 * x] = u[x];
        uv[2 * x + 1] = v[x];
    }
}

inline void deinterleave(const std::uint8_t *uv, std::uint8_t *u,
                         std::uint8_t *v, int count) {
    const auto mask = _mm_set1_epi16(0xff);
    int x = 0;
    for (; x + 16 <= count; x += 16) {
        const auto a = _mm_loadu_si128(reinterpret_cast<const __m128i *>(uv + 2 * x));
        const auto b = _mm_loadu_si128(reinterpret_cast<const __m128i *>(uv + 2 * x + 16));
        _mm_storeu_si128(reinterpret_cast<__m128i *>(u + x),
            _mm_packus_epi16(_mm_and_si128(a, mask), _mm_and_si128(b, mask)));
        _mm_storeu_si128(reinterpret_cast<__m128i *>(v + x),
            _mm_packus_epi16(_mm_srli_epi16(a, 8), _mm_srli_epi16(b, 8)));
    }
    for (; x < count; ++x) {
        u[x] = uv[2 * x];
        v[x] = uv[2 * x + 1];
    }
}
} // namespace nv12
