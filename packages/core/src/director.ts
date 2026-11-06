// The director decides when to take the camera's own controls away from its firmware.
// Pure: capabilities, settings and measurements in, at most one command out. The session applies it.
//
// Policy is minimal intervention. A camera whose auto exposure holds the frame rate and lights the
// face is left alone. The director takes over in two cases: auto exposure stretched the shutter and
// halved the frame rate, or it has no shutter left at this frame rate and the face is still far too
// dark. It then pins the longest shutter that fits the frame period and makes up light with sensor
// gain, which is cleaner than brightening 8-bit video afterwards.

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
  autoExposure: boolean;
  autoWhiteBalance: boolean;
  brightness?: Range;
}

export interface CameraSettings {
  exposureMode?: string;
  exposureTime?: number;
  gain?: number;
  whiteBalanceMode?: string;
  /** Kelvin; only meaningful while white balance is manual. */
  colorTemperature?: number;
  brightness?: number;
}

export interface DirectorInput {
  nowMs: number;
  /** Real frames per second arriving from the camera. */
  fps: number;
  /** Frame rate the stream was opened at. */
  nominalFps: number;
  /** Share of wall time spent enhancing, 0..1. Near 1 means frames are late because of us, not the camera. */
  busy: number;
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
  whiteBalanceMode?: 'continuous' | 'manual';
  /** Only sent when putting a hand-fixed white balance back. */
  colorTemperature?: number;
  brightness?: number;
}

export interface DirectorState {
  mode: 'observe' | 'manual';
  lastCommandMs: number;
  /** When the frame rate first dropped or the face first starved (observe), or the scene first became too bright (manual). */
  sinceMs: number | null;
  /** No takeover before this time: avoids flapping after handing control back. */
  holdOffUntilMs: number;
  /** No takeover for a dark face before this time. Longer than the hold-off: a takeover that ended in "too bright" was probably wrong. */
  starvedHoldOffUntilMs: number;
  /** Gain step awaiting proof that it changed the picture. */
  gainProbe: { shortfallBefore: number } | null;
  gainWorks: boolean;
  /** A gain that clipped highlights; not tried again until `ceilingUntilMs`. */
  gainCeiling: number | null;
  ceilingUntilMs: number;
  /** How long the next ceiling lasts. Grows each time gain clips, so a still scene is retried ever more rarely. */
  ceilingMs: number;
  /** When exposure was last handed back to the camera. */
  handedBackMs: number;
  /** The camera answered a hand-back by dropping its frame rate, so a bright scene is met with a shorter shutter instead. */
  autoDropsFps: boolean;
  /** The shutter the camera reported when we last asked it for another; null when no request is waiting for proof. */
  shutterFrom: number | null;
  shutterWorks: boolean;
  whiteBalanceChecked: boolean;
  exposureChecked: boolean;
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
  starvedHoldOffUntilMs: 0,
  gainProbe: null,
  gainWorks: true,
  gainCeiling: null,
  ceilingUntilMs: 0,
  ceilingMs: CEILING_MS,
  handedBackMs: -1e9,
  autoDropsFps: false,
  shutterFrom: null,
  shutterWorks: true,
  whiteBalanceChecked: false,
  exposureChecked: false,
});

const SETTLE_MS = 1200; // cameras need about a second to apply and stabilise a control change
const SLOW_FOR_MS = 1500;
const BRIGHT_FOR_MS = 3000;
const HOLD_OFF_MS = 8000;
const STARVED_HOLD_OFF_MS = 60000;
const CEILING_MS = 30000;
const CEILING_MAX_MS = 30 * 60000;
const DROP_AFTER_HAND_BACK_MS = 30000;
const P98_HEADROOM = 0.8; // only add gain while highlights have room
const P98_CLIPPING = 0.95;
const STARVED_STOPS = 2.5; // past this much software brightening, sensor gain gives the cleaner picture

