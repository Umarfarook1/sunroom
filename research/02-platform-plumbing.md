# 02 Platform plumbing: virtual cameras, camera controls, extension, shell

Research date: 2026-11-06. Every factual claim links its source. Anything I could not confirm from a primary source is marked **UNVERIFIED**. "Inference" marks a conclusion I drew from cited facts, not a statement made by the source.

## 0. Answers in one table

| Target | Most practical path with no admin and no compiler | Honest limit |
|---|---|---|
| Windows 10 and 11, user already has OBS Studio installed | Write NV12 frames into OBS's shared-memory queue `OBSVirtualCamVideo` from Node via koffi. pyvirtualcam does exactly this from a third-party process ([virtual_output.h](https://github.com/letmaik/pyvirtualcam/blob/main/pyvirtualcam/native_windows_obs/virtual_output.h)). | Admin was needed once, when OBS registered its filter ([OBS KB](https://obsproject.com/kb/virtual-camera-troubleshooting)). OBS itself must not run its own virtual camera at the same time (inference). OBS camera is DirectShow, so the Windows Camera app will not list it. |
| Windows 10 and 11, no OBS | Per-user (HKCU) registration of the prebuilt MIT UnityCapture DLL. | **UNVERIFIED.** No project or Microsoft document I found shows a DirectShow capture filter registered only under HKCU being listed by apps. Elevated apps ignore HKCU COM by design. Needs a 15-minute test (section 1.4). Fallback: one UAC prompt to run `regsvr32` once. |
| Windows 11 only, Media Foundation camera | Not possible without admin: the media-source COM class must be in HKLM ([VCamSample](https://github.com/smourier/VCamSample)). After a one-time admin registration, the app can create a per-user, session-lifetime camera without admin ([MFCreateVirtualCamera](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nf-mfvirtualcamera-mfcreatevirtualcamera)). | No prebuilt permissive media source that accepts external frames was found with release binaries. |
| macOS | None that we can ship ourselves. A camera extension needs Developer ID signing (USD 99/year), an app in `/Applications`, and approval by an admin user ([Apple](https://developer.apple.com/tutorials/data/documentation/coremediaio/creating-a-camera-extension-with-core-media-i-o.json), [programs](https://developer.apple.com/programs/)). Lightest honest path: feed the already-signed OBS 30+ camera extension through plain-C CoreMediaIO calls, as pyvirtualcam does ([virtual_output.hpp](https://github.com/letmaik/pyvirtualcam/blob/main/pyvirtualcam/native_macos_obs_cmioextension/virtual_output.hpp)). | Depends on OBS being installed and its extension approved once. |
| Linux | v4l2loopback needs root once to load the module ([README](https://github.com/v4l2loopback/v4l2loopback)); after that, pipe raw frames to `ffmpeg -f v4l2` without root. PipeWire `Video/Source` node needs no kernel module and no root, but Chrome only reads PipeWire cameras behind a flag that is off by default ([capture_switches.cc](https://github.com/chromium/chromium/blob/main/media/capture/capture_switches.cc)). | No no-root path that native apps see. |
| Browser (Meet, Zoom web, Teams web) | MV3 content script with `"world": "MAIN"`, `"run_at": "document_start"`, `"all_frames": true`, overriding `getUserMedia` and `enumerateDevices`, frames driven by `MediaStreamTrackProcessor` and output by `MediaStreamTrackGenerator` (Chrome). | Firefox has no `MediaStreamTrackProcessor` ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/MediaStreamTrackProcessor.json)); canvas fallback freezes in background tabs. |
| Desktop shell | Electron. Tauri cannot be built without Rust and the MSVC build tools ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)). | Electron is heavier. |

---

## 1. Windows virtual camera through DirectShow (Windows 10 and 11)

### 1.1 Filters that exist

| Project | Licence | Prebuilt binaries | Frame IPC | Pixel format to the app | Limits | Notes |
|---|---|---|---|---|---|---|
| [schellingb/UnityCapture](https://github.com/schellingb/UnityCapture) | Filter: MIT. Unity plugin: zlib ([README](https://github.com/schellingb/UnityCapture)) | Yes: `UnityCaptureFilter32.dll` and `UnityCaptureFilter64.dll` are committed in [`Install/`](https://github.com/schellingb/UnityCapture/tree/master/Install) | Named shared memory `UnityCapture_Data`, mutex `UnityCapture_Mutx`, events `UnityCapture_Want` and `UnityCapture_Sent`; a digit suffix selects device 2+ ([shared.inl](https://github.com/schellingb/UnityCapture/blob/master/Source/shared.inl)). Header: `DWORD maxSize; int width, height, stride, format, resizemode, mirrormode, timeout;` then pixel data. Formats: `FORMAT_UINT8`, `FORMAT_FP16_GAMMA`, `FORMAT_FP16_LINEAR` ([shared.inl](https://github.com/schellingb/UnityCapture/blob/master/Source/shared.inl)) | `MEDIASUBTYPE_RGB24` or `MEDIASUBTYPE_ARGB32` ([UnityCaptureFilter.cpp](https://github.com/schellingb/UnityCapture/blob/master/Source/UnityCaptureFilter.cpp)) | Max 3840x2160 ([README](https://github.com/schellingb/UnityCapture)); caps advertise 30 to 120 fps, default 30 ([UnityCaptureFilter.cpp](https://github.com/schellingb/UnityCapture/blob/master/Source/UnityCaptureFilter.cpp)) | `Install.bat` self-elevates through UAC, then runs `regsvr32` on both DLLs ([Install.bat](https://github.com/schellingb/UnityCapture/blob/master/Install/Install.bat)). Registration writes `DevicePath` under **HKLM** explicitly ([UnityCaptureFilter.cpp](https://github.com/schellingb/UnityCapture/blob/master/Source/UnityCaptureFilter.cpp)). Input channel order for `FORMAT_UINT8`: 4 bytes per pixel (inferred from the size constant `3840*2160*4*sizeof(short)`); RGBA vs BGRA **UNVERIFIED**. |
| [tshino/softcam](https://github.com/tshino/softcam) | MIT ([README](https://github.com/tshino/softcam)) | **No.** Every release has zero assets ([releases API](https://api.github.com/repos/tshino/softcam/releases)); you must build with Visual Studio ([README](https://github.com/tshino/softcam)) | Shared memory `DirectShow Softcam/SharedMemory`, mutex `DirectShow Softcam/NamedMutex`; header `uint32 image_offset; uint16 width, height; float framerate; uint8 is_active, connected_min_version, sender_heartbeat, receiver_heartbeat; uint64 frame_counter` ([FrameBuffer.cpp](https://github.com/tshino/softcam/blob/main/src/softcamcore/FrameBuffer.cpp)) | `MEDIASUBTYPE_RGB24`, 24 bpp ([DShowSoftcam.cpp](https://github.com/tshino/softcam/blob/main/src/softcamcore/DShowSoftcam.cpp)); 3 bytes per pixel, top-down in shared memory ([FrameBuffer.cpp](https://github.com/tshino/softcam/blob/main/src/softcamcore/FrameBuffer.cpp)) | Width and height 1 to 16384, multiple of 4 ([FrameBuffer.cpp](https://github.com/tshino/softcam/blob/main/src/softcamcore/FrameBuffer.cpp)) | Installer asks for admin through UAC ([README](https://github.com/tshino/softcam)). Registers via `IFilterMapper2` with `CLSID_VideoInputDeviceCategory` ([softcam.cpp](https://github.com/tshino/softcam/blob/main/src/softcam/softcam.cpp)). Not usable by us without a compiler. |
| OBS Studio virtual camera (`obs-virtualcam-module`) | GPL-2.0 (OBS licence) | Ships inside the OBS installer | Shared memory `OBSVirtualCamVideo`; header `write_idx, read_idx, state, offsets[3], type, cx, cy, uint64 interval, reserved[8]`; 3 frame slots, each with a 32-byte header that starts with a 64-bit timestamp; NV12 payload `cx*cy*3/2` ([shared-memory-queue.c](https://github.com/obsproject/obs-studio/blob/master/plugins/win-dshow/shared-memory-queue.c)) | Offers NV12, I420, YUY2 ([virtualcam-filter.cpp](https://github.com/obsproject/obs-studio/blob/master/plugins/win-dshow/virtualcam-module/virtualcam-filter.cpp)) | Resolution comes from the queue header; before a stream starts the filter reads `%APPDATA%\obs-virtualcam.txt` as `WIDTHxHEIGHTxINTERVAL` ([virtualcam-filter.cpp](https://github.com/obsproject/obs-studio/blob/master/plugins/win-dshow/virtualcam-module/virtualcam-filter.cpp)) | Registration writes via `HKEY_CLASSES_ROOT` and `IFilterMapper2` ([virtualcam-module.cpp](https://github.com/obsproject/obs-studio/blob/master/plugins/win-dshow/virtualcam-module/virtualcam-module.cpp)); manual install is "Run as Administrator" ([OBS KB](https://obsproject.com/kb/virtual-camera-troubleshooting)). Any process can feed it: pyvirtualcam checks `HKCR\CLSID\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}` and then writes the queue, accepting RGB/BGR/I420/YUY2/UYVY/NV12 and converting to NV12 ([virtual_output.h](https://github.com/letmaik/pyvirtualcam/blob/main/pyvirtualcam/native_windows_obs/virtual_output.h)). |
| [webcamoid/akvirtualcamera](https://github.com/webcamoid/akvirtualcamera) | GPL-3.0 ([repo](https://github.com/webcamoid/akvirtualcamera)) | Yes: `akvirtualcamera-windows-9.4.1.exe` (2026-05-15) ([releases](https://github.com/webcamoid/akvirtualcamera/releases)) | CLI pipe: `producer | AkVCamManager stream AkVCamVideoDevice0 RGB24 W H [--fps 30]` ([wiki](https://github.com/webcamoid/akvirtualcamera/wiki/Usage-and-examples)). Internally shared memory (default) or sockets ([wiki](https://github.com/webcamoid/akvirtualcamera/wiki/Configure-the-cameras)) | Output formats set with `add-format`; wiki advises at least YUY2 640x480 ([wiki](https://github.com/webcamoid/akvirtualcamera/wiki/Configure-the-cameras)) | Per configured formats | Driving it as a separate CLI process avoids linking GPL code (inference; get a licence opinion). Whether the installer or `AkVCamManager update` needs admin: **UNVERIFIED** (likely, since it registers a system DirectShow filter). |
| [jozeta/camtest](https://github.com/jozeta/camtest) | MIT | Not checked | Static image / GIF / slideshow only | RGB24 at 30 fps | Configurable resolution | "registers up to 4 camera devices system-wide and requires an elevation prompt" ([README](https://github.com/jozeta/camtest)). Useful as a small, readable reference. |
| [leadedge/SpoutCam](https://github.com/leadedge/SpoutCam) | **UNVERIFIED** (no licence file visible on the repo page) | `.ax` binaries in a `binaries` folder ([repo](https://github.com/leadedge/SpoutCam)) | Spout (DirectX 11 shared textures) | **UNVERIFIED** | **UNVERIFIED** | Feeding needs a D3D11 Spout sender, not practical from Node without native code (inference). |

### 1.2 Which apps see a DirectShow virtual camera

| App | Sees DirectShow virtual camera? | Evidence |
|---|---|---|
| Chrome, Edge, Electron, WebView2 (Chromium) | Yes. Chromium uses Media Foundation by default (`kMediaFoundationVideoCapture` is `FEATURE_ENABLED_BY_DEFAULT`, [media_switches.cc](https://github.com/chromium/chromium/blob/main/media/base/media_switches.cc)) and then appends DirectShow-only devices because "DirectShow virtual cameras are not supported by MediaFoundation" ([video_capture_device_factory_win.cc](https://chromium.googlesource.com/chromium/src/+/HEAD/media/capture/video/win/video_capture_device_factory_win.cc)). | Device name comes from `Description` or `FriendlyName`; ID from `DevicePath`, falling back to the name if missing. Name prefixes such as "Google Camera Adapter", "IP Camera [JPEG/MJPEG]", "CyberLink Webcam Splitter", "EpocCam", "eBUS DirectShow Source" are blocked ([same file](https://chromium.googlesource.com/chromium/src/+/HEAD/media/capture/video/win/video_capture_device_factory_win.cc)). |
| Firefox (Windows) | Likely yes: libwebrtc's Windows capturer is DirectShow based ([device_info_ds.cc](https://chromium.googlesource.com/external/webrtc/+/HEAD/modules/video_capture/windows/device_info_ds.cc)). Whether Firefox still uses that path: **UNVERIFIED**. | |
| Windows Camera app | **No.** It "only enumerates cameras through Media Foundation's frame-server pipeline" ([camtest README](https://github.com/jozeta/camtest)). | |
| Zoom desktop, Teams classic | Commonly reported to work ([camtest README](https://github.com/jozeta/camtest) lists "Teams, Zoom, OBS, browsers"). Independent primary confirmation: **UNVERIFIED**. | |
| New Teams | Mixed community reports: some users lost OBS virtual camera after moving to new Teams ([OBS forum](https://obsproject.com/forum/threads/new-teams-cant-capture-the-virtual-camera.171102/)). **UNVERIFIED** either way. | |
| Discord | Commonly reported to work with OBS virtual camera; **UNVERIFIED** from a primary source. | |

### 1.3 Can a DirectShow source filter be registered per user (HKCU) without admin?

What the documentation says:

1. DirectShow documents both the COM server and the category entry under `HKEY_CLASSES_ROOT`: `HKCR\CLSID\{Filter CLSID}\InprocServer32` and `HKCR\CLSID\{Category}\Instance\{Filter CLSID}` with values `CLSID`, `FilterData`, `FriendlyName` ([Layout of the Registry Keys](https://learn.microsoft.com/en-us/windows/win32/directshow/layout-of-the-registry-keys)).
2. `HKEY_CLASSES_ROOT` is a merged view of `HKLM\Software\Classes` and `HKCU\Software\Classes`; HKCU entries take precedence ([Merged View of HKCR](https://learn.microsoft.com/en-us/windows/win32/sysinfo/merged-view-of-hkey-classes-root)). So a reader that opens `HKCR` (as DirectShow's documented layout implies) should see HKCU entries. Inference, not a Microsoft statement about devenum.
3. Writes to `HKCR` go to HKLM unless the key already exists in HKCU (same page), which is why `regsvr32` on OBS, UnityCapture and softcam needs admin.
4. **Elevated apps ignore per-user COM.** "If an application is run with administrator rights and User Account Control is disabled, the COM runtime ignores per-user COM configuration" ([Merged View of HKCR](https://learn.microsoft.com/en-us/windows/win32/sysinfo/merged-view-of-hkey-classes-root)); more precisely, per-user COM "does not work at all ... for any process with a MIC level higher than medium" and `CoCreateInstance` returns `REGDB_E_CLASSNOTREG` ([Vista compat team](https://learn.microsoft.com/en-us/archive/blogs/vistacompatteam/per-user-com-on-vista-for-elevated-token-processes)). So Zoom, OBS or anything started "as administrator" will not load an HKCU-only filter.
5. **Bitness.** `HKCU\Software\Classes\CLSID` is a *redirected* key on Windows 7 and later ([Registry Keys Affected by WOW64](https://learn.microsoft.com/en-us/windows/win32/winprog64/shared-registry-keys)). A 32-bit app reads `HKCU\Software\Classes\WOW6432Node\CLSID\...`. To reach both 32-bit and 64-bit apps you register the 32-bit DLL under `WOW6432Node\CLSID` and the 64-bit DLL under `CLSID`, each with its own `{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance\{filter}` entry (inference from the same table). `HKCU\Software\Classes\DirectShow` and `MediaFoundation` are redirected too (same table).
6. Chrome's video capture service runs **unsandboxed** on Windows (`kVideoCaptureSandbox = kNoSandbox` on every platform except Fuchsia, [video_capture_service.mojom](https://github.com/chromium/chromium/blob/main/services/video_capture/public/mojom/video_capture_service.mojom)), at the user's medium integrity, so it is a normal candidate for HKCU COM lookup (inference).

What I could not find:

- No project, blog or Microsoft page that demonstrates a DirectShow capture filter registered only under HKCU and listed by Chrome, Zoom or Teams. Every filter I checked (OBS, UnityCapture, softcam, camtest, SpoutCam) registers machine-wide with elevation. A web search for per-user DirectShow camera registration found only claims I could not open or verify. **Status: UNVERIFIED, plausible for non-elevated, same-user, matching-bitness apps.**
- The merged-view page says that for some duplicate subkeys "the merged view does not include the HKEY_LOCAL_MACHINE contents" ([Merged View of HKCR](https://learn.microsoft.com/en-us/windows/win32/sysinfo/merged-view-of-hkey-classes-root)). Its example is ambiguous about whether creating `HKCU\Software\Classes\CLSID\{860BB310-...}` could hide machine-wide virtual cameras (for example OBS) in the merged view. **UNVERIFIED; must be part of the test.**
- Whether DirectShow's device enumerator needs the binary `FilterData` value for a capture source to be listed, or only `CLSID` and `FriendlyName`: **UNVERIFIED.**
- DirectShow keeps a per-user cache under `HKCU\Software\Microsoft\ActiveMovie\devenum` (observed on the dev laptop: the key exists with category subkeys). Whether a stale cache delays a new per-user entry: **UNVERIFIED.**

UnityCapture is still the best candidate for the experiment, because it is MIT, its 32 and 64-bit DLLs are prebuilt in the repo, and its frame protocol is simple. We would **not** call its `DllRegisterServer` (it opens HKLM with `KEY_ALL_ACCESS`, [UnityCaptureFilter.cpp](https://github.com/schellingb/UnityCapture/blob/master/Source/UnityCaptureFilter.cpp)); we would write the keys ourselves with `reg.exe add HKCU\...`, which needs no admin.

### 1.4 The test that settles 1.3 (run before committing to the design)

On the Windows 10 laptop, with no admin:

1. Copy `UnityCaptureFilter64.dll` to `%LOCALAPPDATA%\sunroom\`.
2. `HKCU\Software\Classes\CLSID\{UnityCapture CLSID}` (default = friendly name) and `\InprocServer32` (default = DLL path, `ThreadingModel = Both`).
3. `HKCU\Software\Classes\CLSID\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance\{UnityCapture CLSID}` with `CLSID`, `FriendlyName`, `DevicePath` (UnityCapture writes `foo:bar`, [UnityCaptureFilter.cpp](https://github.com/schellingb/UnityCapture/blob/master/Source/UnityCaptureFilter.cpp)). Try once without `FilterData`, then with a `FilterData` blob copied from an admin-registered machine.
4. Check: `navigator.mediaDevices.enumerateDevices()` in Chrome and Edge, `ffmpeg -list_devices true -f dshow -i dummy`, Zoom, Teams, Discord, and Chrome started "as administrator" (expected to fail per 1.3 item 4). Repeat with OBS installed to check the shadowing question.
5. Undo by deleting the HKCU keys.

### 1.5 Other paths on Windows without a compiler

- **csc.exe is already on the machine.** The .NET Framework 4 C# compiler is present at `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (checked locally on the dev laptop); it is what PowerShell `Add-Type` uses. That is enough for small Windows helpers (camera controls, section 9). A DirectShow *filter* in managed code would load the CLR into Chrome or Zoom; I would not ship that (opinion).
- **pyvirtualcam** (GPL-2.0) ships prebuilt wheels for Windows, macOS and Linux ([PyPI](https://pypi.org/project/pyvirtualcam/), [README](https://github.com/letmaik/pyvirtualcam)). Backends: OBS and Unity Capture on Windows, OBS on macOS, v4l2loopback on Linux. It is a working reference for every protocol in this report. Bundling it makes that component GPL-2.0.

---

## 2. Windows 11 Media Foundation virtual camera (`MFCreateVirtualCamera`)

| Question | Answer | Source |
|---|---|---|
| Minimum build | Windows Build 22000 (Windows 11). Not available on Windows 10. | [MFCreateVirtualCamera](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nf-mfvirtualcamera-mfcreatevirtualcamera) |
| Lifetime | `MFVirtualCameraLifetime_Session`: camera disappears when the `IMFVirtualCamera` is released or shut down. `_System`: persists across sessions and reboots. | same |
| Access | `MFVirtualCameraAccess_CurrentUser`: only the calling user. `_AllUsers`: "the caller ... must have administrator permissions." Non-admin callers may only use the categories `KSCATEGORY_VIDEO_CAMERA`, `KSCATEGORY_VIDEO`, `KSCATEGORY_CAPTURE`, `KSCATEGORY_SENSOR_CAMERA`. `E_ACCESSDENIED` if privacy settings deny camera access. | same |
| Media source | `sourceId` is the CLSID of your own media source COM class. Windows appends "Windows Virtual Camera" to the friendly name. | same |
| Where the source runs | Loaded in-process by the app, the Windows Frame Server and the Frame Server Monitor (svchost, Local Service and Local System). | [VCamSample](https://github.com/smourier/VCamSample) |
| Admin needed? | **Yes, once.** "it's not possible to register a Virtual Camera media source in HKCU, only in HKLM since it will be loaded by multiple processes"; `regsvr32` must run as administrator. After that, creating a CurrentUser + Session camera needs no admin (per the API docs). | [VCamSample](https://github.com/smourier/VCamSample), [VCamNetSample](https://github.com/smourier/VCamNetSample), [API docs](https://learn.microsoft.com/en-us/windows/win32/api/mfvirtualcamera/nf-mfvirtualcamera-mfcreatevirtualcamera) |
| Frame IPC | The source runs inside the Frame Server service, so frames cross sessions. VL.Video.VirtualCamera has the media source create a pagefile section `Global\vvvv-vcam0-v2-{w}x{h}` whose DACL lets the user app write and everyone read, with a seqlock ring. | [VL.Video.VirtualCamera](https://github.com/bj-rn/VL.Video.VirtualCamera) |
| Who sees it | Windows Camera app, Chrome/Edge, Teams (preview), OBS's DirectShow "Video Capture Device" ([VCamSample](https://github.com/smourier/VCamSample)); "OBS, browsers, the Windows Camera app" ([VL.Video.VirtualCamera](https://github.com/bj-rn/VL.Video.VirtualCamera)); BestCam claims Zoom, Discord, OBS, Teams, Windows Camera ([BestCam](https://github.com/OneLimeStudio/BestCam), project claim). Known bug in VCamSample: Teams shows the preview but "it's not rendered to the communicating party" ([VCamSample](https://github.com/smourier/VCamSample)). | |

Open-source implementations:

| Project | Licence | Release binary | Feedable from another process? |
|---|---|---|---|
| [smourier/VCamSample](https://github.com/smourier/VCamSample) (C++) | MIT | `VCamSample.zip`, v1.0.0.0, 2024-01-22 ([releases API](https://api.github.com/repos/smourier/VCamSample/releases)) | No external frame input found in the README (the sample produces its own frames). **UNVERIFIED.** |
| [smourier/VCamNetSample](https://github.com/smourier/VCamNetSample) (.NET, NativeAOT) | MIT | `VCamNetSampleAOT.x64.zip`, 2025-05-09 ([releases API](https://api.github.com/repos/smourier/VCamNetSample/releases)) | Same as above, **UNVERIFIED.** |
| [bj-rn/VL.Video.VirtualCamera](https://github.com/bj-rn/VL.Video.VirtualCamera) | MIT | No GitHub releases ([releases API](https://api.github.com/repos/bj-rn/VL.Video.VirtualCamera/releases)) | Yes: BGRA/RGBA in, served as RGB32 or NV12. Session-lifetime camera; admin once for `regsvr32`. Build needs .NET SDK (NativeAOT). |
| [OneLimeStudio/BestCam](https://github.com/OneLimeStudio/BestCam) | GPL-2.0 | None | Yes: `Global\BestCam_SharedMem`, NV12. README says it needs Windows 11 22H2 and admin. |

Conclusion: on Windows 11 the MF camera is the more future-proof path (Windows Camera app sees it), but it costs one admin registration and a build of a media source we do not have prebuilt. It does nothing for Windows 10.

---

## 3. macOS

| Requirement | Detail | Source |
|---|---|---|
| Minimum OS | Camera extensions are "available in macOS 12.3 and later." | [Apple: Creating a camera extension](https://developer.apple.com/tutorials/data/documentation/coremediaio/creating-a-camera-extension-with-core-media-i-o.json) |
| Packaging | Extension lives in the app bundle; host app needs the System Extension and App Groups capabilities (`com.apple.developer.system-extension.install`, `com.apple.security.application-groups`). App activates it with `OSSystemExtensionRequest.activationRequest`. | same |
| Location | "Only apps that reside in the `/Applications` directory can activate an extension." | same |
| Approval | "a person with Admin privileges for the Mac must explicitly allow access to it" in System Settings. | same |
| Signing | Activation checks the code signature and that entitlements "match the entitlements granted to your development team." | [Installing System Extensions and Drivers](https://developer.apple.com/tutorials/data/documentation/systemextensions/installing-system-extensions-and-drivers.json) |
| Distribution outside the App Store | Developer ID certificate plus notarization; Apple Developer Program costs "$99 annual membership." | [Apple Developer Program](https://developer.apple.com/programs/) |
| Unsigned / ad-hoc | Only on a developer machine: `systemextensionsctl developer on` lifts the location check, and disabling SIP bypasses notarization checks. Apple: "Disabling validation checks is only appropriate during the development process on your local system." | [Debugging and Testing System Extensions](https://developer.apple.com/tutorials/data/documentation/driverkit/debugging-and-testing-system-extensions.json) |
| Old DAL plug-ins | No longer loaded from macOS Sonoma 14.1 ([Eclectic Light](https://eclecticlight.co/2023/10/27/how-sonoma-14-1-could-stop-your-camera-working/)). | |

What OBS does: OBS 30+ on macOS 13+ ships a camera extension; users approve it under Privacy & Security (macOS 13 to 14) or Login Items & Extensions (macOS 15+) and restart OBS ([OBS KB](https://obsproject.com/kb/virtual-camera-troubleshooting)). Source: [`plugins/mac-virtualcam/src/camera-extension`](https://github.com/obsproject/obs-studio/tree/master/plugins/mac-virtualcam/src) (GPL-2.0).

Third parties can feed OBS's extension. pyvirtualcam finds the device with UID `7626645E-4425-469E-9D8B-97E0FA59AC75` via `CMIOObjectGetPropertyData(kCMIOHardwarePropertyDevices)`, takes the sink stream (index 1, which the code itself calls a guess), gets its queue with `CMIOStreamCopyBufferQueue`, calls `CMIODeviceStartStream`, and enqueues UYVY `CMSampleBuffer`s with `CMSimpleQueueEnqueue` ([virtual_output.hpp](https://github.com/letmaik/pyvirtualcam/blob/main/pyvirtualcam/native_macos_obs_cmioextension/virtual_output.hpp)). All of those are plain C functions; only the pixel-buffer-pool attribute dictionary uses Objective-C literals, which a `CFDictionary` can replace (inference). So koffi could drive it from Node without compiling (inference, **UNVERIFIED in practice**). pyvirtualcam requires OBS 30+ on macOS 13+ ([README](https://github.com/letmaik/pyvirtualcam)).

Open-source camera extension examples: OBS (above); [csuft/cameraextension](https://github.com/csuft/cameraextension) and its fork [ldenoue/cameraextension](https://github.com/ldenoue/cameraextension) (source plus sink stream design; licence **UNVERIFIED**); [below/wwdc22_coremediaio](https://awesome.ecosyste.ms/projects/github.com%2Fbelow%2Fwwdc22_coremediaio) (MIT, reported activation error on 12.4). akvirtualcamera ships a macOS `.run`/`.pkg` installer ([releases](https://github.com/webcamoid/akvirtualcamera/releases)); whether it is a DAL plug-in (dead on 14.1+) or a camera extension: **UNVERIFIED**.

**Can an unsigned open-source project ship its own camera?** No. An end user cannot activate an unsigned or ad-hoc-signed system extension without disabling SIP. **Lightest honest path:** (1) the browser extension covers Meet, Zoom web and Teams web on macOS; (2) for native apps, feed OBS's signed extension (user installs OBS 30+ and approves it once); (3) later, if someone pays for a Developer ID, ship our own camera extension built from Apple's sample.

---

## 4. Linux

**v4l2loopback basics.** GPL-2.0 kernel module; load as root with `modprobe v4l2loopback` and options such as `video_nr=`, `card_label=`, `exclusive_caps=1` ("If you encounter problems detecting your device with Chrome/WebRTC"). Secure Boot may block an unsigned module. Formats can be fixed with `v4l2loopback-ctl set-caps /dev/video0 "UYVY:640x480"`; devices can be added at runtime with `v4l2loopback-ctl add` (examples use `sudo`) ([README](https://github.com/v4l2loopback/v4l2loopback)). Many distros package it as `v4l2loopback-dkms` ([pyvirtualcam README](https://github.com/letmaik/pyvirtualcam)). **Root is needed at least once.**

**Writing frames without compiling:**

- **Pipe to ffmpeg** (simplest): spawn `ffmpeg -f rawvideo -pix_fmt rgba -s 1280x720 -r 30 -i - -f v4l2 -pix_fmt yuv420p /dev/video10` and write frames to stdin. The output half matches the documented `-f v4l2 ... -pix_fmt yuv420p /dev/videoN` usage ([v4l2loopback wiki](https://github.com/v4l2loopback/v4l2loopback/wiki/Ffmpeg)). GStreamer `v4l2sink` also works ([README](https://github.com/v4l2loopback/v4l2loopback)).
- **Direct write from Python:** stdlib `fcntl.ioctl` plus `ctypes.Structure` for `struct v4l2_format`, then `os.write`. No native build (inference; this is how a pure-Python writer would work). The ioctl constant `VIDIOC_S_FMT` must be computed for the target ABI: **UNVERIFIED value, compute from headers**.
- **Direct write from Node:** koffi can declare variadic C functions such as `ioctl` with `'...'` arguments ([koffi: load](https://koffi.dev/load)); frames then go through `fs.writeSync`. Alternatively set caps with `v4l2loopback-ctl set-caps` and skip the ioctl (**UNVERIFIED** that plain `write()` then works without `S_FMT`).
- `/dev/videoN` must be writable by the user (normally the `video` group); **UNVERIFIED** per distro.

**PipeWire without a kernel module.**

- PipeWire supports userspace virtual camera nodes; Laurent Pinchart (libcamera, Ideas on Board) argues they replace v4l2loopback: "The use cases traditionally covered by the v4l2loopback kernel module are now supported in userspace" ([Ideas on Board, 2026-02-02](https://ideasonboard.com/news/pipewire-is-the-new-v4l2loopback); page returned 403 to my fetch, quote taken from search snippet, so **UNVERIFIED wording**). On the kernel list he suggests feeding PipeWire with GStreamer `pipewiresink` ([LKML](https://lkml.iu.edu/hypermail/linux/kernel/2602.0/00337.html)), with a receiver described as `pipewiresink` with `media.class=Video/Source` and `media.role=Camera` ([LKML](https://lkml.iu.edu/2604.0/07886.html)). A follow-up says the setup looked broken in PipeWire 1.6.x ([LKML, 2026-04-06](https://lkml.iu.edu/2604.0/07886.html)).
- **Chrome:** `kWebRtcPipeWireCamera` is `FEATURE_DISABLED_BY_DEFAULT` on current main ([capture_switches.cc](https://github.com/chromium/chromium/blob/main/media/capture/capture_switches.cc)). Users must enable "PipeWire camera support" in `chrome://flags` ([Jan Grulich, Red Hat](https://jgrulich.cz/2024/08/19/making-pipewire-default-option-for-firefox-camera-handling)).
- **Firefox:** `media.webrtc.camera.allow-pipewire`; default on in Fedora 41+ builds ([Jan Grulich](https://jgrulich.cz/2024/08/19/making-pipewire-default-option-for-firefox-camera-handling)).
- **Native apps (Zoom etc.):** need V4L2 unless launched through `pw-v4l2`, an `LD_PRELOAD` layer that "maps PipeWire video devices to be visible to applications using V4L2" ([pw-v4l2 man page](https://docs.pipewire.org/page_man_pw-v4l2_1.html)). That only helps apps we launch ourselves. Zoom's own PipeWire support: **UNVERIFIED**.

Conclusion: ship v4l2loopback as the native-app path (document the one-time `sudo` step) and PipeWire as an optional no-root path for Firefox and flag-enabled Chrome.

---

## 5. Node without a compiler

**koffi.** MIT. "For all fully supported platforms (green check marks), a prebuilt binary is included in the NPM package": Windows x64/ARM64/ia32, Linux glibc and musl x64/ARM64 (plus ARM32, RISC-V and others on glibc), macOS x64/ARM64, FreeBSD, OpenBSD, Android ([koffi.dev](https://koffi.dev/)). Supports `__stdcall` Win32 calls (example loads `user32.dll`) and variadic functions ([koffi: load](https://koffi.dev/load)). Pointers are BigInt; a `void *` return such as `mmap`'s comes back as a pointer value ([koffi: pointers](https://koffi.dev/pointers)). Koffi's repo ships an electron-forge example using `plugin-auto-unpack-natives` ([unpkg: forge.config.js](https://app.unpkg.com/koffi@2.15.0/files/src/koffi/examples/electron-forge/forge.config.js)).

**Electron caveat.** `koffi.view(ptr, len)` maps external memory as an ArrayBuffer, but "Some runtimes (such as Electron) forbid the use of external buffers ... trying to create a view will trigger an exception" ([koffi: pointers](https://koffi.dev/pointers)); Electron 21+ enables the V8 memory cage, and "ArrayBuffers which point to external ("off-heap") memory are no longer allowed" ([Electron blog](https://www.electronjs.org/blog/v8-memory-cage)). Workaround: keep frames in a normal `Uint8Array` and copy into the mapped section by calling a C copy function through koffi (for example `RtlMoveMemory` in kernel32, or `memcpy`), since koffi accepts typed arrays where a pointer is expected ([koffi: pointers](https://koffi.dev/pointers)). One copy of a 1280x720 NV12 frame is about 1.4 MB, 41 MB/s at 30 fps (arithmetic).

**Calls needed per OS (all reachable through koffi, inference):**

- Windows: `CreateFileMappingW` / `OpenFileMappingW`, `MapViewOfFile`, `CreateMutexW`, `WaitForSingleObject`, `ReleaseMutex`, `SetEvent`, `RtlMoveMemory` (kernel32).
- Linux: `open`, `ioctl` (variadic), `write`, or no FFI at all with the ffmpeg pipe.
- macOS: CoreMediaIO, CoreMedia, CoreVideo and CoreFoundation C functions (section 3).

**Existing npm packages.**

| Package | Licence | Status |
|---|---|---|
| [node-virtualcam](https://github.com/letmaik/node-virtualcam) | GPL-2.0 | "work-in-progress. No support is provided"; Windows only; depends on the old separately installed obs-virtual-cam plug-in; builds a native addon (`binding.gyp`) with `windows-build-tools`. Not usable. |
| npm wrappers for softcam, UnityCapture or the OBS 26+ queue | none found | (search: no results) |

Recommendation: write our own ~150-line koffi writers for the OBS queue (Windows) and UnityCapture (Windows), and use the ffmpeg pipe on Linux. Use pyvirtualcam's source as the protocol reference.

---

## 6. Browser camera controls (MediaTrackCapabilities)

Spec facts: `exposureTime` is "in 100 microsecond units" ([Image Capture spec](https://w3c.github.io/mediacapture-image/)). The spec's capability members are whiteBalanceMode, colorTemperature, exposureMode, exposureCompensation, exposureTime, iso, focusMode, focusDistance, brightness, contrast, saturation, sharpness, pan, tilt, zoom, torch. Pan, tilt and zoom need the camera permission with `panTiltZoom: true` (same spec). The spec has no power-line or anti-flicker control (none found in the spec text I read).

### 6.1 Chromium per OS

| Property | Windows MF (default backend) | Windows DirectShow (DirectShow-only devices) | Linux V4L2 | macOS |
|---|---|---|---|---|
| exposureMode | `CameraControl_Exposure` auto/manual flag | same | `V4L2_CID_EXPOSURE_AUTO` (continuous = APERTURE_PRIORITY) | Behind `kExposeAllUvcControls` (off) |
| exposureTime | `CameraControl_Exposure`, log2 seconds converted to 100 µs | same | `V4L2_CID_EXPOSURE_ABSOLUTE`, passed through (already 100 µs) | Behind flag; UVC value passed through |
| exposureCompensation | **`VideoProcAmp_Gain`** (that is, gain) | not implemented | `V4L2_CID_AUTO_EXPOSURE_BIAS` | not implemented |
| iso | empty range | empty range | empty range | no |
| brightness, contrast, saturation, sharpness | VideoProcAmp | VideoProcAmp | `V4L2_CID_BRIGHTNESS` etc. | Behind flag |
| whiteBalanceMode, colorTemperature | `VideoProcAmp_WhiteBalance` | same | `V4L2_CID_AUTO_WHITE_BALANCE`, `V4L2_CID_WHITE_BALANCE_TEMPERATURE` | Behind flag |
| focusMode, focusDistance | `CameraControl_Focus` | same | `V4L2_CID_FOCUS_AUTO`, `V4L2_CID_FOCUS_ABSOLUTE` | Behind flag |
| zoom, pan, tilt | `CameraControl_Zoom/Pan/Tilt` | same | `V4L2_CID_ZOOM/PAN/TILT_ABSOLUTE` | **Yes by default** (UVC) |
| torch | hardcoded false | false | false | not handled |
| gain (as such) | only via exposureCompensation | no | `V4L2_CID_GAIN` not used | no |
| Background blur, face framing, eye gaze | Yes, via `KSPROPERTY_CAMERACONTROL_EXTENDED_*` | no | no | Background blur reflects Apple Portrait effect (read only) |
| Power line frequency | **Not set** (no reference in the file) | Set at start via `KSPROPERTY_VIDEOPROCAMP_POWERLINE_FREQUENCY` (50 Hz = 1, 60 Hz = 2) | Set at start via `V4L2_CID_POWER_LINE_FREQUENCY` | Set at start via UVC `kPuPowerLineFrequencyControl` |

Sources: Windows MF [video_capture_device_mf_win.cc](https://github.com/chromium/chromium/blob/main/media/capture/video/win/video_capture_device_mf_win.cc); Windows DirectShow [video_capture_device_win.cc](https://github.com/chromium/chromium/blob/main/media/capture/video/win/video_capture_device_win.cc) (`GetPhotoState` gated by `kDirectShowGetPhotoState`, enabled by default, [media_switches.cc](https://github.com/chromium/chromium/blob/main/media/base/media_switches.cc)); Linux [v4l2_capture_delegate.cc](https://github.com/chromium/chromium/blob/main/media/capture/video/linux/v4l2_capture_delegate.cc); macOS [uvc_control_mac.mm](https://github.com/chromium/chromium/blob/main/media/capture/video/mac/uvc_control_mac.mm) (`BASE_FEATURE(kExposeAllUvcControls, base::FEATURE_DISABLED_BY_DEFAULT)`, added after crashes with "exotic camera devices", [commit a2dbd20](https://chromium.googlesource.com/chromium/src/+/a2dbd2045d6825aeb9e72c6d9dc8bbeae325cf05)) and [video_capture_device_apple.mm](https://github.com/chromium/chromium/blob/main/media/capture/video/apple/video_capture_device_apple.mm). The power-line value is the requested one if 50 or 60 Hz, otherwise derived from the timezone's country (44 countries mapped to 60 Hz) ([video_capture_device.cc](https://github.com/chromium/chromium/blob/main/media/capture/video/video_capture_device.cc)). The "not set" cell for MF is from searching the whole MF file for PowerLine/power_line/POWERLINE/flicker with no match; a call elsewhere in the MF path is **UNVERIFIED**.

### 6.2 Exposure time units and our camera

- Windows stores exposure as log2 seconds: -7 = 1/128 s, -4 = 1/16 s ([KSPROPERTY_CAMERACONTROL_EXPOSURE](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/ksproperty-cameracontrol-exposure)).
- Chromium converts with `exp2(log_seconds) * kSecondsTo100MicroSeconds` and back with `long CaptureExposureTimeToPlatformValue(double h) { return std::log2(h / kSecondsTo100MicroSeconds); }`; the step is `(exp2(log_step) - 1) * min` ([video_capture_device_utils_win.cc](https://github.com/chromium/chromium/blob/main/media/capture/video/win/video_capture_device_utils_win.cc)).
- V4L2 and UVC both use 100 µs units: "Drivers should interpret the values as 100 µs units" ([V4L2 camera controls](https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/ext-ctrls-camera.html)).
- Our test camera (1/1024 s to 1/16 s in powers of two, Windows values -10 to -4) should therefore report `exposureTime` min 9.765625, max 625, step 9.765625 (arithmetic from the formulas above). Because the result of `log2` is converted to `long`, which truncates toward zero, a requested 50 (5 ms, log2 = -7.64) becomes -7 = 1/128 s = 7.8 ms. **Always request exact powers of two** (inference from the code).
- Windows `exposureCompensation` actually drives gain (table above), so a UI slider labelled "exposure compensation" will change gain on Windows and AE bias on Linux.

### 6.3 Other browsers and embedders

- **Firefox:** its `MediaTrackSupportedConstraints` IDL has no image-capture members (no zoom, torch, exposure, white balance, brightness) ([Gecko IDL mirror](https://github.com/mozilla/gecko-dev/blob/master/dom/webidl/MediaTrackSupportedConstraints.webidl); the GitHub mirror may lag current Firefox, **UNVERIFIED for the newest release**).
- **Safari/WebKit:** supports `whiteBalanceMode`, `zoom`, `torch`, `backgroundBlur`, `powerEfficient`; `focusDistance` is a FIXME ([WebKit IDL](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediastream/MediaTrackSupportedConstraints.idl)). No exposure, brightness or ISO. On macOS desktop these mostly matter for iPhone Continuity cameras (**UNVERIFIED**).
- **Electron and WebView2:** same Chromium capture code (`media/capture`), so the same table applies (inference). Electron on macOS needs `NSCameraUsageDescription` and `systemPreferences.askForMediaAccess` ([Electron docs](https://www.electronjs.org/docs/latest/api/system-preferences)). WebView2 host must handle the permission request (**UNVERIFIED** detail).

---

## 7. Browser extension camera replacement (MV3)

### 7.1 Technique

1. **Manifest:** a content script with `"world": "MAIN"`, `"run_at": "document_start"`, `"all_frames": true`, `"match_about_blank": true` (and `"match_origin_as_fallback": true` for `blob:`/`about:` frames). `world` is supported in Chrome 111, Firefox 128, Safari 18; `match_origin_as_fallback` in Chrome 99, Firefox 128, Safari 18.4 ([BCD content_scripts](https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/content_scripts.json)). MAIN-world scripts have no extension APIs, and the page "can detect and interfere with the executed code" ([MDN content_scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts)). Pair it with an ISOLATED-world script for `chrome.storage` and settings, as [spite/virtual-webcam](https://github.com/spite/virtual-webcam) does (its manifest has one MAIN and one ISOLATED entry, both `document_start`, `all_frames`, `match_about_blank`).
2. **Override** `MediaDevices.prototype.getUserMedia` and `enumerateDevices`: call the real `getUserMedia`, keep audio tracks untouched, replace the video track with a processed one, and add a virtual entry to the device list. Injecting at `document_start` matters: a late hook misses Google Meet, which requests the camera on page load ([mganeko/chrome_virtual_camera](https://github.com/mganeko/chrome_virtual_camera), [mganeko/chrome_audio_mix](https://github.com/mganeko/chrome_audio_mix)).
3. **Processing pipeline (Chrome):** `MediaStreamTrackProcessor` (camera frames as `VideoFrame`) -> WebGL2/WebGPU -> `MediaStreamTrackGenerator`. Chrome ships `MediaStreamTrackProcessor` since 94 but "Exposed on `Window` instead of `DedicatedWorker`" (partial) ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/MediaStreamTrackProcessor.json)); the standard worker-only `VideoTrackGenerator` is Safari 18 only, not Chrome or Firefox ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/VideoTrackGenerator.json)). spite/virtual-webcam uses exactly `MediaStreamTrackProcessor` + shaders + `MediaStreamTrackGenerator` ([README](https://github.com/spite/virtual-webcam)).
4. **Fallback (Firefox, old Chrome):** draw into a canvas and return `canvas.captureStream()`; the fallback is what [pymikofficial/virtual-background-extension](https://github.com/pymikofficial/virtual-background-extension) uses.

### 7.2 Pitfalls

- **Background tabs.** `requestAnimationFrame` "will wait for the page to be visible"; hidden-page timers run once per second, or once per minute after 5 minutes unless the page made sound in the last 30 s or has an `RTCPeerConnection` with a live track ([Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)). A canvas loop driven by rAF therefore freezes when the user switches tabs mid-call ([mganeko README](https://github.com/mganeko/chrome_virtual_camera) reports this; spite reports filters freezing in Firefox background tabs, [README](https://github.com/spite/virtual-webcam)). **Fix:** drive the loop from the `MediaStreamTrackProcessor` reader (camera frame cadence), never from rAF or `setTimeout`.
- **CSP.** The MAIN-world override is "subject to that page's Content Security Policy, not the extension's"; dynamic `import()` or `fetch()` of WASM/model files could be blocked ([pymikofficial README](https://github.com/pymikofficial/virtual-background-extension)). spite moves ML and JS effects into a sandboxed extension page in a hidden frame, passing frames as `ImageBitmap`, with `'wasm-unsafe-eval'` in the extension's own sandbox CSP and model files listed as `web_accessible_resources` ([README](https://github.com/spite/virtual-webcam), [manifest](https://github.com/spite/virtual-webcam/blob/master/manifest.json)). Shader-only processing needs no WASM and runs in the page (same source). Our WebGL2 core fits the in-page case; any ML model belongs in the extension frame.
- **Track identity.** Some apps run device checks "that don't expect a virtual camera" ([spite README](https://github.com/spite/virtual-webcam)); [xViada/VCam-Bypass](https://github.com/xViada/VCam-Bypass) (GPL-3.0) patches `getSettings()` and `getCapabilities()` plus `label`, `deviceId`, `groupId` for that reason. A `MediaStreamTrackGenerator` track or canvas track will not report the physical camera's `deviceId` unless we wrap those methods (inference). `applyConstraints` on a generated track and `clone()` behaviour per app: **UNVERIFIED**, test on Meet, Zoom web, Teams web.
- **Iframes.** Inject in all frames (`all_frames`, `match_about_blank`, `match_origin_as_fallback`). Which frame Zoom web or Teams web calls `getUserMedia` from: **UNVERIFIED**. Firefox does not inject into empty iframes at `document_start` ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts)).
- **Scene switching without new tracks:** spite updates "all streams without changing the app's track" ([README](https://github.com/spite/virtual-webcam)); apps such as Meet hold on to the first track, so keep one generator track per stream.

### 7.3 Firefox MV3 differences

- `world: "MAIN"` from Firefox 128 ([BCD](https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/content_scripts.json)).
- No `MediaStreamTrackProcessor` or `VideoTrackGenerator` ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/MediaStreamTrackProcessor.json), [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/VideoTrackGenerator.json)); `VideoFrame.copyTo` from Firefox 130 ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/VideoFrame.json)). So Firefox needs the canvas `captureStream` path and will freeze in background tabs.
- Sandboxed extension pages are not supported, so spite's ML/JS effects do not run in Firefox ([README](https://github.com/spite/virtual-webcam)).
- No image-capture camera controls (section 6.3).

### 7.4 Open-source extensions to study

| Repo | Licence | Why study it |
|---|---|---|
| [spite/virtual-webcam](https://github.com/spite/virtual-webcam) | README says CC-BY-4.0; GitHub API reports no licence file ([API](https://api.github.com/repos/spite/virtual-webcam)). CC-BY is not a code licence: read, do not copy. | Best design found: MV3, MAIN + ISOLATED, MSTP + MSTG, sandboxed frame for ML, tested on Google Meet. Active (pushed 2026-10-10). |
| [pymikofficial/virtual-background-extension](https://github.com/pymikofficial/virtual-background-extension) | MIT (MediaPipe parts Apache-2.0) | MAIN-world `getUserMedia` override with canvas `captureStream`; honest CSP notes. Not yet tested on Meet or Zoom per its README. |
| [mganeko/chrome_virtual_camera](https://github.com/mganeko/chrome_virtual_camera) | MIT (tfjs Apache-2.0) | Small; documents the late-hook and hidden-tab failures. |
| [xViada/VCam-Bypass](https://github.com/xViada/VCam-Bypass) | GPL-3.0 with extra terms | Shows the full set of identity surfaces to patch (`enumerateDevices`, legacy gUM, `getSettings`, `getCapabilities`). |
| [unixpickle/camera-hijack](https://github.com/unixpickle/camera-hijack) | not stated on the page | Minimal per-frame canvas hook. |

---

## 8. Desktop shell: Electron vs Tauri

| Factor | Electron | Tauri |
|---|---|---|
| Build on our dev machine today | npm only (inference: Electron is distributed as prebuilt binaries) | "Tauri is built with Rust and requires it for development", plus Microsoft C++ Build Tools on Windows ([prerequisites](https://v2.tauri.app/start/prerequisites/)). **Not buildable here.** |
| Engine per OS | Chromium everywhere | WebView2 (Chromium) on Windows, WKWebView on macOS, WebKitGTK on Linux ([webview versions](https://v2.tauri.app/reference/webview-versions/)) |
| Camera in the webview | Same as Chrome; macOS needs Info.plist strings ([Electron](https://www.electronjs.org/docs/latest/api/system-preferences)) | Linux: WebKitGTK gates media behind `enable-media-stream`, "off by default", and denies unhandled permission requests ([block/buzz PR](https://github.com/block/buzz/pull/2771)); a Tauri maintainer: "Linux (webkitgtk) does not support webrtc at all yet" (2024, [tauri#2600](https://github.com/tauri-apps/tauri/issues/2600)). macOS: permission quirks needing wry patches (same issue). |
| Image-capture camera controls | Full Chromium table (section 6) | Windows same as Chromium; macOS WebKit subset; Linux **UNVERIFIED** |
| `MediaStreamTrackProcessor` / `VideoFrame.copyTo` RGB | Chrome 94 / 127 ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/MediaStreamTrackProcessor.json), [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/VideoFrame.json)) | WKWebView needs Safari 18 for MSTP (worker only); `copyTo` `format` not in Safari ([BCD](https://github.com/mdn/browser-compat-data/blob/main/api/VideoFrame.json)) |
| WebGPU | Chrome 113+ on Windows/macOS; Linux since 144, Intel Gen12+ only ([BCD GPU](https://github.com/mdn/browser-compat-data/blob/main/api/GPU.json)) | Safari 26 for WKWebView-era WebKit ([BCD GPU](https://github.com/mdn/browser-compat-data/blob/main/api/GPU.json)); WebKitGTK **UNVERIFIED** (assume none). WebGL2 everywhere is the safe baseline. |
| Memory (empty app, release) | Windows ~279 MB, macOS ~370 MB, Linux ~596 MB | Windows ~312 MB, macOS ~96 MB, Linux ~94 MB ([benchmark repo](https://github.com/Elanis/web-to-desktop-framework-comparison); versions and dates not stated there) |
| Keep rendering when hidden or minimised | `backgroundThrottling: false` stops throttling of "animations and timers" and also affects the Page Visibility API ([webPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences)); a fix also keeps the compositor producing frames when hidden ([Electron #38924 mirror](https://ayakael.net/mirrors/electron/commit/2190793fe6351e50940dec077907eaac1f16471c)). `paintWhenInitiallyHidden` keeps a `show:false` window's renderer active ([BrowserWindow options](https://www.electronjs.org/docs/latest/api/structures/browser-window-options)). Best: drive frames from `MediaStreamTrackProcessor`, not rAF. | Per webview, **UNVERIFIED** |
| Frames to native memory | Renderer: MSTP -> process -> `new VideoFrame(canvas)` -> `copyTo(buf, {format:'RGBA'\|'BGRA'})` (Chrome 127+) or native NV12 -> MessagePort to main or a preload with Node -> koffi copy into the shared section (section 5). GPU zero-copy (`offscreen.useSharedTexture`) "requir[es] a native node module" ([Electron OSR](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)), so not for us now. | Same web side, then a Rust command; requires Rust. |

Avoid WebGL `readPixels` in the hot loop: it is synchronous (well-known GPU stall; no source checked here, **UNVERIFIED** magnitude). `copyTo` returns a Promise ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/copyTo)).

**Recommendation: Electron.** It is the only option we can build on this machine today; it gives identical capture, controls and WebCodecs behaviour on all three OSes, which matches the shared web core; and koffi (prebuilt, MIT, Electron example in its repo) covers the native writes. Revisit Tauri only if memory becomes a user complaint and someone installs Rust, and even then Linux camera access in WebKitGTK is the blocker.

---

## 9. Native UVC control beyond the browser

| Control | Windows | Linux (V4L2) | macOS |
|---|---|---|---|
| Power line frequency | `KSPROPERTY_VIDEOPROCAMP_POWERLINE_FREQUENCY` (id 13): 0 off, 1 = 50 Hz, 2 = 60 Hz, 3 = auto ("not available on all cameras (UVC 1.1 specifically)") ([MS docs](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/ksproperty-videoprocamp-powerline-frequency)) | `V4L2_CID_POWER_LINE_FREQUENCY`: 0 off, 1 = 50 Hz, 2 = 60 Hz, 3 = auto ([V4L2 user controls](https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/control.html)) | UVC Processing Unit `kPuPowerLineFrequencyControl` over IOKit, as Chrome does ([uvc_control_mac.mm](https://github.com/chromium/chromium/blob/main/media/capture/video/mac/uvc_control_mac.mm)) |
| Auto-exposure priority (frame rate may drop in low light) | `KSPROPERTY_CAMERACONTROL_AUTO_EXPOSURE_PRIORITY` (id 19): 0 constant frame rate, 1 variable; only valid in auto-exposure; maps to "Low-Light Compensation" ([MS docs](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/ksproperty-cameracontrol-auto-exposure-priority)) | `V4L2_CID_EXPOSURE_AUTO_PRIORITY`, default 0 ([V4L2 camera controls](https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/ext-ctrls-camera.html)) | UVC Camera Terminal control; Chrome does not use it. Any library: **UNVERIFIED** |
| Gain | `VideoProcAmp_Gain` (also what Chrome calls exposureCompensation on MF) ([Chromium MF](https://github.com/chromium/chromium/blob/main/media/capture/video/win/video_capture_device_mf_win.cc)) | `V4L2_CID_GAIN`, `V4L2_CID_AUTOGAIN` ([V4L2 user controls](https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/control.html)) | UVC PU gain; not in Chrome |
| Exposure | log2 seconds ([MS docs](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/ksproperty-cameracontrol-exposure)) | `V4L2_CID_EXPOSURE_ABSOLUTE`, 100 µs; `V4L2_CID_EXPOSURE_AUTO` (manual, auto, shutter priority, aperture priority) ([V4L2 camera controls](https://www.kernel.org/doc/html/latest/userspace-api/media/v4l/ext-ctrls-camera.html)) | UVC CT exposure time absolute |

**Windows.** `IAMVideoProcAmp` and `IAMCameraControl` work on DirectShow filters, and Chromium also obtains them from the Media Foundation source ([Chromium MF](https://github.com/chromium/chromium/blob/main/media/capture/video/win/video_capture_device_mf_win.cc)); your existing PowerShell `Add-Type` C# helper (ids 13 and 19 confirmed on the test laptop) is the right shape. It compiles with the in-box .NET Framework `csc.exe` (present on the dev laptop), so no SDK install. Whether settings persist after Chrome reopens the camera, and whether they can be changed while Chrome is streaming: **UNVERIFIED**, test on the laptop. Note Chrome's MF path does not set power-line frequency (section 6.1), so our setting should stick unless the driver resets it (**UNVERIFIED**).

**Linux.** `v4l2-ctl -d /dev/videoN -l` lists controls and `-c name=value` sets them (v4l-utils; control names vary by kernel, list first, **UNVERIFIED** exact names). Or Python stdlib `fcntl.ioctl(VIDIOC_S_CTRL)`, no compile. [cameractrls](https://github.com/soyersoyer/cameractrls) is a standalone Python CLI/GUI that sets V4L2 controls and vendor extension units (licence not shown on the README page, **UNVERIFIED**).

**macOS.** There is no public AVFoundation API for these on macOS (**UNVERIFIED**; Chrome resorts to IOKit USB requests, which supports the point, [uvc_control_mac.mm](https://github.com/chromium/chromium/blob/main/media/capture/video/mac/uvc_control_mac.mm)). Libraries: [jtfrey/uvc-util](https://github.com/jtfrey/uvc-util) (MIT, IOKit, "all Terminal and Processing Unit controls available under the 1.1 standard", source only, gcc build); [joelpurra/uvcc](https://github.com/joelpurra/uvcc) (GPL-3.0, Node CLI/library; tested with Logitech C920/C922, Elgato Facecam, LifeCam Studio). Known risk: on macOS 12, `USBInterfaceOpen` from IOKit returns `e00002c5` for UVC property access ([Apple forums](https://developer.apple.com/forums/thread/685707)); a libusb approach reportedly sends control requests without claiming the interface even while AVFoundation streams (macuvc on PyPI, page did not load for me, **UNVERIFIED**). Chrome's own UVC control path works only for USB devices it can find by vendor and product ID (same Chrome file).

---

## 10. Things to verify by experiment (ordered)

1. Per-user HKCU registration of UnityCapture on Windows 10 (section 1.4), including the OBS shadowing question and 32-bit apps.
2. Writing the OBS `OBSVirtualCamVideo` queue from Electron main via koffi while OBS is closed; check Chrome, Zoom, Teams, Discord.
3. Chrome `exposureTime` range and snapping on the test laptop (expect 9.77 to 625).
4. Whether a UVC power-line setting from our C# helper survives Chrome opening the camera through MF.
5. Extension on Meet, Zoom web, Teams web: frame which calls `getUserMedia`, `getSettings().deviceId` expectations, background-tab behaviour with the MSTP loop.
6. macOS: feeding OBS's camera extension via koffi and CoreMediaIO (needs a Mac).
