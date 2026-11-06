// Runs inside Chrome: pushes one clip's frames through the enhancer and posts the results back.
import { Enhancer, type EnhancerOptions, FaceSmoother, type FaceTracker, createMediaPipeFaceTracker } from '../packages/core/src/index';

interface Job {
  clip: string;
  count: number;
  variant: string;
  faces: (number[] | null)[] | null; // [x, y, w, h] in source pixels per frame; null with detect = no face input at all
  detect: boolean; // find the face with the shipped detector on the enhanced output, as the live session does
  options: EnhancerOptions;
  enabled: boolean;
}

const pad = (i: number) => String(i).padStart(4, '0');

(window as unknown as { runClip: (j: Job) => Promise<unknown> }).runClip = async (job) => {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const enh = new Enhancer(canvas, job.options);
  enh.enabled = job.enabled;
  const gl = canvas.getContext('webgl2')!;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  const ms: number[] = [];
  const trace: unknown[] = [];
  let tracker: FaceTracker | null = null;
  if (job.detect) tracker = await createMediaPipeFaceTracker({ wasmBaseUrl: '/mp', modelUrl: '/models/blaze_face_short_range.tflite' });
  const smoother = new FaceSmoother();
  let found = 0;
  let tried = 0;
  for (let i = 1; i <= job.count; i++) {
    const blob = await (await fetch(`/frames/${job.clip}/${pad(i)}.jpg`)).blob();
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    const f = job.faces?.[i - 1];
    if (!tracker) enh.setFace(f ? { x: f[0]! / bmp.width, y: f[1]! / bmp.height, w: f[2]! / bmp.width, h: f[3]! / bmp.height } : null);
    const t0 = performance.now();
    const rep = enh.process(bmp, bmp.width, bmp.height, (i * 1000) / 30);
    gl.finish();
    ms.push(performance.now() - t0);
    if (tracker && i % 6 === 1) {
      const small = await createImageBitmap(canvas, { resizeWidth: 320, resizeHeight: Math.round((320 * bmp.height) / bmp.width), resizeQuality: 'low' });
      const box = tracker.detect(small);
      small.close();
      tried++;
      if (box) found++;
      enh.setFace(smoother.update(box, (i * 1000) / 30));
    }
    bmp.close();
    if (i % 15 === 0 || i === 1) trace.push({ i, stats: rep.stats, state: rep.decision.state, render: rep.decision.render, analysis: rep.decision.analysis });
    const out = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
    await fetch(`/out/${job.variant}/${job.clip}/${pad(i)}.png`, { method: 'POST', body: out });
  }
  enh.dispose();
  tracker?.close();
  canvas.remove();
  ms.sort((a, b) => a - b);
  return { renderer, msMedian: ms[ms.length >> 1], msP95: ms[Math.floor(ms.length * 0.95)], trace, detect: tracker ? `${found}/${tried}` : null };
};