/** Longest shutter the camera supports that still fits one frame period. */
export function shutterFor(fps: number, r: Range): number {
  const limit = 10000 / fps;
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

  // A shutter someone pinned earlier (possibly us, in a tab that was closed before it could clean up)
  // is not a starting point we can reason from. Start from the camera's own automatic exposure.
  if (!state.exposureChecked) {
    const s = { ...state, exposureChecked: true };
    if (state.mode === 'observe' && settings.exposureMode === 'manual' && caps.autoExposure) {
      return sent(s, { exposureMode: 'continuous' }, 'exposure was fixed by hand; back to automatic');
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
    if (!caps.manualExposure || !caps.exposureTime || input.nowMs < state.holdOffUntilMs) return idle({ ...state, sinceMs: null });
    const pin = shutterFor(input.nominalFps, caps.exposureTime);
    // few frames arriving while we are the bottleneck says nothing about the camera
    const slow = input.fps < input.nominalFps * 0.75 && input.busy < 0.5;
    // auto exposure is already at the longest shutter this frame rate allows, so pinning it there costs
    // nothing, and gain is the only light left; with no headroom in the highlights gain would not be used
    const starved =
      input.nowMs >= state.starvedHoldOffUntilMs &&
      input.shortfallStops > STARVED_STOPS &&
      input.p98 < P98_HEADROOM &&
      settings.exposureTime !== undefined &&
      settings.exposureTime >= pin - 1e-6 &&
      !!caps.gain &&
      settings.gain !== undefined &&
      settings.gain < caps.gain.max &&
      state.gainWorks;
    if (!slow && !starved) return idle({ ...state, sinceMs: null });
    if (state.sinceMs === null) return idle({ ...state, sinceMs: input.nowMs });
    if (input.nowMs - state.sinceMs < SLOW_FOR_MS) return idle(state);
    return sent(
      { ...state, mode: 'manual', sinceMs: null, gainProbe: null, shutterFrom: null, autoDropsFps: state.autoDropsFps || (slow && input.nowMs - state.handedBackMs < DROP_AFTER_HAND_BACK_MS) },
      { exposureMode: 'manual', exposureTime: pin },
      slow
        ? `camera fell to ${input.fps.toFixed(0)} fps; pinning the shutter to hold ${input.nominalFps} fps`
        : 'face is dark and the camera has no shutter left; taking over to add sensor gain',
    );
  }

  // Another session on the same camera (a second tab, a page that opened the camera twice) can put
  // exposure back to automatic under us. Believe the camera, not our own bookkeeping.
  if (settings.exposureMode === 'continuous') {
    return idle({ ...state, mode: 'observe', sinceMs: null, gainProbe: null, holdOffUntilMs: input.nowMs + HOLD_OFF_MS });
  }

  // manual mode: light comes from sensor gain
  if (state.gainProbe) {
    const helped = state.gainProbe.shortfallBefore - input.shortfallStops > 0.08;
    state = { ...state, gainProbe: null, gainWorks: helped };
  }
  if (state.shutterFrom !== null) {
    // a camera that did not move its shutter when asked will not move it next time either
    const moved = settings.exposureTime !== undefined && Math.abs(settings.exposureTime - state.shutterFrom) > 1e-6;
    state = { ...state, shutterFrom: null, shutterWorks: moved };
  }
  const gain = caps.gain;
  const g = settings.gain;
  const clipping = input.p98 > P98_CLIPPING;
  const tooBright = input.shortfallStops < -0.3 || clipping;
  if (tooBright) {
    if (gain && g !== undefined && g > gain.min && state.gainWorks) {
      // clipped highlights are gone for good, a dark face can still be lifted: remember this gain was too much
      const ceiling = clipping ? { gainCeiling: g, ceilingUntilMs: input.nowMs + state.ceilingMs, ceilingMs: Math.min(state.ceilingMs * 4, CEILING_MAX_MS) } : {};
      return sent({ ...state, ...ceiling, sinceMs: null }, { exposureCompensation: Math.max(gain.min, g - gain.step) }, clipping ? 'highlights are clipping; lowering sensor gain' : 'scene is bright; lowering sensor gain');
    }
    // Minimum gain. Only highlights clip (a window behind a dark face): there is nothing left to give up.
    if (input.shortfallStops >= -0.3) return idle({ ...state, sinceMs: null });
    // The camera's own exposure suits a bright room best: it also avoids flicker from the lamps. Only a camera
    // that answered the last hand-back by dropping its frame rate stays with us, on a shorter shutter.
    const t = settings.exposureTime;
    if (state.autoDropsFps && state.shutterWorks && caps.exposureTime && t !== undefined && t > caps.exposureTime.min + 1e-6) {
      return sent({ ...state, sinceMs: null, shutterFrom: t }, { exposureTime: Math.max(caps.exposureTime.min, t / 2) }, 'scene is bright; shortening the shutter');
    }
    if (state.sinceMs === null) return idle({ ...state, sinceMs: input.nowMs });
    if (input.nowMs - state.sinceMs < BRIGHT_FOR_MS) return idle(state);
    return sent(
      { ...state, mode: 'observe', sinceMs: null, handedBackMs: input.nowMs, holdOffUntilMs: input.nowMs + HOLD_OFF_MS, starvedHoldOffUntilMs: input.nowMs + STARVED_HOLD_OFF_MS },
      { exposureMode: 'continuous' },
      'plenty of light; handing exposure back to the camera',
    );
  }
  const dark = input.shortfallStops > 1 && input.p98 < P98_HEADROOM;
  // light from the shutter is free of noise, so take back any we gave up before adding gain
  if (dark && state.shutterWorks && caps.exposureTime && settings.exposureTime !== undefined) {
    const pin = shutterFor(input.nominalFps, caps.exposureTime);
    if (settings.exposureTime < pin - 1e-6) {
      return sent({ ...state, sinceMs: null, shutterFrom: settings.exposureTime }, { exposureTime: Math.min(pin, settings.exposureTime * 2) }, 'scene is dark; lengthening the shutter');
    }
  }
  const ceiling = state.gainCeiling !== null && input.nowMs < state.ceilingUntilMs ? state.gainCeiling : Infinity;
  if (dark && gain && g !== undefined && g < gain.max && g + gain.step < ceiling && state.gainWorks) {
    // far from enough light and with highlights under a quarter: two steps at once, so a dark start is over sooner.
    // Two steps can triple the signal on a camera whose gain is a plain multiplier, and that must not clip.
    const steps = input.shortfallStops > 3 && input.p98 < 0.25 && ceiling === Infinity ? 2 : 1;
    return sent(
      { ...state, sinceMs: null, gainProbe: { shortfallBefore: input.shortfallStops } },
      { exposureCompensation: Math.min(gain.max, g + steps * gain.step) },
      'scene is dark; raising sensor gain',
    );
  }
  return idle({ ...state, sinceMs: null });
}
