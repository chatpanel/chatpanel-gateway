// One place to get an onnxruntime, for the engines that drive raw ONNX graphs:
// parakeet (STT) and pocket-tts (TTS). Transformers.js brings its own; these do
// not, and they were each resolving it separately.
//
// KNOWN LIMITATION — raw ORT does not work inside the standalone binary.
// The Bun build embeds the ORT runtime as a virtual path (.wasm) and a blob: URL
// (.mjs), and onnxruntime-web reaches for both with fetch(), which serves neither.
// Handing it the wasm BYTES, pointing wasmPaths at an extracted directory, and
// importing the wasm-only bundle were all tried; each moves the failure without
// removing it. Transformers.js works there because it configures its own bundled
// copy through its own env.
//
// This is NOT new — parakeet has had it since it shipped; it simply failed as an
// opaque "no available backend found" instead of saying so. Models that need this
// runtime are now marked `requiresNative` in their catalogs and are not offered on
// the binary, so the npm gateway is the answer rather than a broken download.

let _promise = null;

/** Is a raw-ONNX engine usable in this process? False inside the binary. */
export function rawOrtAvailable() {
  return !globalThis.__CHATPANEL_WASM_PATHS__;
}

export function ortRuntimeName() {
  return globalThis.__CHATPANEL_WASM_PATHS__ ? 'wasm' : 'native';
}

// 'wasm' in the binary, 'cpu' on the native build. The wrong one makes ORT fall
// through its provider list and report a confusing "no available backend".
export function ortProviders() {
  return globalThis.__CHATPANEL_WASM_PATHS__ ? ['wasm'] : ['cpu'];
}

export function getOrt() {
  if (_promise) return _promise;
  _promise = (async () => {
    const wasmPaths = globalThis.__CHATPANEL_WASM_PATHS__ || null;
    if (!wasmPaths) {
      const mod = await import('onnxruntime-node');
      return mod.InferenceSession ? mod : (mod.default || mod);
    }

    // Say what is actually wrong. ORT's own message describes a failed fetch and
    // sends people looking for a corrupt download.
    throw new Error(
      'this model needs the native onnxruntime, which the standalone binary does not carry — '
      + 'install the npm gateway instead (npm i -g @chatpanel/gateway), or pick a model that runs on the bundled runtime',
    );
  })();
  return _promise;
}
