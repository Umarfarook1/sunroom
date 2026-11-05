# 01. Landscape: tools that make a weak webcam look better

Research date: 2026-11-06. Scope: desktop apps, OS features, meeting-app features, browser extensions and open-source projects that improve webcam image quality or expose webcam controls, plus user complaints, the gap, and a name check.

Method and limits:

- Sources are vendor docs, GitHub (repos and issues, read with `gh`), the OBS forum, vendor community forums, Hacker News and Chrome Web Store listings. Every claim has a source link (`[rN]`, list at the end).
- Reddit blocks the crawler this research used. One Reddit thread is quoted from an archive snapshot and is marked as anecdotal. All other complaint evidence comes from non-Reddit forums.
- "UNVERIFIED" means I could not confirm the claim from a primary or reliable source. Prices that come only from third-party listings are marked UNVERIFIED.
- Star counts, licences and last-push dates for GitHub repos come from the GitHub API on 2026-11-06.

---

## Summary: the five most important findings

1. **Every strong automatic enhancer is gated by hardware, by one meeting app, or by a paywall.** NVIDIA Broadcast needs an RTX 2060 or better and runs on Windows only [r13]. Its relighting effect needs an RTX 3060 or better [r13]. Windows Studio Effects needs an NPU, the full set needs a Copilot+ PC with more than 40 TOPS, and Portrait light runs only on Snapdragon Copilot+ PCs [r18]. Apple Studio Light needs an Apple-silicon laptop's built-in camera or an iPhone used as a webcam [r42]. Zoom, Meet and Teams fixes work only inside their own app [r62][r67][r69]. Meet's "studio look", the feature aimed at low light and low-quality webcams, needs a paid plan [r68].
2. **No tool fixes the camera at the hardware layer automatically.** Tools that expose UVC controls (exposure, gain, white balance, anti-flicker) are all manual: cameractrls, guvcview and v4l2-ctl on Linux [r48][r49][r50], CameraController and Webcam Settings on macOS [r45][r44], Webcamoid [r37]. The vendor apps work only with that vendor's cameras (Logitech, Elgato, Dell) [r33][r30][r35]. Nothing detects the mains frequency, sets anti-flicker, or caps exposure time to protect the frame rate on its own. Browser extensions cannot do this at all: the web camera API has no power-line-frequency control, and the W3C proposal to add one has been open since 2022 [r61].
3. **Low frame rate in dim light is a known and silent failure.** Framework's staff say "the default behavior is auto-framerate to handle low lighting conditions", and a user saw 10 fps indoors [r72]. Vendor docs call this "AE priority": the camera lowers the frame rate to gather more light [r74]. Forum fixes are manual (turn off low-light compensation, set exposure by hand) [r76][r75].
4. **The only free, cross-platform low-light filter lives inside OBS and is hard to install.** obs-backgroundremoval (4.7k stars, GPL-3.0) has a neural low-light "Enhance" filter [r1][r3]. To use it you install OBS, then the plugin, then add the filter, then start the virtual camera. Its two most-discussed install issues are "filter does not appear" reports with 33 and 22 comments [r5][r6]. Forum users report heavy CPU load from the plugin [r4].
5. **The well-known low-light models are licensed for non-commercial use only.** Zero-DCE and Zero-DCE++ are CC BY-NC 4.0, "for academic research purpose only" [r83][r84]. SCI has no licence file [r85]. A permissively licensed open-source app cannot ship these models. It must use classical image processing or permissively licensed models, such as IAT (Apache-2.0) [r86].

---

## 1. Comparison table

Legend: **Y** = yes, **P** = partial, **N** = no, **?** = UNVERIFIED. "Auto" means the tool improves the picture without the user moving sliders. "UVC hw" means it changes settings inside the camera (exposure, gain, white balance, anti-flicker).

### 1a. Desktop apps, plugins and OS features

