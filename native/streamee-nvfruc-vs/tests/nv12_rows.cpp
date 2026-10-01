#include "../src/nv12_rows.hpp"
#include <cstdio>
#include <random>
#include <vector>

int main() {
    std::mt19937 random(12345);
    int plane_cases = 0;
    for (int width : {0, 1, 31, 32, 1920, 3840}) {
        for (int height : {0, 1, 7}) {
            for (int source_padding : {0, 13}) {
                for (int target_padding : {0, 17}) {
                    for (int direction : {-1, 1}) {
                        const int source_stride = width + source_padding;
                        const int target_stride = width + target_padding;
                        std::vector<std::uint8_t> source(source_stride * height + 64);
                        for (auto &value : source) value = static_cast<std::uint8_t>(random());
                        std::vector<std::uint8_t> actual(target_stride * height + 64, 0xcd);
                        auto expected = actual;
                        const int source_offset = 7 + (direction < 0 && height > 0 ? (height - 1) * source_stride : 0);
                        const int target_offset = 11;
                        for (int y = 0; y < height; ++y)
                            for (int x = 0; x < width; ++x)
                                expected[target_offset + y * target_stride + x] =
                                    source[source_offset + y * source_stride * direction + x];
                        nv12::copy_plane(source.data() + source_offset, source_stride * direction,
                                         actual.data() + target_offset, target_stride, width, height);
                        if (actual != expected) return 3;
                        ++plane_cases;
                    }
                }
            }
        }
    }
    std::printf("%d plane cases passed: contiguous, padded, reversed, empty and sentinels\n", plane_cases);
    for (int count : {0, 1, 7, 15, 16, 17, 31, 32, 33, 960, 1919, 1920, 1921, 3840}) {
        for (int offset = 0; offset < 16; ++offset) {
            std::vector<std::uint8_t> u(count + 32), v(count + 32);
            for (auto &value : u) value = static_cast<std::uint8_t>(random());
            for (auto &value : v) value = static_cast<std::uint8_t>(random());
            std::vector<std::uint8_t> uv(2 * count + 32, 0xcd), expected = uv;
            for (int x = 0; x < count; ++x) {
                expected[offset + 2 * x] = u[offset + x];
                expected[offset + 2 * x + 1] = v[offset + x];
            }
            nv12::interleave(u.data() + offset, v.data() + offset, uv.data() + offset, count);
            if (uv != expected) return 1;
            std::vector<std::uint8_t> a(count + 32, 0xcd), b = a;
            auto expected_a = a, expected_b = b;
            for (int x = 0; x < count; ++x) {
                expected_a[offset + x] = u[offset + x];
                expected_b[offset + x] = v[offset + x];
            }
            nv12::deinterleave(uv.data() + offset, a.data() + offset, b.data() + offset, count);
            if (a != expected_a || b != expected_b) return 2;
        }
    }
    std::puts("224 row cases passed: exact scalar equivalence, unaligned offsets, tails and sentinels");
}
