// CRC-32 (IEEE 802.3, the zlib/MCAP polynomial), slice-by-8 for throughput.

const T = new Uint32Array(8 * 256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  T[n] = c >>> 0;
}
for (let n = 0; n < 256; n++) {
  for (let s = 1; s < 8; s++) T[s * 256 + n] = (T[(s - 1) * 256 + n] >>> 8) ^ T[T[(s - 1) * 256 + n] & 0xff];
}

/** Continue a CRC-32 over `bytes` (Uint8Array). `crc` is the previous result (0 to start). */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  let i = 0;
  const n = bytes.length;
  const end8 = n - (n % 8);
  while (i < end8) {
    const a = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) ^ c;
    c =
      T[7 * 256 + (a & 0xff)] ^
      T[6 * 256 + ((a >>> 8) & 0xff)] ^
      T[5 * 256 + ((a >>> 16) & 0xff)] ^
      T[4 * 256 + (a >>> 24)] ^
      T[3 * 256 + bytes[i + 4]] ^
      T[2 * 256 + bytes[i + 5]] ^
      T[256 + bytes[i + 6]] ^
      T[bytes[i + 7]];
    i += 8;
  }
  while (i < n) c = T[(c ^ bytes[i++]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