| Tool | Platforms | Price / licence | Auto? | UVC hw | Face-aware AE | Low-light | Denoise | Sharpen / deblock | Relight | Virtual cam | Needs | Main weakness | Sources |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OBS Studio (core) | Win, mac, Linux | Free, GPL-2.0 | N | ? | N | N | N | ? | N | Y | Linux: v4l2loopback; mac 13+: approve a camera extension | Users describe a steep learning curve; the virtual camera outputs the whole scene | [r7][r94][r95] |
| obs-backgroundremoval "Enhance" filter | Win, mac, Linux (inside OBS) | Free, GPL-3.0 | P (filter on/off) | N | N | Y (neural models) | N | N | N | via OBS | No GPU needed; GPU optional | Install friction; CPU load; low-light quality undocumented | [r1][r2][r3][r4][r5][r6] |
| OBS native NVIDIA filters | Windows | Free | N | N | N | N | N | N | N | via OBS | RTX GPU + NVIDIA Video Effects SDK | Background blur/removal only | [r8][r9] |
| StreamFX (OBS plugin) | Windows for NVIDIA features | Paid (patron access) | N | N | N | N | ? | ? | N | via OBS | NVIDIA Maxine SDKs, now hard to obtain | Paywalled; SDK links reported 404 | [r10][r11][r12] |
| NVIDIA Broadcast | Windows 10/11 64-bit, Windows on Arm | Free | P (effects auto once on) | N | N | P | Y (Video Noise Removal) | P (Super Resolution, beta) | Y (Virtual Key Light) | Y | RTX 2060+; Key Light RTX 3060+; 8 GB RAM | NVIDIA RTX only; GPU load | [r13][r14][r15][r16] |
| Windows Studio Effects | Windows 11 with NPU | Free with hardware | P (toggles) | N | N | P (Portrait light) | N | N | Y (Snapdragon Copilot+ only) | N (works at OS level in all apps) | NPU; full set needs a Copilot+ PC (>40 TOPS) | Hardware-gated; USB-webcam support only since 2025 Insider builds | [r18][r19][r20] |
| Windows 11 camera settings page | Windows 11 | Free | N | P (brightness maps to EV compensation) | N | N | N | P (sharpness slider) | N | N | Windows 11 | Manual; only controls the driver exposes | [r21][r104] |
| Camo Studio (Reincubate) | Win 10+, macOS 12.3+ | Free tier (720p); Pro paid, price not shown on pricing page | P | Y (exposure, ISO/gain, WB, anti-flicker on supported devices) | P (Spotlight brightens subject; Pro) | P (Spotlight) | P (Retouch "reducing visual noise") | P (sharpness slider) | P (Spotlight) | Y | None stated | Best features behind Pro; phone-first product | [r22][r23][r24] |
| FineCam (FineShare) | Windows; Mac "on its way" | Freemium; 1-yr $29.99, lifetime $49.99 (UNVERIFIED, third-party) | P (AI background only) | ? | N | ? (claimed by third parties) | ? | ? | N | Y | Uses "dedicated GPU hardware" | Windows only today; brightness is a manual slider | [r25][r26] |
| ManyCam | Win, mac | Free with watermark; Standard $49/yr, Premium $99/yr (UNVERIFIED, Capterra) | N | ? | N | N | N | N | N | Y | ? | Watermark; no image-repair features listed | [r27][r28] |
| XSplit VCam | Win, mac | Free with watermark; Personal, Business, Lifetime | P | ? | ? | P ("studio lighting effects", unspecified) | ? | ? | P | Y | "NPU-optimized models" | Watermark; lighting feature not described | [r29] |
| Elgato Camera Hub | Win, mac | Free | P (auto toggles) | Y (AE, shutter, WB, anti-flicker 50/60/off) | N | N | Y (2D/3D, Facecam only) | ? | N | N | Elgato cameras; some Corsair laptop cameras | Brand-locked | [r30][r31][r32] |
| Logitech Logi Options+ / Logi Tune / G HUB | Win, mac | Free | P (presets) | Y (AE, shutter/ISO, WB, low-light compensation, anti-flicker, frame rate vs exposure on some models) | N | P (low-light compensation, in camera) | N | N | N | N | Logitech webcams | Brand-locked; three overlapping apps | [r33][r34] |
| Dell (Display and) Peripheral Manager | Win, mac | Free | P | Y (HDR, AWB, brightness, sharpness) | Y (FDAE, in the camera hardware) | N | N | P | N | N | Dell webcams; HDR and AI framing need USB 3.0 | Brand-locked | [r35][r36] |
| Webcamoid | Linux, Win, mac, Android, FreeBSD | Free, GPL-3.0 | N | Y (per-camera controls) | N | N | N | N | N | Y on Linux and Windows only | None | Manual; 60+ effects but no low-light or denoise listed; no mac virtual cam | [r37] |
| Snap Camera | was Win, mac | Shut down 25 Jan 2023 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Discontinued | [r38] |
| mmhmm, now Airtime Camera | mac, web (Windows UNVERIFIED) | 14-day trial, then one-time fee (amount not on page) | ? | N | ? | ? | ? | ? | ? | Y | ? | Presentation and branding tool, not image repair | [r39] |
| PRISM Live Studio + PRISM Lens | Windows (mac UNVERIFIED) | Free | N | P ("Advanced Camera Settings") | N | ? | ? | ? | N | Y | ? | Beauty and colour filters, not repair | [r40][r41] |
| Lumina Studio (for the Lumina webcam) | Win 10+, Intel and Apple-silicon mac | Free with the camera | P | Y | ? | ? | ? | Y | N | Y | Lumina webcam | Tied to one camera; reviewers report high CPU use | [r46][r47][r73] |

### 1b. Built-in features of meeting apps and operating systems

| Feature | Where | Price | Auto? | What it does | Limits | Sources |
|---|---|---|---|---|---|---|
| Zoom "Adjust for low light" | Zoom desktop client | Free | Y (Auto is the default; Manual slider) | Brightens video in dim rooms | Zoom only; a user with a washed-out face had to use the camera's own software because Zoom has no brightness reduction | [r62][r63][r64] |
| Zoom "Touch up my appearance" | Zoom | Free | Slider | Skin softening | Zoom only | [r62] |
| Zoom "Optimize video quality with de-noise" | Zoom advanced video settings | Free | Toggle | Denoise | Users reported distorted video; turning it off was the workaround | [r65] |
| Google Meet "Adjust video lighting" | Meet on desktop, iPhone, iPad | Free | Y (Meet detects underexposure) | Brightens underexposed video | Meet only; "Enabling light adjustment may slow down your device"; needs WebGL and hardware acceleration | [r67] |
| Google Meet "Portrait touch-up" | Meet | Depends on edition | Subtle / Smooth | Skin smoothing, eye brightening | Edition-gated | [r67] |
| Google Meet "Studio lighting" | Meet | Eligible Workspace or Google AI plan | Auto or Custom | Simulated studio light | CPU at least Intel Core i9-9880H class or Apple M1 | [r68] |
| Google Meet "Studio look" | Meet | Eligible Workspace or Google AI plan | Y | "fix issues caused by low light or low quality webcams" | Runs in the cloud; paid | [r68] |
| Microsoft Teams "Adjust brightness", "Soft focus", "Automatically adjust camera controls" | Teams desktop | Free | P | Brightness for low light; smoothing | Microsoft's page says "only available for Microsoft Teams for personal use on desktop" | [r69] |
| ChromeOS "Improve lighting" | Chromebook Plus | Free with device | Toggle | Evens face lighting; works across calling apps | ChromeOS on Chromebook Plus only | [r70] |
| macOS Studio Light, Portrait, Center Stage | macOS Sonoma+ | Free with device | Toggle | Dims background, lights face | Built-in camera of an Apple-silicon laptop, or iPhone 12+ via Continuity Camera; third-party USB webcams not listed | [r42] |

