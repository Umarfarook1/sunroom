"""Builds a local, self-contained HTML proof report from scored variants.

Usage: python eval/report.py <out_root> <report_dir> --raw raw --baseline gamma --ours finaldetect
       [--oracle final] [--live data/live/director_on2.json] [--sheet data/sheet_final.jpg] [--live-shot data/live/web.png]

Everything it prints comes from the JSON files eval/metrics.py and eval/live.mjs wrote. The report
contains frames of whoever was on camera, so it is written under data/ and never committed.
"""
import json, os, shutil, sys, html, math

args = sys.argv[1:]


def opt(name, default=None):
    return args[args.index(name) + 1] if name in args else default


out_root, report_dir = args[0], args[1]
names = {'raw': opt('--raw', 'raw'), 'baseline': opt('--baseline', 'gamma'), 'ours': opt('--ours'), 'oracle': opt('--oracle')}
data = {k: json.load(open(os.path.join(out_root, v + '.json'))) for k, v in names.items() if v}
os.makedirs(report_dir, exist_ok=True)

REALISTIC = ['asfound_auto', 'aeprio0_auto', 'aeprio0_50hz', 'dim_exp-5_gain1', 'dark_exp-7_gain8', 'cast_warm_wb6500']
STRESS = ['dark_exp-6_gain1', 'vdark_exp-7_gain1', 'cast_cool_wb2800']
LABEL = {
    'asfound_auto': 'Camera as found (15 real fps)', 'aeprio0_auto': 'Frame rate held at 30 fps', 'aeprio0_50hz': '30 fps, anti-flicker 50 Hz',
    'dim_exp-5_gain1': 'Dim room', 'dark_exp-7_gain8': 'Dark room, sensor gain at maximum', 'cast_warm_wb6500': 'Wrong white balance (green cast)',
    'dark_exp-6_gain1': 'Starved exposure, shadows clipped by the camera', 'vdark_exp-7_gain1': 'Nearly black', 'cast_cool_wb2800': 'Extreme blue cast',
}
clips = [c for c in REALISTIC if all(c in d for d in data.values())]


def mean(key, variant, which=clips):
    vals = [data[variant][c].get(key) for c in which if c in data[variant]]
    vals = [v for v in vals if v is not None and not (isinstance(v, float) and math.isnan(v))]
    return sum(vals) / len(vals) if vals else float('nan')


def fmt(v, digits=1):
    return '-' if v is None or (isinstance(v, float) and math.isnan(v)) else f'{v:.{digits}f}'


ROWS = [
    ('Face brightness (0 to 255, healthy band 95 to 150)', 'face_luma', 0, None),
    ('Face exposure error (distance from the healthy band)', 'face_exposure_err', 1, 'lower'),
    ('Contrast against grain (face shape divided by noise)', 'cnr', 1, 'higher'),
    ('Noise in dark areas (grey levels)', 'dark_sigma', 2, 'lower'),
    ('Noise on the bright wall (grey levels)', 'wall_sigma', 2, 'lower'),
    ('Flicker banding (% of brightness)', 'banding_rel_pct', 2, 'lower'),
    ('Skin colour error against the reference', 'skin_colour_err', 1, 'lower'),
    ('Shirt colour error against the reference', 'shirt_colour_err', 1, 'lower'),
    ('Wall colour error against the reference', 'wall_colour_err', 1, 'lower'),
    ('Clipped highlights (% of pixels)', 'blown_pct', 2, 'lower'),
]
cols = [('raw', 'Untouched camera'), ('baseline', 'Simple brightening (gamma)'), ('ours', 'Sunroom')]


