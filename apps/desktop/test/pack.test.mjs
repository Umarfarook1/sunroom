import assert from 'node:assert/strict';
import { packFrame } from '../src/vcam/unity-capture.ts';

const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');

test('packFrame writes the header after maxSize, then the rows bottom-up', () => {
  const top = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const bottom = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const out = packFrame({ width: 3, height: 2, data: Uint8Array.from([...top, ...bottom]) });
  // width 3, height 2, stride 3 pixels, FORMAT_UINT8, RESIZEMODE_LINEAR, MIRRORMODE_DISABLED, timeout 1000 ms
  const header = [3, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0xe8, 0x03, 0, 0];
  assert.deepEqual([...out], [...header, ...bottom, ...top]);
});

test('packFrame rejects a buffer that is not width x height x 4', () => {
  assert.throws(() => packFrame({ width: 3, height: 2, data: new Uint8Array(23) }), RangeError);
});
