"""Compare scored variants metric by metric.

Usage: python eval/compare.py <out_root> <variant> [<variant> ...] [--clips a,b]
Reads <out_root>/<variant>.json (written by eval/metrics.py). Prints the mean over clips per metric,
then the per-clip values for the metrics that matter most.
"""
import json, sys, os, math

args = sys.argv[1:]
only = None
if '--clips' in args:
    i = args.index('--clips')
    only = args[i + 1].split(',')
    del args[i:i + 2]
root, variants = args[0], args[1:]
data = {v: json.load(open(os.path.join(root, v + '.json'))) for v in variants}
clips = [c for c in data[variants[0]] if (not only or c in only) and all(c in data[v] for v in variants)]

# metric, whether lower is better
METRICS = [('face_exposure_err', True), ('face_luma', None), ('face_contrast', False), ('blown_pct', True),
           ('wall_sigma', True), ('dark_sigma', True), ('cnr', False), ('banding_rel_pct', True), ('flicker_rel_pct', True),
           ('detail_vs_ref', False), ('wall_colour_err', True), ('skin_colour_err', True), ('shirt_colour_err', True)]


def mean(vals):
    vals = [v for v in vals if v is not None and not (isinstance(v, float) and math.isnan(v))]
    return sum(vals) / len(vals) if vals else float('nan')


print(f'mean over {len(clips)} clips: {", ".join(clips)}')
print(f'{"metric":20s}' + ''.join(f'{v[:12]:>13s}' for v in variants) + '   better')
for m, lower in METRICS:
    row = [mean([data[v][c].get(m) for c in clips]) for v in variants]
    tag = '' if lower is None else ('lower' if lower else 'higher')
    print(f'{m:20s}' + ''.join(f'{x:13.2f}' for x in row) + f'   {tag}')
for m in ('face_luma', 'dark_sigma', 'shirt_colour_err', 'skin_colour_err'):
    print(f'\n{m}')
    for c in clips:
        print(f'  {c:20s}' + ''.join(f'{data[v][c].get(m, float("nan")):13.2f}' for v in variants))