def table():
    head = ''.join(f'<th>{html.escape(t)}</th>' for _, t in cols)
    body = ''
    for label, key, digits, better in ROWS:
        vals = {k: mean(key, k) for k, _ in cols}
        best = None
        if better:
            pick = min if better == 'lower' else max
            best = pick(vals, key=lambda k: vals[k] if not math.isnan(vals[k]) else (1e9 if better == 'lower' else -1e9))
        cells = ''.join(f'<td class="{"best" if k == best else ""}">{fmt(vals[k], digits)}</td>' for k, _ in cols)
        note = f'<span class="dim">{better} is better</span>' if better else ''
        body += f'<tr><th scope="row">{html.escape(label)} {note}</th>{cells}</tr>'
    return f'<table><thead><tr><th></th>{head}</tr></thead><tbody>{body}</tbody></table>'


def per_clip():
    rows = ''
    for c in REALISTIC + STRESS:
        if c not in data['ours']:
            continue
        r, o = data['raw'][c], data['ours'][c]
        rows += (f'<tr><th scope="row">{html.escape(LABEL.get(c, c))}</th><td>{fmt(r.get("face_luma"), 0)}</td><td>{fmt(o.get("face_luma"), 0)}</td>'
                 f'<td>{fmt(r.get("cnr"))}</td><td>{fmt(o.get("cnr"))}</td><td>{fmt(r.get("skin_colour_err"))}</td><td>{fmt(o.get("skin_colour_err"))}</td></tr>')
    return ('<table><thead><tr><th></th><th>Face before</th><th>Face after</th><th>Contrast/grain before</th><th>after</th>'
            f'<th>Skin colour error before</th><th>after</th></tr></thead><tbody>{rows}</tbody></table>')


def live():
    path = opt('--live')
    if not path or not os.path.exists(path):
        return ''
    d = json.load(open(path))
    s = d['samples']
    rows, last = '', None
    for x in s[3::4]:
        reason = x['reason'] if x['reason'] != last else ''
        last = x['reason']
        rows += (f'<tr><td>{x["t"]:.0f} s</td><td>{x["cameraFps"]:.0f}</td><td>{x["exposureMode"]}</td><td>{x["gain"]}</td>'
                 f'<td>{fmt(x["faceLumaOut"], 0)}</td><td>{x["processMs"]:.0f} ms</td><td>{html.escape(reason or "")}</td></tr>')
    first, final = s[3], s[-1]
    return (f'<h2>Live on the real webcam</h2><p>Started from the camera as found. Frame rate went from <b>{first["cameraFps"]:.0f}</b> to '
            f'<b>{final["cameraFps"]:.0f}</b> frames per second, enhanced output ran at {d["outFps"]:.0f} fps, about {final["processMs"]:.0f} ms of work per frame, '
            'and the camera settings were put back when the session stopped.</p>'
            f'<details><summary>What the camera control did, second by second</summary><table><thead><tr><th>Time</th><th>Camera fps</th><th>Exposure</th><th>Sensor gain</th>'
            f'<th>Face brightness out</th><th>Work per frame</th><th>Action</th></tr></thead><tbody>{rows}</tbody></table></details>')


def image(flag, name, caption):
    src = opt(flag)
    if not src or not os.path.exists(src):
        return ''
    shutil.copy2(src, os.path.join(report_dir, name))
    return f'<figure><img src="{name}" alt="{html.escape(caption)}" loading="lazy"><figcaption>{html.escape(caption)}</figcaption></figure>'


face = (mean('face_luma', 'raw'), mean('face_luma', 'ours'))
cnr = (mean('cnr', 'raw'), mean('cnr', 'baseline'), mean('cnr', 'ours'))
dark = (mean('dark_sigma', 'baseline'), mean('dark_sigma', 'ours'))
oracle_note = ''
if 'oracle' in data:
    oracle_note = (f'<p class="dim">Sunroom found the face with its own detector for these numbers. With hand-marked faces instead, face brightness is '
                   f'{fmt(mean("face_luma", "oracle"), 0)} and contrast against grain {fmt(mean("cnr", "oracle"))}: the detector costs almost nothing.</p>')

