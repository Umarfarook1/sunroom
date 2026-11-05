"""Simple baselines every enhancer must beat. They get the annotated face box for free
(an advantage the real pipeline does not have).

Usage: python eval/baselines.py <frames_root> <out_root>
Writes <out_root>/<baseline>/<clip>/NNNN.png for: gain, gamma, clahe_greyworld
"""
import cv2, numpy as np, json, sys, os, glob

TARGET = 115.0  # face median luma aimed for, 8-bit sRGB


def luma(bgr):
    return bgr[..., 0] * 0.0722 + bgr[..., 1] * 0.7152 + bgr[..., 2] * 0.2126


def to_lin(v):
    v = v / 255.0
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def to_srgb(v):
    v = np.clip(v, 0, 1)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055) * 255.0


def measured_level(frames, faces):
    """Median face luma over the first frames, or frame mean when no face is annotated."""
    vals = []
    for im, b in list(zip(frames, faces))[:10]:
        y = luma(im.astype(np.float32))
        if b is None:
            vals.append(y.mean() * 1.15)
        else:
            x, y0, w, h = b
            vals.append(np.median(y[y0 + int(h * .2):y0 + int(h * .8), x + int(w * .2):x + int(w * .8)]))
    return max(float(np.median(vals)), 0.5)


def gain(frames, level):
    g = float(to_lin(np.float32(TARGET)) / to_lin(np.float32(level)))
    lut = to_srgb(to_lin(np.arange(256, dtype=np.float32)) * g).astype(np.uint8)
    return [cv2.LUT(f, lut) for f in frames]


def gamma(frames, level):
    p = np.log(TARGET / 255.0) / np.log(level / 255.0)
    lut = (255.0 * (np.arange(256) / 255.0) ** p).astype(np.uint8)
    return [cv2.LUT(f, lut) for f in frames]


def clahe_greyworld(frames, level):
    clahe = cv2.createCLAHE(2.0, (8, 8))
    out = []
    for f in gamma(frames, level):
        m = f.reshape(-1, 3).mean(0) + 1e-3
        f = np.clip(f.astype(np.float32) * (m.mean() / m), 0, 255).astype(np.uint8)
        lab = cv2.cvtColor(f, cv2.COLOR_BGR2Lab)
        lab[..., 0] = clahe.apply(lab[..., 0])
        out.append(cv2.cvtColor(lab, cv2.COLOR_Lab2BGR))
    return out


def main(frames_root, out_root):
    for clip in sorted(glob.glob(os.path.join(frames_root, '*/'))):
        name = os.path.basename(os.path.dirname(clip))
        files = sorted(glob.glob(os.path.join(clip, '*.jpg')))
        frames = [cv2.imread(f) for f in files]
        faces = json.load(open(os.path.join(clip, 'faces.json')))
        level = measured_level(frames, faces)
        for fn in (gain, gamma, clahe_greyworld):
            d = os.path.join(out_root, fn.__name__, name)
            os.makedirs(d, exist_ok=True)
            for f, im in zip(files, fn(frames, level)):
                cv2.imwrite(os.path.join(d, os.path.basename(f)[:-4] + '.png'), im, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        print(f'{name}: measured level {level:.1f}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
