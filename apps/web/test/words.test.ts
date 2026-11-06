import { expect, test } from 'vitest';
import type { SessionStatus } from '../../../packages/core/src/index';
import { problemFrom, statusLine } from '../src/words';

const face = { x: 0.4, y: 0.3, w: 0.2, h: 0.3 };
const status = (o: { lift?: number; wbRG?: number; wbExcess?: number; face?: boolean; manual?: boolean; fps?: number; frame?: boolean } = {}) =>
  ({
    cameraFps: o.fps ?? 30,
    outputFps: o.fps ?? 30,
    face: o.face === false ? null : face,
    director: { mode: o.manual ? 'manual' : 'observe', lastReason: null, lastCommand: null },
    frame:
      o.frame === false
        ? null
        : { decision: { render: { anchor: -6, target: -6 + (o.lift ?? 0) }, state: { wbRG: o.wbRG ?? 0, wbBG: 0, wbExcess: o.wbExcess ?? 0 } } },
  }) as unknown as SessionStatus;
const on = { enabled: true, director: true, droppedTo: null };

test('says what is being done, in order of impact', () => {
  expect(statusLine(status({ lift: 2.14 }), on)).toBe('Brightening your face');
  expect(statusLine(status({ lift: 4.2, face: false }), on)).toBe('Brightening the picture a lot');
  expect(statusLine(status({ lift: -0.5 }), on)).toBe('Toning down your face a little');
  expect(statusLine(status({ lift: 1.5, wbRG: 0.1, manual: true, fps: 29.6 }), { ...on, droppedTo: 14.8 })).toBe(
    'Holding 30 fps (camera had dropped to 15), brightening your face and correcting a colour cast',
  );
  expect(statusLine(status({ wbRG: -0.3, wbExcess: 0.5 }), on)).toBe('Softening a colour cast too strong to fully correct');
});

test('quiet and off states', () => {
  expect(statusLine(status({ lift: 0.1 }), on)).toBe('Your face is well lit. Keeping it steady.');
  expect(statusLine(status({ face: false }), on)).toBe('The light looks good. Keeping it steady.');
  expect(statusLine(status({ frame: false }), on)).toBe('Starting');
  expect(statusLine(status({ lift: 3 }), { ...on, enabled: false })).toBe('Enhance is off. This is the picture your camera gives.');
  expect(statusLine(status({ lift: 1, manual: true }), { ...on, director: false })).toBe('Brightening your face');
});

test('camera errors map to what the user can do', () => {
  expect(problemFrom(new DOMException('', 'NotAllowedError'))).toBe('denied');
  expect(problemFrom(new DOMException('', 'NotFoundError'))).toBe('none');
  expect(problemFrom(new DOMException('', 'NotReadableError'))).toBe('busy');
  expect(problemFrom(new Error('boom'))).toBe('other');
  expect(problemFrom(undefined)).toBe('other');
});
