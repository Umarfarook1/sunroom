# Virtual camera by platform

The desktop app feeds a system camera that native apps (Zoom, Teams, Discord, OBS) can pick. Each platform needs its own backend behind `VirtualCameraOutput` in `src/vcam/output.ts`: a `state`, `send(frame)` and `close()`. `src/main.ts` picks the backend in one line.

| Platform | Status |
|---|---|
| Windows 10 and 11 | Sender implemented and tested against a simulated filter. Not yet tested with the real filter inside a real app. |
| Linux | Not implemented. |
| macOS | Not implemented. |

Research behind every row: `research/02-platform-plumbing.md`, sections 1 to 5.

## Windows

Sunroom Camera is the UnityCapture DirectShow filter (MIT). Sunroom writes frames into the filter's shared memory with koffi, so nothing is compiled. `src/vcam/unity-capture.ts` cites the upstream source lines for each protocol detail: RGBA byte order, stride in pixels, rows bottom-up.

The filter must be registered once before apps can list it:

- Per user, no admin: `tools/register-virtual-camera.ps1 -Install`. **Unverified.** No source confirms that apps list a DirectShow capture filter registered only under HKCU. Apps run as administrator never will.
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

- `npm test -w apps/desktop` runs the frame packing test and the sender against `test/receiver-sim.mjs`, a stand-in for the filter in a separate process.
- `npm run e2e -w apps/desktop` runs the app on Chromium's fake camera with the simulated filter attached.

## Linux (not implemented)

Researched path: v4l2loopback plus ffmpeg.

1. Root, once: `sudo modprobe v4l2loopback video_nr=10 card_label="Sunroom Camera" exclusive_caps=1`. Distros package the module as `v4l2loopback-dkms`. Secure Boot can block the unsigned module.
2. No root after that: spawn `ffmpeg -f rawvideo -pix_fmt rgba -s 1280x720 -r 30 -i - -f v4l2 -pix_fmt yuv420p /dev/video10` and write each RGBA frame to its stdin. The user needs write access to `/dev/video10`, normally through the `video` group.

A Linux `VirtualCameraOutput` would own that ffmpeg process. It would report `not-installed` while `/dev/video10` is missing, and `sending` while ffmpeg accepts frames. v4l2loopback does not tell the sender whether an app is reading, so this backend would send all the time, unlike the Windows one, which sends only while an app asks for frames.

PipeWire can host a camera node without a kernel module or root. Firefox and Chrome with "PipeWire camera support" turned on in `chrome://flags` can read it. Native apps such as Zoom read V4L2 only, so PipeWire does not replace v4l2loopback for them.

## macOS (not implemented)

An open-source project cannot ship its own camera on macOS. A camera extension needs a Developer ID signature (paid Apple Developer Program), must run from `/Applications`, and an admin must approve it. Unsigned extensions load only with SIP disabled.

Researched path: feed the signed camera extension that OBS Studio 30+ installs. pyvirtualcam does this with plain C calls (`CMIOObjectGetPropertyData`, `CMIOStreamCopyBufferQueue`, `CMSimpleQueueEnqueue`), and koffi could make the same calls. This needs OBS installed with its extension approved once, and it is untested because it needs a Mac.

The browser extension (`apps/extension`) covers web calls (Meet, Zoom web, Teams web) on every OS without a system camera.
