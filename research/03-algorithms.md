# 03. Algorithms: real-time enhancement for a weak webcam on weak hardware

Research date: 2026-11-06. Scope: questions 1 to 10 of the algorithm brief (tone, temporal stability, denoising, small neural models, face-aware processing, mains-flicker banding, white balance, MJPEG artefacts and sharpening, our own auto exposure, evaluation). No project code was written and no weights were downloaded.

Method and conventions:

- Sources are papers (arXiv, CVF, author PDFs), official repos read with `gh` (licence fields and files checked on 2026-11-06), vendor docs, kernel and W3C specs, and patents (Google Patents). Every factual claim carries a reference `[aN]` (list at the end).
- **UNVERIFIED** means I could not confirm the claim from a primary or reliable source.
- **Derived** means my own arithmetic or engineering inference from cited facts. It is not a published result and must be checked on our hardware.
- Our measured facts from the brief are quoted as "(our measurement)".
- Patent notes are flags for a legal check, not legal advice. Google Patents itself labels its status data an assumption [a43][a89].

---

## Summary

### Recommended pipeline, in order

| # | Stage | Runs where, how often | Technique | Section |
|---|---|---|---|---|
| 0 | Camera control | Native helper, 5 to 10 Hz | Detect mains frequency, set the camera's power-line filter, turn frame-rate priority off, run our own AE: manual exposure quantised to flicker-safe times up to 1/30 s, then analogue gain, then shader gain | Q6, Q9 |
| 1 | Statistics | GPU writes tiny textures, async readback to CPU, every frame | 1/8-res luma for tile histograms, column-subsampled row means for flicker, grey-edge sums for WB, Immerkaer noise sigma; face box or landmarks every 3rd to 6th frame | Q1, Q3, Q5, Q6, Q7 |
| 2 | Controller | CPU, well under 1 ms | Face-priority metering with a "do no harm" band; per-tile tone curves (CLAHE-style, noise-aware slope cap, 10% global blend); IIR smoothing at about 0.5 Hz; dead bands; scene-cut reset | Q1, Q2, Q5 |
| 3 | Pass A | GPU, full res | sRGB to linear; divide by the fitted per-row flicker gain; residual WB gains | Q6, Q7 |
| 4 | Pass B | GPU, full res | Motion-adaptive recursive temporal filter: blend weight from the 3x3-averaged difference against the noise sigma, history clamped to the current 3x3 min/max | Q3 |
| 5 | Pass C | GPU, chroma at half res, luma full res | Chroma: joint bilateral or guided filter guided by luma. Luma: 2 to 3 level edge-avoiding a-trous, strength scaled by the gain the tone stage will apply | Q3 |
| 6 | Pass D | GPU, full res | Slice per-tile curves (bilinear across the 4 nearest tiles), apply as a luminance ratio to linear RGB, face fill by a feathered luma-only mask, highlight shoulder | Q1, Q5 |
| 7 | Pass E | GPU, full res | Deblock only when blockiness is detected; RCAS sharpening gated by noise and gain; back to sRGB; dither | Q8 |

**Neural networks:** none for enhancement in version 1. A face detector is worth including for metering only: MediaPipe BlazeFace short-range (Apache-2.0) or YuNet (MIT). Every well-known low-light model is either non-commercial (Zero-DCE, Zero-DCE++), unlicensed (SCI, RUAS, PairLIE), or too heavy for an Intel UHD iGPU at 720p30 (IAT, StableLLVE, RRNet), and I found no evidence that any of them beats a tuned classical pipeline on already-processed 8-bit webcam video (Q4).

**Evaluation:** replay recorded MJPEG clips (our own scenario set plus Microsoft VCD2 webcam clips, CC-BY-4.0 repo) through the exact shader pipeline offline, and gate every change on face-exposure band, face clipping, static-region temporal noise, a temporal-flicker score, a row-banding score, warping error on the face, skin colour stability and ΔE2000, GPU ms per frame, and periodic crowdsourced P.910 ratings. No-reference IQA scores are secondary only, because they correlate weakly with human preference for low-light enhancement (Q10).

### Five findings that shape the design

1. **The best-matched published design is Eilertsen et al. 2015 "Real-time noise-aware tone mapping".** It uses per-tile tone curves (10% global, 90% local), interpolates curves between neighbouring tiles, smooths each curve over time with a 0.5 Hz low-pass IIR filter, and limits contrast boost so camera noise stays below visibility. It ran the full chain at 720p in 9.18 ms on a GTX 980 [a12]. Google's Live HDR+ viewfinder likewise applies one curve per tile and blends the 4 nearest tiles [a2].
2. **Our own measurement says temporal denoising has little headroom.** Plain 8-frame averaging cut noise only 1.2 to 1.8 times (our measurement), so the camera's own temporal filter already ran. In-camera processing makes the remaining noise spatially and chromatically correlated [a34]. The biggest noise lever is therefore not amplifying it: a noise-aware tone curve [a12] plus low-resolution chroma denoising, with temporal filtering mainly for static background.
3. **Our banding numbers fit the textbook exposure model.** A camera set to 60 Hz under 50 Hz light uses exposures of 8.33 ms multiples, which only partly cancel 100 Hz flicker. Going below 10 ms removes the cancellation, which explains "3 times worse" (Derived, Q6). The first fix is setting the camera's power-line control correctly. The web camera API has no such control [a93], so a native helper is required.
4. **No-reference metrics are weak judges here.** Against human preference for low-light enhancement, Spearman correlation was 0.143 for MUSIQ, 0.321 for BRISQUE, 0.457 for NIMA, and -0.250 for NIQE [a68]. Use targeted physical metrics plus human ratings.
5. **Licences rule out most of the literature.** Zero-DCE and Zero-DCE++ are CC BY-NC 4.0 [a48][a49]. SCI, RUAS and PairLIE have no licence file [a51][a53][a55]. NVIDIA holds an active patent on variance clipping of temporal history (expected expiry 2037 per Google Patents) [a43]. The old flicker-detection patent with row-mean frame differencing expired in 2024 per Google Patents [a89].

---

## Q1. Classical real-time low-light and tone pipeline

### Findings

**Working in linear light and exposure gain.**
- Phone pipelines tone-map from linear data. Live HDR+ predicts its curves from a low-resolution version of the linear image and applies them to the full-resolution viewfinder [a2]. Night Sight raises shadow gain gradually as lux falls (more than one extra stop at the 0.1 lux end), gives highlights at most 20% of the extra shadow gain, raises saturation by up to 20% as the scene darkens, and deliberately keeps a "night" look [a1].
- Contrast changes alter perceived colourfulness. Mantiuk et al. measured the saturation correction needed after contrast compression and found the relation is non-linear [a17].

**Local tone mapping options, cost in a fragment shader.**

