// Bounded LZ4 frame decoder (https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md).
// Output is written into a caller-sized buffer; any attempt to exceed it throws, so a
// malicious frame can never allocate or write more than the chunk's declared size.

const MAGIC = 0x184d2204;

function u32(b, p) {
  if (p + 4 > b.length) throw new Error('lz4: truncated frame');
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
}

function block(src, s, sEnd, out, o) {
  const oEnd = out.length;
  while (s < sEnd) {
    const token = src[s++];
    let lit = token >>> 4;
    if (lit === 15) {
      let b;
      do {
        if (s >= sEnd) throw new Error('lz4: truncated literal length');
        b = src[s++];
        lit += b;
      } while (b === 255);
    }
    if (s + lit > sEnd) throw new Error('lz4: literal overruns block');
    if (o + lit > oEnd) throw new Error('lz4: output exceeds declared size');
    out.set(src.subarray(s, s + lit), o);
    s += lit;
    o += lit;
    if (s >= sEnd) break; // last sequence has literals only
    if (s + 2 > sEnd) throw new Error('lz4: truncated offset');
    const off = src[s] | (src[s + 1] << 8);
    s += 2;
    if (off === 0 || off > o) throw new Error('lz4: invalid match offset');
    let len = token & 15;
    if (len === 15) {
      let b;
      do {
        if (s >= sEnd) throw new Error('lz4: truncated match length');
        b = src[s++];
        len += b;
      } while (b === 255);
    }
    len += 4;
    if (o + len > oEnd) throw new Error('lz4: output exceeds declared size');
    let m = o - off;
    if (off >= len) {
      out.copyWithin(o, m, m + len);
      o += len;
    } else {
      for (let i = 0; i < len; i++) out[o++] = out[m++];
    }
  }
  return o;
}

/** Decompress one or more concatenated LZ4 frames into exactly `size` bytes. */
export function lz4Decompress(src, size) {
  const out = new Uint8Array(size);
  let p = 0;
  let o = 0;
  while (p < src.length) {
    const magic = u32(src, p);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      // skippable frame
      p += 8 + u32(src, p + 4);
      continue;
    }
    if (magic !== MAGIC) throw new Error('lz4: bad frame magic');
    p += 4;
    if (p + 2 > src.length) throw new Error('lz4: truncated frame header');
    const flg = src[p];
    if (flg >>> 6 !== 1) throw new Error('lz4: unsupported frame version');
    const blockChecksum = (flg >>> 4) & 1;
    const contentSize = (flg >>> 3) & 1;
    const contentChecksum = (flg >>> 2) & 1;
    const dictId = flg & 1;
    if (dictId) throw new Error('lz4: dictionaries are not supported');
    p += 2 + (contentSize ? 8 : 0) + 1; // FLG, BD, [content size], HC
    for (;;) {
      const bsize = u32(src, p);
      p += 4;
      if (bsize === 0) break; // EndMark
      const raw = bsize & 0x80000000;
      const n = bsize & 0x7fffffff;
      if (p + n > src.length) throw new Error('lz4: block overruns input');
      if (raw) {
        if (o + n > out.length) throw new Error('lz4: output exceeds declared size');
        out.set(src.subarray(p, p + n), o);
        o += n;
      } else {
        o = block(src, p, p + n, out, o);
      }
      p += n + (blockChecksum ? 4 : 0);
    }
    p += contentChecksum ? 4 : 0;
  }
  if (p !== src.length) throw new Error('lz4: trailing bytes after frame');
  if (o !== size) throw new Error('decompressed chunk size differs from declared uncompressed size');
  return out;
}
