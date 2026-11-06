// Turns the meter grid read back from the GPU into scene statistics. Pure: no GL, no DOM.

/** Face rectangle in normalised image coordinates, origin top-left. */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceStats {
  /** Median linear luminance of the inner face. */
  median: number;
  /** log(R/G) and log(B/G) of mid-tone skin, linear light. */
  rg: number;
  bg: number;
}

export interface FrameStats {
  /** Centre-weighted mean of log2 linear luminance. */
  logAvg: number;
  p02: number;
  p50: number;
  p98: number;
  face: FaceStats | null;
  /** Temporal noise sigma in enc (sqrt-linear) units, for dark and for bright areas. */
  sigmaDark: number;
  sigmaBright: number;
}

const NOISE_SCALE = 16; // must match the METER shader

function percentile(hist: Uint32Array, total: number, q: number): number {
  let acc = 0;
  const want = total * q;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]!;
    if (acc >= want) return i;
  }
  return hist.length - 1;
}

/**
 * @param px RGBA bytes, top row first. rgb = sqrt of linear colour, a = scaled noise sample.
 */
export function measure(px: Uint8Array, w: number, h: number, face: FaceBox | null): FrameStats {
  const lumHist = new Uint32Array(256);
  const noiseAll = new Uint32Array(256);
  const noiseDark = new Uint32Array(256);
  const noiseBright = new Uint32Array(256);
  let nDark = 0;
  let nBright = 0;
  const n = w * h;
  const lum = new Float32Array(n);
  let logSum = 0;
  let wSum = 0;
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5) / h - 0.42; // a seated person's face sits a little above the middle
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = px[i * 4]! / 255;
      const g = px[i * 4 + 1]! / 255;
      const b = px[i * 4 + 2]! / 255;
      const L = 0.2126 * r * r + 0.7152 * g * g + 0.0722 * b * b;
      lum[i] = L;
      const e = Math.sqrt(L);
      lumHist[Math.min(255, Math.round(e * 255))]!++;
      const nz = px[i * 4 + 3]!;
      noiseAll[nz]!++;
      if (e < 0.25) {
        noiseDark[nz]!++;
        nDark++;
      } else if (e > 0.45) {
        noiseBright[nz]!++;
        nBright++;
      }
      const dx = (x + 0.5) / w - 0.5;
      const wt = Math.exp(-(dx * dx + dy * dy) / (2 * 0.2 * 0.2));
      logSum += wt * Math.log2(L + 1e-4);
      wSum += wt;
    }
  }
  const lin = (bin: number) => (bin / 255) ** 2;
  const toSigma = (hist: Uint32Array, count: number) => percentile(hist, count, 0.5) / 255 / NOISE_SCALE / 0.6745;
  const sigmaAll = toSigma(noiseAll, n);
  const enough = n * 0.03; // a band with too few cells borrows the whole-frame figure
  const sigmaDark = nDark > enough ? toSigma(noiseDark, nDark) : sigmaAll;
  const sigmaBright = nBright > enough ? toSigma(noiseBright, nBright) : sigmaAll;

  let faceStats: FaceStats | null = null;
  if (face) {
    // inner 60% of the box: skin, not hair or background
    const x0 = Math.max(0, Math.floor((face.x + face.w * 0.2) * w));
    const x1 = Math.min(w, Math.ceil((face.x + face.w * 0.8) * w));
    const yTop = face.y + face.h * 0.2;
    const yBot = face.y + face.h * 0.8;
    const y0 = Math.max(0, Math.floor(yTop * h));
    const y1 = Math.min(h, Math.ceil(yBot * h));
    const vals: number[] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(lum[y * w + x]!);
    if (vals.length >= 12) {
      const sorted = Float32Array.from(vals).sort();
      const lo = sorted[Math.floor(sorted.length * 0.33)]!;
      const hi = sorted[Math.floor(sorted.length * 0.8)]!;
      let R = 0;
      let G = 0;
      let B = 0;
      // colour from mid-tone skin only: shadows are noisy, speculars are the lamp's colour
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          if (lum[i]! < lo || lum[i]! > hi) continue;
          R += (px[i * 4]! / 255) ** 2;
          G += (px[i * 4 + 1]! / 255) ** 2;
          B += (px[i * 4 + 2]! / 255) ** 2;
        }
      }
      const e = 1e-5;
      faceStats = {
        median: sorted[Math.floor(sorted.length / 2)]!,
        rg: Math.log((R + e) / (G + e)),
        bg: Math.log((B + e) / (G + e)),
      };
    }
  }

  return {
    logAvg: logSum / wSum,
    p02: lin(percentile(lumHist, n, 0.02)),
    p50: lin(percentile(lumHist, n, 0.5)),
    p98: lin(percentile(lumHist, n, 0.98)),
    face: faceStats,
    sigmaDark,
    sigmaBright,
  };
}
