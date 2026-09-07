// A minimal SentencePiece (Unigram) tokenizer — parse the .model protobuf and
// encode with Viterbi.
//
// Why not a library: the reference implementation for pocket-tts ships a 4 MB
// WASM-bundled sentencepiece build aimed at browsers. This gateway is
// zero-runtime-dependency by design and also compiles into a Bun single-file
// binary, so a 4 MB WASM blob for what is fundamentally a shortest-path search
// over a 4,000-entry vocabulary is the wrong trade.
//
// Scope is deliberately narrow: UNIGRAM models with byte fallback, which is what
// pocket-tts uses (4,000 pieces, each with a log-probability score, plus the 256
// <0xNN> byte pieces). A BPE model would need a different algorithm and is
// rejected at load rather than silently mis-tokenized.

const UNK = 0, NORMAL_TYPE = 1, CONTROL = 3, BYTE = 6;
// SentencePiece represents a space as U+2581 LOWER ONE EIGHTH BLOCK.
const SPACE = '▁';

function readVarint(buf, i) {
  let result = 0, shift = 0;
  for (;;) {
    const b = buf[i++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [result, i];
    shift += 7;
    if (shift > 49) throw new Error('varint too long');
  }
}

// ModelProto { repeated SentencePiece pieces = 1; ... }
// SentencePiece { string piece = 1; float score = 2; Type type = 3; }
function parseModelProto(buf) {
  const pieces = [];
  let i = 0;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = key >> 3, wire = key & 7;
    if (wire === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      const chunk = buf.subarray(i, i + len);
      i += len;
      if (field === 1) pieces.push(parsePiece(chunk));
    } else if (wire === 0) {
      [, i] = readVarint(buf, i);
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return pieces;
}

function parsePiece(buf) {
  let i = 0, piece = '', score = 0, type = NORMAL_TYPE;
  while (i < buf.length) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = key >> 3, wire = key & 7;
    if (wire === 2) {
      let len;
      [len, i] = readVarint(buf, i);
      const val = buf.subarray(i, i + len);
      i += len;
      if (field === 1) piece = new TextDecoder().decode(val);
    } else if (wire === 5) {
      if (field === 2) score = new DataView(buf.buffer, buf.byteOffset + i, 4).getFloat32(0, true);
      i += 4;
    } else if (wire === 0) {
      let v;
      [v, i] = readVarint(buf, i);
      if (field === 3) type = v;
    } else {
      break;
    }
  }
  return { piece, score, type };
}

export class SentencePieceUnigram {
  constructor(modelBytes) {
    const pieces = parseModelProto(modelBytes);
    if (!pieces.length) throw new Error('sentencepiece model contains no pieces');
    // A unigram model scores every piece; a BPE model does not. Rejecting here
    // beats producing plausible-looking but wrong token ids.
    if (!pieces.some((p) => p.score !== 0)) {
      throw new Error('this looks like a BPE sentencepiece model — only unigram is supported');
    }
    this.pieces = pieces;
    this.vocab = new Map();
    this.byteId = new Array(256).fill(-1);
    this.unkId = 0;
    for (let id = 0; id < pieces.length; id++) {
      const { piece, type } = pieces[id];
      if (type === UNK) this.unkId = id;
      if (type === BYTE) {
        const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(piece);
        if (m) this.byteId[parseInt(m[1], 16)] = id;
        continue;
      }
      // Control pieces (<s>, </s>, <pad>) are addressable by id but must never be
      // produced by encoding text — they are inserted by the caller if wanted.
      if (type === CONTROL) continue;
      if (!this.vocab.has(piece)) this.vocab.set(piece, id);
    }
    this.maxPieceLen = Math.max(...[...this.vocab.keys()].map((p) => p.length), 1);
  }

  get vocabSize() { return this.pieces.length; }

  /** Text → token ids. Viterbi over piece scores, byte fallback for the rest. */
  encodeIds(text) {
    const norm = SPACE + String(text ?? '').normalize('NFKC').replace(/ /g, SPACE);
    const n = norm.length;
    // best[i] = { score, from, id } for the best segmentation of norm[0..i)
    const best = new Array(n + 1).fill(null);
    best[0] = { score: 0, from: -1, id: -1, bytes: null };

    for (let i = 0; i < n; i++) {
      if (!best[i]) continue;
      let matched = false; // kept for readability of the fallback comment below
      const limit = Math.min(n, i + this.maxPieceLen);
      for (let j = i + 1; j <= limit; j++) {
        const id = this.vocab.get(norm.slice(i, j));
        if (id === undefined) continue;
        matched = true;
        const score = best[i].score + this.pieces[id].score;
        if (!best[j] || score > best[j].score) best[j] = { score, from: i, id, bytes: null };
      }
      // Byte fallback is ALWAYS offered as an alternative, not only when nothing
      // matched: a character can be in the vocabulary and still be the wrong split
      // for the sentence around it. The per-byte penalty is far worse than any real
      // piece's score, so Viterbi picks it only when it genuinely has to.
      void matched;
      {
        const ch = String.fromCodePoint(norm.codePointAt(i));
        const j = i + ch.length;
        const bytes = new TextEncoder().encode(ch);
        if (bytes.every((b) => this.byteId[b] >= 0)) {
          const score = best[i].score + bytes.length * -10;
          if (!best[j] || score > best[j].score) best[j] = { score, from: i, id: -1, bytes };
        }
      }
    }

    if (!best[n]) return [this.unkId];
    const out = [];
    for (let i = n; i > 0;) {
      const node = best[i];
      if (node.bytes) for (let k = node.bytes.length - 1; k >= 0; k--) out.push(this.byteId[node.bytes[k]]);
      else out.push(node.id);
      i = node.from;
    }
    return out.reverse();
  }

  /** Token ids → text. Byte pieces are reassembled before decoding as UTF-8. */
  decodeIds(ids) {
    const parts = [];
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      parts.push(new TextDecoder().decode(Uint8Array.from(pending)));
      pending = [];
    };
    for (const id of ids) {
      const p = this.pieces[id];
      if (!p) continue;
      if (p.type === BYTE) {
        const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(p.piece);
        if (m) { pending.push(parseInt(m[1], 16)); continue; }
      }
      flush();
      if (p.type === CONTROL || p.type === UNK) continue;
      parts.push(p.piece);
    }
    flush();
    return parts.join('').replace(new RegExp(SPACE, 'g'), ' ').replace(/^ /, '');
  }
}