### 1c. Browser extensions (Meet, Zoom web, Teams web)

| Extension | What it does | Auto? | Price | Size / rating | Sources |
|---|---|---|---|---|---|
| Visual Effects for Google Meet | Fun effects (fireworks, dog ears, black-and-white) | N | Free | ? | [r55] |
| Visual Effects, Stickers, Mirror for Google Meet, Zoom, Teams | Brightness, contrast, zoom, colour filters, AI blur | N (sliders) | ? | ? | [r56] |
| LookGood Live | "enhances lighting to brighten your video, even in dark or low-light settings", plus sharpening | ? | Free features; premium removes watermark | about 6,000 users, 3.5/5 from 34 ratings, updated 18 May 2026 | [r57] |
| Candela, Edge Light for video calls, LumiFrame | Screen-edge "ring light": the monitor lights your face; video is not processed | N | Free | Candela: 15 users | [r58][r59] |
| GlowCam (Imagera AI) | Skin retouch, makeup, brightness/contrast sliders, background | N | $24.99/month or $249.99/year after a 7-day trial | ? | [r60] |

All extensions share two hard limits. They work only in browser calls, not in the desktop Zoom or Teams apps. They cannot change camera hardware settings: there is no power-line-frequency constraint in `getUserMedia`, and Chrome's old non-standard `googPowerLineFrequency` constraint "went AWOL" [r61].

### 1d. macOS and Linux utilities

| Tool | Platform | Licence / price | What it does | Auto? | Weakness | Sources |
|---|---|---|---|---|---|---|
| Hand Mirror | macOS 14.4+ | Free, optional Plus purchase | One-click camera preview in the menu bar | n/a | Preview only; changes nothing | [r43] |
| Webcam Settings (Mactaris) | macOS | $7.99 | UVC exposure, gain, WB, focus, zoom | N | Reviews: all controls greyed out on an M1 MacBook Pro; settings not kept | [r44] |
| CameraController | macOS 10.15+ | Free, GPL-3.0, 1.7k stars, last push 2025-04 | UVC exposure, brightness, contrast, saturation, sharpness, WB | N (some controls can stay on auto) | Built-in cameras on T1/T2 Macs need an Apple-only entitlement | [r45] |
| cameractrls | Linux | Free, LGPL-3.0, 961 stars | V4L2 controls GUI/CLI, vendor extensions, presets, a daemon that restores presets on connect | N | Manual | [r48] |
| guvcview | Linux | Free, GPLv2, updated 2026-10-03 | Capture app with camera control tabs | N | Manual | [r49] |
| v4l2-ctl | Linux | Free (v4l-utils) | CLI for every V4L2 control, for example `power_line_frequency` (0 off, 1 50 Hz, 2 60 Hz, auto on newer kernels) | N | Manual | [r50] |
| backscrub | Linux | Apache-2.0, 748 stars, last push 2023-01 | Background replacement to v4l2loopback | Y (segmentation) | 640x480 hardcoded; no lighting features | [r51] |
| Linux-Fake-Background-Webcam | Linux | GPL-3.0, 1.7k stars | Background blur/replace with MediaPipe; v4l2loopback or akvcam | Y (segmentation) | Kernel module may need Secure Boot off; no lighting features | [r52] |

### 1e. Open-source low-light projects and building blocks

| Project | What it is | Licence | Fit for a shipped app | Sources |
|---|---|---|---|---|
| obs-backgroundremoval Enhance | Low-light filter with TBEFN, URetinex-Net, Semantic-Guided LLIE and Zero-DCE models from PINTO's model zoo | GPL-3.0 (model licences UNVERIFIED) | Only inside OBS | [r1][r3] |
| Zero-DCE / Zero-DCE++ | Tiny curve-estimation low-light networks; one port reports 1000 / 11 FPS GPU / CPU for 1200x900 | CC BY-NC 4.0 | No: non-commercial only | [r83][r84][r102] |
| SCI (CVPR 2022) | Lightweight self-calibrated illumination network | No licence file | No: no licence grant | [r85] |
| IAT | Illumination-adaptive transformer, small | Apache-2.0 | Yes, licence-wise | [r86] |
| ixc-camera | "Free, lightweight webcam enhancer for Windows 11" with low-light motion smoothing | MIT, 1 star | Windows 11 only, very new | [r90] |
| beauty-webcam-mac | macOS menu-bar beauty filters and lighting correction | No licence, 23 stars | No licence grant | [r91] |
| npu-camfx | Linux virtual camera: blur, skin smoothing, gamma on Intel NPU | MIT, 0 stars | Intel NPU only | [r92] |
| face-light | Browser WebGL2 face lighting | No licence, 0 stars | Browser only | [r93] |
| v4l2loopback / akvirtualcamera / pyvirtualcam | Virtual camera plumbing | GPL-2.0 / GPL-3.0 / GPL-2.0 | Yes, with GPL obligations | [r87][r88][r89] |

GitHub search found no established (more than 100 stars) open-source app whose main purpose is automatic low-light webcam enhancement with a virtual camera. Searches for "low light webcam", "webcam enhance", "webcam lighting" and "virtual camera effects" returned only the small or new repos above.

---

## 2. Notes by tool

### OBS Studio and its plugins

