# Virtual camera by platform

The desktop app feeds a system camera that native apps (Zoom, Teams, Discord, OBS) can pick. Each platform needs its own backend behind `VirtualCameraOutput` in `src/vcam/output.ts`: a `state`, `send(frame)` and `close()`. `src/main.ts` picks the backend in one statement.

| Platform | Status |
|---|---|
| Windows 10 and 11 | Works on the one Windows 10 laptop tried, registered per user without admin rights. ffmpeg (DirectShow) and Chrome list and read "Sunroom Camera". Not yet tried inside Zoom or Teams, or on Windows 11. |
| Linux | Parked until Windows is finished. Sender implemented and its ffmpeg pipe tested. On GitHub's Ubuntu machine the v4l2loopback module builds and loads, but the device test has not passed yet. |
| macOS | Not implemented. |

Research behind every row: `research/02-platform-plumbing.md`, sections 1 to 5.

## Windows

Sunroom Camera is the UnityCapture DirectShow filter (MIT). Sunroom writes frames into the filter's shared memory with koffi, so nothing is compiled. `src/vcam/unity-capture.ts` cites the upstream source lines for each protocol detail: RGBA byte order, stride in pixels, rows bottom-up.

The filter must be registered once before apps can list it:

- Per user, no admin: `tools/register-virtual-camera.ps1 -Install`. Tried on one Windows 10 laptop: ffmpeg and Chrome list and read the camera. Apps run as administrator will not see it.
- Machine-wide, admin once: `regsvr32 UnityCaptureFilter64.dll` (and the 32-bit DLL for 32-bit apps). This is the route every other DirectShow virtual camera uses. The camera then shows as "Unity Video Capture".

Either way the filter DLL is loaded into every app that opens the camera. The per-user script
checks the DLL's hash when it registers it, not afterwards, and the DLL sits in a folder your
user account can write to (`%LOCALAPPDATA%\sunroom\vcam`). Anything running as you could swap
it later. That gives no extra rights, but keep it in mind, and use `-Uninstall` when you stop
using the camera.

While Sunroom runs it keeps the real camera open, also when its window is closed to the tray and
no app is reading "Sunroom Camera". Quit from the tray to release the camera.

DirectShow cameras are invisible to the Windows Camera app, which lists Media Foundation cameras only. A Windows 11 Media Foundation camera (`MFCreateVirtualCamera`) needs an admin registration and a media source that we have no prebuilt binary for.

Checks:

- `npm test -w apps/desktop` runs the frame packing test and the sender against `test/receiver-sim.mjs`, a stand-in for the filter in a separate process. It also runs the Linux pipe test below.
- `npm run e2e -w apps/desktop` runs the app on Chromium's fake camera with the simulated filter attached.
- With the camera registered, `test/real-filter.test.mjs` sends a test picture through the real filter and reads it back with ffmpeg, pixel for pixel. `node eval/live-vcam.mjs` runs the whole chain: webcam, app, "Sunroom Camera", ffmpeg and Chrome.

## Linux

Sunroom Camera is a v4l2loopback device fed by ffmpeg. `src/vcam/v4l2-ffmpeg.ts` runs `ffmpeg -f rawvideo -pix_fmt rgba -s WxH -r 30 -i - -f v4l2 -pix_fmt yuv420p /dev/video10` and writes each RGBA frame to its stdin.

Set it up once:

1. Install ffmpeg and the module. Debian and Ubuntu package the module as `v4l2loopback-dkms`. Secure Boot can block the unsigned module.
2. As root: `sudo modprobe v4l2loopback video_nr=10 card_label="Sunroom Camera" exclusive_caps=1`.
3. Give your user write access to `/dev/video10`, normally through the `video` group.

To use another device node, set `SUNROOM_V4L2_DEVICE`.

How the backend behaves:

- It reports `not-installed` while the device node is missing or not writable, or ffmpeg is not on PATH.
- It reports `sending` once ffmpeg takes frames. v4l2loopback does not tell the sender whether an app is reading, so Sunroom feeds the camera all the time. The Windows backend sends only while an app asks for frames.
- A new frame size restarts ffmpeg. A frame that arrives while ffmpeg is still taking the previous one is dropped, not queued.
- If ffmpeg exits on its own, the backend logs it and starts it again on a later frame. It waits 1 s, then 2, 4 and 8, and at most 10 s.

Checks:

- `test/v4l2-pipe.test.mjs` runs the backend with ffmpeg writing a raw RGBA file instead of the device, on any OS with ffmpeg on PATH. It checks the frame count, size and every pixel, the restart on a new size, the dropped frame, and the back-off. It passes on Windows 10.
- `test/v4l2-device.test.mjs` sends frames into the real device while a second ffmpeg reads them back, and compares them within what yuv420p allows. It runs only on Linux with the device loaded. It has not passed yet: on its first CI run the device node was not writable.

Not tested at all: an app such as Zoom, Chrome or OBS reading the device.

PipeWire can host a camera node without a kernel module or root. Firefox and Chrome with "PipeWire camera support" turned on in `chrome://flags` can read it. Native apps such as Zoom read V4L2 only, so PipeWire does not replace v4l2loopback for them.

## macOS (not implemented)

An open-source project cannot ship its own camera on macOS. A camera extension needs a Developer ID signature (paid Apple Developer Program), must run from `/Applications`, and an admin must approve it. Unsigned extensions load only with SIP disabled.

Researched path: feed the signed camera extension that OBS Studio 30+ installs. pyvirtualcam does this with plain C calls (`CMIOObjectGetPropertyData`, `CMIOStreamCopyBufferQueue`, `CMSimpleQueueEnqueue`), and koffi could make the same calls. This needs OBS installed with its extension approved once, and it is untested because it needs a Mac.

The browser extension (`apps/extension`) covers web calls (Meet, Zoom web, Teams web) on every OS without a system camera.
