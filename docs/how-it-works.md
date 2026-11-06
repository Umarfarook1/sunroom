# How Sunroom works

Sunroom has one job: take the video a weak webcam produces in a badly lit room and make the
person in it look well lit, at full frame rate, without the user touching a control.

It does this in two places. First it fixes what it can at the camera, because light captured by
the sensor is always better than light invented afterwards. Then it repairs the picture on the
GPU.

## Why webcams look bad

These are measurements from the laptop Sunroom was developed on (a 720p Sonix UVC module), not
general claims. Your camera may differ, which is why Sunroom measures instead of assuming.

| Problem | What was measured |
|---|---|
| Frame rate halves in room light | Auto exposure chose a 1/16 s shutter. The stream reported 30 fps but delivered 15 real frames. |
| The face is darker than the room | The camera exposes for the whole frame. With a bright wall behind, the face sat at luma 73 of 255 and the wall at 175. |
| Flicker bands | The anti-flicker setting was 60 Hz in a 50 Hz country. Rolling bands were 4 to 7 times the noise floor. |
| Noise that averaging cannot remove | The firmware already denoises across frames, so the noise left is correlated in time. Averaging 8 frames cut it only 1.2 to 1.8 times. |
| Soft detail | A 720p frame held little more detail than a 360p one. |

## Stage 1: the director (camera control)

`packages/core/src/director.ts`

The director is a small state machine that watches the real frame rate and the scene brightness.
Its policy is minimal intervention.

- A camera that holds its frame rate is left alone.
- When auto exposure stretches the shutter and the frame rate drops below three quarters of
  nominal for 1.5 seconds, the director switches the camera to manual exposure and pins the
  longest shutter that fits one frame period (1/32 s on a power-of-two UVC camera at 30 fps).
- Light lost to the shorter shutter is made up with sensor gain, one step at a time, only while
  highlights have headroom. A gain that clipped highlights is remembered and not retried for
  30 seconds, which stops the loop from cycling.
- Each gain step is checked. If the picture did not get brighter, the director stops using that
  control: on some systems the same browser property means something else.
- A hand-fixed white balance is switched back to automatic. A negative black level that clips
  shadows is raised toward the middle of its range.
- When the scene gets bright, exposure is handed back to the camera.
- On stop, or when the user turns the director off, every control it changed is put back.

The director is a pure function (`direct(state, caps, settings, input)`), so its rules are unit
tested without a camera.

Browsers expose these controls through `MediaStreamTrack.applyConstraints`. Chromium does on
Windows and Linux. Firefox and Safari do not, and there the director does nothing. No browser
exposes the anti-flicker (mains frequency) setting, so Sunroom removes flicker in software.

## Stage 2: the picture pipeline (WebGL2)

`packages/core/src/shaders.ts`, `pipeline.ts`

All colour math is in linear light with 16-bit float targets. Motion and noise decisions use a
square-root encoding, where camera noise is close to uniform across brightness.

1. **Deflicker.** The frame is averaged down to a 160 x 90 luminance grid and compared with a
   slow running average of the same grid. Mains flicker shows up as a smooth pattern across rows
   that rolls from frame to frame; a moving person does not, and is rejected by a reweighted
   mean. The result is one gain per row, applied before anything else.
2. **Temporal denoise.** Each pixel is blended with its own history. The blend weight comes from
   how much the neighbourhood changed, measured against the noise level, so static background
   accumulates many frames while a moving face keeps none. History is clamped to the range of
   the current neighbourhood, which prevents ghost trails.
3. **Metering.** A small grid is read back to the CPU each frame: luminance percentiles, a
   centre-weighted average, face brightness and skin colour when a face box is known, and the
   noise level measured separately for dark and bright areas.
4. **Control.** `controller.ts` turns those statistics into rendering parameters. It is
   feed-forward: it never looks at its own output, so it cannot oscillate. Smoothing and a dead
   band only keep the picture from pumping.
   - A face below a healthy brightness band is lifted to the band's lower edge. A face already
     inside the band keeps its brightness. Skin tones differ and Sunroom does not push every
     face to one value.
   - Brightening is capped at 5 stops. Past that the result is noise.
   - Highlights that would clip after the lift are compressed instead.
   - White balance is corrected only when skin falls outside a wide plausible range, and then by
     the smallest amount that brings it back. A cast too strong to correct is shown as a calmer,
     greyer picture.
5. **Spatial denoise.** Where temporal history is thin, or where firmware noise is too correlated
   to average away, neighbouring pixels and coarser mip levels are mixed in, but only when they
   agree with the pixel to within the remaining noise.
6. **Local tone mapping.** A guided filter on log luminance separates large-scale light from
   detail. The large-scale part is compressed around the face, so the face lands on target and a
   bright wall folds down. Detail rides on top unchanged. Shadows on the face get an extra lift,
   a soft fill light for eye sockets under a ceiling lamp.
7. **Finish.** Chroma comes from a coarser level where the picture is grainy. Near-black pixels,
   whose hue is mostly noise, lose their colour. Fine detail is sharpened where it rises above
   the noise. A soft shoulder rolls highlights off, and triangular dither hides the steps an
   8-bit shadow shows when lifted.

There is no neural network in the enhancement path. The well-known small low-light models are
either licensed for non-commercial use only or have no licence, and none was shown to beat a
tuned classical pipeline on already-processed webcam video (see `research/03-algorithms.md`).
The only model is BlazeFace, used to find the face for metering. It runs on the enhanced picture,
which is why it still finds a face the raw frame is too dark to show.

## One core, three shells

`packages/core/src/session.ts`

`CameraSession` takes a camera track and returns an enhanced track. It pumps frames with
Insertable Streams (`MediaStreamTrackProcessor` and `MediaStreamTrackGenerator`), which keep
running in a background tab, and falls back to a canvas where those are missing.

- `apps/web`: a page with a before and after view. Nothing to install.
- `apps/extension`: a browser extension that hands the enhanced track to any site that asks for
  the camera. No driver, no admin rights, any desktop OS.
- `apps/desktop`: an Electron app that feeds a system virtual camera so native apps can use the
  enhanced video.

## How it is tested

`eval/`

Quality is scored on recorded clips, not judged by eye alone.

1. `tools/record_clips.sh` records the same scene under forced camera states (as found, dim,
   dark, high gain, colour casts), saving the camera's own MJPEG frames without re-encoding.
2. `eval/annotate.py` marks the face in every frame with an independent detector.
3. `eval/run.mjs` replays the frames through the real shaders in Chrome on the real GPU.
4. `eval/metrics.py` scores each result against the well-exposed clip of the same scene: face
   exposure, noise in static regions, contrast against noise, flicker, banding, detail, and
   colour error on skin, shirt and wall.
5. `eval/baselines.py` produces the simple alternatives (gain, gamma, CLAHE with grey-world) that
   any enhancer must beat.
6. `eval/live.mjs` runs the whole session on the real webcam and logs what the director did.

The clips contain the developer's face and are not in the repository. Record your own.
