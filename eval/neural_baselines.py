"""Published neural low-light enhancers, run on the same recorded frames as eval/baselines.py so that
eval/metrics.py scores them with the same code. Each frame is enhanced on its own at full resolution,
with no face box and no temporal filtering, the way the authors' test scripts run.

  zerodce        Zero-DCE++ (Li, Guo, Loy, TPAMI 2021), snapshot Epoch99.pth.
                 Licence: CC BY-NC 4.0, academic research only (the repository README).
  sci            SCI (Ma et al., CVPR 2022), weights/medium.pt: the default in the authors' test.py,
                 trained mainly on LOL and LSRW. Licence: MIT (CVPR/LICENSE in the repository).
  sci_easy       the same network with easy.pt (MIT-Adobe FiveK), for a sensitivity check.
  sci_difficult  the same network with difficult.pt (DARK FACE), for a sensitivity check.

The networks below are written from the papers so the published weights load. No upstream file is
copied here. The weights stay in data/models/ (gitignored) and are checked by SHA-256 before use.
Never commit them.

Usage:
  python eval/neural_baselines.py <frames_root> <out_root> [variant ...]   default: zerodce sci
      writes <out_root>/<variant>/<clip>/NNNN.png, then score with
      python eval/metrics.py <frames_root> <out_root>/<variant> --json <out_root>/<variant>.json
  python eval/neural_baselines.py --time <frames_root> [threads]          default threads: 2
      median per-frame time on this CPU, 8-bit BGR in to 8-bit BGR out, file I/O excluded
"""
import cv2, numpy as np, torch, torch.nn as nn, torch.nn.functional as F, hashlib, glob, os, sys, time

MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'models')
ZDCE = 'https://raw.githubusercontent.com/Li-Chongyi/Zero-DCE_extension/main/Zero-DCE++/snapshots_Zero_DCE++/Epoch99.pth'
SCI_W = 'https://raw.githubusercontent.com/vis-opt-group/SCI/main/CVPR/weights/'


class DSConv(nn.Module):
    """Depthwise 3x3 then pointwise 1x1, the Zero-DCE++ layer."""

    def __init__(self, cin, cout):
        super().__init__()
        self.depth_conv = nn.Conv2d(cin, cin, 3, padding=1, groups=cin)
        self.point_conv = nn.Conv2d(cin, cout, 1)

    def forward(self, x):
        return self.point_conv(self.depth_conv(x))


class ZeroDCEpp(nn.Module):
    """Seven layers with skip concatenations estimate one curve map from a 1/12 size copy; the
    quadratic curve x + a(x^2 - x) is then applied 8 times at full resolution."""

    def __init__(self):
        super().__init__()
        f = 32
        self.e_conv1, self.e_conv2, self.e_conv3, self.e_conv4 = DSConv(3, f), DSConv(f, f), DSConv(f, f), DSConv(f, f)
        self.e_conv5, self.e_conv6, self.e_conv7 = DSConv(2 * f, f), DSConv(2 * f, f), DSConv(2 * f, 3)

    def forward(self, x):
        h, w = x.shape[-2:]
        # the authors crop the frame to a multiple of 12; edge padding instead keeps all 1280 columns
        x = F.pad(x, (0, -w % 12, 0, -h % 12), mode='replicate')
        d = F.interpolate(x, scale_factor=1 / 12, mode='bilinear')
        x1 = F.relu(self.e_conv1(d))
        x2 = F.relu(self.e_conv2(x1))
        x3 = F.relu(self.e_conv3(x2))
        x4 = F.relu(self.e_conv4(x3))
        x5 = F.relu(self.e_conv5(torch.cat([x3, x4], 1)))
        x6 = F.relu(self.e_conv6(torch.cat([x2, x5], 1)))
        a = torch.tanh(self.e_conv7(torch.cat([x1, x6], 1)))
        a = F.interpolate(a, scale_factor=12, mode='bilinear', align_corners=True)
        for _ in range(8):
            x = x + a * (x * x - x)
        return x[..., :h, :w]


class SCI(nn.Module):
    """The single illumination block SCI keeps at test time: three 3x3 convolutions on 3 channels.
    Output is the input divided by the estimated illumination."""

    def __init__(self):
        super().__init__()
        self.in_conv = nn.Sequential(nn.Conv2d(3, 3, 3, padding=1), nn.ReLU())
        self.conv = nn.Sequential(nn.Conv2d(3, 3, 3, padding=1), nn.BatchNorm2d(3), nn.ReLU())
        self.out_conv = nn.Sequential(nn.Conv2d(3, 3, 3, padding=1), nn.Sigmoid())

    def forward(self, x):
        f = self.in_conv(x)
        f = f + self.conv(f)
        illu = torch.clamp(self.out_conv(f) + x, 1e-4, 1)
        return torch.clamp(x / illu, 0, 1)