- **Virtual camera.** On macOS, OBS 30+ on macOS 13+ ships a camera extension the user must approve in System Settings. On Linux it needs the v4l2loopback kernel module [r7]. Linux users report Zoom not listing the camera or showing black until v4l2loopback is loaded with `exclusive_caps=1` [r96]. A Mozilla bug tracks v4l2loopback cameras not appearing in WebRTC [r97].
- **obs-backgroundremoval.** The title on the OBS forum is "Background Removal / Virtual Green-screen & Low-Light Enhance". The page says it can "correct lighting in low-light conditions, just like Zoom or Google Meet", "doesn't require* a GPU", and lists v1.4.1 updated 9 Aug 2026 [r2]. Low-light enhancement arrived in v0.5.19 [r3]. The GitHub repo has 4,668 stars, GPL-3.0, latest release 1.4.1 on 2026-07-26 [r1].
- **NVIDIA filters in OBS.** OBS 31 added NVIDIA background blur [r8]. Elgato's guide lists an RTX 2060 or better and the NVIDIA Video Effects SDK as requirements [r9].
- **StreamFX.** The OBS forum listing calls it "a non-free Plug-in" [r10]. An NVIDIA developer-forum post says the Maxine SDK GitHub repos "now point to Error 404 pages" [r11]. The AUR package says the NVIDIA SDK packages are "no longer accessible publicly and locked behind a paywall" [r12].

### NVIDIA Broadcast

- Requirements: "NVIDIA GeForce RTX 2060, Quadro RTX 3000, TITAN RTX, or higher", 8 GB RAM, Windows 10/11 64-bit or Windows on Arm [r13].
- Camera effects: virtual background, auto frame, video noise removal, eye contact, vignette, virtual key light, and two beta effects (RTX Video Super Resolution, RTX Video Frame Generation) [r13]. "Virtual Key Light, Studio Voice, and RTX Video Super Resolution (beta) require a GeForce RTX 3060 GPU or higher" [r13]. Frame Generation needs an RTX 40 Series GPU or newer [r14].
- Video Noise Removal was added in 1.2.0: "reduces video noise from webcams, especially in low light situations" [r14].
- GTX cards are not supported; the app "uses Tensor Cores on NVIDIA RTX GPUs" [r13].

### Windows Studio Effects

- Full set "requires a Copilot+ PC with an NPU boasting over 40 tera operations per second (TOPS)". Devices with smaller NPUs get background blur, standard eye contact, automatic framing and voice focus. Portrait light, Teleprompter and creative filters are "Only available on Snapdragon Copilot + PCs devices" [r18].
- "On some devices, turning on camera effects might have a significant effect on performance and battery life" [r18].
- In May 2024, heise reported that Windows 11 "does not offer Windows Studio Effects for webcams connected externally via USB", even on a Ryzen 8600G desktop with an NPU [r19]. Insider builds in September 2025 added Studio Effects for one alternative camera such as a USB webcam on Copilot+ PCs, with a known issue: "For some classes of external webcams, turning on the setting may cause a camera preview failure" [r20].

### Camo Studio (Reincubate)

- Free covers 720p and below; Pro adds up to 4K, 60 fps, Portrait mode and background effects. The pricing page lists "Spotlight", which compensates for backlit or under-lit scenes, among the Pro features [r22]. Prices are not on the page.
- The support article lists "sliders for adjusting Exposure, ISO/Gain, White balance, Brightness, Saturation, Vibrance, Contrast and more" and "an anti-flicker tool accessed by clicking the ellipsis adjacent to Exposure's Auto toggle" on supported devices. Spotlight "excels in challenging lighting scenarios, such as when you are lit strongly from the back" [r23].
- Camo Studio 2 (2023) supports "pretty much any other third-party webcam" [r24].
- Camo is the closest commercial product to the goal: it has hardware controls and a backlight fix. It is closed source, its best features are paid, and the user still has to find and set the controls.

### Vendor camera apps (Logitech, Elgato, Dell)

- Logitech: in Logi Options+, "Turn off auto exposure to adjust shutter speed and ISO", turn low-light compensation and HDR on or off, and "Some webcams may include additional settings such as anti-flicker and frame rate vs. exposure prioritization" [r33]. A C920 support article describes 50 Hz, 60 Hz or disabled anti-flicker (from search snippet; page not fetched, UNVERIFIED wording) [r34].
- Elgato: anti-flicker 50/60 Hz applies only when exposure is automatic [r30]. A Corsair laptop's built-in camera can be adjusted in Camera Hub [r31]. Camera Hub noise reduction (Off/Low/Medium/High/Custom with 2D and 3D sliders) is for "supported Facecam models" and "comes at a slight cost in image quality as small details may be removed" [r32]. The same Elgato page says Camera Hub is no longer supported and Facecam settings moved to Elgato Studio; Elgato's Studio 1.0 notes list only capture cards, so this is UNVERIFIED [r32].
- Dell: Peripheral Manager offers HDR, auto white balance and sliders; HDR and AI auto framing "can only be enabled if you are connected via USB 3.0" [r35]. Dell's newer webcams do face-detection auto exposure (FDAE) inside the camera [r36]. This is the only face-aware auto exposure found, and it is hardware in specific Dell cameras.

### Meeting apps and operating systems

- Zoom: the Zoom Rooms SDK models low light as an auto/manual flag with a 0 to 100 manual level [r63]. Community answers say "no software can really do a good job if the light available is too low" [r64].
- Google Meet: automatic lighting adjustment is free, but "Automatic recommendation is only available to participants on a device with 2 core or higher with hyper-threading", and Meet may move processing to the cloud on devices with fewer than 8 logical cores [r67]. Studio look "uses artificial intelligence to fix issues caused by low light or low quality webcams" and "automatically happens in the cloud" [r68].
- Chrome: a 2024 Chromium proposal exposes the state of OS camera effects (blur first, then lighting) to web pages. It is an API for developers, not a user feature [r71].
- macOS: Studio Light requires "macOS Sonoma 14 or later on a Mac laptop with Apple silicon using the built-in camera", or Continuity Camera with an iPhone [r42].

### Linux camera quality

- New Intel laptops with IPU6 cameras often run through libcamera's software ISP. The libcamera FAQ says image quality and battery life suffer [r53]. Lead developer Hans de Goede wrote that "colors being washed out and/or the image possibly being a bit over or under exposed is expected behavior ATM" [r54]. A Dell Latitude user on Ubuntu 24.04 reported "extremely aggressive Temporal Noise Reduction (TNR), causing severe ghosting/blur artifacts" [r98].

