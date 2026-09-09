/** Gzip magic (ID1 ID2). OkHttp/Lynx may hand these bytes to JS even after identity. */
const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;
const GZIP_CM_DEFLATE = 8;
const FLG_FHCRC = 2;
const FLG_FEXTRA = 4;
const FLG_FNAME = 8;
const FLG_FCOMMENT = 16;

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 10 && bytes[0] === GZIP_ID1 && bytes[1] === GZIP_ID2;
}

export function gunzipSync(bytes: Uint8Array): Uint8Array {
  if (!isGzip(bytes)) {
    return bytes;
  }
  if (bytes[2] !== GZIP_CM_DEFLATE) {
    throw new Error("gzip: unsupported compression method");
  }
  const headerLen = gzipHeaderLength(bytes);
  if (headerLen < 10 || headerLen + 8 > bytes.length) {
    throw new Error("gzip: truncated header");
  }
  const isize =
    bytes[bytes.length - 4]! |
    (bytes[bytes.length - 3]! << 8) |
    (bytes[bytes.length - 2]! << 16) |
    (bytes[bytes.length - 1]! << 24);
  const destSize = isize > 0 ? isize : Math.max(64, bytes.length * 4);
  const source = bytes.subarray(headerLen, bytes.length - 8);
  return inflateRaw(source, destSize);
}

function gzipHeaderLength(bytes: Uint8Array): number {
  const flags = bytes[3]!;
  let offset = 10;
  if ((flags & FLG_FEXTRA) !== 0) {
    if (offset + 2 > bytes.length) {
      throw new Error("gzip: truncated extra");
    }
    const extra = bytes[offset]! | (bytes[offset + 1]! << 8);
    offset += 2 + extra;
  }
  if ((flags & FLG_FNAME) !== 0) {
    offset = skipCString(bytes, offset);
  }
  if ((flags & FLG_FCOMMENT) !== 0) {
    offset = skipCString(bytes, offset);
  }
  if ((flags & FLG_FHCRC) !== 0) {
    offset += 2;
  }
  return offset;
}

function skipCString(bytes: Uint8Array, start: number): number {
  let i = start;
  while (i < bytes.length && bytes[i] !== 0) {
    i += 1;
  }
  if (i >= bytes.length) {
    throw new Error("gzip: truncated name");
  }
  return i + 1;
}

interface HuffmanTree {
  table: Uint16Array;
  trans: Uint16Array;
}

interface InflateState {
  source: Uint8Array;
  sourceIndex: number;
  tag: number;
  bitcount: number;
  dest: Uint8Array;
  destLen: number;
  ltree: HuffmanTree;
  dtree: HuffmanTree;
}

function newTree(symbols: number): HuffmanTree {
  return { table: new Uint16Array(16), trans: new Uint16Array(symbols) };
}

const sltree = newTree(288);
const sdtree = newTree(32);
const lengthBits = new Uint8Array(30);
const lengthBase = new Uint16Array(30);
const distBits = new Uint8Array(30);
const distBase = new Uint16Array(30);
const clcidx = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
const codeTree = newTree(19);
const lengths = new Uint8Array(288 + 32);
const offs = new Uint16Array(16);
let tablesReady = false;

function ensureTables(): void {
  if (tablesReady) {
    return;
  }
  buildFixedTrees(sltree, sdtree);
  buildBitsBase(lengthBits, lengthBase, 4, 3);
  buildBitsBase(distBits, distBase, 2, 1);
  lengthBits[28] = 0;
  lengthBase[28] = 258;
  tablesReady = true;
}

function buildBitsBase(bits: Uint8Array, base: Uint16Array, delta: number, first: number): void {
  for (let i = 0; i < delta; i++) {
    bits[i] = 0;
  }
  for (let i = 0; i < 30 - delta; i++) {
    bits[i + delta] = (i / delta) | 0;
  }
  let sum = first;
  for (let i = 0; i < 30; i++) {
    base[i] = sum;
    sum += 1 << bits[i]!;
  }
}

function buildFixedTrees(lt: HuffmanTree, dt: HuffmanTree): void {
  for (let i = 0; i < 7; i++) {
    lt.table[i] = 0;
  }
  lt.table[7] = 24;
  lt.table[8] = 152;
  lt.table[9] = 112;
  for (let i = 0; i < 24; i++) {
    lt.trans[i] = 256 + i;
  }
  for (let i = 0; i < 144; i++) {
    lt.trans[24 + i] = i;
  }
  for (let i = 0; i < 8; i++) {
    lt.trans[24 + 144 + i] = 280 + i;
  }
  for (let i = 0; i < 112; i++) {
    lt.trans[24 + 144 + 8 + i] = 144 + i;
  }
  for (let i = 0; i < 5; i++) {
    dt.table[i] = 0;
  }
  dt.table[5] = 32;
  for (let i = 0; i < 32; i++) {
    dt.trans[i] = i;
  }
}

function buildTree(tree: HuffmanTree, lens: Uint8Array, off: number, num: number): void {
  for (let i = 0; i < 16; i++) {
    tree.table[i] = 0;
  }
  for (let i = 0; i < num; i++) {
    tree.table[lens[off + i]!]! += 1;
  }
  tree.table[0] = 0;
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    offs[i] = sum;
    sum += tree.table[i]!;
  }
  for (let i = 0; i < num; i++) {
    const len = lens[off + i]!;
    if (len !== 0) {
      tree.trans[offs[len]!] = i;
      offs[len]! += 1;
    }
  }
}

