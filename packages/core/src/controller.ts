// Decides how to render a frame from what was measured. Pure and feed-forward: it never looks at
// its own output, so it cannot oscillate; smoothing only keeps the picture from pumping.

import type { FrameStats } from './meter';
import type { AnalysisParams, RenderParams } from './pipeline';

export interface Tuning {
  /** A face is left alone inside this display-linear luminance band and moved to its nearest edge outside it. */
  faceBand: readonly [number, number];
  /** Same, for the centre-weighted scene when no face is known. */
  sceneTarget: number;
  /** Most the picture may be brightened, in stops. Past this, noise wins. */
  maxGainStops: number;
  /** Brightest the 98th percentile may land, display-linear. */
  highlightCeiling: number;
  /** Seconds for brightness and colour decisions to settle. */
  settleSeconds: number;
  /** Plausible skin chromaticity box, log(R/G) and log(B/G) in linear light. */
  skinRG: readonly [number, number];
  skinBG: readonly [number, number];
  /** Largest white-balance correction per axis, in log units. Beyond it the channel has no data left. */
  maxWbShift: number;
  /** 0..1: extra shadow lift on the face, a soft fill light. */
  faceFill: number;
}

export const DEFAULT_TUNING: Tuning = {
  faceBand: [0.15, 0.4],
  sceneTarget: 0.19,
  maxGainStops: 5,
  highlightCeiling: 0.8,
  settleSeconds: 0.6,
  // measured: webcams render skin far less saturated than studio swatches (R/G 1.4 to 1.6 on the dev camera)
  skinRG: [0.22, 1.2],
  skinBG: [-1.2, -0.1],
  maxWbShift: 1.1,
  faceFill: 0.3,
};

/** Smoothed decisions carried between frames. */
export interface ControlState {
  anchor: number;
  target: number;
  cHi: number;
  wbRG: number;
  wbBG: number;
  /** White-balance correction that was needed but not applied (log units); colour is drained instead. */
  wbExcess: number;
  sigmaDark: number;
  sigmaBright: number;
  /** A face has been measured at least once. The first one sets colour at once; later changes ease in. */
  faceSeen: boolean;
}

export interface Decision {
  state: ControlState;
  render: RenderParams;
  /** For the next frame's analysis half. */
  analysis: Omit<AnalysisParams, 'reset' | 'deflicker'>;
  /** Stops of brightening the scene needs before any cap: what the camera itself should try to supply. */
  shortfallStops: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function goals(s: FrameStats, t: Tuning): { state: ControlState; shortfallStops: number } {
  const anchor = s.face ? Math.log2(s.face.median + 1e-5) : s.logAvg;
  // a face already in a healthy range keeps its brightness: skin tones differ, and all are right
  const targetLin = s.face ? clamp(s.face.median, t.faceBand[0], t.faceBand[1]) : t.sceneTarget;
  const wanted = Math.log2(targetLin);
  const target = Math.min(wanted, anchor + t.maxGainStops);

  const xHi = Math.log2(s.p98 + 1e-5) - anchor;
  const cHi = xHi > 0.05 ? clamp((Math.log2(t.highlightCeiling) - target) / xHi, 0.35, 1) : 1;

  let wbRG = 0;
  let wbBG = 0;
  let wbExcess = 0;
  if (s.face) {
    // smallest correction that brings skin back inside the plausible set; none if it already is
    // skin outside the set is carried a little past the edge: the edge itself is still an odd colour
    const into = (need: number) => need + Math.sign(need) * Math.min(Math.abs(need), 0.15);
    const needRG = into(clamp(s.face.rg, t.skinRG[0], t.skinRG[1]) - s.face.rg);
    const needBG = into(clamp(s.face.bg, t.skinBG[0], t.skinBG[1]) - s.face.bg);
    wbRG = clamp(needRG, -t.maxWbShift, t.maxWbShift);
    wbBG = clamp(needBG, -t.maxWbShift, t.maxWbShift);
    wbExcess = Math.hypot(needRG - wbRG, needBG - wbBG);
  }
  return {
    state: { anchor, target, cHi, wbRG, wbBG, wbExcess, sigmaDark: Math.max(s.sigmaDark, 0.002), sigmaBright: Math.max(s.sigmaBright, 0.002), faceSeen: !!s.face },
    shortfallStops: wanted - anchor,
  };
}

/**
 * @param prev null on the first frame or after a scene reset
 * @param dt seconds since the previous frame
 */
export function control(prev: ControlState | null, s: FrameStats, dt: number, t: Tuning = DEFAULT_TUNING): Decision {
  const { state: g, shortfallStops } = goals(s, t);
  let state = g;
  if (prev) {
    const k = 1 - Math.exp(-dt / t.settleSeconds);
    const kSlow = 1 - Math.exp(-dt / (t.settleSeconds * 3));
    // the detector finds the face about a second into a call; easing colour in from there is seconds of wrong skin
    const kColour = g.faceSeen && !prev.faceSeen ? 1 : kSlow;
    const ease = (from: number, to: number, rate: number, dead = 0) => (Math.abs(to - from) < dead ? from : from + (to - from) * rate);
    state = {
      anchor: ease(prev.anchor, g.anchor, k, 0.03),
      target: ease(prev.target, g.target, k),
      cHi: ease(prev.cHi, g.cHi, k),
      wbRG: ease(prev.wbRG, g.wbRG, kColour),
      wbBG: ease(prev.wbBG, g.wbBG, kColour),
      wbExcess: ease(prev.wbExcess, g.wbExcess, kColour),
      sigmaDark: ease(prev.sigmaDark, g.sigmaDark, kSlow),
      sigmaBright: ease(prev.sigmaBright, g.sigmaBright, kSlow),
      faceSeen: prev.faceSeen || g.faceSeen,
    };
  }

  const gainStops = state.target - state.anchor;
  // how grainy the dark parts will look: either we are lifting them a lot, or the sensor already is
  const grain = Math.max(smoothstep(1, 3.5, gainStops), smoothstep(0.01, 0.03, state.sigmaDark));
  const r = Math.exp(state.wbRG);
  const b = Math.exp(state.wbBG);
  const norm = 0.2126 * r + 0.7152 + 0.0722 * b;
  const render: RenderParams = {
    anchor: state.anchor,
    target: state.target,
    cHi: state.cHi,
    cLo: mix(0.85, 1, smoothstep(1.5, 4, gainStops)), // lift shadows a little, unless they are all noise
    wb: [r / norm, 1 / norm, b / norm],
    detail: 1,
    sharpen: mix(1.0, 0.15, Math.max(smoothstep(2, 5, gainStops), grain * 0.7)),
    chromaLod: clamp(0.5 + Math.max(0.5 * gainStops, 2 * grain), 0.5, 2.5),
    // a colour cast too strong to correct is shown as a calmer, greyer picture rather than a wrong one
    saturation: mix(1.05, 0.85, smoothstep(3, 6, gainStops)) * (1 - 0.85 * smoothstep(0, 0.8, state.wbExcess)),
    shadowDesat: grain,
    spatial: 1,
    faceFill: t.faceFill,
    bypass: false,
  };
  return {
    state,
    render,
    analysis: { sigmaDark: state.sigmaDark, sigmaBright: state.sigmaBright, maxAge: clamp(6 + Math.max(5 * gainStops, 18 * grain), 6, 28) },
    shortfallStops,
  };
}