---

## 3. What users complain about

Grouped by problem. Quotes are exact unless marked "paraphrase".

**Frame rate drops in low light (silent, looks like lag).**
- Framework laptop owner: "I'm only getting 10 FPS in recordings and visible choppiness/motion blur in the live feed." Framework staff: "The default behavior is auto-framerate to handle low lighting conditions." [r72]
- FTC (robotics) camera docs: if the camera's auto exposure "detects that the image is very dark, AE Priority allows the frame rate to decrease" [r74].
- HP forum fix: turn off "Low Light Compensation" [r76]. OBS forum: set manual exposure for the frame rate you need, add light; some cheap cameras cannot be fixed (paraphrase) [r75]. A C920 owner: exposure "limits the frame rate to 24 fps and even lower" [r100].

**Grain, noise and app over-processing.**
- HN, "Webcams aren't good enough" (2022): a 2020 HP laptop camera "made a brightly lit room look like a closet at midnight" (Miraste) [r73].
- Zoom users fixed distorted video by turning off "Optimize video quality with de-noise" (paraphrase) [r65].

**Flicker and banding under mains-powered and LED light.**
- No web app can set anti-flicker: "AFAIK there is no way to control the power line frequency of the video capture device to reduce the light flickering" (W3C issue, open since 2022-09-22) [r61].
- A Zoom community thread asks how to switch Zoom's flicker reduction from 60 Hz to 50 Hz; per the search snippet, the user could change the frequency in other apps but not in Zoom (UNVERIFIED: page did not load) [r66].
- The Windows Camera app has its own flicker setting [r79]; Windows exposes the property to drivers only "if the device supports anti-flicker processing" [r80].
- Banding happens when shutter timing does not match the light's flicker; the fix is the camera's power-line-frequency setting [r77]. A Reddit r/Ubiquiti thread (archive snapshot, anecdotal) says cheap LED fixtures flicker at "120-360Hz" through PWM dimming, which a 50/60 Hz setting does not fix [r78].

**Wrong skin colour.**
- Canon community: "mixed colors and different color temperatures in the lighting may be confusing Auto White Balance" (paraphrase of thread) [r81].
- HP forum, "Webcam has green hue": turning off the webcam IR lights and adjusting Low Light Compensation reduced a purple tint in low light (paraphrase) [r82].
- Framework forum has a 26-reply thread titled "Camera shows extreme red hue" (title only seen) [r72].

**Backlit face and exposure hunting.**
- HN: "Except it cannot handle exposure changes at all, whether from a cloud or just moving around in the frame." (whoopsie) [r73]
- A Webcam Settings reviewer needed to disable auto exposure because of a bright window behind them (paraphrase) [r44].

**CPU and GPU cost.**
- obs-backgroundremoval: "when switched to GPU it still uses 40% cpu. Turn it off and obs cpu usage goes to 3%"; another user measured OBS CPU rising "from 9% to 63%" (OBS forum thread and plugin reviews) [r4].
- NVIDIA Broadcast in OBS: preview "very laggy, something like 20 fps or less" [r15]; with an RTX 3070 "the utilization stills hovers around 90%" [r16].
- Lumina: the AI app "cleans up the feed but at a huge cost of CPU usage" [r47].
- Google: "Enabling light adjustment may slow down your device" [r67]. Microsoft: effects "might have a significant effect on performance and battery life" [r18].
- A PCWorld article (reposted) reports Windows limited a 4K webcam to 1440p once Studio Effects was active; the workaround was disabling the "Windows Studio Effects Driver" (secondary source) [r101].

**Needs special hardware.**
- NVIDIA Broadcast does not support GTX GPUs [r13]. An AMD community thread looks for Broadcast alternatives; one user says XSplit "just kind of sucks" by comparison [r17].
- Studio Effects: no NPU, no effects; USB webcams excluded until 2025 [r19][r20].

**Paywalls and watermarks.** VCam free tier has a watermark [r29]. ManyCam free tier has a watermark (UNVERIFIED, Capterra) [r28]. Camo's backlight fix and 60 fps are Pro [r22]. Meet's low-light "studio look" needs a paid plan [r68]. StreamFX is paid [r10]. GlowCam is $24.99/month [r60].

**Too complex or fragile.**
- OBS reviewers on G2 and Capterra describe a steep learning curve and an overwhelming first setup (paraphrase) [r94][r95].
- obs-backgroundremoval issues "The option does not appear in the filter section" (33 comments) and "plugin is not appearing in filters OBS studio" (22 comments) [r5][r6].

**Users want it automatic.** A Lumina buyer on HN: "It still doesn't do automatic tuning of the video. Everything requires manual adjustment." and "try and get it to automatically work right for 99% of cases without manual user input." (mchusma) [r73]

---

## 4. The gap

**Gap statement.** No free, open-source tool runs on Windows 10, Windows 11, macOS and Linux and automatically makes a weak webcam look good in bad light. Free automatic fixes exist only inside one meeting app (Zoom, Meet, Teams) [r62][r67][r69] or on specific hardware (RTX GPU, Copilot+ NPU, Apple-silicon built-in camera, Chromebook Plus) [r13][r18][r42][r70]. Open tools that touch the camera hardware are manual control panels [r37][r45][r48][r49]. The only open low-light filter needs OBS and a plugin, and users report install and CPU problems [r4][r5][r6]. No tool works at both layers: it neither sets the camera (anti-flicker for the local mains frequency, an exposure cap that keeps the frame rate) nor then repairs the picture (face-metered tone, stable colour, denoise) from one switch. Browser tools cannot reach the hardware layer at all [r61].

**Features that would make a new tool clearly best for weak webcams in bad light:**

