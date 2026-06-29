// Binary entry point for the Bun `--compile` standalone build (no Node required).
//
// A compiled single-file binary cannot embed onnxruntime-node's native dylib, so
// NER runs on the onnxruntime-web WASM runtime instead. We embed that runtime's
// two files INTO the executable here (Bun's `with { type: 'file' }` copies the
// asset in and yields a runtime path to it), then hand their paths to the NER
// engine via a global. src/ner-engine.js sees the global, forces the WASM backend,
// and points ORT at these files. Everything else is the normal CLI.
//
// The npm/Node package uses bin/chatpanel-gateway.js instead, which keeps the
// faster native onnxruntime-node runtime.

import { pathToFileURL } from 'node:url';
import wasmFile from '../assets/ort-wasm-simd-threaded.wasm' with { type: 'file' };
import mjsFile from '../assets/ort-wasm-simd-threaded.mjs' with { type: 'file' };

globalThis.__CHATPANEL_WASM_PATHS__ = {
  wasm: pathToFileURL(wasmFile).href,
  mjs: pathToFileURL(mjsFile).href,
};

// Delegate to the normal CLI (start / --install / --version / …). The global is
// already set, so when the gateway starts NER the engine uses the embedded WASM.
await import('./chatpanel-gateway.js');
