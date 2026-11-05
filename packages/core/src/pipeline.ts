import { type GL, type Program, type Target, createProgram, createTarget, deleteTarget, draw } from './gl';
import * as S from './shaders';

/** Everything the output pass needs. Produced by the controller, consumed by the GPU. */
export interface RenderParams {
  anchor: number; // log2 scene luminance mapped onto `target`
  target: number; // log2 display-linear luminance
  cHi: number;
  cLo: number;
  wb: readonly [number, number, number];
  detail: number;
  sharpen: number;
  chromaLod: number;
  saturation: number;
  /** 0..1: how much colour to drain from near-black pixels, whose hue is mostly noise. */
  shadowDesat: number;
  /** 0..1: spatial smoothing where temporal history is thin (moving areas). */
  spatial: number;
  bypass: boolean;
}

/** What the analysis half needs before the frame has been measured. */
export interface AnalysisParams {
  sigmaDark: number; // noise sigma in enc units, dark areas
  sigmaBright: number; // and bright areas
  maxAge: number;
  deflicker: boolean;
  reset: boolean;
}

export const GRID_W = 160;

/**
 * GPU side of the enhancer. A frame is two calls: analyse() denoises and fills the meter grid,
 * output() tone-maps to the canvas. The split lets the controller see this frame before toning it.
 */
export class Pipeline {
  readonly gridW = GRID_W;
  readonly gridH: number;
  private readonly inTex: WebGLTexture;
  private readonly prog: Record<string, Program>;
  private cur: Target;
  private ref: [Target, Target];
  private rows: Target;
  private rowGain: Target;
  private hist: [Target, Target];
  private meter: Target;
  private guide: [Target, Target];
  private readonly meterBuf: Uint8Array;
  private frame = 0;
  private sigmas: readonly [number, number] = [0.01, 0.005];

  constructor(private readonly gl: GL, readonly w: number, readonly h: number) {
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float is required');
    this.gridH = Math.max(Math.round((GRID_W * h) / w), 8);
    const g = (mips = false) => createTarget(gl, this.gridW, this.gridH, 'rgba16f', mips);
    this.cur = g();
    this.ref = [g(), g()];
    this.rows = createTarget(gl, 1, this.gridH, 'rgba16f');
    this.rowGain = createTarget(gl, 1, this.gridH, 'rgba16f');
    this.hist = [createTarget(gl, w, h, 'rgba16f', true), createTarget(gl, w, h, 'rgba16f', true)];
    this.meter = createTarget(gl, this.gridW, this.gridH, 'rgba8');
    this.guide = [g(), g()];
    this.meterBuf = new Uint8Array(this.gridW * this.gridH * 4);
    this.inTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.inTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.prog = Object.fromEntries(
      Object.entries(S).map(([name, src]) => [name, createProgram(gl, src)]),
    );
  }

  /** Uploads the frame, removes flicker bands, denoises, and returns the meter grid (top row first). */
  analyse(source: TexImageSource, a: AnalysisParams): Uint8Array {
    const { gl, w, h } = this;
    const px = [1 / w, 1 / h] as const;
    const P = this.prog;
    gl.bindTexture(gl.TEXTURE_2D, this.inTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // textures keep image row 0 at v = 0; only the canvas pass flips
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const input = { tex: this.inTex };
    const reset = a.reset || this.frame === 0;

    draw(gl, P.CUR_SMALL!, this.cur, { u_in: input, u_px: px });
    draw(gl, P.ROW_GAIN!, this.rows, { u_cur: { tex: this.cur.tex }, u_ref: { tex: this.ref[0].tex } });
    draw(gl, P.ROW_FINAL!, this.rowGain, {
      u_rows: { tex: this.rows.tex },
      u_rowCount: this.gridH,
      u_enable: a.deflicker && !reset ? 1 : 0,
    });
    draw(gl, P.REF_SMALL!, this.ref[1], {
      u_cur: { tex: this.cur.tex },
      u_ref: { tex: this.ref[0].tex },
      u_alpha: reset ? 1 : 0.1,
    });
    draw(gl, P.TEMPORAL!, this.hist[1], {
      u_in: input,
      u_hist: { tex: this.hist[0].tex },
      u_rowGain: { tex: this.rowGain.tex },
      u_px: px,
      u_sigmaDark: a.sigmaDark,
      u_sigmaBright: a.sigmaBright,
      u_maxAge: a.maxAge,
      u_reset: reset ? 1 : 0,
    });
    const lod = Math.log2(w / this.gridW);
    draw(gl, P.METER!, this.meter, {
      u_in: input,
      u_den: { tex: this.hist[1].tex },
      u_prev: { tex: reset ? this.hist[1].tex : this.hist[0].tex },
      u_rowGain: { tex: this.rowGain.tex },
      u_lod: lod,
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.meter.fbo);
    gl.readPixels(0, 0, this.gridW, this.gridH, gl.RGBA, gl.UNSIGNED_BYTE, this.meterBuf);

    // edge-aware base for local tone mapping (guided filter on log luminance)
    const [g0, g1] = this.guide;
    const tx = [1 / this.gridW, 0] as const;
    const ty = [0, 1 / this.gridH] as const;
    draw(gl, P.GUIDE_INIT!, g0, { u_den: { tex: this.hist[1].tex }, u_lod: lod });
    draw(gl, P.BLUR2!, g1, { u_tex: { tex: g0.tex }, u_dir: tx });
    draw(gl, P.BLUR2!, g0, { u_tex: { tex: g1.tex }, u_dir: ty });
    draw(gl, P.GUIDE_AB!, g1, { u_mean: { tex: g0.tex }, u_eps: 0.35 });
    draw(gl, P.BLUR2!, g0, { u_tex: { tex: g1.tex }, u_dir: tx });
    draw(gl, P.BLUR2!, g1, { u_tex: { tex: g0.tex }, u_dir: ty });

    this.hist.reverse();
    this.ref.reverse();
    this.frame++;
    this.sigmas = [a.sigmaDark, a.sigmaBright];
    return this.meterBuf;
  }

  /** Tone-maps the denoised frame from the last analyse() onto the canvas. */
  output(p: RenderParams, canvasSize: readonly [number, number]): void {
    draw(
      this.gl,
      this.prog.TONE!,
      null,
      {
        u_den: { tex: this.hist[0].tex },
        u_ab: { tex: this.guide[1].tex },
        u_wb: p.wb,
        u_anchor: p.anchor,
        u_target: p.target,
        u_cHi: p.cHi,
        u_cLo: p.cLo,
        u_detail: p.detail,
        u_sharpen: p.sharpen,
        u_chromaLod: p.chromaLod,
        u_saturation: p.saturation,
        u_shadowDesat: p.shadowDesat,
        u_spatial: p.spatial,
        u_sigmaDark: this.sigmas[0],
        u_sigmaBright: this.sigmas[1],
        u_px: [1 / this.w, 1 / this.h],
        u_seed: (this.frame * 7.31) % 97,
        u_bypass: p.bypass ? 1 : 0,
      },
      canvasSize,
    );
  }

  dispose(): void {
    const { gl } = this;
    for (const t of [this.cur, ...this.ref, this.rows, this.rowGain, ...this.hist, this.meter, ...this.guide]) deleteTarget(gl, t);
    gl.deleteTexture(this.inTex);
    for (const p of Object.values(this.prog)) gl.deleteProgram(p.prog);
  }
}