1. **Fix the camera first, automatically.** Detect 50 or 60 Hz and set anti-flicker; stop auto exposure from stretching frame time (turn off AE priority or cap exposure, use gain instead); keep the settings and re-apply them when the camera reconnects. Evidence: silent frame-rate drops [r72][r74]; anti-flicker only in brand apps or manual tools [r30][r33][r48]; web apps cannot set it [r61]. cameractrls' restore daemon shows the reapply idea works, on Linux only [r48].
2. **Face-metered exposure and tone with no pumping.** Meter on the face, lift a backlit face without blowing out the window, and smooth changes over time. Evidence: backlit and exposure-hunting complaints [r73][r44]. Today this exists only as Dell camera hardware (FDAE) [r36] and Camo Pro Spotlight [r23].
3. **Stable, skin-aware white balance.** Hold colour steady under mixed light and correct orange, green and purple casts with hysteresis instead of constant hunting. Evidence: [r81][r82][r54].
4. **Low-light lift and temporal denoise that run on integrated graphics or a CPU, within a stated budget.** No RTX GPU, NPU or cloud. Back off when the sensor already denoises heavily, so detail is not smeared twice. Evidence: hardware gating [r13][r18]; CPU and GPU cost complaints [r4][r15][r16][r47]. Use classical methods or permissively licensed models, because Zero-DCE and Zero-DCE++ are non-commercial [r83][r84].
5. **Residual flicker and banding removal in software.** Handles LED PWM flicker that a 50/60 Hz setting cannot fix [r78][r77].
6. **Clean-up tuned for soft MJPEG sensors.** Light deblocking and sharpening for 720p MJPEG input, and an optional upscale. NVIDIA charges an RTX 3060 for this kind of super resolution [r13].
7. **One virtual camera on all four targets with no extra apps.** DirectShow on Windows 10, Media Foundation on Windows 11, a CoreMediaIO camera extension on macOS, v4l2loopback on Linux, with guided setup for Secure Boot and the `exclusive_caps` pitfall [r7][r52][r96]. It must work in Zoom, Teams and Meet desktop and web.
8. **Explain what it fixed.** Show real frame rate, exposure time, flicker setting and a before/after view, so users can see the 10 to 15 fps drop that they now experience only as "lag" [r72].

Where a new project can be clearly best: free, open, cross-platform, no special hardware, automatic, and the only tool that fixes the camera's own settings before it processes the picture.

---

## 5. Name check

Checks done on 2026-11-06: npm registry lookups (`https://registry.npmjs.org/<name>`), GitHub repository search sorted by stars, and web searches for camera, webcam and video products. No trademark-office search was done; trademark status is UNVERIFIED for every name.

| Name | npm | Notable GitHub | Camera / video product collision | Verdict |
|---|---|---|---|---|
| **Sunroom** | Free (404) | None notable; top hit is dwyl/sunroom with 3 stars [n2] | None found. The name is used by Sunroom Rentals (proptech) [n3], a creator social app called Sunroom [n4], and sunroom design apps [n5], all outside camera and video | **Usable. Best of the list.** Fits the idea of warm, flattering light. |
| Dawncam | Free (404) | qFane/DawnCamera, a Minecraft camera plugin, 1 star [n6] | None exact; DawnArk WebCam Monitor is a Windows webcam app with a similar name [n7] | Usable but weak: "dawn" suggests dim light. |
| Glowcam | Free (404) | Several tiny repos | **Yes.** Imagera's GlowCam is a paid Chrome extension that beautifies webcams on Meet, Zoom and Teams [r60]; several "GlowCam" selfie-light apps on the App Store [n8]; BeautyPlus "Glow Cam" [n9] | Avoid. |
| Candela | **Taken** (`candela`, Kitware visualization, last modified 2022) [n10] | Kitware/candela 120 stars, others [n10] | **Yes.** A Chrome extension named "Candela" is "A virtual ring light to illuminate your face during video calls" [r58]; Rollei Candela LED lights and app [n11] | Avoid. |
| Brightcam | Free (404) | ckosmic/BrightCam, an iOS tweak, 3 stars [n12] | None found | Usable but generic and descriptive, so hard to protect or search for. |
| Lumacam | Free (404) | G4LumaCam, a simulator for the LumaCam event camera [n13]; tryshyzov/lumacam "Your phone's camera as a webcam" [n13] | **Partial.** LumaCam event camera; Luma Surveillance cameras [n14]; LUMA Camera iPhone app | Avoid. |
| Fairlight | **Taken** (`fairlight`, React REST hooks) [n15] | Many repos about DaVinci Resolve | **Yes.** Fairlight is Blackmagic Design's audio product and the audio page inside DaVinci Resolve [n15] | Avoid. |

**Verdict:** keep **Sunroom**. It has no camera or video collision, the npm name is free, and GitHub has no notable project with that name. Because one name passes, a full list of replacements is not needed. One backup name was checked: **Daylit**. The npm name is free, the only GitHub repo is a small Home Assistant brightness project [n16], and no camera product uses it; "Dayli" (a timelapse photo app) and several "Daylight" apps are near misses [n17]. "Facelit" was checked and rejected: Apple ML research publishes FaceLit, a face-relighting model [n18].

---

## 6. Not verified or not checked

- Current prices for Camo Pro, XSplit VCam, ManyCam, FineCam and Airtime Camera (official pages did not show prices, or only third-party listings had them).
- Whether OBS core exposes UVC controls on every platform, and which OBS filters ship built in (not checked against OBS docs).
- The image quality and CPU cost of obs-backgroundremoval's low-light models (no benchmarks found); licences of the PINTO model-zoo models it uses.
- FineCam's low-light feature (claimed only by third parties); XSplit VCam's "studio lighting effects" (no detail on vendor page).
- Whether Elgato Camera Hub is retired in favour of Elgato Studio (sources conflict).
- Reddit threads (crawler blocked). Complaint coverage leans on vendor forums, GitHub, the OBS forum and Hacker News.
- Trademark registrations for all candidate names.

