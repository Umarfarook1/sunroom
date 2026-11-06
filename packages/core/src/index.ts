export { Enhancer, type EnhancerOptions, type FrameReport } from './enhancer';
export { CameraSession, type SessionOptions, type SessionStatus } from './session';
export { control, DEFAULT_TUNING, type ControlState, type Decision, type Tuning } from './controller';
export { direct, initialDirectorState, shutterFor, type CameraCaps, type CameraSettings, type Command, type DirectorInput, type DirectorState } from './director';
export { createMediaPipeFaceTracker, FaceSmoother, type FaceTracker, type MediaPipeAssets } from './face';
export { measure, type FaceBox, type FaceStats, type FrameStats } from './meter';
export type { AnalysisParams, RenderParams } from './pipeline';

/** True for the virtual camera the desktop app feeds, under either name its filter registers with. Enhancing it would feed Sunroom its own output. */
export const isSunroomCamera = (label: string): boolean => label.includes('Sunroom Camera') || label.includes('Unity Video Capture');
