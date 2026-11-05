"""Score a variant (a folder of processed frames per clip) against the same-scene reference clip.

Layout:  <root>/<variant>/<clip>/NNNN.(jpg|png)     variant "raw" is the camera frames
         <frames_root>/<clip>/faces.json            from eval/annotate.py
         <frames_root>/dataset.json                 {"reference": clip, "rois": {name: [x, y, w, h]}}

Usage: python eval/metrics.py <frames_root> <variant_dir> [--json out.json]

Every number is display-referred (8-bit sRGB values). Nothing here knows how the frames were made.
"""
import cv2, numpy as np, json, sys, os, glob

FACE_TARGET = (95.0, 150.0)  # acceptable band for median face luma, 8-bit sRGB


def load_clip(d):
    files = sorted(glob.glob(os.path.join(d, '*.jpg')) + glob.glob(os.path.join(d, '*.png')))
    return [cv2.imread(f) for f in files]


def luma(bgr):
    return bgr[..., 0] * 0.0722 + bgr[..., 1] * 0.7152 + bgr[..., 2] * 0.2126


def crop(a, r):
    x, y, w, h = r
    return a[y:y + h, x:x + w]


def lab_mean(bgr_patch):
    lab = cv2.cvtColor((bgr_patch.astype(np.float32) / 255.0), cv2.COLOR_BGR2Lab)
    return lab.reshape(-1, 3).mean(0)