---

## References

[r1]: https://github.com/royshil/obs-backgroundremoval
[r2]: https://obsproject.com/forum/resources/background-removal-virtual-green-screen-low-light-enhance.1260/
[r3]: https://obsproject.com/forum/resources/background-removal-virtual-green-screen-low-light-enhance.1260/version/4894/download
[r4]: https://obsproject.com/forum/threads/background-removal-virtual-green-screen-low-light-enhance.142442/page-2
[r5]: https://github.com/royshil/obs-backgroundremoval/issues/592
[r6]: https://github.com/royshil/obs-backgroundremoval/issues/602
[r7]: https://obsproject.com/kb/virtual-camera-troubleshooting
[r8]: https://ubuntuhandbook.org/index.php/2024/12/obs-studio-31-0-0-released/
[r9]: https://help.elgato.com/hc/en-us/articles/7665140128653
[r10]: https://obsproject.com/forum/resources/streamfx-by-vhonowslend.578
[r11]: https://forums.developer.nvidia.com/t/obs-streamfx-maxine-ar-afx-vfx-sdks-for-linux/324484
[r12]: https://aur.archlinux.org/packages/obs-streamfx
[r13]: https://www.nvidia.com/en-us/geforce/broadcasting/broadcast-app/faq/
[r14]: https://www.nvidia.com/en-in/geforce/broadcasting/broadcast-app/release-notes
[r15]: https://obsproject.com/forum/threads/nvidia-broadcast-make-output-preview-laggy.132542/
[r16]: https://obsproject.com/forum/threads/obs-high-gpu-usage-issue-with-nvidia-broadcast-after-upgrading-from-2060-super-to-3070-rtx.150647
[r17]: https://community.amd.com/t5/pc-graphics/nvidia-broadcast-alternatives/td-p/717984
[r18]: https://support.microsoft.com/en-us/windows/ai/ai-features/windows-studio-effects
[r19]: https://heise.de/-9725856
[r20]: https://windowsreport.com/windows-11-25h2-dev-beta-build-expands-windows-studio-effects-to-more-cameras/
[r21]: https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/camera-settings-page
[r22]: https://camo.com/pricing
[r23]: https://camo.com/support/camo/adjusting-video-settings
[r24]: https://sixcolors.com/post/2023/03/camo-studio-2-supports-any-webcam-including-continuity-camera/
[r25]: https://www.fineshare.com/finecam/
[r26]: https://www.trustradius.com/compare-products/fineshare-finecam
[r27]: https://manycam.com/
[r28]: https://www.capterra.com/p/228396/ManyCam/pricing/
[r29]: https://vcam.ai/
[r30]: https://help.elgato.com/hc/en-us/articles/4405055113357-Elgato-Facecam-Camera-Hub-Settings-Overview
[r31]: https://corsair.com/explorer/gamer/gaming-laptops/how-to-set-up-the-voyager-gaming-laptop-webcam-with-elgato-camera-hub
[r32]: https://www.elgato.com/eu/el/explorer/software/camera-hub/camera-hub-noise-reduction/
[r33]: https://www.logitech.com/en-us/discover/a/optimize-webcam-settings
[r34]: https://support.logi.com/hc/en-us/articles/360023188714-Customize-HD-Pro-Webcam-C920-Settings-with-Logitech-Gaming-Software
[r35]: https://www.dell.com/support/kbdoc/000189066/dell-wb7022-ultrasharp-webcam-usage-and-troubleshooting-guide
[r36]: https://windowscentral.com/accessories/dell-pro-webcam-launches-featuring-hdr-exposure-correction-and-ai-auto-framing
[r37]: https://github.com/webcamoid/webcamoid
[r38]: https://techcrunch.com/2023/01/05/snap-is-shutting-down-its-desktop-camera-app-that-allows-users-to-apply-filters-during-video-calls
[r39]: https://www.airtime.com/blog/mmhmm-becomes-airtime
[r40]: https://medium.com/prismlivestudio/windows-prism-lens-v1-0-0-release-eadfc69aa467
[r41]: https://guide.prismlive.com/lens/guides/features
[r42]: https://support.apple.com/105117
[r43]: https://apps.apple.com/us/app/hand-mirror/id1502839586?mt=12
[r44]: https://apps.apple.com/app/id533696630
[r45]: https://github.com/itaybre/CameraController
[r46]: https://setup.getlumina.com/lumina-studio-026
[r47]: https://shotkit.com/lumina-webcam-review/
[r48]: https://github.com/soyersoyer/cameractrls
[r49]: https://sourceforge.net/projects/guvcview/
[r50]: https://lkml.iu.edu/hypermail/linux/kernel/2206.0/06536.html
[r51]: https://github.com/floe/backscrub
[r52]: https://github.com/fangfufu/Linux-Fake-Background-Webcam
[r53]: https://libcamera.org/faq.html
[r54]: https://hansdegoede.dreamwidth.org/28841.html
[r55]: https://chromewebstore.google.com/detail/visual-effects-google-mee/lcalofoidkpopkkadcjjgcnnkcoalpba
[r56]: https://chromewebstore.google.com/detail/hkllpdmppeddmlbiclpeafgpcapgkedd
[r57]: https://chromewebstore.google.com/detail/lookgood-live/mleflnbfifngdmiknggikhfmjjmioofi
[r58]: https://chromewebstore.google.com/detail/candela/emfpgoggcpaoeciappebbkfeljehjhag
[r59]: https://chromewebstore.google.com/detail/edge-light-for-video-call/gnokgiieigiolelecndoalclipjjimoi
[r60]: https://imagera.ai/compare/snap-camera-alternative
[r61]: https://github.com/w3c/mediacapture-image/issues/294
[r62]: https://support.zoom.com/hc/fr/article?id=zm_kb&sysparm_article=KB0060622
[r63]: https://marketplacefront.zoom.us/sdk/zrc/struct_my_video_low_light_settings.html
[r64]: https://community.zoom.com/meetings-2/video-face-too-bright-79147
[r65]: https://community.zoom.com/t5/Zoom-Meetings/Problems-Optimize-video-quality-with-de-noise/td-p/93007
[r66]: https://community.zoom.com/meetings-2/switch-zoom-camera-flicker-reduction-from-60-hz-to-50-hz-21104
[r67]: https://support.google.com/meet/answer/9302964?hl=en
[r68]: https://support.google.com/meet/answer/14441737
[r69]: https://support.microsoft.com/en-us/office/manage-your-device-settings-5b5ca50f-eea2-47b6-a98c-611548528498
[r70]: https://support.google.com/chromebook/answer/10264237
[r71]: https://groups.google.com/a/chromium.org/g/blink-dev/c/fG8V4YeLByM
[r72]: https://community.frame.work/t/webcam-capture-low-framerates-in-low-light/4387
[r73]: https://news.ycombinator.com/item?id=31801093
[r74]: https://ftc-docs.firstinspires.org/programming_resources/vision/webcam_controls/exposure/auto_exposure/auto-exposure.html
[r75]: https://obsproject.com/forum/threads/camera-frame-rate-issues.119429/
[r76]: https://h30434.www3.hp.com/t5/Notebooks-Archive-Read-Only/Slow-FPS-for-HP-TrueVision-HD-Webcam/m-p/1060937
[r77]: https://www.tp-link.com/us/support/faq/4748/
[r78]: https://reddit.sentinel-team.org/posts/1tu4caj/snapshots/2026-06-02T05%3A08%3A52.887754Z
[r79]: https://community.acer.com/tr/kb/articles/107-webcam-may-flicker-when-using-the-microsoft-camera-application
[r80]: https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/ksproperty-videoprocamp-powerline-frequency
[r81]: https://community.usa.canon.com/t5/EOS-DSLR-Mirrorless-Cameras/Color-on-WebCam-with-background-light/td-p/331978
[r82]: https://h30434.www3.hp.com/t5/Notebook-Video-Display-and-Touch/Webcam-has-green-hue/m-p/7791607
[r83]: https://github.com/Li-Chongyi/Zero-DCE
[r84]: https://github.com/Li-Chongyi/Zero-DCE_extension
[r85]: https://github.com/vis-opt-group/SCI
[r86]: https://github.com/cuiziteng/Illumination-Adaptive-Transformer
[r87]: https://github.com/v4l2loopback/v4l2loopback
[r88]: https://github.com/webcamoid/akvirtualcamera
[r89]: https://github.com/letmaik/pyvirtualcam
[r90]: https://github.com/infernoxc/ixc-camera
[r91]: https://github.com/madebyaris/beauty-webcam-mac
[r92]: https://github.com/fstronin/npu-camfx
[r93]: https://github.com/pradhankukiran/face-light
[r94]: https://www.g2.com/products/open-broadcaster-software/reviews
[r95]: https://www.capterra.com/p/164144/OBS/reviews/?page=6
[r96]: https://obsproject.com/forum/threads/obs-virtual-camera-feed-to-zoom-shows-nothing.152785
[r97]: https://bugzilla.mozilla.org/show_bug.cgi?id=1622628
[r98]: https://www.dell.com/community/en/conversations/linux-general/poor-image-quality-ghostingexcessive-tnr-on-ipu6-webcam-ubuntu-2404-meteor-lake/693919bd72c11a30abeae544
[r100]: https://www.mathworks.com/matlabcentral/answers/329833-enforce-fixed-frame-rate-with-webcam
[r101]: https://longform.social/post/did:plc:xj2drxwuk2r3tfelpnw2uqog/3mgmz6x7xv4z2
[r102]: https://github.com/Thehunk1206/Zero-DCE
[r104]: https://support.microsoft.com/en-us/kb/5016488

