# Sunroom

Sunroom makes a weak webcam in a badly lit room look good on video calls. It is automatic: there
are no sliders to learn. It runs on the graphics chip your laptop already has, and your video
never leaves your device.

It is for the person on a call from a dim room with a built-in laptop camera, whose face is dark,
grainy, the wrong colour, or stuttering at half the frame rate.

## What it does

- **Holds the frame rate.** Many webcams silently halve their frame rate in dim light. Sunroom
  notices, takes over the camera's exposure, and makes up the light with sensor gain.
- **Uses the camera's own gain before software.** When the face is far too dark and the camera
  has gain to spare, Sunroom raises it, because light added at the sensor is cleaner than light
  added afterwards.
- **Lights the face, not the room.** Exposure is measured on your face. A bright wall or window
  behind you is folded down instead of deciding how dark you look.
- **Cleans grain without smearing you.** Still background is averaged over many frames. Anything
  that moves, such as your face, is not.
- **Removes flicker bands** caused by mains lighting.
- **Keeps skin a plausible colour** when the camera's white balance goes wrong.
- **Goes easy on a good picture.** A face that is already well lit keeps its own brightness.
  The picture still gets noise cleanup and some sharpening, so it is not left untouched.

How each part works, and why, is in [docs/how-it-works.md](docs/how-it-works.md).

## Results

<!-- results:start -->
Scored on 6 clips of the same scene recorded from a 720p laptop webcam in a badly lit room, each
under a different camera state: as found, frame rate held, dim, dark with gain at maximum, and a
wrong white balance. Every clip is replayed through the real shaders on the laptop's own Intel
graphics. Colour and detail are compared with the camera's own automatic recording of the same
scene, the best this camera does unaided (its face brightness is 73, still short of healthy).
Sunroom finds the face with its own detector.

| Measure | Untouched camera | Simple brightening | Sunroom |
|---|---:|---:|---:|
| Face brightness (0 to 255, healthy is 95 to 150) | 39 | 114 | 104 |
| Face contrast against grain, higher is better | 26.1 | 27.9 | 51.1 |
| Noise in dark areas (grey levels), lower is better | 2.71 | 6.94 | 2.20 |
| Flicker banding (% of brightness), lower is better | 0.34 | 0.10 | 0.07 |
| Brightness wobble between frames (%), lower is better | 0.09 | 0.03 | 0.54 |
| Skin colour error, lower is better | 3.4 | 8.4 | 2.9 |
| Shirt colour error, lower is better | 7.5 | 26.7 | 4.8 |
| Wall colour error, lower is better | 5.7 | 3.8 | 6.2 |

"Simple brightening" is a gamma curve that puts the face at the same brightness, which is what a
brightness slider does. It gets the face bright by lifting everything, noise included: dark
areas come out 3.2 times noisier than with Sunroom, and colours wash out.

- **Speed.** About 12 ms per 720p frame on Intel UHD integrated graphics, 16 to 20 ms at the 95th
  percentile, so 30 fps fits with room to spare.
- **Live on the real webcam.** From the camera as found, Sunroom took over after 4 seconds and
  kept 30 fps. Over a 25 second run sensor gain went from 1 to 6 and the face from 78 to 109.
  Gain and exposure were back as found after it stopped.
- **Where it loses.** Brightness wobble is worse than the untouched camera. That is the first
  second of each 4.5 second clip, while the detector finds the face and the picture settles;
  after that second it measures 0.02. The wall keeps more tint than simple brightening leaves,
  because colour is corrected from skin, not from the whole picture. In the darkest clip the
  face reaches 66, short of healthy. Three harder clips (shadows clipped by the camera, nearly
  black, an extreme blue cast) are not in the averages: software cannot rebuild what the sensor
  did not record.

One camera, one room, one person. The harness is in `eval/` so you can score your own.
<!-- results:end -->

## How it compares

### Measured against two published neural enhancers

