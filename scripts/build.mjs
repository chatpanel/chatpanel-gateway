// Compile the gateway into standalone single-file binaries with Bun.
//
// Run with Bun:  bun scripts/build.mjs            (all four platforms)
//                bun scripts/build.mjs macos-arm64 (one, by output-name substring)
//
// Why a JS build script instead of `bun build --compile` on the CLI: NER runs on
// the onnxruntime-web WASM runtime inside the binary, which requires (a) aliasing
// the native `onnxruntime-node` and `sharp` imports to inert stubs so their dlopen
// never runs, and (b) embedding the ORT wasm files. Aliasing needs a build plugin,
// and the CLI `--compile` doesn't accept plugins — only the Bun.build() API does.

import path from 'node:path';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';

const ROOT = path.join(import.meta.dir, '..');
const ORT_STUB = path.join(import.meta.dir, 'stubs', 'onnxruntime-node.mjs');
const SHARP_STUB = path.join(import.meta.dir, 'stubs', 'sharp.mjs');
const ENTRY = path.join(ROOT, 'bin', 'chatpanel-gateway-bin.mjs');

// Copy the ORT-web WASM runtime into assets/ so the binary entry can embed it
// (the `with { type: 'file' }` import resolves against a real file at build time).
const ORT_DIST = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const ASSETS = path.join(ROOT, 'assets');
mkdirSync(ASSETS, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
  const src = path.join(ORT_DIST, f);
  if (!existsSync(src)) {
    console.error(`missing ${src} — is onnxruntime-web installed? (npm i)`);
    process.exit(1);
  }
  copyFileSync(src, path.join(ASSETS, f));
}

// Stub the native deps NER doesn't use in the binary (forces the WASM backend).
const aliasNativeDeps = {
  name: 'alias-native-deps',
  setup(build) {
    build.onResolve({ filter: /^onnxruntime-node($|\/)/ }, () => ({ path: ORT_STUB }));
    build.onResolve({ filter: /^sharp($|\/)/ }, () => ({ path: SHARP_STUB }));
  },
};

const targets = [
  ['bun-darwin-arm64', 'chatpanel-gateway-macos-arm64'],
  ['bun-darwin-x64', 'chatpanel-gateway-macos-x64'],
  ['bun-linux-x64', 'chatpanel-gateway-linux-x64'],
  ['bun-windows-x64', 'chatpanel-gateway-windows-x64.exe'],
];

const only = process.argv[2]; // optional: filter to one target by name substring
mkdirSync(path.join(ROOT, 'dist'), { recursive: true });

for (const [target, out] of targets) {
  if (only && !out.includes(only)) continue;
  console.log(`→ building dist/${out} (${target})`);
  const result = await Bun.build({
    entrypoints: [ENTRY],
    target: 'bun',
    plugins: [aliasNativeDeps],
    compile: { target, outfile: path.join(ROOT, 'dist', out) },
  });
  if (!result.success) {
    console.error('BUILD FAILED', target);
    for (const l of result.logs) console.error(l);
    process.exit(1);
  }
}
console.log('✓ binaries in dist/');
