import { describe, expect, it } from 'vitest';
import { type CameraCaps, type CameraSettings, type DirectorInput, type DirectorState, direct, initialDirectorState, shutterFor } from '../src/director';

// the dev laptop's Sonix webcam as Chrome reports it
const caps: CameraCaps = {
  exposureTime: { min: 9.765625, max: 625, step: 9.765625 },
  gain: { min: 1, max: 8, step: 1 },
  manualExposure: true,
  autoWhiteBalance: true,
  brightness: { min: -64, max: 64, step: 1 },
};
const auto: CameraSettings = { exposureMode: 'continuous', exposureTime: 625, gain: 1, whiteBalanceMode: 'continuous', brightness: 0 };
const manual: CameraSettings = { ...auto, exposureMode: 'manual', exposureTime: 312.5 };
const input = (over: Partial<DirectorInput>): DirectorInput => ({ nowMs: 0, fps: 30, nominalFps: 30, shortfallStops: 0, p98: 0.5, p02: 0.01, ...over });
const inManual = (over: Partial<DirectorState> = {}): DirectorState => ({ ...initialDirectorState(), mode: 'manual', whiteBalanceChecked: true, ...over });

describe('shutterFor', () => {
  it('picks 1/32 s on a power-of-two camera at 30 fps', () => {
    expect(shutterFor(30, caps.exposureTime!)).toBe(312.5);
  });
  it('picks 1/64 s at 60 fps', () => {
    expect(shutterFor(60, caps.exposureTime!)).toBe(156.25);
  });
  it('rounds down to the step on a linear camera', () => {
    expect(shutterFor(30, { min: 1, max: 5000, step: 1 })).toBe(333);
  });
  it('never goes below the camera minimum', () => {
    expect(shutterFor(240, { min: 100, max: 5000, step: 100 })).toBe(100);
  });
});

describe('direct', () => {
  it('leaves a camera that holds its frame rate alone', () => {
    const d = direct(initialDirectorState(), caps, auto, input({ nowMs: 5000, fps: 29.8, shortfallStops: 2 }));
    expect(d.command).toBeNull();
    expect(d.state.mode).toBe('observe');
  });

  it('pins the shutter only after the frame rate has been low for 1.5 s', () => {
    let s = initialDirectorState();
    let d = direct(s, caps, auto, input({ nowMs: 2000, fps: 15 }));
    expect(d.command).toBeNull();
    d = direct(d.state, caps, auto, input({ nowMs: 3000, fps: 15 }));
    expect(d.command).toBeNull();
    d = direct(d.state, caps, auto, input({ nowMs: 3600, fps: 15 }));
    expect(d.command).toEqual({ exposureMode: 'manual', exposureTime: 312.5 });
    expect(d.state.mode).toBe('manual');
    s = d.state;
    expect(s.lastCommandMs).toBe(3600);
  });

  it('forgets a brief dip', () => {
    let d = direct(initialDirectorState(), caps, auto, input({ nowMs: 2000, fps: 15 }));
    d = direct(d.state, caps, auto, input({ nowMs: 2500, fps: 30 }));
    d = direct(d.state, caps, auto, input({ nowMs: 4200, fps: 15 }));
    expect(d.command).toBeNull();
  });

  it('does nothing on a camera without manual exposure', () => {
    let d = direct(initialDirectorState(), { ...caps, manualExposure: false }, auto, input({ nowMs: 2000, fps: 15 }));
    d = direct(d.state, { ...caps, manualExposure: false }, auto, input({ nowMs: 9000, fps: 15 }));
    expect(d.command).toBeNull();
    expect(d.state.mode).toBe('observe');
  });

  it('waits for the camera to settle between commands', () => {
    const d = direct(inManual({ lastCommandMs: 1000 }), caps, manual, input({ nowMs: 2000, shortfallStops: 3 }));
    expect(d.command).toBeNull();
  });

  it('raises sensor gain one step when the scene is dark and highlights have room', () => {
    const d = direct(inManual(), caps, { ...manual, gain: 2 }, input({ nowMs: 5000, shortfallStops: 2.4, p98: 0.4 }));
    expect(d.command).toEqual({ exposureCompensation: 3 });
  });

  it('does not raise gain into clipping highlights', () => {
    const d = direct(inManual(), caps, { ...manual, gain: 2 }, input({ nowMs: 5000, shortfallStops: 2.4, p98: 0.85 }));
    expect(d.command).toBeNull();
  });

  it('lowers gain when highlights clip and does not climb back for 30 s', () => {
    let d = direct(inManual(), caps, { ...manual, gain: 5 }, input({ nowMs: 5000, shortfallStops: 0.9, p98: 0.97 }));
    expect(d.command).toEqual({ exposureCompensation: 4 });
    d = direct(d.state, caps, { ...manual, gain: 4 }, input({ nowMs: 7000, shortfallStops: 1.3, p98: 0.7 }));
    expect(d.command).toBeNull();
    d = direct(d.state, caps, { ...manual, gain: 4 }, input({ nowMs: 36000, shortfallStops: 1.3, p98: 0.7 }));
    expect(d.command).toEqual({ exposureCompensation: 5 });
  });

  it('stops using gain when a step made no difference', () => {
    let d = direct(inManual(), caps, { ...manual, gain: 2 }, input({ nowMs: 5000, shortfallStops: 2.4, p98: 0.4 }));
    expect(d.command).toEqual({ exposureCompensation: 3 });
    d = direct(d.state, caps, { ...manual, gain: 3 }, input({ nowMs: 7000, shortfallStops: 2.39, p98: 0.4 }));
    expect(d.command).toBeNull();
    expect(d.state.gainWorks).toBe(false);
  });

  it('hands exposure back when the scene stays bright at minimum gain, then holds off', () => {
    let d = direct(inManual(), caps, manual, input({ nowMs: 5000, shortfallStops: -1 }));
    expect(d.command).toBeNull();
    d = direct(d.state, caps, manual, input({ nowMs: 8100, shortfallStops: -1 }));
    expect(d.command).toEqual({ exposureMode: 'continuous' });
    expect(d.state.mode).toBe('observe');
    // the frame rate drops again straight away: no takeover during the hold-off
    d = direct(d.state, caps, auto, input({ nowMs: 10000, fps: 15 }));
    d = direct(d.state, caps, auto, input({ nowMs: 12000, fps: 15 }));
    expect(d.command).toBeNull();
  });

  it('switches a hand-fixed white balance back to automatic once', () => {
    let d = direct(initialDirectorState(), caps, { ...auto, whiteBalanceMode: 'manual' }, input({ nowMs: 1000 }));
    expect(d.command).toEqual({ whiteBalanceMode: 'continuous' });
    d = direct(d.state, caps, { ...auto, whiteBalanceMode: 'manual' }, input({ nowMs: 5000 }));
    expect(d.command).toBeNull();
  });

  it('raises a negative black level when shadows are clipped and the scene is dark', () => {
    const d = direct(inManual(), caps, { ...manual, brightness: -24 }, input({ nowMs: 5000, shortfallStops: 1.5, p02: 0, p98: 0.9 }));
    expect(d.command).toEqual({ brightness: -8 });
  });
});
