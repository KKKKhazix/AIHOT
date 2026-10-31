// Structural similarity (SSIM) of two same-sized pictures, on luma in 8×8 windows (4 px apart): the
// measure that holds an AVIF variant to at least the sharpness of the rendition it stands in for.
import sharp, { type Sharp } from "sharp";

export interface Luma {
  values: Float32Array;
  width: number;
  height: number;
}

export async function luma(image: Buffer | Sharp): Promise<Luma> {
  const { data, info } = await (Buffer.isBuffer(image) ? sharp(image) : image.clone())
    .removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const values = new Float32Array(info.width * info.height);
  for (let i = 0; i < values.length; i++) {
    const o = i * info.channels;
    values[i] = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
  }
  return { values, width: info.width, height: info.height };
}

/** Mean SSIM of b against the reference a (1 is identical); null when the sizes differ. */
export function ssim(a: Luma, b: Luma): number | null {
  if (a.width !== b.width || a.height !== b.height || a.width < 8 || a.height < 8) return null;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const w = a.width;
  let sum = 0;
  let windows = 0;
  for (let y = 0; y + 8 <= a.height; y += 4) {
    for (let x = 0; x + 8 <= w; x += 4) {
      let ma = 0;
      let mb = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { ma += a.values[(y + j) * w + x + i]!; mb += b.values[(y + j) * w + x + i]!; }
      ma /= 64;
      mb /= 64;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let j = 0; j < 8; j++) {
        for (let i = 0; i < 8; i++) {
          const da = a.values[(y + j) * w + x + i]! - ma;
          const db = b.values[(y + j) * w + x + i]! - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      }
      sum += ((2 * ma * mb + C1) * (2 * cov / 63 + C2)) / ((ma * ma + mb * mb + C1) * ((va + vb) / 63 + C2));
      windows++;
    }
  }
  return sum / windows;
}
