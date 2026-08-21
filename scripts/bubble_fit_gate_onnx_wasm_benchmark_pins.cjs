"use strict";

const BUBBLE_FIT_GATE_BENCHMARK_RUNTIME_PINS = Object.freeze({
  packageName: "onnxruntime-web",
  packageVersion: "1.27.0",
  entry: Object.freeze({
    file: "ort.node.min.js",
    sha256: "e83abc8b43ce2e160d3fe1a84ac7cdb674e7c3713e84545da1ba27baaf56db4a",
    sizeBytes: 27_103,
  }),
  wasmModule: Object.freeze({
    file: "ort-wasm-simd-threaded.mjs",
    sha256: "0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3",
    sizeBytes: 24_180,
  }),
  wasmBinary: Object.freeze({
    file: "ort-wasm-simd-threaded.wasm",
    sha256: "d1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6",
    sizeBytes: 13_479_978,
  }),
});

module.exports = { BUBBLE_FIT_GATE_BENCHMARK_RUNTIME_PINS };