function getBit(state: InflateState): number {
  if (!state.bitcount--) {
    state.tag = state.source[state.sourceIndex++]!;
    state.bitcount = 7;
  }
  const bit = state.tag & 1;
  state.tag >>>= 1;
  return bit;
}

function readBits(state: InflateState, num: number, base: number): number {
  if (num === 0) {
    return base;
  }
  while (state.bitcount < 24) {
    state.tag |= (state.source[state.sourceIndex++] ?? 0) << state.bitcount;
    state.bitcount += 8;
  }
  const val = state.tag & (0xffff >>> (16 - num));
  state.tag >>>= num;
  state.bitcount -= num;
  return val + base;
}

function decodeSymbol(state: InflateState, tree: HuffmanTree): number {
  while (state.bitcount < 24) {
    state.tag |= (state.source[state.sourceIndex++] ?? 0) << state.bitcount;
    state.bitcount += 8;
  }
  let sum = 0;
  let cur = 0;
  let len = 0;
  let tag = state.tag;
  do {
    cur = 2 * cur + (tag & 1);
    tag >>>= 1;
    len += 1;
    sum += tree.table[len]!;
    cur -= tree.table[len]!;
  } while (cur >= 0);
  state.tag = tag;
  state.bitcount -= len;
  return tree.trans[sum + cur]!;
}

function decodeTrees(state: InflateState, lt: HuffmanTree, dt: HuffmanTree): void {
  const hlit = readBits(state, 5, 257);
  const hdist = readBits(state, 5, 1);
  const hclen = readBits(state, 4, 4);
  for (let i = 0; i < 19; i++) {
    lengths[i] = 0;
  }
  for (let i = 0; i < hclen; i++) {
    lengths[clcidx[i]!] = readBits(state, 3, 0);
  }
  buildTree(codeTree, lengths, 0, 19);
  for (let num = 0; num < hlit + hdist; ) {
    const sym = decodeSymbol(state, codeTree);
    if (sym === 16) {
      const prev = lengths[num - 1]!;
      let copies = readBits(state, 2, 3);
      while (copies--) {
        lengths[num++] = prev;
      }
    } else if (sym === 17) {
      let copies = readBits(state, 3, 3);
      while (copies--) {
        lengths[num++] = 0;
      }
    } else if (sym === 18) {
      let copies = readBits(state, 7, 11);
      while (copies--) {
        lengths[num++] = 0;
      }
    } else {
      lengths[num++] = sym;
    }
  }
  buildTree(lt, lengths, 0, hlit);
  buildTree(dt, lengths, hlit, hdist);
}

function growDest(state: InflateState, needed: number): void {
  if (needed <= state.dest.length) {
    return;
  }
  let next = state.dest.length;
  while (next < needed) {
    next *= 2;
  }
  const grown = new Uint8Array(next);
  grown.set(state.dest.subarray(0, state.destLen));
  state.dest = grown;
}

function inflateBlockData(state: InflateState, lt: HuffmanTree, dt: HuffmanTree): void {
  for (;;) {
    const sym = decodeSymbol(state, lt);
    if (sym === 256) {
      return;
    }
    if (sym < 256) {
      growDest(state, state.destLen + 1);
      state.dest[state.destLen++] = sym;
      continue;
    }
    const length = readBits(state, lengthBits[sym - 257]!, lengthBase[sym - 257]!);
    const dist = decodeSymbol(state, dt);
    const offs = state.destLen - readBits(state, distBits[dist]!, distBase[dist]!);
    growDest(state, state.destLen + length);
    for (let i = 0; i < length; i++) {
      state.dest[state.destLen++] = state.dest[offs + i]!;
    }
  }
}

function inflateUncompressedBlock(state: InflateState): void {
  while (state.bitcount > 8) {
    state.sourceIndex -= 1;
    state.bitcount -= 8;
  }
  const length = state.source[state.sourceIndex]! | (state.source[state.sourceIndex + 1]! << 8);
  const inv = state.source[state.sourceIndex + 2]! | (state.source[state.sourceIndex + 3]! << 8);
  if (length !== (~inv & 0xffff)) {
    throw new Error("gzip: invalid uncompressed block");
  }
  state.sourceIndex += 4;
  growDest(state, state.destLen + length);
  for (let i = 0; i < length; i++) {
    state.dest[state.destLen++] = state.source[state.sourceIndex++]!;
  }
  state.bitcount = 0;
}

function inflateRaw(source: Uint8Array, destSize: number): Uint8Array {
  ensureTables();
  const state: InflateState = {
    source,
    sourceIndex: 0,
    tag: 0,
    bitcount: 0,
    dest: new Uint8Array(destSize),
    destLen: 0,
    ltree: newTree(288),
    dtree: newTree(32),
  };
  let bfinal = 0;
  do {
    bfinal = getBit(state);
    const btype = readBits(state, 2, 0);
    if (btype === 0) {
      inflateUncompressedBlock(state);
    } else if (btype === 1) {
      inflateBlockData(state, sltree, sdtree);
    } else if (btype === 2) {
      decodeTrees(state, state.ltree, state.dtree);
      inflateBlockData(state, state.ltree, state.dtree);
    } else {
      throw new Error("gzip: invalid block type");
    }
  } while (bfinal === 0);
  return state.dest.subarray(0, state.destLen);
}
