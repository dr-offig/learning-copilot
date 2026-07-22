/**
 * Pure image-metadata helpers: pixel dimensions read straight from file
 * headers, with no native dependencies and no full decode. Used to describe
 * content assets (images students add for their site) to the model without
 * spending a vision call on them.
 *
 * This module must stay free of `vscode` imports so it remains unit-testable
 * outside VS Code.
 */

export type ImageDimensions = { width: number; height: number };

function parsePngDimensions(b: Buffer): ImageDimensions | null {
  // 8-byte signature, then IHDR chunk: length(4) + "IHDR"(4) + width(4) + height(4).
  if (b.length < 24) { return null; }
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) { return null; }
  if (b.toString("latin1", 12, 16) !== "IHDR") { return null; }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function parseGifDimensions(b: Buffer): ImageDimensions | null {
  if (b.length < 10) { return null; }
  const sig = b.toString("latin1", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") { return null; }
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function parseJpegDimensions(b: Buffer): ImageDimensions | null {
  // Walk the marker segments until a start-of-frame marker carries the size.
  // EXIF blocks can push it deep into the file, so callers should hand over a
  // generous head slice (256KB covers embedded thumbnails).
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) { return null; }
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) { off++; continue; }
    const marker = b[off + 1];
    if (marker === 0xff) { off++; continue; }
    // Standalone markers (TEM, RSTn, SOI/EOI) have no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
    const len = b.readUInt16BE(off + 2);
    if (len < 2) { return null; }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7) };
    }
    if (marker === 0xda) { return null; } // start of scan; no SOF seen
    off += 2 + len;
  }
  return null;
}

function parseWebpDimensions(b: Buffer): ImageDimensions | null {
  if (b.length < 30) { return null; }
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") { return null; }
  const fourCC = b.toString("latin1", 12, 16);
  if (fourCC === "VP8X") {
    // Extended header: 10-byte payload with 24-bit little-endian sizes minus one.
    return {
      width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
    };
  }
  if (fourCC === "VP8 ") {
    // Lossy: 3-byte frame tag, then the 9D 01 2A sync code, then 14-bit sizes.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) { return null; }
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fourCC === "VP8L") {
    // Lossless: 0x2F signature byte, then 14-bit sizes minus one, bit-packed.
    if (b[20] !== 0x2f) { return null; }
    const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6)),
    };
  }
  return null;
}

/**
 * Reads pixel dimensions from the head of an image file. `head` only needs
 * the first ~256KB of the file. Returns null for unsupported or malformed
 * content rather than throwing.
 */
export function parseImageDimensions(head: Buffer, mimeType: string): ImageDimensions | null {
  try {
    switch (mimeType) {
      case "image/png": return parsePngDimensions(head);
      case "image/jpeg": return parseJpegDimensions(head);
      case "image/gif": return parseGifDimensions(head);
      case "image/webp": return parseWebpDimensions(head);
      default: return null;
    }
  } catch {
    return null;
  }
}
