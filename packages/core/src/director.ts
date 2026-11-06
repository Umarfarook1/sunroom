// The director decides when to take the camera's own controls away from its firmware.
// Pure: capabilities, settings and measurements in, at most one command out. The session applies it.
//
// Policy is minimal intervention. A camera whose auto exposure holds the frame rate is left alone.
// When auto exposure stretches the shutter and halves the frame rate, the director pins the longest
// shutter that still fits the frame period and makes up light with sensor gain, which is cleaner
// than brightening 8-bit video afterwards.

export interface Range {
  min: number;
  max: number;
  step: number;
}

/** What the camera says it can do (from MediaStreamTrack.getCapabilities()). */
export interface CameraCaps {
  /** Shutter time range in units of 100 microseconds. */
  exposureTime?: Range;
  /** Sensor gain. Chromium exposes it as `exposureCompensation` on Windows. */
  gain?: Range;
  manualExposure: boolean;
  autoWhiteBalance: boolean;
  brightness?: Range;
}

export interface CameraSettings {
  exposureMode?: string;
  exposureTime?: number;
  gain?: number;
  whiteBalanceMode?: string;
  brightness?: number;
}

export interface DirectorInput {
  nowMs: number;
  /** Real frames per second arriving from the camera. */
  fps: number;
  /** Frame rate the stream was opened at. */
  nominalFps: number;
  /** Stops of brightening the software still has to add (negative: scene is brighter than needed). */
  shortfallStops: number;
  /** 98th percentile of scene luminance, linear 0..1. */
  p98: number;
  /** 2nd percentile of scene luminance, linear 0..1. */
  p02: number;
}

export interface Command {
  exposureMode?: 'manual' | 'continuous';
  exposureTime?: number;
  exposureCompensation?: number;
  whiteBalanceMode?: 'continuous';
  brightness?: number;
}

export interface DirectorState {
  mode: 'observe' | 'manual';
  lastCommandMs: number;
  /** When the frame rate first dropped (observe) or the scene first became too bright (manual). */
  sinceMs: number | null;
  /** No takeover before this time: avoids flapping after handing control back. */
  holdOffUntilMs: number;
  /** Gain step awaiting proof that it changed the picture. */
  gainProbe: { shortfallBefore: number } | null;
  gainWorks: boolean;
  /** A gain that clipped highlights; not tried again until `ceilingUntilMs`. Stops raise/lower cycling. */
  gainCeiling: number | null;
  ceilingUntilMs: number;
  whiteBalanceChecked: boolean;
}

export interface Direction {
  state: DirectorState;
  command: Command | null;
  /** Plain-language reason, for the UI and logs. */
  reason: string | null;
}

export const initialDirectorState = (): DirectorState => ({
  mode: 'observe',
  lastCommandMs: -1e9,
  sinceMs: null,
  holdOffUntilMs: 0,
  gainProbe: null,
  gainWorks: true,
  gainCeiling: null,
  ceilingUntilMs: 0,
  whiteBalanceChecked: false,
});

const SETTLE_MS = 1200; // cameras need about a second to apply and stabilise a control change
const SLOW_FOR_MS = 1500;
const BRIGHT_FOR_MS = 3000;
const HOLD_OFF_MS = 8000;
const CEILING_MS = 30000;
const P98_HEADROOM = 0.8; // only add gain while highlights have room
const P98_CLIPPING = 0.95;

/** Longest shutter the camera supports that still fits one frame period. */
export function shutterFor(fps: number, r: Range): number {
  const limit = (10000 / fps) * 1.02;
  // UVC on Windows exposes power-of-two shutters as min * 2^k; other stacks expose a linear step
  const log2Steps = Math.log2(r.max / r.min);
  if (Math.abs(log2Steps - Math.round(log2Steps)) < 0.01 && Math.abs(r.step - r.min) < 1e-6) {
    let t = r.min;
    while (t * 2 <= Math.min(limit, r.max) + 1e-6) t *= 2;
    return t;
  }
  const t = Math.floor(Math.min(limit, r.max) / r.step) * r.step;
  return Math.max(t, r.min);
}