| Technique | What it does | Shader cost (Derived unless cited) | Artefacts | Evidence |
|---|---|---|---|---|
| Global curve (1D LUT) | One curve for the frame | 1 texture fetch; 0.9 ms on our CPU (our measurement) | No local adaptation, so backlit faces stay dark | baseline |
| Per-tile curves (CLAHE family, Live HDR+, Eilertsen) | One curve per tile, blended between the 4 nearest tile centres | Apply: 4 fetches from a tiles x bins texture, or 1 fetch from a 3D texture with hardware filtering. Stats: tiny histograms on a 1/8-res image | Halos where a tile straddles a strong edge; flicker if curves are not filtered over time; noise boost in flat dark areas | Live HDR+ per-tile curves, blend of 4 nearest tiles [a2]; Eilertsen: per-tile cost about equal to one global histogram, 10%/90% global/local blend [a12]; CLAHE caps the CDF slope (typical amplification limit 3 to 4) and interpolates up to four tile functions [a14] |
| Exposure fusion of synthetic exposures (Mertens; HDR+ tone mapping) | Render 2 to 3 virtual exposures, blend Laplacian pyramids with Gaussian-pyramid weights | About 10 to 20 low-res pyramid passes plus a guided upsample. Wronski estimates "under 1ms on even previous generation consoles" but did not profile it [a8] | Halos at extreme settings; washed-out look if the coarsest blend level is too low [a8] | HDR+ uses a variant of synthetic exposure fusion with a "shadows" and a "highlights" exposure [a1]; Mertens et al. [a7]; Wronski's three.js WebGL demo, released to the public domain, computed at 1/4 x 1/4 res then guided-upsampled [a8][a9] |
| Guided-filter base/detail split | Edge-aware base layer, detail = input minus base | Box filters, O(N) regardless of radius [a10]; the fast guided filter at 4x subsampling is over 10x faster [a11] | Avoids the gradient reversal of the bilateral filter [a10]; Wronski finds it blurs some edges compared with exposure fusion [a8] | [a10][a11] |
| Bilateral grid / HDRNet | Store affine colour transforms in a (x, y, intensity) grid, slice per pixel | Slicing is one trilinear fetch. Building the grid needs scatter writes (WebGPU compute, or point splatting in WebGL2), and HDRNet needs a learned network to fill it | HDRNet: 14 ms for 1920x1080 on a Pixel phone [a3]. The bilateral grid ran in real time on HD video on 2007 GPUs [a5]; the authors pulled code version 0.2 over patent issues [a5]. google/hdrnet is Apache-2.0 and archived [a4] | |
| Local Laplacian filter | Per-intensity remapping in a Laplacian pyramid | Fast version about 50x faster on greyscale; interactive on CPU [a6]. Still many pyramid evaluations | Best halo behaviour of the group | [a6] |
| Multi-scale Retinex (MSR, MSRCR) | Log ratio to large Gaussian blurs at 3 scales | 3 large blurs per frame | Greying when the grey-world assumption fails (reported in secondary summaries of Rahman, Jobson and Woodell; primary text not retrieved, UNVERIFIED); MSRCR described as "not conducive to real-time applications" [a16] | |

**CLAHE and its artefacts.** AHE over-amplifies noise in homogeneous regions; CLAHE clips the histogram before computing the CDF, which caps the transform slope [a14]. Clipping does not address temporal behaviour: local histograms change when a head moves, so tile curves jump unless filtered over time. Eilertsen notes that local operators can "change incoherently over time" while a tone curve is "trivial to smooth out over time" [a12]. A GPU CLAHE exists for Metal (per-tile LUT per thread group) but has no licence [a15].

**How products do it.**
- Google Meet: automatic lighting adjustment needs a WebGL browser (Chrome M91+, Firefox 110+) [a19] and starts five seconds after the user enters a low-light area [a18]. The algorithm is not published (UNVERIFIED).
- Zoom: "Adjust for low light" with Auto (default) and Manual slider modes [a20]. Algorithm not published (UNVERIFIED).
- Chrome has a proposal to report platform effects such as lighting adjustment to web apps [a21]; it does no enhancement itself (UNVERIFIED beyond the proposal).
- OS level: Apple Studio Light dims the background and lights the face [a22]; Windows Studio Effects "Portrait light" brightens the face in dim settings, Snapdragon Copilot+ PCs only [a23].

**Web platform notes.** WebGL2 offers `fenceSync` for non-blocking readback through pixel-pack buffers [a24][a25], which is how small statistics textures should reach the CPU. WebGPU shipped by default in Chrome 113 on ChromeOS, macOS and Windows [a26] and adds compute shaders (histograms with atomics). Budget reality: Intel UHD Graphics 620 peaks near 384 GFLOPS FP32 at 1 GHz [a27].

### Recommendation

