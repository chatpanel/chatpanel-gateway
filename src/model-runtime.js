// Which ONNX runtime is active, and what precision it can actually load.
//
// This is a fact about the RUNTIME, not about any one speech stage, so it lives in
// its own module rather than inside whichever engine needed it first. The voice
// pipeline's rule is that a stage never imports another stage (docs/voice-pipeline.md
// "Composable pipeline"), and stt-engine and tts-engine both have to answer this —
// so neither can own it.
//
//   • native onnxruntime-node (the npm gateway) loads the small, fast `q8`
//     (_quantized) exports — best size + speed.
//   • onnxruntime-web WASM (the standalone binary — SAME wasm on macOS/Windows/
//     Linux, so this is inherently cross-platform) CANNOT load the block-quantized
//     exports (q8/int8/uint8 → MatMulNBits "missing scale"; fp16 → graph error);
//     of the loadable ones only `fp32` is fast enough for real-time (q4/bnb4 are
//     ~8× slower). Verified empirically against the bundled ORT-web build.
//
// The binary entry sets __CHATPANEL_WASM_PATHS__, so that global tells us which
// runtime we're on. A model may override the choice via `dtype` in its catalog.
export function runtimeDtype() {
  return globalThis.__CHATPANEL_WASM_PATHS__ ? 'fp32' : 'q8';
}

// 'native' (npm, fast quantized) | 'wasm' (binary, slow fp32). The extension
// surfaces this so users on the slow WASM build know the native gateway is faster.
export function runtimeName() {
  return globalThis.__CHATPANEL_WASM_PATHS__ ? 'wasm' : 'native';
}

// transformers.js dtype → the ONNX filename suffix it loads. A presence check must
// target the EXACT file the current runtime will fetch — otherwise a q8 install
// (native) looks "present" to the WASM runtime, which actually needs the fp32 file,
// and the offline load fails. Checking the real target makes a runtime switch
// re-download rather than fail.
export const DTYPE_SUFFIX = {
  fp32: '', q8: '_quantized', int8: '_int8', uint8: '_uint8',
  fp16: '_fp16', q4: '_q4', bnb4: '_bnb4', q4f16: '_q4f16',
};
