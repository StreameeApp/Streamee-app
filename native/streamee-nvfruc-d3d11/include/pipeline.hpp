/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include "bridge.h"
#include <d3d11_4.h>
#include <wrl/client.h>
#include <memory>
#include <optional>
namespace streamee::optiflow {
using Microsoft::WRL::ComPtr;
void validate_config(const streamee_optiflow_config &);
void validate_frame(const D3D11_TEXTURE2D_DESC &, UINT, UINT, UINT, double, std::optional<double>);
struct Output {
    ComPtr<ID3D11Texture2D> texture;
    double timestamp{};
    bool repeated{}, priming{};
    uint32_t reason{};
};
class Pipeline {
public:
    Pipeline(ID3D11Device *, const streamee_optiflow_config &);
    ~Pipeline();
    Pipeline(const Pipeline &) = delete;
    Pipeline &operator=(const Pipeline &) = delete;
    Output submit(ID3D11Texture2D *, UINT, double, bool allow = true);
    Output submit_into(ID3D11Texture2D *, UINT, double, ID3D11Texture2D *, UINT, bool allow = true);
    streamee_optiflow_caps caps() const;
    streamee_optiflow_stats stats() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
