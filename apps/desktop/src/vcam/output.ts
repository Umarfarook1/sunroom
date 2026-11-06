/** What other apps (Zoom, Teams, OBS) can get from the system camera Sunroom feeds. */
export type VirtualCameraState =
  /** The camera driver is not registered, so no app can list Sunroom Camera. */
  | 'not-installed'
  /** Installed, but no app is reading the camera right now. */
  | 'waiting'
  /** An app is reading the camera and gets every frame we send. */
  | 'sending'
  /** No virtual camera on this OS yet (see PLATFORMS.md). */
  | 'unsupported';

/** One picture: RGBA bytes, rows top to bottom, no padding between rows. */
export interface RgbaFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

/** One virtual camera backend per OS. */
export interface VirtualCameraOutput {
  readonly state: VirtualCameraState;
  /** Hands a frame to the app reading the camera; does nothing while no app is connected. */
  send(frame: RgbaFrame): void;
  close(): void;
}