Zero-DCE++ (TPAMI 2021) and SCI (CVPR 2022) are well-known neural networks for brightening dark
pictures. Both ran on the same 6 clips and were scored by the same code. Each frame is enhanced on
its own, the way the authors' test scripts do it.

| Measure | Zero-DCE++ | SCI | Sunroom |
|---|---:|---:|---:|
| Face brightness (0 to 255, healthy is 95 to 150) | 110 | 148 | 104 |
| Picture clipped to white (%), lower is better | 0.01 | 20.3 | 0.02 |
| Face contrast against grain, higher is better | 26.6 | 22.7 | 51.1 |
| Noise in dark areas (grey levels), lower is better | 6.35 | 7.74 | 2.20 |
| Brightness wobble between frames (%), lower is better | 0.04 | 0.02 | 0.54 |
| Fine detail against the camera's own recording (1.00 is equal) | 1.15 | 1.18 | 1.02 |
| Skin colour error, lower is better | 14.6 | 14.5 | 2.9 |
| Shirt colour error, lower is better | 25.2 | 40.7 | 4.8 |
| Wall colour error, lower is better | 14.6 | 4.9 | 6.2 |
| Time per 720p frame on the test laptop | 147 ms on CPU | 89 ms on CPU | 12 ms on integrated graphics |

- **Where Sunroom wins.** Noise, face contrast against grain, and colour. Both networks brighten
  the grain along with the face and turn it into coloured speckle in the shadows. Neither removes
  a colour cast. SCI clips a fifth of the picture to white on these clips.
- **Where the networks win.** Brightness wobble and fine detail, and SCI on wall colour. They
  have no state between frames, so they cannot wobble. Sunroom's wobble is the first second of
  each clip, while its exposure settles.
- **How fair this is.** Not fully, in both directions. These networks were trained on still
  photos, not webcam video, and have no denoiser and no white balance. Three of the measures
  read noise from frame to frame, which Sunroom's filtering over time is built to cut. The
  measures were written while tuning Sunroom. The timing compares PyTorch on 2 CPU threads with
  shaders on a GPU; the networks would be faster on a GPU, which this laptop does not have for
  them.

Rerun it with `eval/neural_baselines.py`. The weights are not in this repo: Zero-DCE++ is
licensed for non-commercial research only.

### Against the tools people use today

This table is from each tool's own documentation and from user reports, not from tests here.
The sources are in `research/01-landscape.md`.

| | Sunroom | NVIDIA Broadcast | Windows Studio Effects | OBS with a low-light plugin | Zoom, Meet and Teams settings | Brightness extensions |
|---|---|---|---|---|---|---|
| Price and licence | Free, MIT | Free, closed | Comes with the PC, closed | Free, GPL | Free, closed | Free to paid |
| Needs | A browser with WebGL2 | An RTX 2060 or better | A Windows 11 PC with an NPU | OBS, the plugin, and CPU to spare | Nothing | Nothing |
| Runs on | Windows, macOS and Linux in the browser; the virtual camera on Windows | Windows | Windows 11 | Windows, macOS, Linux | Inside that app only | Browser calls only |
| Automatic in low light | Yes | Partly, once switched on | Partly, toggles | A filter you add | Yes in Zoom and Meet | No, sliders |
| Sets the camera's own exposure and gain | Yes, in Chromium browsers | No | No | No | No | No |
| Meters exposure on the face | Yes | No | No | No | Not documented | No |
| Cleans up noise | Yes | Yes | No | Not documented | A Zoom option | No |

What none of them do is work at both layers: steer the camera so it stops dropping frames in the
dark, then clean and tone what the sensor recorded. That is the part Sunroom adds. What Sunroom
does not have: background blur, relighting, eye contact, or a virtual camera on macOS or Linux.

## Try it

Requires Node 20 or later and Chrome or another Chromium browser.

```sh
git clone https://github.com/Umarfarook1/sunroom.git
cd sunroom
npm install
npm run web
```

Open the address it prints and allow the camera. Drag the divider to compare before and after.

