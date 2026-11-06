// Everything the page says to the user, derived from the session's live status.

import type { SessionStatus } from '../../../packages/core/src/index';

export interface Switches {
  enabled: boolean;
  director: boolean;
  /** Camera frame rate seen just before the director took over, if it has. */
  droppedTo: number | null;
}

const LIFT_STOPS = 0.2; // smaller changes are invisible, so not worth mentioning
const CAST_LOG = 0.04;
const CAST_TOO_STRONG = 0.2;

/** One plain sentence saying what Sunroom is doing right now. */
export function statusLine(s: SessionStatus, sw: Switches): string {
  if (!sw.enabled) return 'Enhance is off. This is the picture your camera gives.';
  const f = s.frame;
  if (!f) return 'Starting';
  const parts: string[] = [];
  if (sw.director && s.director.mode === 'manual') {
    const fps = Math.round(s.cameraFps);
    const was = sw.droppedTo === null ? null : Math.round(sw.droppedTo);
    parts.push(was !== null && was < fps - 2 ? `holding ${fps} fps (camera had dropped to ${was})` : `holding ${fps} fps`);
  }
  const stops = f.decision.render.target - f.decision.render.anchor;
  const who = s.face ? 'your face' : 'the picture';
  // "stops" is a photographer's word; the number lives under Advanced
  const much = (n: number) => (n < 1 ? ' a little' : n > 3 ? ' a lot' : '');
  if (stops >= LIFT_STOPS) parts.push(`brightening ${who}${much(stops)}`);
  else if (stops <= -LIFT_STOPS) parts.push(`toning down ${who}${much(-stops)}`);
  const { wbRG, wbBG, wbExcess } = f.decision.state;
  if (Math.max(Math.abs(wbRG), Math.abs(wbBG)) > CAST_LOG) {
    parts.push(wbExcess > CAST_TOO_STRONG ? 'softening a colour cast too strong to fully correct' : 'correcting a colour cast');
  }
  if (!parts.length) return s.face ? 'Your face is well lit. Keeping it steady.' : 'The light looks good. Keeping it steady.';
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]!;
  return text[0]!.toUpperCase() + text.slice(1);
}

export type Problem = 'denied' | 'none' | 'busy' | 'insecure' | 'ended' | 'other';

export const PROBLEMS: Record<Problem, { title: string; body: string; retry: boolean }> = {
  denied: {
    title: 'Sunroom needs your camera',
    body: 'Camera access is blocked for this page. Allow it from the camera icon in the address bar, then try again.',
    retry: true,
  },
  none: { title: 'No camera found', body: 'Connect a camera, then try again.', retry: true },
  busy: { title: 'Your camera is busy', body: 'Another app or tab is using it. Close that one, then try again.', retry: true },
  insecure: { title: 'This page needs a secure connection', body: 'Open Sunroom over https or from localhost to use the camera.', retry: false },
  ended: { title: 'Camera disconnected', body: 'Reconnect your camera, then try again.', retry: true },
  other: { title: 'The camera did not start', body: 'Try again, or pick another camera.', retry: true },
};

const BY_ERROR_NAME: Record<string, Problem> = {
  NotAllowedError: 'denied',
  SecurityError: 'denied',
  NotFoundError: 'none',
  OverconstrainedError: 'none',
  NotReadableError: 'busy',
  TrackStartError: 'busy',
  AbortError: 'busy',
};

/** Maps a getUserMedia rejection to what the user can do about it. */
export function problemFrom(err: unknown): Problem {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
  return BY_ERROR_NAME[name] ?? 'other';
}

export const NO_WEBGL2 = "Showing your camera untouched. This browser can't run WebGL2, which Sunroom needs to process video.";
export const NO_FLOAT_TARGETS = 'Showing your camera untouched. This graphics chip lacks a feature Sunroom needs (floating-point render targets).';