export function direct(state: DirectorState, caps: CameraCaps, settings: CameraSettings, input: DirectorInput): Direction {
  const idle = (s: DirectorState): Direction => ({ state: s, command: null, reason: null });
  if (input.nowMs - state.lastCommandMs < SETTLE_MS) return idle(state);
  const sent = (s: DirectorState, command: Command, reason: string): Direction => ({
    state: { ...s, lastCommandMs: input.nowMs },
    command,
    reason,
  });

  if (!state.whiteBalanceChecked) {
    const s = { ...state, whiteBalanceChecked: true };
    if (settings.whiteBalanceMode === 'manual' && caps.autoWhiteBalance) {
      return sent(s, { whiteBalanceMode: 'continuous' }, 'white balance was fixed by hand; back to automatic');
    }
    state = s;
  }

  // a negative brightness offset throws away the darkest tones before we ever see them
  if (caps.brightness && settings.brightness !== undefined && input.p02 <= 0 && input.shortfallStops > 0.5) {
    const mid = (caps.brightness.min + caps.brightness.max) / 2;
    if (settings.brightness < mid) {
      const next = Math.min(mid, settings.brightness + (caps.brightness.max - caps.brightness.min) / 8);
      return sent(state, { brightness: Math.round(next / caps.brightness.step) * caps.brightness.step }, 'shadows are clipped; raising the camera black level');
    }
  }

  if (state.mode === 'observe') {
    const slow = input.fps < input.nominalFps * 0.75;
    if (!slow || !caps.manualExposure || !caps.exposureTime || input.nowMs < state.holdOffUntilMs) {
      return idle({ ...state, sinceMs: null });
    }
    if (state.sinceMs === null) return idle({ ...state, sinceMs: input.nowMs });
    if (input.nowMs - state.sinceMs < SLOW_FOR_MS) return idle(state);
    return sent(
      { ...state, mode: 'manual', sinceMs: null, gainProbe: null },
      { exposureMode: 'manual', exposureTime: shutterFor(input.nominalFps, caps.exposureTime) },
      `camera fell to ${input.fps.toFixed(0)} fps; pinning the shutter to hold ${input.nominalFps} fps`,
    );
  }

  // manual mode: light comes from sensor gain
  if (state.gainProbe) {
    const helped = state.gainProbe.shortfallBefore - input.shortfallStops > 0.08;
    state = { ...state, gainProbe: null, gainWorks: helped };
  }
  const gain = caps.gain;
  const g = settings.gain;
  const clipping = input.p98 > P98_CLIPPING;
  const tooBright = input.shortfallStops < -0.3 || clipping;
  if (tooBright) {
    if (gain && g !== undefined && g > gain.min && state.gainWorks) {
      // clipped highlights are gone for good, a dark face can still be lifted: remember this gain was too much
      const ceiling = clipping ? { gainCeiling: g, ceilingUntilMs: input.nowMs + CEILING_MS } : {};
      return sent({ ...state, ...ceiling, sinceMs: null }, { exposureCompensation: Math.max(gain.min, g - gain.step) }, clipping ? 'highlights are clipping; lowering sensor gain' : 'scene is bright; lowering sensor gain');
    }
    if (state.sinceMs === null) return idle({ ...state, sinceMs: input.nowMs });
    if (input.nowMs - state.sinceMs < BRIGHT_FOR_MS) return idle(state);
    return sent(
      { ...state, mode: 'observe', sinceMs: null, holdOffUntilMs: input.nowMs + HOLD_OFF_MS },
      { exposureMode: 'continuous' },
      'plenty of light; handing exposure back to the camera',
    );
  }
  const ceiling = state.gainCeiling !== null && input.nowMs < state.ceilingUntilMs ? state.gainCeiling : Infinity;
  if (input.shortfallStops > 1 && input.p98 < P98_HEADROOM && gain && g !== undefined && g < gain.max && g + gain.step < ceiling && state.gainWorks) {
    return sent(
      { ...state, sinceMs: null, gainProbe: { shortfallBefore: input.shortfallStops } },
      { exposureCompensation: Math.min(gain.max, g + gain.step) },
      'scene is dark; raising sensor gain',
    );
  }
  return idle({ ...state, sinceMs: null });
}