1. Linearise with the sRGB transfer function, compute everything on luminance in the log domain, and apply results as a ratio to linear RGB so hue is preserved. Use additive lifts nowhere.
2. Primary local operator: **temporally filtered, noise-aware per-tile curves** (Eilertsen's structure [a12], Live HDR+'s application [a2], CLAHE's slope cap [a14]).
   - Grid: about 6x4 to 8x5 tiles over 720p (Derived: Eilertsen's tiles are 5 visual degrees, about 230 px on a 15-inch full-HD screen at 45 cm [a12]; call video is shown smaller, so tiles relative to the frame should be larger).
   - Stats: 64-bin histograms of log luminance on a 160x90 copy (Derived: 14,400 pixels, trivial on CPU).
   - Curve: global exposure gain, then clipped-histogram equalisation with a low slope cap (about 1.5 to 2), a noise-aware slope cap (Q3), and a highlight shoulder in which highlights get at most about 20% of the extra shadow gain (borrowed from Night Sight [a1]). Blend 10% global into every tile [a12].
   - Apply: bilinear between tile centres, linear in intensity.
3. Option B, only if halos at bright windows remain visible after tuning: Wronski-style exposure fusion at 1/4 res with 3 synthetic exposures, exposure-only weights, guided upsampling [a8][a9]. The demo code is public domain.
4. Optional detail boost: guided-filter detail layer at 1/4 res [a11], gain at most about 1.2, multiplied by a noise-visibility mask (Eilertsen modulates the detail layer by noise [a12]).
5. Do not use MSR/MSRCR, full local Laplacian, or un-filtered CLAHE.

---

## Q2. Temporal stability: no flicker, no pumping

### Findings

- Eilertsen's evaluation found that all tested video tone mappers produced flicker, ghosting, amplified noise or lost detail [a12]. Their fix: the tone curve is the only time-varying part, filtered with a 3-tap low-pass IIR at a 0.5 Hz cut-off, chosen to minimise visible flicker after Mantiuk et al. 2008; a temporal edge-stop filter helped only with extreme changes [a12]. A full review of video tone mappers and their temporal artefacts is Eilertsen et al. 2017 [a13].
- RRNet (2026) smooths its lighting parameters with an exponential moving average (beta 0.8 to 0.99) and re-estimates only every few frames: 17.0 ms per 1080p frame when estimating every frame, 2.6 ms when estimating every 10 frames, on an RTX 3090 [a28].
- Scene cuts: ffmpeg's `scdet` computes a mean absolute frame difference score and suggests thresholds of 8 to 14 percent [a29].
- Control-loop lessons from libcamera's webcam AGC: a fixed 10% step per frame overshot and caused visible brightness oscillation; a proportional step `1 + clamp(0.04 x error, -0.15, +0.15)` plus the existing hysteresis converged in about 3 seconds with no visible oscillation [a30].
- Hysteresis is standard in exposure control: hold the value when the change is below a threshold to stop "hunting and oscillation" [a31]; about 0.5 EV of hysteresis with a direction flag [a32]. Both patents are expired per Google Patents [a31][a32].
- Face-driven metering adds its own noise: BlazeFace's model card warns of more "jittering" in degraded light, noise and motion [a33].
- Meet waits five seconds before enhancing after light drops [a18], which is a strong hint that products prefer slow, deliberate adaptation (inference).

### Recommendation

1. Filter statistics and curve parameters, never output pixels.
2. Tone curves: one IIR per tile node at about 0.5 Hz [a12]. Derived: a first-order equivalent at 30 fps is an EMA with alpha = 1 - exp(-2 pi 0.5 / 30), about 0.10 (time constant about 0.32 s).
3. Global exposure gain: work in EV (log2). Dead band of about 0.1 EV; proportional step with a per-frame clamp in the libcamera style [a30]; react faster when the frame is getting brighter (to protect highlights) than when it is getting darker (to hide noise and avoid pumping). The asymmetry is a design choice (UNVERIFIED for our content); tune it with the step-response metric in Q10.
4. Scene cut (MAFD score above about 10% [a29], or a large histogram distance): reset all filters to the new target over 3 to 5 frames instead of the slow path.
5. Face loss: hold the last face statistics for about 1 s, then blend back to scene metering over about 1 s. Smooth the face box itself before using it.
6. Never cascade two fast auto-exposure loops. If the camera's AE stays on, our digital gain must be several times slower than it (Derived; two loops of similar speed interact). The better fix is to own AE (Q9).
7. Measure pumping as a step response on lights-on/lights-off clips: overshoot and settling time (Q10).

---

## Q3. Denoising video in shaders

### Findings

**The noise we face.** In-camera processing (demosaicing, gamma, JPEG) makes noise spatially and chromatically correlated [a34]. Our camera also denoises temporally: 8-frame averaging gained only 1.2 to 1.8 times (our measurement). So the residual noise is low-frequency blotches plus chroma mottle, and it grows with every gain we apply. Eilertsen frames the core problem the same way: tone mapping pushes camera noise into the visible range, so the curve and detail boost must be noise-aware [a12].

**Temporal (recursive) filtering.**
- Motion-compensated recursive temporal filtering for noise reduction dates to Dubois and Sabri, 1984 [a39].
- Classic motion-adaptive temporal noise reduction uses a per-pixel blend factor driven by the frame difference, often through a lookup table; ghosting appears as "sticky contours" when filtering is strong; mitigations include spatially filtering the motion signal and forcing the blend to the current pixel when motion is detected [a38].
- STMKF (Kalman temporal filter plus bilateral spatial filter, aimed at video conferencing and lectures) keeps the Kalman update in static areas and uses the bilateral filter where motion occurs; the thesis reports about 30 full-HD fps on an Intel i7 and over 1000 fps at 480p on a GPU [a40][a41].
- From real-time rendering: SVGF combines temporal accumulation with a variance-guided, multi-level edge-avoiding a-trous wavelet filter, about 10 ms at 1080p on the authors' GPU [a35]; A-SVGF adds gradient-based adaptive accumulation to reduce lag and ghosting, with the temporal part at 2 ms at 1080p [a36]. Edge-avoiding a-trous filtering is from Dammertz et al. 2010 [a37].
- History rejection: neighbourhood clipping (Malan 2012, Karis 2014) is "the main ingredient" of temporal supersampling; RGB or YCoCg can be used [a42]. **Patent flag:** NVIDIA's US10116916 (Salvi, Patney, Lefohn) covers clipping the previous-frame colour using the mean and variance of the current neighbourhood, status "Active" with expected expiry 2037 per Google Patents [a43]. Plain min/max (AABB) clamping is the older technique; whether it is free of claims is UNVERIFIED.
- Commercial reference point: NVIDIA Maxine Webcam Denoise keeps temporal state and works from 80p to 1080p [a47].

**Spatial filtering.**
- Joint (cross) bilateral filtering and joint bilateral upsampling use a high-res guide to filter or upsample another signal [a46]; this is the natural tool for chroma guided by luma.
- Guided filter: O(N), no gradient reversal [a10][a11].
- Non-local means: 643 ms per frame on our CPU (our measurement). Derived: even a small 7x7 search with 3x3 patches is about 441 taps per pixel, too heavy for a UHD iGPU at 720p30.

**Noise-level estimation.** Immerkaer's method convolves with a Laplacian-type kernel (separable `[1, -2, 1]`) and averages; it is the fastest of HALCON's estimators and does not need homogeneous regions [a45], but it underestimates low noise [a44].

### Recommendation

1. **Estimate noise automatically.** Per frame, Immerkaer sigma on half-res luma over non-edge pixels [a44][a45]. Over seconds, build a signal-dependent table sigma(level) from temporal differences in static, non-face regions. Smooth both over time.
2. **Temporal pass (luma and chroma).** `out = hist + w (cur - hist)`, with `w = clamp(d / (k sigma), w_min, 1)`, where `d` is the 3x3-averaged absolute difference (spatially filtered motion signal, a stated anti-ghost measure [a38]). Clamp `hist` to the current 3x3 min/max before blending [a42]. Use a higher `w_min` for luma than for chroma, and a higher `w_min` inside the face box (mouth and eyes move). Reset on scene cut. Expect modest gains (1.2 to 1.8x from averaging, our measurement); the pass mainly cleans the static background that our gain amplifies. Use min/max clamping, not variance clipping, until the patent question [a43] is cleared.
3. **Chroma pass.** At half resolution, joint bilateral or guided filter on Cb/Cr guided by luma [a46][a10], strength from the chroma sigma. This removes chroma blotches and MJPEG chroma bleed together (Q8).
4. **Luma pass.** 2 to 3 levels of edge-avoiding a-trous (dilations 1, 2, 4) [a37], edge-stopping on luma difference relative to `sigma x applied gain`. Strength is proportional to the gain the tone stage will apply at that pixel (shadows get more). Leave a little grain on faces to avoid a plastic look.
5. **Noise-aware tone curve** (Q1): cap each curve's slope where the local sigma times slope would exceed a visibility threshold, as Eilertsen does [a12]. This is the cheapest denoiser of all.
6. Skip NLM and optical flow on the iGPU.

---

## Q4. Small neural low-light models

### Findings

| Model | Params / FLOPs | Reported speed | Code licence | Video behaviour | Notes |
|---|---|---|---|---|---|
| Zero-DCE (CVPR 2020) | 0.0789 M; 5.21 GFLOPs [a52] | 0.0042 s, TITAN X, resolution not stated [a52] | **CC BY-NC 4.0, "for non-commercial use only"** [a48] | Per-frame curves; frame-wise image methods cause temporal inconsistency on video [a69] | Excluded by licence |
| Zero-DCE++ (TPAMI 2021) | About 10K params [a50] | About 1000 fps on one GPU and 11 fps on one CPU at 1200x900 [a50] | **CC BY-NC 4.0, academic research only** [a49] | Same | Excluded by licence |
| SCI (CVPR 2022) | 0.0003 M; 0.0619 GFLOPs [a52] | 0.0017 s, TITAN X [a52] | **No licence file** (repo has only README and two folders, checked with `gh`) [a51] | Per-frame | Test time uses one block of "3 convolution + ReLU with 3 channels" [a52]; that is small enough to write as three shader passes, but the weights cannot be used without a licence |
| RUAS (CVPR 2021) | 0.0014 M; 0.2813 GFLOPs [a52] | 0.0063 s, TITAN X [a52] | **No licence file** [a53] | Per-frame | Excluded |
| IAT (BMVC 2022) | About 90k params; 1.44 GFLOPs at 256x256, 5.28 at 400x600 [a54] | About 0.004 s per image on an RTX 3090 (batched) [a54] | Apache-2.0 [a54], but the README says code is borrowed from Zero-DCE (CC BY-NC) [a54] | Per-frame | Derived: about 20 GFLOPs per 720p frame, about 600 GFLOP/s at 30 fps, above the UHD 620's 384 GFLOPS peak [a27]. Only feasible at low res. Provenance and training-data licence UNVERIFIED |
| PairLIE (CVPR 2023) | UNVERIFIED | Not reported [a55] | **No licence file** [a55] | Per-frame | Excluded |
| OBS `obs-backgroundremoval` "Enhance" | ONNX files: TBEFN 1.98 MB, URetinex-Net 1.66 MB, Semantic-Guided LLIE 53 KB (`gh` file sizes) [a58] | Defaults: TBEFN, CPU, 1 thread, blend 1.0 [a56] | Plugin GPL-3.0. Model licence files: TBEFN BSD-3-Clause, URetinex-Net MIT, SG-LLIE MIT [a58]; upstreams TBEFN BSD-3 [a60], URetinex-Net MIT [a61], SG-LLIE MIT [a62] | No temporal handling found in the filter source [a56] | The frame is resized to the network input size before inference [a59] (file names say 180x320 and 180x324 [a57]), and the output is blended over the source with a slider [a56]. SG-LLIE's README says it is "heavily based upon Zero-DCE" [a62], so its MIT label may inherit a non-commercial provenance question (UNVERIFIED) |
| FastLLVE (2023) | Not reported; 4D intensity-aware LUT, 33 points per axis, 3 basis LUTs [a63] | 13 ms per 1080p frame on an RTX 3090 [a63] | Apache-2.0 [a64] | Built for inter-frame brightness consistency; AB(Var) 0.038 and MABD 0.091 on SDSD [a63] | Trained on SDSD and SMID [a63] (licences not stated, Q10). Derived: 33^4 x 3 outputs x 3 bases is about 10.7 M values (about 21 MB in fp16) |
| StableLLVE (CVPR 2021) | UNVERIFIED | 38 ms per 1080p frame on an RTX 3090 (FastLLVE's table) [a63] | MIT [a65] | Trained for temporal consistency | Too heavy for the iGPU at 720p30 (Derived) |
| LIVE-Net (2026) | 0.13 M; 1.48 GFLOPs [a66] | Not stated | UNVERIFIED | Temporal difference consistency loss, no optical flow [a66] | Watch list |
| RRNet (2026) | Not reported; needs Depth Anything-Small [a28] | 17.0 ms per 1080p frame on an RTX 3090 [a28] | Not stated [a28] | EMA on lighting parameters [a28] | Too heavy; its "estimate rarely, smooth heavily" pattern matches our controller |
| Zero-TIG (2025) | UNVERIFIED | UNVERIFIED | Repo has no licence (checked with `gh`) | Warps the previous enhanced output for temporal consistency (abstract, as summarised in search results) [a71] | Excluded |

**Does a learned model beat a good classical pipeline on processed 8-bit webcam video?** I found no head-to-head test on webcam MJPEG input, so neither answer is proven. The available evidence leans classical:

- On the Real63 set, the classical LIME scored better NIQE (3.117) than Zero-DCE (3.257) [a67].
- No-reference metrics track human preference poorly for low-light enhancement (Spearman: NIQE -0.250, MUSIQ 0.143, BRISQUE 0.321, NIMA 0.457) [a68], so papers that win on NIQE have not shown they look better.
- Frame-by-frame image models flicker on video [a69].
- RAW-trained models do not transfer: the DRV authors state their model "does not work for images after camera ISP, i.e., the JPG or PNG data" [a70].
- What these tiny networks output is a smooth illumination map or per-pixel curve (SCI's single block, Zero-DCE's curves [a52][a50]). That is the same kind of output as the per-tile curves in Q1, but without explicit noise control or temporal filtering. The OBS filter even infers at 180x320 and blends [a57][a59]. (Inference from the cited structure.)

### Recommendation

- Ship **no** learned enhancement model in version 1. IAT is the only permissive candidate, and it carries a provenance question and does not fit the iGPU at 720p.
- If a later version wants a learned element, train our own SCI-sized curve or illumination network (a few hundred parameters, shader-implementable) on our own recordings, and adopt it only if it beats the classical pipeline under the Q10 protocol. FastLLVE's LUT idea (Apache-2.0) is the most shader-friendly published video design to revisit.
- Treat the OBS Enhance filter (TBEFN default) as a baseline to beat in evaluation, not as a component.

---

## Q5. Face-aware processing

### Findings

**Detectors and landmarkers usable in a browser.**

| Model | Licence | Size / input | Speed | Fairness notes |
|---|---|---|---|---|
| MediaPipe BlazeFace short-range | Apache-2.0 (model card) [a33] | 224 KB, 128x128 input [a33][a72] | About 275 fps on a Pixel 2 single CPU core [a33]; Pixel 6 whole pipeline 2.94 ms CPU, 7.41 ms GPU [a72] | Evaluated across perceived gender and five skin-tone groups aligned with Fitzpatrick types; quality degrades and jitter rises in poor light, noise and motion [a33] |
| MediaPipe Face Landmarker (Face Mesh V2) | Apache-2.0 (model card) [a74] | 478 3D landmarks from a 256x256 face crop; 52 blendshapes [a73][a74] | Not stated on the page [a73] | IOD-normalised error compared across genders and Fitzpatrick skin tones 1 to 6 [a74] |
| YuNet | MIT [a75] | 75,856 parameters [a76] | 1.6 ms per 320x320 frame on an Intel i7-12700K [a76] | WIDER Face hard: 0.811 mAP in the paper [a76]; the zoo's table lists 0.7503, without explanation [a75] |

Web use: `@mediapipe/tasks-vision` with a GPU delegate and a VIDEO running mode [a72].

**Metering targets.**
- Face-priority AE is normal in phones: Android's FACE_PRIORITY scene mode keeps AE, AWB and AF active while prioritising faces [a81]. A hidden FACE_PRIORITY_LOW_LIGHT mode raises sensitivity up to the maximum once maximum exposure (bounded by the target fps) is reached, and warns that images "may be noisier", to be used only when the app can denoise [a82]. That is exactly our Q9 strategy.
- Skin-tone-agnostic face-priority AE misexposes faces depending on the background; El-Yamany et al. adjust the target-brightness bounds from a predicted skin-tone likelihood [a77].
- There is no standard face target. Practitioner guidance: about 60 to 70 IRE for lighter skin and 40 to 55 IRE for darker skin, expose for the brightest skin in the frame, never clip faces [a79]; a fixed 70% zebra is "only good if everyone you shoot has the same skin tone" [a80].
- Google's Real Tone tunes auto-exposure so skin is not rendered unnaturally bright or dark, and reduces stray light that makes darker skin look "ashy" [a78].
- Monk Skin Tone scale (10 shades) and the MST-E example set (1,515 images, 31 videos, 19 subjects) support fairness testing [a83][a142]; MST-E's licence is UNVERIFIED.

**Relighting.**
- Learned: Google Portrait Light was trained from Light Stage captures [a84]. Real-time 3D-aware portrait relighting runs at 32.98 fps on consumer hardware [a85]. Personalised relighting runs at about 45 fps [a86]. All need a discrete GPU or NPU class budget (UNVERIFIED for UHD; Derived from model types).
- Products: Apple Studio Light dims the background and lights the face [a22]; Windows Portrait light is Snapdragon-only [a23].

### Recommendation

1. Run BlazeFace short-range (or YuNet) every 3rd to 6th frame on a 1/4-res copy **after** a provisional global gain, since detectors degrade in low light [a33]. Use Face Landmarker only if the skin mask needs to exclude eyes and mouth; otherwise use a shrunken ellipse from the detector box.
2. **"Do no harm" band metering instead of a single target.** On the skin mask, measure display-referred luma percentiles p50 and p95. Raise exposure only when p50 is clearly below a floor that is plausible for any skin tone, cap it so p50 stays under a ceiling, and keep p95 below a clip guard. Starting values to tune (UNVERIFIED, derived from [a79][a80]): floor about 0.36, ceiling about 0.65, clip guard about 0.92 (full-range Y'). Inside the band, leave the face alone. Do not classify skin tone; a misclassification is itself a fairness failure.
3. **Fill light without a network.** Multiply luminance by `1 + s M(x, y)`, where `M` is a feathered face ellipse refined by the guided filter on luma (so it does not leak onto hair or background). Use it only when the face is much darker than its surroundings (backlit), cap `s` (about +0.7 EV), and apply it in linear light to luminance so chroma is kept. Optionally dim the background slightly instead of only lifting the face, as Studio Light does [a22].
4. **Fairness guard rails.** No additive lifts (they grey skin; inferred from the "ashy" stray-light effect Google describes [a78]). Keep the chroma ratio when brightening and apply at most a mild saturation correction [a17]. Report every face metric per skin-tone group (Q10).

---

## Q6. Mains flicker and rolling-shutter banding

### Findings

- Rolling shutters expose rows at different times, so flicker from AC light shows as horizontal bands; lamps flicker at twice the mains frequency (100 or 120 Hz) [a87].
- Cameras avoid it by using exposures that are integer multiples of the flicker period wherever possible [a90]. Android exposes OFF, 50HZ, 60HZ and AUTO antibanding modes [a91]. libcamera exposes FlickerOff, FlickerManual (period 10000 us for 50 Hz mains, 8333 us for 60 Hz) and FlickerAuto, and reports the detected period [a90]. If the needed exposure is shorter than the period (for example 5 ms), flicker cannot be cancelled by exposure [a98].
- V4L2 has a power-line-frequency control with values disabled, 50 Hz, 60 Hz and auto [a92]. The W3C Image Capture API has no such control [a93].
- **Detection.** The expired patent US7187405 (Agilent/Avago; "Expired - Lifetime", adjusted expiry 2024-11-06 per Google Patents) averages each row, subtracts the row profiles of two successive frames so static content cancels, then correlates with 100 Hz and 120 Hz sinusoids; correlating over 0.05 s keeps the two bases orthogonal; quadrature bases give the phase; the frame rate may be varied slightly so static bands move [a89].
- **Correction.** Per-row digital gain from measured row luminance is a patented approach (US11588985) [a97]. Sheinin et al. model rolling-shutter flicker on the electric grid and include image deflicker [a87]; this work is patented (US11212459) [a88], status UNVERIFIED.
- **Learned work** (not real-time on an iGPU): BurstDeflicker (NeurIPS 2025, 4,000 real flicker images plus synthesis; repo Apache-2.0) [a94][a95]; RIFLE, a diffusion model [a96].
- ffmpeg's `deflicker` only smooths whole-frame luminance with a moving average [a29]; it does not touch row banding. I found no maintained open-source real-time row-banding corrector (GitHub search on 2026-11-06 returned one experimental RAW-photo tool).

**Exposure model (Derived).** Integrating a sinusoidal flicker component of frequency `f` over exposure `E` scales its amplitude by `|sin(pi f E) / (pi f E)|`. For 100 Hz flicker:

| Exposure | Factor | Context |
|---|---|---|
| 10, 20, 30 ms | 0 | Correct 50 Hz setting |
| 8.33 ms | 0.19 | Camera set to 60 Hz under 50 Hz light |
| 16.7 ms | 0.17 | same |
| 25 ms | 0.13 | same |
| 33.3 ms | 0.08 | same |
| 5 ms | 0.64 | Shorter than the period |

Going from 8.33 to 16.7 ms down to 5 ms raises banding about 3.3 to 3.9 times, which matches our "3 times worse" (our measurement).

**Band geometry (Derived, check per camera).** If readout spans most of a 33.3 ms frame of about 750 lines, a line takes about 44 us, so one 100 Hz period covers about 225 rows (about 3.2 bands per 720-row frame) and one 120 Hz period about 188 rows. At exactly 30 fps, 100 Hz advances 3.33 cycles per frame, so the bands step 120 degrees per frame and the average of 3 consecutive row profiles cancels the fundamental. 120 Hz advances exactly 4 cycles, so its bands are static and frame differencing cannot see them.

### Recommendation

1. **Detect actively, then fix in hardware.** In the native helper, switch the camera's power-line control between 50 Hz and 60 Hz for about 1 s each at startup (and when banding reappears), measure the periodic row energy, and keep the setting with less. This works for static and rolling bands alike. Use the patent's row-mean and frame-difference correlation [a89] as the passive monitor that triggers a re-probe.
2. **Our AE only picks flicker-safe exposures** (Q9). For a scene bright enough to need less than one period, lower gain first and go shorter only if highlights clip.
3. **Software correction as a fallback** (wrong setting cannot be changed, or exposure is forced below the period):
   - Row profile: mean linear luma per row, every 4th column, in about 8 vertical strips. Drop strips that overlap the face box.
   - Reference: for rolling bands, the mean of the last 3 frames' profiles (Derived cancellation above); otherwise a heavily low-passed version of the profile along rows.
   - Fit `log g(y) = a1 sin(2 pi y / P + phi1) + a2 sin(4 pi y / P + phi2)` by least squares, where `P` is found once by a period search and refined slowly. Take the median over strips. Predict the phase from its per-frame step to stay stable.
   - Shader: divide linear RGB by `g(y)` from a 720x1 texture. Leave clipped pixels alone.
4. Treat any per-row-gain correction as close to the patent in [a97]; get a legal check before shipping it. The detection approach is from an expired patent [a89].

---

## Q7. Auto white balance stabilisation and skin tone

### Findings

- **Grey-world family.** Grey-world and max-RGB are special cases of a Minkowski-norm estimator; grey-edge assumes the average edge difference is achromatic [a99]. In the 2005 results, mean angular error was 9.8 for grey-world, 9.2 for max-RGB, 6.3 for L6 grey-world (shades of grey) and 5.7 for L6 grey-edge [a100]. Edge type (material, shadow, highlight) matters [a99].
- **Learned but light.** FFCC runs at 700 fps on a mobile device and outputs a posterior that "enables simple and effective temporal smoothing" [a101]; code Apache-2.0 [a102]. Night Sight retrained FFCC for low light on 5,000 images [a1]. C5 (cross-camera) is Apache-2.0 [a103]. Both expect linear raw-like input (UNVERIFIED for post-ISP sRGB).
- **Face and skin priors.** Skin forms a tight cluster usable as an illuminant cue; Bianco and Schettini estimate the illuminant from detected faces, and switch to spatially varying correction when face estimates differ [a104][a105]. Individual skin colour variation hurts these estimates [a106]. The sclera is another near-white cue [a107].
- **Mixed light.** Afifi et al. blend several WB renderings with learned weight maps, but need ISP changes [a108]; repo licence NOASSERTION [a109]. Post-ISP sRGB re-balancing methods (WB_sRGB, Deep White Balance) are research-only [a110][a111].
- **Controls.** V4L2 has auto WB on/off and a manual colour temperature in kelvin [a92]. Image Capture has `whiteBalanceMode` and `colorTemperature` (kelvin, manual mode only) [a93].

### Recommendation

1. Treat the camera's AWB as the main correction and ours as a bounded residual (about 15% per channel at most). If the camera's AWB oscillates, lock it at our last smoothed estimate through the colour-temperature control [a92][a93] and let the residual follow slow drift.
2. Estimator: L6 grey-edge [a99][a100] on a 1/8-res linear image, excluding near-clipped pixels, very dark (noisy) pixels and the face mask.
3. Skin prior as a guard, not a driver: if the corrected face chroma would fall outside a broad skin locus, shrink the correction. Never pull faces to a "standard" skin colour [a106].
4. Mixed light (screen glow on the face, tungsten room): weight statistics near the face 2 to 3 times more than the background, accept some background cast, and do not attempt per-pixel correction.
5. Temporal: smooth in log-chromaticity with a time constant of about 2 to 4 s, a dead band of about 1 to 2% chroma, and a fast path only on scene cut (Q2). Values are starting points (UNVERIFIED), to tune with the Q10 colour-stability metric.

---

## Q8. MJPEG artefacts and detail restoration

### Findings

- **Chroma upsampling.** JPEG decoders choose their own chroma upsampling. libjpeg-turbo's `do_fancy_upsampling` is on by default (triangle filter; box when off), and browsers can differ [a116]. 75.3% of VCD2's webcam clips were captured as MJPEG [a117].
- **Deblocking.** ffmpeg's `deblock` filter (8-pixel blocks, weak or strong, tunable thresholds) is a reference [a29]. Basis Universal ships a small reference deblocking fragment shader and documents that block positions are known from the sample position, and that the work can be limited to pixels near block edges [a115]; Apache-2.0 (checked with `gh`). Shifted-DCT re-application (ffmpeg `spp`) is the classical higher-quality option [a120].
- **Sharpening without ringing.**
  - FSR 1 RCAS solves for the maximum local sharpness that does not clip, uses a 5-tap cross, includes a noise-detection term "to reduce the effect of RCAS on grain", and caps the lobe at `0.25 - 1/16` [a112].
  - CAS adapts sharpening per pixel, can scale in the same pass, and is MIT [a114]; ffmpeg has a `cas` filter [a29].
  - EASU is a single-pass, direction-adaptive approximation of Lanczos-2 with a 12-tap kernel. It removes ringing by clamping to the nearest 2x2 input texels. It is described as suited to "laptops and other low-end GPUs". It requires input without banding and without high-amplitude noise [a112].
  - FSR 1 is MIT [a113]. Its cost is 0.5 ms or less at 1440p on an RX 5700 XT class GPU [a113].
- **Does light super-resolution help on soft webcam frames?** In VCD2's crowdsourced study, blur and low resolution have the most negative MOS coefficients (about -1.0), then noise (-0.87) and choppy motion (-0.80); lighting and colour issues were flagged on 36.6% of clips [a117]. So perceived sharpness matters. VCD2's SR test (RealSR, SwinIR, RealViformer, BasicVSR++; 4x from 180p) reports VMAF but no baseline, so it does not show a visible gain [a117]. Anime4K shaders are MIT but tuned for anime [a118]; FSRCNNX ships with its own licence file in mpv shader bundles [a119] and its training code repo (igv/FSRCNN-TensorFlow) is GPL-3.0 (checked with `gh`), so the shader licence is UNVERIFIED.

### Recommendation

1. Denoise chroma at half res with luma guidance (Q3). It also hides chroma bleed from the decoder's upsampler [a46][a116].
2. Deblock only when needed: compute an 8x8 boundary-discontinuity ratio on luma every second or so; if above threshold, run a weak ffmpeg-style deblock pass across 8-pixel boundaries (16 pixels for subsampled chroma) [a29][a115].
3. Sharpen last with RCAS [a112] at a moderate setting. Scale it down where the tone stage applied large gain or where the noise mask is high. Do not use `FSR_RCAS_DENOISE`; we denoise earlier. RCAS replaces our 3.2 ms CPU unsharp mask (our measurement).
4. No super-resolution while input and output are both 720p. Use EASU only if we later process internally below 720p or the camera only offers a lower MJPEG mode at 30 fps, and only after denoising [a112]. CAS and FSR 1 are MIT [a113][a114].

---

## Q9. Our own auto exposure controlling the hardware

### Findings

- **Linux/V4L2.** `exposure_time_absolute` is in 100 us units [a121]. With auto exposure in AUTO or APERTURE_PRIORITY, `exposure_auto_priority` decides whether the device may vary the frame rate; it defaults to off [a121]. `gain` on most webcams is digital [a92]. libcamera's UVC pipeline converts its microsecond exposure to UVC's 100 us units and maps the default gain to 1.0 [a122].
- **Browser.** `exposureMode` manual plus `exposureTime` in 100 us units [a93]; support depends on OS, browser, camera and driver, with Chrome on Windows, Linux and Android reported as good from version 101 [a124]. A 2018 proposal notes the sensor shortens the exposure to the nearest possible value rather than lengthening it [a123].
- **Windows.** DirectShow's camera exposure is log base 2 seconds, so the steps are powers of two [a125]. The extended exposure property takes 100 ns units in manual mode (Windows 8.1 and later) [a126]. Derived: the log2 steps (7.8, 15.6, 31.25 ms) are not multiples of 10 or 8.33 ms; 15.6 ms leaves about 20% of the 100 Hz flicker amplitude.
- **Control-loop references.** libcamera's webcam AGC: proportional step `1 + clamp(0.04 x error, -0.15, +0.15)`, existing hysteresis kept, exposure raised first up to its maximum then gain, gain lowered first when too bright, about 3 s to converge from cold start with no visible oscillation [a30]. Hysteresis dead zone to stop hunting [a31]; about 0.5 EV hysteresis with a direction flag [a32]. Android's low-light face-priority mode raises sensitivity only after maximum exposure, and expects the app to denoise [a82].

### Recommendation

1. **Fix the frame rate.** Turn frame-rate priority off so the camera keeps 30 fps [a121]. Cap exposure at the largest flicker-safe value at or under 1/30 s: 10, 20 or 30 ms on 50 Hz; 8.33, 16.67, 25 or 33.33 ms on 60 Hz. Whether 33.33 ms is reachable at 30 fps depends on the sensor's blanking (UNVERIFIED; probe the capability range at startup).
2. **Quantise to the API.** Derived: in 100 us units, 1/120 s becomes 83 (8.3 ms), leaving under 1% of the flicker amplitude. On Windows use the 100 ns extended property when the driver supports it [a126]. If only log2 steps exist [a125], leave exposure to the camera's own AE with the correct power-line setting and apply only digital gain.
3. **Allocation order** (matches libcamera [a30] and Android [a82]): exposure (flicker-safe set) first, then camera gain, then our shader gain (cap about 4x, paired with denoise strength). Reverse the order when the scene brightens.
4. **Loop.** Work in EV. Dead band about 0.1 EV. Proportional step with a clamp of about 0.25 EV per update, as in [a30]. Update hardware no faster than its measured actuation latency (step the exposure once at startup and count frames until the change appears; UNVERIFIED per camera). Hardware steps are coarse (20 to 30 ms is +0.58 EV), so on the frame where a change lands, cancel it with the opposite shader gain and let the smooth loop take over. Detect the landing frame from the global brightness jump, because UVC frames rarely carry exposure metadata (UNVERIFIED).
5. **Metering** comes from Q5 (face band) and Q1 (scene log mean with highlight guard).

---

## Q10. How to prove it works

### Findings

- **NR-IQA is weak here:** Spearman correlation with human preference on low-light enhancement was NIMA 0.457, BRISQUE 0.321, ClipIQA 0.307, LIQE 0.225, MUSIQ 0.143 and NIQE -0.250; a detection-based measure scored 0.593 [a68].
- **Video papers** report AB(Var) and MABD for brightness consistency [a63], and warping error with optical flow for content consistency [a128]. MABD can be gamed: darker outputs score better [a127].
- **Products and webcam datasets:** VCD2 used ITU-T P.910 ACR via crowdsourcing (216 workers, about 7 votes per clip, colour-vision and display checks) plus ten quality tokens [a117]. Microsoft's crowdsourced P.910 toolkit is MIT [a130].
- **Colour:** CIEDE2000 test data and reference implementations [a136]; ColorChecker reference values include "dark skin" and "light skin" patches [a137].
- **Implementations and licences:** BRISQUE in OpenCV contrib's `quality` module [a131] (opencv_contrib Apache-2.0 [a132]); NIQE in scikit-video (BSD-3-Clause) [a133]; MUSIQ code in google-research (Apache-2.0) [a134], checkpoint licence UNVERIFIED. `pyiqa` (IQA-PyTorch) is **PolyForm Noncommercial 1.0.0** [a135]: fine for a private check, not as a project dependency.
- The face detector's own metrics (IOD-normalised landmark error and jitter, average precision) are defined in its model card [a33] and make a useful downstream proxy.

**Datasets.**

| Dataset | Content | Licence | Fit |
|---|---|---|---|
| VCD2 (Microsoft, 2026) | 838 camera-native talking-head clips from 799 people, 443 camera models; FFV1 lossless of MJPEG (75.3%) or raw; MOS and tokens incl. lighting, noise, banding, blockiness; gender and simplified ethnicity metadata [a117][a143] | Repo licence field CC-BY-4.0; README: docs CC BY 4.0, code MIT [a129]. Licence of the video files specifically: UNVERIFIED | **Best fit** |
| VCD (Microsoft, 2023) | 160 talking-head clips, 1080p30 [a129] | Same repo [a129] | Codec-oriented, less low light |
| DID (ICCV 2023) | Paired low/normal-light video, 2560x1440, five cameras [a138] | No licence stated (checked with `gh`) | Research reference only |
| SDSD (ICCV 2021) | 150 paired videos [a139] | No licence stated [a139]; frames not well aligned [a69] | Research reference only |
| DRV (ICCV 2019) | RAW static-camera low-light video [a70] | README says MIT [a70] | RAW, not post-ISP; limited fit |
| BVI-Lowlight | 40 scenes at 10% and 20% light, registered [a141] | IEEE DataPort login; licence field blank [a141] | Research reference |
| LLVIP | Visible-infrared surveillance pairs | Non-commercial only [a140] | Not relevant |
| BurstDeflicker | Flicker-banding images, real and synthetic [a94] | Repo Apache-2.0 [a95]; data terms UNVERIFIED | Banding detector tests |
| MST-E | 10-shade skin-tone examples, 19 subjects [a142] | UNVERIFIED | Fairness spot checks |

### Recommendation: automatic protocol

1. **Record a fixed clip set** of 20 to 30 s clips, with the raw MJPEG bitstream copied losslessly, so every run replays identical input:
   - Scenarios: dim front light; strong backlight (window); screen glow only; mixed tungsten and daylight; 50 Hz and 60 Hz fluorescent or LED (banding); talking with head turns and hand waves; lights switched on and off (step response); person leaving and re-entering (face loss); a ColorChecker held next to the face.
   - At least 3 laptops and participants across the Monk scale.
   - Add the VCD2 clips with high `token_light_percent`, noise, banding or blockiness [a143].
2. **Replay offline** through the same shaders in a headless browser. Baselines: passthrough; global gain plus gamma; OpenCV CLAHE; ffmpeg `hqdn3d` + `cas`; OBS Enhance (TBEFN).
3. **Metrics per clip**, all automatic:
   - **Face exposure:** p50 and p95 of skin-mask luma; percent of frames inside the Q5 band; percent of face pixels at 250 or above. Report by skin-tone group.
   - **Skin colour:** temporal standard deviation of face a* and b*; hue shift against input; ΔE2000 on ColorChecker skin and neutral patches when present [a136][a137].
   - **Noise:** temporal sigma in static background patches after removing global drift; Immerkaer sigma in flat areas [a44]; noise-gain ratio `sigma_out / (sigma_in x applied gain)`; chroma sigma separately.
   - **Temporal stability:** MABD and AB(Var) on static regions [a63], read together with mean brightness because darker scores better [a127]; the spectrum of static-region mean luma from 0.5 to 10 Hz; step response (overshoot, settling time).
   - **Banding:** row-profile spectral peak at the flicker period, relative to the noise floor, the same measure as our 4 to 7x baseline (our measurement).
   - **Ghosting:** warping error on the face region with optical flow [a128].
   - **Sharpness and ringing:** gradient energy in the face region against input; overshoot ratio at strong edges.
   - **Downstream:** BlazeFace detection rate, confidence and landmark jitter [a33].
   - **Secondary:** BRISQUE, NIQE and MUSIQ [a131][a133][a134], with their weak correlation [a68] noted in every report.
   - **Cost:** GPU ms per frame from timer queries, CPU ms, dropped frames.
4. **Gate every change** on regressions against the previous build. Starting thresholds to tune (UNVERIFIED): face p50 in band on 95% of frames; face clipping under 0.5%; banding peak under 1.5x the noise floor; noise-gain ratio under 0.7; warping error no worse than passthrough plus 10%; GPU time under 8 ms per 720p frame on a UHD 620.
5. **Human truth, periodically:** P.910 ACR or pairwise comparison with the MIT toolkit [a130] on 30 to 60 clips stratified by skin tone and scenario. Any learned model (Q4) must win here, not only on metrics.

---

## Licence summary

| Component | Licence | Use? |
|---|---|---|
| MediaPipe BlazeFace, Face Mesh V2 | Apache-2.0 [a33][a74] | Yes |
| YuNet (opencv_zoo) | MIT [a75] | Yes |
| FidelityFX CAS, FSR 1 (EASU, RCAS) | MIT [a113][a114] | Yes |
| Wronski local tone-mapping demo | Public domain [a8] | Yes (reference) |
| Basis Universal deblock shader | Apache-2.0 [a115] | Yes (reference) |
| google/hdrnet | Apache-2.0, archived [a4] | Reference only |
| FFCC, C5 | Apache-2.0 [a102][a103] | Not needed in v1 |
| IAT | Apache-2.0, code partly from Zero-DCE [a54] | Not in v1 |
| FastLLVE | Apache-2.0 [a64] | Future |
| StableLLVE | MIT [a65] | Too heavy |
| TBEFN / URetinex-Net / SG-LLIE | BSD-3 / MIT / MIT [a60][a61][a62] | Baseline only |
| Zero-DCE, Zero-DCE++ | CC BY-NC 4.0 [a48][a49] | No |
| SCI, RUAS, PairLIE, Zero-TIG, Accelerated-CLAHE | No licence [a51][a53][a55][a15] | No |
| WB_sRGB, Deep White Balance | Research only [a110][a111] | No |
| pyiqa (IQA-PyTorch) | PolyForm Noncommercial [a135] | Not as a dependency |
| obs-backgroundremoval | GPL-3.0 [a58] | Baseline only |

## Patent watch list (for a legal check)

- US10116916 (NVIDIA), variance clipping of temporal history: Active, expected expiry 2037 [a43]. Use min/max clamping.
- US11588985, per-row digital gain against flicker [a97]: status UNVERIFIED. Affects the Q6 fallback.
- US11212459 (Technion, Toronto), rolling-shutter imaging on the electric grid [a88]: status UNVERIFIED.
- Bilateral grid: code version 0.2 was withdrawn over patent issues [a5]. Not used here.
- Expired per Google Patents: US7187405 flicker detection [a89]; US6836288 and US6970198 AE hysteresis [a31][a32].

## Open items to test on our hardware

- GPU cost of each pass on an Intel UHD at 720p (WebGL2 and WebGPU). All per-pass costs above are Derived.
- Line time and band period per camera; whether 33.33 ms exposure is reachable at 30 fps; exposure actuation latency.
- Whether Chrome's `exposureTime` on Windows maps to the 100 ns extended property or to log2 steps.
- Whether VCD2's video files carry the repo's CC BY 4.0 terms; MST-E and BurstDeflicker data terms.
- Face-band thresholds across the Monk scale.

---

## References

[a1]: https://ar5iv.labs.arxiv.org/html/1910.11336
[a2]: https://research.google/blog/live-hdr-and-dual-exposure-controls-on-pixel-4-and-4a/
[a3]: https://people.csail.mit.edu/hasinoff/pubs/GharbiEtAl17-hdrnet.pdf
[a4]: https://github.com/google/hdrnet
[a5]: https://groups.csail.mit.edu/graphics/bilagrid/
[a6]: https://imagine.enpc.fr/~aubrym/projects/llf/index.html
[a7]: https://www.jankautz.com/publications/exposure_fusion.pdf
[a8]: https://bartwronski.com/2022/02/28/exposure-fusion-local-tonemapping-for-real-time-rendering/
[a9]: https://bartwronski.github.io/local_tonemapping_js_demo/
[a10]: https://people.csail.mit.edu/kaiming/publications/pami12guidedfilter.pdf
[a11]: https://ar5iv.labs.arxiv.org/html/1505.00996
[a12]: https://www.cl.cam.ac.uk/~rkm38/pdfs/eilertsen2015rt_na_tmo.pdf
[a13]: https://www.cl.cam.ac.uk/~rkm38/pdfs/eilertsen2017tmo_star.pdf
[a14]: https://en.wikipedia.org/wiki/Adaptive_histogram_equalization
[a15]: https://github.com/YuAo/Accelerated-CLAHE
[a16]: https://www.atlantis-press.com/article/25844973.pdf
[a17]: https://www.cl.cam.ac.uk/~rkm38/pdfs/mantiuk09cctm.pdf
[a18]: https://workspaceupdates.googleblog.com/2021/09/improved-visibility-in-google-meet-on.html
[a19]: https://support.google.com/meet/answer/10058482
[a20]: https://comsupport.fau.edu/kb/articles/zoom-features-enhancing-your-video-in-zoom
[a21]: https://groups.google.com/a/chromium.org/g/blink-dev/c/fG8V4YeLByM
[a22]: https://support.apple.com/en-asia/guide/mac-help/mchlff01c919/13.0/mac/13.0
[a23]: https://support.microsoft.com/en-us/windows/ai/ai-features/windows-studio-effects
[a24]: https://developer.mozilla.org/docs/Web/API/WebGL2RenderingContext
[a25]: https://www.khronos.org/webgl/public-mailing-list/public_webgl/1712/msg00009.php
[a26]: https://developer.chrome.com/blog/new-in-webgpu-113
[a27]: https://www.techpowerup.com/gpu-specs/uhd-graphics-620-mobile.c2909
[a28]: https://arxiv.org/html/2601.01865v1
[a29]: https://ffmpeg.org/ffmpeg-filters.html
[a30]: https://patchwork.libcamera.org/patch/26648/
[a31]: https://patents.google.com/patent/US6836288B1/en
[a32]: https://patents.google.com/patent/US6970198B1/en
[a33]: https://storage.googleapis.com/mediapipe-assets/MediaPipe%20BlazeFace%20Model%20Card%20(Short%20Range).pdf
[a34]: https://ar5iv.labs.arxiv.org/html/1807.04686
[a35]: https://cg.ivd.kit.edu/publications/2017/svgf/svgf_preprint.pdf
[a36]: https://cg.ivd.kit.edu/atf.php
[a37]: https://www.uni-ulm.de/fileadmin/website_uni_ulm/iui.inst.100/institut/Papers/atrousGIfilter.pdf
[a38]: https://patents.google.com/patent/US8564724
[a39]: https://doi.org/10.1109/tcom.1984.1096143
[a40]: https://repositorio.ufsc.br/handle/123456789/174438?show=full
[a41]: https://aminer.org/pub/5c756c2ef56def97984621db/real-time-video-denoising-on-multicores-and-gpus-with-kalman-based-and
[a42]: https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf
[a43]: https://patents.google.com/patent/US10116916B2/en
[a44]: https://loli.github.io/medpy/generated/medpy.filter.noise.immerkaer.html
[a45]: https://www.mvtec.com/doc/halcon/2411/en/estimate_noise.html
[a46]: https://johanneskopf.de/publications/jbu/paper/FinalPaper_0185.pdf
[a47]: https://docs.nvidia.com/maxine/vfx/Filters/WebcamDenoiser.html
[a48]: https://github.com/Li-Chongyi/Zero-DCE
[a49]: https://github.com/Li-Chongyi/Zero-DCE_extension
[a50]: https://arxiv.org/abs/2103.00860
[a51]: https://github.com/vis-opt-group/SCI
[a52]: https://ar5iv.labs.arxiv.org/html/2204.10137
[a53]: https://github.com/KarelZhang/RUAS
[a54]: https://github.com/cuiziteng/Illumination-Adaptive-Transformer
[a55]: https://github.com/zhenqifu/PairLIE
[a56]: https://github.com/royshil/obs-backgroundremoval/blob/main/src/enhance-filter.cpp
[a57]: https://github.com/royshil/obs-backgroundremoval/blob/main/src/consts.h
[a58]: https://github.com/royshil/obs-backgroundremoval/tree/main/data/models
[a59]: https://github.com/royshil/obs-backgroundremoval/blob/main/src/ort-utils/ort-session-utils.cpp
[a60]: https://github.com/lukun199/TBEFN
[a61]: https://github.com/AndersonYong/URetinex-Net
[a62]: https://github.com/ShenZheng2000/Semantic-Guided-Low-Light-Image-Enhancement
[a63]: https://arxiv.org/html/2308.06749
[a64]: https://github.com/Wenhao-Li-777/FastLLVE
[a65]: https://github.com/zkawfanx/StableLLVE
[a66]: https://link.springer.com/article/10.1007/s11760-026-05297-3
[a67]: https://arxiv.org/pdf/2103.10621
[a68]: https://arxiv.org/html/2410.08810
[a69]: https://arxiv.org/html/2402.01970v2
[a70]: https://github.com/cchen156/Seeing-Motion-in-the-Dark
[a71]: https://arxiv.org/pdf/2503.11175
[a72]: https://developers.google.com/edge/mediapipe/solutions/vision/face_detector
[a73]: https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker
[a74]: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf
[a75]: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
[a76]: https://link.springer.com/10.1007/s11633-023-1423-y
[a77]: https://library.imaging.org/ei/articles/31/4/art00004
[a78]: https://store.google.com/intl/en_uk/ideas/articles/inclusive-photography-real-tone/
[a79]: https://theshumba.github.io/framecoach-blog/how-to-expose-a-shot-correctly
[a80]: https://www.dvinfo.net/forum/open-dv-discussion/341200-zebras-70-what-2.html
[a81]: https://learn.microsoft.com/en-us/dotnet/api/android.hardware.camera2.controlscenemode?view=net-android-37.0
[a82]: https://android.googlesource.com/platform/frameworks/base/+/ee2ebde%5E%21/
[a83]: https://research.google/blog/consensus-and-subjectivity-of-skin-tone-annotation-for-ml-fairness/
[a84]: https://research.google/blog/portrait-light-enhancing-portrait-lighting-with-machine-learning/
[a85]: https://openaccess.thecvf.com/content/CVPR2024/html/Cai_Real-time_3D-aware_Portrait_Video_Relighting_CVPR_2024_paper.html
[a86]: https://arxiv.org/pdf/2311.08843
[a87]: https://webee.technion.ac.il/~yoav/publications/Mark%20-%20Rolling%20Shutter%20Imaging%20on%20The%20Electric%20Grid%202018.pdf
[a88]: https://patents.google.com/patent/US11212459
[a89]: https://patents.google.com/patent/US7187405B2/en
[a90]: https://patchwork.libcamera.org/patch/18853/
[a91]: https://learn.microsoft.com/en-us/dotnet/api/android.hardware.camera2.controlaeantibanding?view=net-android-37.0
[a92]: https://docs.kernel.org/userspace-api/media/v4l/control.html
[a93]: https://w3c.github.io/mediacapture-image/
[a94]: https://arxiv.org/html/2510.09996v1
[a95]: https://github.com/qulishen/BurstDeflicker
[a96]: https://arxiv.org/html/2509.24644v3
[a97]: https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11588985
[a98]: https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/52337523/avoid-banding-using-android-s-camera2-api
[a99]: https://thoth.inrialpes.fr/people/vandeweijer/papers/ColorConstancyIP.pdf
[a100]: https://thoth.inrialpes.fr/people/vandeweijer/papers/cr2542.pdf
[a101]: https://arxiv.org/abs/1611.07596
[a102]: https://github.com/google/ffcc
[a103]: https://github.com/mahmoudnafifi/C5
[a104]: https://boa.unimib.it/handle/10281/41841
[a105]: https://boa.unimib.it/handle/10281/56695
[a106]: https://www.mi.tj.chiba-u.jp/~tsumura/Tsumura/papers/OR2016tanaka.pdf
[a107]: https://koasas.kaist.ac.kr/handle/10203/239798?mode=full
[a108]: https://openaccess.thecvf.com/content/WACV2022/html/Afifi_Auto_White-Balance_Correction_for_Mixed-Illuminant_Scenes_WACV_2022_paper.html
[a109]: https://github.com/mahmoudnafifi/mixedillWB
[a110]: https://github.com/mahmoudnafifi/WB_sRGB
[a111]: https://github.com/mahmoudnafifi/Deep_White_Balance
[a112]: https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/master/ffx-fsr/ffx_fsr1.h
[a113]: https://gpuopen.com/fidelityfx-superresolution/
[a114]: https://gpuopen.com/fidelityfx-cas/
[a115]: https://github.com/BinomialLLC/basis_universal/wiki/Shader-and-In-Loop-Deblocking
[a116]: https://nigeltao.github.io/blog/2024/jpeg-chroma-upsampling.html
[a117]: https://arxiv.org/html/2603.26763
[a118]: https://github.com/bloc97/Anime4K
[a119]: https://archlinux.org/packages/extra/any/mpv-shim-default-shaders/files
[a120]: https://arxiv.org/pdf/1605.00366
[a121]: https://docs.kernel.org/userspace-api/media/v4l/ext-ctrls-camera.html
[a122]: https://patchwork.libcamera.org/patch/3372
[a123]: https://lists.w3.org/Archives/Public/public-media-capture/2018Mar/0004.html
[a124]: https://webrtchacks.com/?p=3807
[a125]: https://learn.microsoft.com/en-us/windows/win32/api/strmif/ne-strmif-cameracontrolproperty
[a126]: https://learn.microsoft.com/nb-no/windows-hardware/drivers/stream/ksproperty-cameracontrol-extended-exposuremode
[a127]: https://arxiv.org/pdf/2511.09609
[a128]: https://arxiv.org/abs/1808.00449
[a129]: https://github.com/microsoft/VCD
[a130]: https://github.com/microsoft/P.910
[a131]: https://docs.opencv.org/ref/master/d6/d00/qualitybrisque_8hpp.html
[a132]: https://github.com/opencv/opencv_contrib
[a133]: https://github.com/scikit-video/scikit-video/blob/master/skvideo/measure/niqe.py
[a134]: https://github.com/google-research/google-research/tree/master/musiq
[a135]: https://github.com/chaofengc/IQA-PyTorch
[a136]: https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/
[a137]: https://mail.babelcolor.com/index_htm_files/RGB%20Coordinates%20of%20the%20Macbeth%20ColorChecker.pdf
[a138]: https://openaccess.thecvf.com/content/ICCV2023/html/Fu_Dancing_in_the_Dark_A_Benchmark_towards_General_Low-light_Video_ICCV_2023_paper.html
[a139]: https://github.com/dvlab-research/SDSD
[a140]: https://github.com/bupt-ai-cz/LLVIP
[a141]: https://ieee-dataport.org/open-access/bvi-lowlight-fully-registered-datasets-low-light-image-and-video-enhancement
[a142]: https://arxiv.org/abs/2305.09073
[a143]: https://vcdpublic.blob.core.windows.net/vcd2/metadata/README.md
