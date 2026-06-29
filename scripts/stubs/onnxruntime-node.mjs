// Build-time stub for `onnxruntime-node`, applied ONLY in the Bun --compile binary
// (via the alias plugin in scripts/build.mjs).
//
// transformers' Node bundle does `import * as ONNX_NODE from "onnxruntime-node"`
// at top level, and onnxruntime-node's binding does an unguarded
// `require(...onnxruntime_binding.node)` — a dlopen of libonnxruntime that can't be
// embedded in a single-file binary, so it would crash the whole import. The binary
// forces the WASM (onnxruntime-web) backend, so this namespace is imported but
// never actually used; an inert stub is enough to keep the module graph importable.

class InferenceSession {
  static async create() {
    throw new Error('onnxruntime-node is stubbed out in the standalone binary; the WASM backend is used instead.');
  }
}
class Tensor {}
const env = {};
const listSupportedBackends = () => [];
export { InferenceSession, Tensor, env, listSupportedBackends };
export default { InferenceSession, Tensor, env, listSupportedBackends };
