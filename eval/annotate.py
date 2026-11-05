"""Annotate a clip dataset with per-frame face boxes (YuNet), so metrics never depend on the
pipeline's own detector. Dark or colour-cast frames are normalised before detection.

Usage: python eval/annotate.py data/frames data/models/yunet.onnx
Writes <clip>/faces.json: one [x, y, w, h] (source pixels) or null per frame.
"""
import cv2, numpy as np, json, sys, os, glob


def normalise(bgr):
    """Grey-world balance + gain to mid brightness: detection aid only, never shown."""
    f = bgr.astype(np.float32)
    means = f.reshape(-1, 3).mean(0) + 1e-3
    f *= means.mean() / means
    gain = np.clip(110.0 / max(f.mean(), 1.0), 1.0, 14.0)
    return np.clip(f * gain, 0, 255).astype(np.uint8)


def main(frames_root, model):
    det = cv2.FaceDetectorYN.create(model, '', (640, 360), score_threshold=0.6)
    for clip in sorted(glob.glob(os.path.join(frames_root, '*/'))):
        files = sorted(glob.glob(os.path.join(clip, '*.jpg')))
        boxes = []
        for f in files:
            im = cv2.imread(f)
            h, w = im.shape[:2]
            small = cv2.resize(normalise(im), (640, 360), interpolation=cv2.INTER_AREA)
            _, faces = det.detect(small)
            if faces is None or not len(faces):
                boxes.append(None)
                continue
            x, y, bw, bh = max(faces, key=lambda q: q[2] * q[3])[:4] * (w / 640.0)
            boxes.append([int(x), int(y), int(bw), int(bh)])
        found = sum(b is not None for b in boxes)
        # fill gaps from the nearest detected frame so every frame is scored on a face region
        known = [i for i, b in enumerate(boxes) if b is not None]
        if known:
            boxes = [boxes[min(known, key=lambda k: abs(k - i))] for i in range(len(boxes))]
        json.dump(boxes, open(os.path.join(clip, 'faces.json'), 'w'))
        print(f'{os.path.basename(os.path.dirname(clip)):22s} frames {len(files):4d} face found in {found:4d}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
