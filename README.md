# Sunroom

Sunroom makes a weak webcam in a badly lit room look good on video calls. It is automatic: there
are no sliders to learn. It runs on the graphics chip your laptop already has, and your video
never leaves your device.

It is for the person on a call from a dim room with a built-in laptop camera, whose face is dark,
grainy, the wrong colour, or stuttering at half the frame rate.

## What it does

- **Holds the frame rate.** Many webcams silently halve their frame rate in dim light. Sunroom
  notices, takes over the camera's exposure, and makes up the light with sensor gain.
- **Lights the face, not the room.** Exposure is measured on your face. A bright wall or window
  behind you is folded down instead of deciding how dark you look.
- **Cleans grain without smearing you.** Still background is averaged over many frames. Anything
  that moves, such as your face, is not.
- **Removes flicker bands** caused by mains lighting.
- **Keeps skin a plausible colour** when the camera's white balance goes wrong.
- **Leaves a good picture alone.** A face that is already well lit keeps its own brightness.

How each part works, and why, is in [docs/how-it-works.md](docs/how-it-works.md).

## Results

<!-- results:start -->
<!-- results:end -->

## Try it

Requires Node 20 or later and a Chromium browser (Chrome or Edge).

```sh
git clone <this repository>
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
`apps/extension/dist`.

### Desktop app

The desktop app is for native apps such as Zoom or Teams, which need a system camera to select.

```sh
npm run desktop
```

See [Status](#status) for what works today.

## Status

<!-- status:start -->
<!-- status:end -->

## Privacy

Sunroom has no server. Frames are processed on your GPU, in your browser or in the desktop app,
and nothing is uploaded, logged or measured. The extension asks for `storage` (to remember your
switches) and access to pages (to hand the enhanced camera to the sites you use).

## Development

```sh
npm test            # unit tests for the metering, control and camera-control rules
npm run typecheck
```

Picture quality is scored, not guessed. The `eval/` folder replays recorded camera frames
through the real shaders in Chrome and scores the result against a well-exposed recording of the
same scene. The recordings used during development contain a person's face and are not in the
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
  the browser exposes camera controls (Chromium on Windows and Linux).
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
