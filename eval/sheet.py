"""Side-by-side contact sheet: one row per clip, one column per variant, same frame.

Usage: python eval/sheet.py <out.jpg> <frame_no> <variant_dir> [<variant_dir> ...] [--clips a,b] [--crop x,y,w,h]
"""
import cv2, numpy as np, sys, os, glob

args = sys.argv[1:]
opt = {}
for k in ('--clips', '--crop'):
    if k in args:
        i = args.index(k)
        opt[k] = args[i + 1]
        del args[i:i + 2]
out, frame_no, variants = args[0], int(args[1]), args[2:]
clips = sorted(d for d in os.listdir(variants[0]) if os.path.isdir(os.path.join(variants[0], d)))
if '--clips' in opt:
    clips = [c for c in clips if c in opt['--clips'].split(',')]
crop = [int(v) for v in opt['--crop'].split(',')] if '--crop' in opt else None
rows = []
for clip in clips:
    tiles = []
    for v in variants:
        files = sorted(glob.glob(os.path.join(v, clip, '*.jpg')) + glob.glob(os.path.join(v, clip, '*.png')))
        if not files:
            tiles.append(np.zeros((360, 640, 3), np.uint8))
            continue
        im = cv2.imread(files[min(frame_no, len(files) - 1)])
        if crop:
            x, y, w, h = crop
            im = im[y:y + h, x:x + w]
            im = cv2.resize(im, (640, int(640 * h / w)), interpolation=cv2.INTER_NEAREST if w < 400 else cv2.INTER_AREA)
        else:
            im = cv2.resize(im, (640, 360), interpolation=cv2.INTER_AREA)
        label = f'{os.path.basename(os.path.normpath(v))} / {clip}'
        cv2.putText(im, label, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(im, label, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(im)
    h = min(t.shape[0] for t in tiles)
    rows.append(np.hstack([t[:h] for t in tiles]))
cv2.imwrite(out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])
print(out, np.vstack(rows).shape)