def clip_stats(frames, faces, rois):
    Y = np.stack([luma(f.astype(np.float32)) for f in frames])
    n = len(frames)
    s = {'frames': n}

    # exposure
    s['mean_luma'] = float(Y.mean())
    s['blown_pct'] = float((Y >= 250).mean() * 100)
    s['crushed_pct'] = float((Y <= 5).mean() * 100)

    # face: inner 60% of the annotated box so background does not leak in
    if faces and any(b is not None for b in faces):
        med, con, ab = [], [], []
        for i, b in enumerate(faces[:n]):
            if b is None:
                continue
            x, y, w, h = b
            inner = [x + int(w * 0.2), y + int(h * 0.2), int(w * 0.6), int(h * 0.6)]
            p = crop(Y[i], inner)
            if p.size < 100:
                continue
            med.append(np.median(p))
            con.append(np.percentile(p, 90) - np.percentile(p, 10))
            ab.append(lab_mean(crop(frames[i], inner)))
        s['face_luma'] = float(np.median(med))
        s['face_luma_wobble'] = float(np.std(np.array(med) - cv2.blur(np.array(med, np.float32).reshape(-1, 1), (1, 15)).ravel()))
        s['face_contrast'] = float(np.median(con))
        s['face_lab'] = [float(v) for v in np.mean(ab, axis=0)]
        lo, hi = FACE_TARGET
        s['face_exposure_err'] = float(max(lo - s['face_luma'], 0, s['face_luma'] - hi))

    # temporal noise in static regions, from consecutive-frame differences
    D = np.diff(Y, axis=0)
    live = np.abs(D).reshape(n - 1, -1).max(1) > 0  # drop exact repeats (camera at half rate)
    D = D[live] if live.any() else D
    mean_frame = np.mean(frames, axis=0)
    for name in ('wall', 'dark'):
        m = float(crop(Y.mean(0), rois[name]).mean())
        sig = float(np.median([crop(d, rois[name]).std() for d in D]) / np.sqrt(2))
        s[f'{name}_luma'] = m
        # a clipped patch has no noise because it has no signal: report it as unmeasurable
        s[f'{name}_sigma'] = sig if m < 245 else float('nan')
        s[f'{name}_lab'] = [float(v) for v in lab_mean(crop(mean_frame, rois[name]))]
    if 'shirt' in rois:
        s['shirt_lab'] = [float(v) for v in lab_mean(crop(mean_frame, rois['shirt']))]
    # what a viewer weighs: how much shape the face has against how much grain the picture has
    if 'face_contrast' in s:
        s['cnr'] = float(s['face_contrast'] / np.nanmean([s['wall_sigma'], s['dark_sigma']]))

    # mains banding: horizontal stripes that move between frames, measured on the static wall strip
    wx, wy, ww, wh = rois['wall']
    band = np.median([d[wy:wy + wh, wx:wx + ww].mean(1).std() for d in D]) / np.sqrt(2)
    floor = np.nan_to_num(s['wall_sigma']) / np.sqrt(ww)
    s['banding_rel_pct'] = float(max(band - floor, 0) / max(s['wall_luma'], 1e-3) * 100)

    # brightness flicker: wall mean over time, slow drift removed
    wm = np.array([crop(y, rois['wall']).mean() for y in Y], np.float32)
    s['flicker_rel_pct'] = float(np.std(wm - cv2.blur(wm.reshape(-1, 1), (1, 15)).ravel()) / max(wm.mean(), 1e-3) * 100)

    # detail on static edges, from the temporal mean so noise cannot pose as sharpness
    t = crop(Y.mean(0), rois['texture'])
    gx, gy = cv2.Sobel(t, cv2.CV_32F, 1, 0), cv2.Sobel(t, cv2.CV_32F, 0, 1)
    spread = float(np.percentile(t, 95) - np.percentile(t, 5))
    s['detail'] = float(np.sqrt(gx ** 2 + gy ** 2).mean() / max(spread, 1.0))
    s['texture_contrast'] = spread

    # posterisation: share of 8-bit levels actually used across the smooth wall
    fills = []
    for y in Y[:: max(n // 8, 1)]:
        p = np.round(crop(y, rois['wall'])).astype(np.int32)
        lo, hi = np.percentile(p, 2), np.percentile(p, 98)
        fills.append(len(np.unique(p[(p >= lo) & (p <= hi)])) / max(hi - lo + 1, 1))
    s['level_fill'] = float(np.median(fills))
    return s


def compare(s, ref):
    """Distances to the well-exposed reference rendering of the same scene."""
    out = {}

    def colour_err(a, b):
        # same surface under more light keeps its hue and its chroma-to-lightness ratio
        k = float(np.clip(a[0] / max(b[0], 1e-3), 0.3, 3.0))
        return float(np.hypot(a[1] - b[1] * k, a[2] - b[2] * k))

    for name in ('wall', 'dark'):
        out[f'{name}_luma_err'] = abs(s[f'{name}_luma'] - ref[f'{name}_luma'])
    for name, key in (('wall', 'wall_lab'), ('skin', 'face_lab'), ('shirt', 'shirt_lab')):
        if key in s and key in ref:
            out[f'{name}_colour_err'] = colour_err(s[key], ref[key])
    out['detail_vs_ref'] = s['detail'] / max(ref['detail'], 1e-6)
    return out


COLS = ['face_luma', 'face_exposure_err', 'face_contrast', 'blown_pct', 'wall_luma', 'wall_sigma', 'dark_luma', 'dark_sigma', 'cnr',
        'banding_rel_pct', 'flicker_rel_pct', 'detail_vs_ref', 'wall_colour_err', 'skin_colour_err', 'shirt_colour_err']


def main():
    frames_root, variant_dir = sys.argv[1], sys.argv[2]
    ds = json.load(open(os.path.join(frames_root, 'dataset.json')))
    ref_stats_path = os.path.join(frames_root, 'reference_stats.json')
    if not os.path.exists(ref_stats_path):
        ref_dir = os.path.join(frames_root, ds['reference'])
        ref = clip_stats(load_clip(ref_dir), json.load(open(os.path.join(ref_dir, 'faces.json'))), ds['rois'])
        json.dump(ref, open(ref_stats_path, 'w'))
    ref = json.load(open(ref_stats_path))
    results = {}
    for clip in sorted(os.listdir(variant_dir)):
        d = os.path.join(variant_dir, clip)
        fj = os.path.join(frames_root, clip, 'faces.json')
        if not os.path.isdir(d) or not os.path.exists(fj):
            continue
        frames = load_clip(d)
        if len(frames) < 3:
            continue
        s = clip_stats(frames, json.load(open(fj)), ds['rois'])
        s.update(compare(s, ref))
        results[clip] = s
    if '--json' in sys.argv:
        json.dump(results, open(sys.argv[sys.argv.index('--json') + 1], 'w'), indent=1)
    print(f'{"clip":20s}' + ''.join(f'{c[:10]:>11s}' for c in COLS))
    for clip, s in results.items():
        print(f'{clip:20s}' + ''.join(f'{s[c]:11.2f}' if c in s else f'{"-":>11s}' for c in COLS))


if __name__ == '__main__':
    main()