def zerodce(sd):
    net = ZeroDCEpp()
    net.load_state_dict(sd)
    return net


def sci(sd):
    # the checkpoint also holds the training-only calibrator and a second name for the same block
    for k in ('0.weight', '0.bias', '1.weight', '1.bias', '1.running_mean', '1.running_var'):
        assert torch.equal(sd['enhance.blocks.0.' + k], sd['enhance.conv.' + k]), k
    net = SCI()
    net.load_state_dict({k[len('enhance.'):]: v for k, v in sd.items() if k.startswith('enhance.') and '.blocks.' not in k})
    return net


VARIANTS = {  # variant: (builder, file in data/models, source URL, SHA-256 of that file)
    'zerodce': (zerodce, 'zerodcepp_Epoch99.pth', ZDCE, 'ca8855b90df9a80fa4195a831f33d3476b1964f787eb70602797c773067f3b84'),
    'sci': (sci, 'sci_medium.pt', SCI_W + 'medium.pt', '4ff1e7e66e8f18114f790e5085ca4c936f0858e329e7ad1cb65b8aa09a9c6916'),
    'sci_easy': (sci, 'sci_easy.pt', SCI_W + 'easy.pt', 'b17326a26a93bf187ecbab217f9d3c57467a8b56020d4d9ff600ba257bbffb36'),
    'sci_difficult': (sci, 'sci_difficult.pt', SCI_W + 'difficult.pt', '657fa1f280cae1035df0d5cbe628e91f2d0f28660df608a3fa3f7e9a71da5a13'),
}


def load(variant):
    build, name, url, sha = VARIANTS[variant]
    path = os.path.join(MODELS, name)
    if not os.path.exists(path):
        sys.exit(f'missing {path}: download {url}')
    got = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if got != sha:
        sys.exit(f'{path}: sha256 {got}, expected {sha} from {url}')
    return build(torch.load(path, map_location='cpu', weights_only=True)).eval()


@torch.inference_mode()
def enhance(net, bgr):
    x = torch.from_numpy(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)).permute(2, 0, 1)[None].float() / 255
    y = net(x)[0].permute(1, 2, 0).numpy()
    # rounded like Zero-DCE++'s save_image; SCI's test.py truncates instead, half a level darker
    return cv2.cvtColor(np.clip(y * 255 + 0.5, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)


def set_threads(n):
    torch.set_num_threads(n)
    cv2.setNumThreads(n)


def main(frames_root, out_root, variants):
    set_threads(2)
    nets = {v: load(v) for v in variants}
    for clip in sorted(glob.glob(os.path.join(frames_root, '*/'))):
        name = os.path.basename(os.path.dirname(clip))
        files = sorted(glob.glob(os.path.join(clip, '*.jpg')))
        for v, net in nets.items():
            d = os.path.join(out_root, v, name)
            os.makedirs(d, exist_ok=True)
            for f in files:
                out = enhance(net, cv2.imread(f))
                cv2.imwrite(os.path.join(d, os.path.basename(f)[:-4] + '.png'), out, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        print(f'{name}: {len(files)} frames x {len(nets)} variants', flush=True)


def timing(frames_root, threads, warmup=5, n=40):
    set_threads(threads)
    nets = {v: load(v) for v in ('zerodce', 'sci')}
    clip = sorted(glob.glob(os.path.join(frames_root, '*/')))[0]
    frames = [cv2.imread(f) for f in sorted(glob.glob(os.path.join(clip, '*.jpg')))[:warmup + n]]
    assert len(frames) == warmup + n and frames[0].shape == (720, 1280, 3), (len(frames), frames[0].shape)
    ms = {v: [] for v in nets}
    for i, im in enumerate(frames):
        for v, net in nets.items():  # interleaved so background load hits both models alike
            t = time.perf_counter()
            out = enhance(net, im)
            if i >= warmup:
                ms[v].append((time.perf_counter() - t) * 1000)
            assert out.shape == im.shape and out.dtype == np.uint8
    print(f'torch {torch.__version__}, {torch.get_num_threads()} threads, {n} frames of 1280x720 after {warmup} warm-up, '
          f'from {os.path.basename(os.path.dirname(clip))}')
    for v, t in ms.items():
        print(f'{v:8s} median {np.median(t):7.1f} ms   min {min(t):7.1f}   max {max(t):7.1f}')


if __name__ == '__main__':
    if sys.argv[1] == '--time':
        timing(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 2)
    else:
        main(sys.argv[1], sys.argv[2], sys.argv[3:] or ['zerodce', 'sci'])
