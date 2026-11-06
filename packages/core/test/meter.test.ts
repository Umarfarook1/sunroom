import { describe, expect, it } from 'vitest';
import { measure } from '../src/meter';
import { FaceSmoother } from '../src/face';

const W = 32;
const H = 18;

/** Builds a meter grid: each cell is [r, g, b] linear 0..1 plus a noise byte. */
function grid(cell: (x: number, y: number) => { rgb: [number, number, number]; noise?: number }): Uint8Array {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = cell(x, y);
      const i = (y * W + x) * 4;
      px[i] = Math.round(Math.sqrt(c.rgb[0]) * 255);
      px[i + 1] = Math.round(Math.sqrt(c.rgb[1]) * 255);
      px[i + 2] = Math.round(Math.sqrt(c.rgb[2]) * 255);
      px[i + 3] = c.noise ?? 0;
    }
  }
  return px;
}

describe('measure', () => {
  it('reads a flat grey frame', () => {
    const s = measure(grid(() => ({ rgb: [0.25, 0.25, 0.25] })), W, H, null);
    expect(s.p50).toBeCloseTo(0.25, 2);
    expect(s.p98).toBeCloseTo(0.25, 2);
    expect(s.logAvg).toBeCloseTo(Math.log2(0.25), 1);
    expect(s.face).toBeNull();
  });

  it('weights the centre: a dark centre on a bright surround meters dark', () => {
    const s = measure(grid((x, y) => ({ rgb: Math.abs(x - W / 2) < 6 && Math.abs(y - H / 2) < 4 ? [0.01, 0.01, 0.01] : [0.5, 0.5, 0.5] })), W, H, null);
    const flat = Math.log2(0.5);
    expect(s.logAvg).toBeLessThan(flat - 1);
    expect(s.p98).toBeCloseTo(0.5, 2);
  });

  it('measures the face from the inner box, top-left origin', () => {
    // skin-coloured block in the top-left quarter, bright grey elsewhere
    const px = grid((x, y) => (x < W / 2 && y < H / 2 ? { rgb: [0.26, 0.1, 0.045] } : { rgb: [0.6, 0.6, 0.6] }));
    const s = measure(px, W, H, { x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(s.face).not.toBeNull();
    const lum = 0.2126 * 0.26 + 0.7152 * 0.1 + 0.0722 * 0.045;
    expect(s.face!.median).toBeCloseTo(lum, 2);
    expect(s.face!.rg).toBeCloseTo(Math.log(2.6), 1);
    expect(s.face!.bg).toBeCloseTo(Math.log(0.45), 1);
  });

  it('returns no face stats for a box too small to trust', () => {
    const s = measure(grid(() => ({ rgb: [0.2, 0.2, 0.2] })), W, H, { x: 0.5, y: 0.5, w: 0.05, h: 0.05 });
    expect(s.face).toBeNull();
  });

  it('converts the noise bytes to sigma, separately for dark and bright areas', () => {
    // top half dark and noisy (byte 40), bottom half bright and clean (byte 10)
    const s = measure(grid((_x, y) => (y < H / 2 ? { rgb: [0.01, 0.01, 0.01], noise: 40 } : { rgb: [0.5, 0.5, 0.5], noise: 10 })), W, H, null);
    expect(s.sigmaDark).toBeCloseTo(40 / 255 / 16 / 0.6745, 4);
    expect(s.sigmaBright).toBeCloseTo(10 / 255 / 16 / 0.6745, 4);
  });

  it('borrows the whole-frame noise when a brightness band is nearly empty', () => {
    const s = measure(grid(() => ({ rgb: [0.5, 0.5, 0.5], noise: 12 })), W, H, null);
    expect(s.sigmaDark).toBeCloseTo(s.sigmaBright, 6);
  });
});

describe('FaceSmoother', () => {
  const box = { x: 0.4, y: 0.2, w: 0.2, h: 0.3 };
  it('takes the first detection as is', () => {
    expect(new FaceSmoother().update(box, 0)).toEqual(box);
  });
  it('moves halfway toward a new detection', () => {
    const s = new FaceSmoother();
    s.update(box, 0);
    expect(s.update({ ...box, x: 0.6 }, 200)!.x).toBeCloseTo(0.5, 6);
  });
  it('holds the last box through a short loss and drops it after the hold time', () => {
    const s = new FaceSmoother(1500);
    s.update(box, 0);
    expect(s.update(null, 1000)).toEqual(box);
    expect(s.update(null, 1600)).toBeNull();
  });
});