### Browser extension

The extension gives the enhanced picture to any website that asks for your camera (Google Meet,
Zoom in the browser, Teams in the browser). No driver and no admin rights.

```sh
npm run build -w apps/extension
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select
`apps/extension/dist`. The popup has three switches: everywhere, this site, and camera control.

### Desktop app

The desktop app is for native apps such as Zoom or Teams, which need a system camera to select.

```sh
npm run desktop
```

The app does not install a camera by itself. On Windows it feeds the
[UnityCapture](https://github.com/schellingb/UnityCapture) filter, which you register once, for
your own user and without admin rights, with `apps/desktop/tools/register-virtual-camera.ps1`.
Apps then list it as "Sunroom Camera". See
[apps/desktop/PLATFORMS.md](apps/desktop/PLATFORMS.md) for the steps and for Linux and macOS, and
[Status](#status) for what works today.

## Status

<!-- status:start -->
Developed and measured on one laptop: Windows 10, Intel UHD graphics, a 720p Sonix webcam.

| Part | State | How it was checked |
|---|---|---|
| Enhancement engine | Works | Unit tests, and scored on recorded clips (see Results) |
| Camera control | Works on the one webcam tried | Live runs in Chrome on Windows 10: frame rate held at 30 fps, sensor gain raised in the dark, gain put back and exposure returned to automatic on stop |
| Web app | Works | 16 end-to-end checks on Chrome's fake camera, plus live runs on the real webcam |
| Browser extension | Works in tests | 14 end-to-end checks in Chromium, including a page with a strict content security policy, a cross-origin iframe, a background tab and a machine without WebGL2. On the real webcam it steered the camera and put the settings back, both on stop and when the tab was closed. On real pages (fake camera, nothing sent out): a WebRTC peer-connection call where the far end shows the enhanced picture, the Jitsi Meet pre-join screen, and webcamtests.com. Not yet tried on Google Meet, Zoom or Teams, which need a login |
| Desktop app on Windows | Works with the real virtual camera | Registered for one user without admin rights, then the whole chain on real hardware: webcam, Sunroom, "Sunroom Camera", read by ffmpeg through DirectShow and by Chrome through `getUserMedia` at 1280x720 and 29 fps. The real filter returns a test picture pixel for pixel, upright and in order. Not yet tried inside Zoom or Teams themselves |
| Desktop app on Linux | Parked, not working yet | A virtual camera through v4l2loopback and ffmpeg is written and its pipe is tested. It has not passed a test on a real Linux device. Windows is being finished first |
| Desktop app on macOS | Not built | The researched route is in `apps/desktop/PLATFORMS.md` |
| Linux, macOS and the Windows 11 family (engine and extension) | Works on GitHub's test machines | Every push runs the unit tests and `eval/smoke.mjs` on Linux x64, macOS on Apple silicon and Windows build 26100 (the Windows 11 24H2 family, server edition): a dark synthetic clip goes from brightness 22 to 105 through the engine, and a plain page gets the enhanced camera from the extension. Those machines have no webcam, so camera control stays tried on Windows 10 only; on Linux Chrome exposes no sensor gain, so only the frame-rate hold could apply there |
| Firefox and Safari | Not tried | They expose no camera controls, so only the picture enhancement can apply |

If enhancement fails while a call is running, the call keeps the camera's own picture. That is
tested by killing the graphics context mid-stream (`eval/failsafe.mjs`).

While it is steering the camera, Sunroom keeps a small note in the site's local storage
(`sunroom.camera.<id>`) with the camera's original gain and brightness, so it can put them back
if the tab is closed mid-call. The note is removed when the settings are restored.
<!-- status:end -->

## Privacy

Sunroom has no server. Frames are processed on your GPU, in your browser or in the desktop app,
and nothing is uploaded, logged or measured. The extension asks for `storage` (to remember your
switches) and access to pages (to hand the enhanced camera to the sites you use).

## Development

```sh
npm test                              # unit tests: metering, control, camera control, frame packing
npm run typecheck
node apps/web/test/e2e.mjs            # web app on Chrome's fake camera
node apps/extension/test/e2e.mjs      # extension, needs a Chromium that loads unpacked extensions
npm run e2e -w apps/desktop           # desktop app into a simulated camera filter (Windows)
node eval/failsafe.mjs <clip.mjpeg>   # kills the GPU context mid-stream: video must keep flowing
node eval/smoke.mjs <clip>            # engine and extension on any OS, no GPU needed (this is what CI runs)
node eval/real-sites.mjs              # extension on real camera pages: a WebRTC call, Jitsi pre-join, a webcam test site
```

The end-to-end tests play a recorded clip through the browser's fake camera. Make one from any
recording with `node tools/make_fake_camera.mjs <clip> data/fake/<name>.mjpeg`.

Picture quality is scored, not guessed. The `eval/` folder replays recorded camera frames
through the real shaders in Chrome and scores the result against the camera's own automatic
recording of the same scene. The recordings used during development contain a person's face and are not in the
repository, so record your own:

```sh
bash tools/record_clips.sh data/clips        # Windows: records the same scene under forced camera states
python eval/annotate.py data/frames data/models/yunet.onnx
node eval/run.mjs my-run --faces detect      # replay through the pipeline and score
python eval/compare.py data/out raw my-run   # compare against the untouched camera
node eval/live.mjs                           # closed-loop test on your real webcam
```

Layout:

| Path | What it is |
|---|---|
| `packages/core` | The engine: shaders, metering, control, camera control, session |
| `apps/web` | Web page with a before and after view |
| `apps/extension` | Browser extension (Manifest V3) |
| `apps/desktop` | Electron app with virtual camera output |
| `eval` | Scoring harness and baselines |
| `research` | Notes on existing tools, platform plumbing and algorithms, with sources |
| `decisions.tsv` | The decision log: what was tried, why, and what the measurement said |

## Limits

- Software cannot recover what the sensor never recorded. Shadows the camera clipped to black
  stay black; Sunroom's answer there is to raise the camera's own gain, which only works where
  the browser exposes it. That is Chrome on Windows as far as tested. Without it, brightening is
  capped at 5 stops and very dark faces stay short of healthy.
- Camera control changes the real camera. Sunroom puts gain and black level back and returns
  exposure to automatic when it stops, also when the tab is closed. If the browser crashes or
  is killed mid-call, the camera keeps the raised gain and manual exposure for every app until
  Sunroom next runs on the same site, or until you reset the camera in its own settings. A
  camera you had set to manual exposure yourself comes back in automatic.
- Two tabs steering the same camera at once are not coordinated. The second one resets the
  first.
- On pages whose security policy blocks WebAssembly, the face detector cannot load and Sunroom
  meters the centre of the picture instead, which lights a face less well.
- Sunroom needs a GPU, any integrated one will do. On a machine with none the browser renders
  in software and manages about 10 frames per second at 640x360 (measured on GitHub's Linux and
  Windows machines), which is too slow for a call.
- The desktop app keeps the camera open, and its light on, for as long as the app runs, also
  when the window is closed to the tray. Quit it from the tray to release the camera.
- No browser exposes the camera's anti-flicker setting, so flicker is removed in software.
  Bands that stand perfectly still cannot be told apart from the scene.
- White balance is corrected from skin colour. With no face in view it is left as the camera
  set it, and objects behind you can keep a tint after your skin is corrected.
- Tested on one camera, one room and one person so far. Reports from other cameras, skin tones
  and lighting are the most useful contribution right now.

## Licence

MIT. See [LICENSE](LICENSE).

Sunroom uses [MediaPipe](https://github.com/google-ai-edge/mediapipe) and its BlazeFace model
(Apache-2.0) to find the face. The Windows virtual camera uses the
[UnityCapture](https://github.com/schellingb/UnityCapture) filter (MIT), which is not bundled.
