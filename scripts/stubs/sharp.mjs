// Build-time stub for `sharp`, applied ONLY in the Bun --compile binary (via the
// alias plugin in scripts/build.mjs).
//
// transformers' Node bundle does `import sharp from "sharp"` at top level, and the
// real package throws at init when its native binary is absent (as in a single-file
// binary). NER never processes images, so a no-op default export keeps the module
// graph importable without shipping sharp's native deps.

const sharp = function sharp() {
  throw new Error('sharp is stubbed out in the standalone binary; image processing is unavailable.');
};
export default sharp;