[n2]: https://github.com/dwyl/sunroom
[n3]: https://jobs.capitalfactory.com/companies/sunroom-rentals
[n4]: https://missingperspectives.com/?p=2298
[n5]: https://apps.apple.com/app/id1003861644
[n6]: https://github.com/qFane/DawnCamera
[n7]: https://www.softpedia.com/get/Multimedia/Video/Other-VIDEO-Tools/DawnArk-WebCam-Monitor.shtml
[n8]: https://apps.apple.com/us/app/-/id6744090021
[n9]: https://www.beautyplus.com/glow-cam
[n10]: https://github.com/Kitware/candela
[n11]: https://apps.apple.com/us/app/id6459833083
[n12]: https://github.com/ckosmic/BrightCam
[n13]: https://github.com/TsvikiHirsh/G4LumaCam
[n14]: https://www.snapav.com/shop/en/snapav/luma-surveillance-700-series-analog-dome-camera-w--heater-lum-700-dom-ah
[n15]: https://blackmagicdesign.com/fairlight
[n16]: https://github.com/Nachox07/daylit
[n17]: https://www.macstories.net/linked/dayli/
[n18]: https://github.com/apple-aiml-research/ml-facelit

Plain-text list of the npm lookups used in section 5 (all on 2026-11-06): https://registry.npmjs.org/sunroom (404), https://registry.npmjs.org/dawncam (404), https://registry.npmjs.org/glowcam (404), https://registry.npmjs.org/candela (exists), https://registry.npmjs.org/brightcam (404), https://registry.npmjs.org/lumacam (404), https://registry.npmjs.org/fairlight (exists), https://registry.npmjs.org/daylit (404). Second LumaCam repo: https://github.com/tryshyzov/lumacam . npm package pages: https://www.npmjs.com/package/candela , https://www.npmjs.com/package/fairlight .
