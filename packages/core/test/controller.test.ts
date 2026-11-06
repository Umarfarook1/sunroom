import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING, control } from '../src/controller';
import type { FrameStats } from '../src/meter';

const stats = (over: Partial<FrameStats> = {}): FrameStats => ({
  logAvg: Math.log2(0.1),
  p02: 0.005,
  p50: 0.1,
  p98: 0.3,
  face: null,
  sigmaDark: 0.008,
  sigmaBright: 0.004,
  ...over,
});
// mid-brown skin under neutral light, linear: R/G = 2.6, B/G = 0.45
const skin = { rg: Math.log(2.6), bg: Math.log(0.45) };

describe('control: exposure', () => {
  it('lifts a face below the band exactly to the lower edge', () => {
    const d = control(null, stats({ face: { median: 0.03, ...skin } }));
    expect(d.render.anchor).toBeCloseTo(Math.log2(0.03), 3);
    expect(d.render.target).toBeCloseTo(Math.log2(0.15), 5);
    expect(d.shortfallStops).toBeCloseTo(Math.log2(0.15 / 0.03), 3);
  });

  it('leaves a face inside the band at its own brightness', () => {
    const d = control(null, stats({ face: { median: 0.22, ...skin } }));
    expect(d.render.target - d.render.anchor).toBeCloseTo(0, 3);
    expect(d.shortfallStops).toBeCloseTo(0, 3);
  });

  it('pulls an over-bright face down to the upper edge', () => {
    const d = control(null, stats({ face: { median: 0.8, ...skin }, p98: 0.95 }));
    expect(d.render.target).toBeCloseTo(Math.log2(0.4), 5);
  });

  it('caps the lift at the gain limit but still reports the full shortfall', () => {
    const d = control(null, stats({ face: { median: 0.0005, ...skin } }));
    expect(d.render.target - d.render.anchor).toBeCloseTo(DEFAULT_TUNING.maxGainStops, 2);
    expect(d.shortfallStops).toBeGreaterThan(8);
  });

  it('meters the centre-weighted scene when there is no face', () => {
    const d = control(null, stats({ logAvg: Math.log2(0.02) }));
    expect(d.render.anchor).toBeCloseTo(Math.log2(0.02), 5);
    expect(d.render.target).toBeCloseTo(Math.log2(DEFAULT_TUNING.sceneTarget), 5);
  });

  it('compresses highlights that would otherwise clip', () => {
    const d = control(null, stats({ face: { median: 0.03, ...skin }, p98: 0.4 }));
    // face goes to 0.15, the wall 3.7 stops above it must land at or under the 0.8 ceiling
    const wallOut = d.render.target + (Math.log2(0.4) - d.render.anchor) * d.render.cHi;
    expect(wallOut).toBeLessThanOrEqual(Math.log2(0.8) + 1e-6);
    expect(d.render.cHi).toBeLessThan(1);
  });

  it('keeps highlights untouched when nothing would clip', () => {
    const d = control(null, stats({ face: { median: 0.2, ...skin }, p98: 0.5 }));
    expect(d.render.cHi).toBe(1);
  });
});

describe('control: colour', () => {
  it('does not touch plausible skin', () => {
    const d = control(null, stats({ face: { median: 0.2, ...skin } }));
    expect(d.render.wb[0]).toBeCloseTo(1, 5);
    expect(d.render.wb[1]).toBeCloseTo(1, 5);
    expect(d.render.wb[2]).toBeCloseTo(1, 5);
  });

  it('warms up skin that came out blue, a little past the edge of the plausible set', () => {
    const d = control(null, stats({ face: { median: 0.2, rg: Math.log(1.0), bg: Math.log(1.0) } }));
    // edge distances are 0.22 and -0.1; each is carried up to 0.15 further in (here: doubled, capped at 0.15)
    expect(d.state.wbRG).toBeCloseTo(0.22 + 0.15, 5);
    expect(d.state.wbBG).toBeCloseTo(-0.1 - 0.1, 5);
    expect(d.render.wb[0]).toBeGreaterThan(d.render.wb[1]);
    expect(d.render.wb[2]).toBeLessThan(d.render.wb[1]);
    expect(d.state.wbExcess).toBe(0);
  });

  it('caps an extreme correction and drains colour instead', () => {
    const neutral = control(null, stats({ face: { median: 0.2, ...skin } }));
    const d = control(null, stats({ face: { median: 0.2, rg: Math.log(0.05), bg: Math.log(3) } }));
    expect(d.state.wbRG).toBeCloseTo(DEFAULT_TUNING.maxWbShift, 5);
    expect(d.state.wbExcess).toBeGreaterThan(1);
    expect(d.render.saturation).toBeLessThan(neutral.render.saturation * 0.3);
  });
});

describe('control: stability', () => {
  it('sets colour at once when the face is first found, and eases after that', () => {
    const blue = { median: 0.2, rg: Math.log(1.0), bg: Math.log(1.0) };
    const noFace = control(null, stats());
    const found = control(noFace.state, stats({ face: blue }), 1 / 30);
    expect(found.state.wbRG).toBeCloseTo(0.22 + 0.15, 5);
    const moved = control(found.state, stats({ face: { ...blue, rg: Math.log(2.0) } }), 1 / 30);
    expect(moved.state.wbRG).toBeGreaterThan(0.3);
    expect(moved.state.wbRG).toBeLessThan(0.37);
  });

  it('eases toward a new brightness instead of jumping', () => {
    const first = control(null, stats({ face: { median: 0.03, ...skin } }));
    const second = control(first.state, stats({ face: { median: 0.06, ...skin } }), 1 / 30);
    const moved = second.state.anchor - first.state.anchor;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(0.1); // the scene changed by a full stop
  });

  it('ignores flutter smaller than the dead band', () => {
    const first = control(null, stats({ face: { median: 0.03, ...skin } }));
    const second = control(first.state, stats({ face: { median: 0.0303, ...skin } }), 1 / 30);
    expect(second.state.anchor).toBe(first.state.anchor);
  });

  it('gets there within a couple of seconds', () => {
    let d = control(null, stats({ face: { median: 0.03, ...skin } }));
    for (let i = 0; i < 90; i++) d = control(d.state, stats({ face: { median: 0.06, ...skin } }), 1 / 30);
    expect(d.state.anchor).toBeCloseTo(Math.log2(0.06), 1);
  });

  it('accumulates more frames and sharpens less when the sensor is noisy', () => {
    const clean = control(null, stats({ face: { median: 0.2, ...skin }, sigmaDark: 0.004 }));
    const noisy = control(null, stats({ face: { median: 0.2, ...skin }, sigmaDark: 0.04 }));
    expect(noisy.analysis.maxAge).toBeGreaterThan(clean.analysis.maxAge);
    expect(noisy.render.sharpen).toBeLessThan(clean.render.sharpen);
    expect(noisy.render.shadowDesat).toBe(1);
    expect(clean.render.shadowDesat).toBe(0);
  });
});