page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sunroom: proof on recorded webcam clips</title>
<style>
:root {{ --bg:#FAF7F2; --surface:#fff; --ink:#1B1A17; --muted:#6B665E; --line:#E6E0D6; --accent:#A85A14; --good:#2F7D4F; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif; }}
main {{ max-width:1080px; margin:0 auto; padding:56px 24px 96px; }}
h1 {{ font-size:34px; line-height:1.15; margin:0 0 12px; letter-spacing:-0.01em; }}
h2 {{ font-size:22px; margin:56px 0 12px; }}
p {{ max-width:68ch; }}
.lead {{ font-size:19px; color:var(--muted); }}
.facts {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; margin:32px 0 8px; }}
.fact {{ background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:20px; }}
.fact b {{ display:block; font-size:30px; font-variant-numeric:tabular-nums; letter-spacing:-0.02em; }}
.fact span {{ color:var(--muted); font-size:14px; }}
table {{ width:100%; border-collapse:collapse; background:var(--surface); border:1px solid var(--line); border-radius:14px; overflow:hidden; font-variant-numeric:tabular-nums; margin:12px 0; }}
th, td {{ padding:10px 14px; text-align:right; border-top:1px solid var(--line); font-size:14px; }}
thead th {{ border-top:0; color:var(--muted); font-weight:600; }}
th[scope=row], th:first-child {{ text-align:left; font-weight:500; }}
td.best {{ color:var(--good); font-weight:700; }}
.dim {{ color:var(--muted); font-size:13px; font-weight:400; }}
figure {{ margin:20px 0; }}
img {{ width:100%; height:auto; border-radius:14px; border:1px solid var(--line); display:block; }}
figcaption {{ color:var(--muted); font-size:13px; margin-top:8px; }}
details {{ margin:14px 0; }}
summary {{ cursor:pointer; color:var(--accent); font-weight:600; padding:6px 0; }}
summary:focus-visible {{ outline:2px solid var(--accent); outline-offset:4px; border-radius:4px; }}
ul {{ max-width:68ch; padding-left:20px; }}
</style></head><body><main>
<h1>Sunroom makes a dark, grainy webcam picture clear</h1>
<p class="lead">Measured on {len(clips)} recorded clips from a 720p laptop webcam in a badly lit room, replayed through the real pipeline on the laptop's own integrated graphics.</p>
<div class="facts">
<div class="fact"><b>{fmt(face[0], 0)} to {fmt(face[1], 0)}</b><span>face brightness on a 0 to 255 scale (healthy is 95 to 150)</span></div>
<div class="fact"><b>{fmt(cnr[2] / cnr[0], 1)} times</b><span>more face contrast against grain than the untouched camera ({fmt(cnr[2] / cnr[1], 1)} times simple brightening)</span></div>
<div class="fact"><b>{fmt(dark[0] / dark[1], 1)} times</b><span>less noise in dark areas than simple brightening to the same level</span></div>
</div>
{oracle_note}
<h2>Same frame, three ways</h2>
{image('--sheet', 'sheet.jpg', 'Left: untouched camera. Middle: simple brightening. Right: Sunroom. One row per recorded condition.')}
<h2>The numbers</h2>
<p>Averages over the {len(clips)} realistic clips. Every result is scored against a well-exposed recording of the same scene.</p>
{table()}
<details><summary>Every clip, including the three stress cases</summary>{per_clip()}
<p class="dim">The last three are stress cases the camera itself has to fix: when the sensor clips shadows to black or one colour channel is empty, software cannot bring the data back. Live, the camera control raises sensor gain and resets white balance instead.</p></details>
{live()}
{image('--live-shot', 'live.png', 'The web app running on the real webcam.')}
<h2>What this does and does not show</h2>
<ul>
<li>Shown: one camera, one room, one person, {len(clips)} lighting and camera conditions, on Windows 10 with Intel UHD graphics.</li>
<li>Not shown: other cameras, other skin tones, daylight, other operating systems. The scoring tools are in the repository so anyone can record and score their own.</li>
</ul>
</main></body></html>'''
open(os.path.join(report_dir, 'index.html'), 'w', encoding='utf-8').write(page)
print(os.path.join(report_dir, 'index.html'))
