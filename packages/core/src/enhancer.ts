import { type ControlState, type Decision, DEFAULT_TUNING, type Tuning, control } from './controller';
import { type FaceBox, type FrameStats, measure } from './meter';
import { Pipeline } from './pipeline';

export interface EnhancerOptions {
  tuning?: Partial<Tuning>;
  /** Remove mains-flicker bands and frame-to-frame brightness wobble. Default true. */
  deflicker?: boolean;
}

export interface FrameReport {
  stats: FrameStats;
  decision: Decision;
}

/**
 * One camera stream in, one enhanced canvas out. Call process() once per new camera frame.
 * The canvas is resized to the frame.
 */
export class Enhancer {
  /** When false the frame is shown untouched (history keeps running so re-enabling is seamless). */
  enabled = true;
  private readonly gl: WebGL2RenderingContext;
  private pipeline: Pipeline | null = null;
  private state: ControlState | null = null;
  private analysis = { sigmaDark: 0.012, sigmaBright: 0.006, maxAge: 8 };
  private face: FaceBox | null = null;
  private lastTime = -1;
  private readonly tuning: Tuning;
  private readonly deflicker: boolean;

  constructor(private readonly canvas: HTMLCanvasElement | OffscreenCanvas, opts: EnhancerOptions = {}) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.tuning = { ...DEFAULT_TUNING, ...opts.tuning };
    this.deflicker = opts.deflicker ?? true;
  }

  /** Latest face position from any detector, or null when no face is in view. */
  setFace(face: FaceBox | null): void {
    this.face = face;
  }

  process(source: TexImageSource, width: number, height: number, timeMs: number): FrameReport {
    let reset = false;
    if (!this.pipeline || this.pipeline.w !== width || this.pipeline.h !== height) {
      this.pipeline?.dispose();
      this.canvas.width = width;
      this.canvas.height = height;
      this.pipeline = new Pipeline(this.gl, width, height);
      this.state = null;
      reset = true;
    }
    const dt = this.lastTime < 0 ? 1 / 30 : Math.min(Math.max((timeMs - this.lastTime) / 1000, 1 / 240), 0.5);
    this.lastTime = timeMs;

    const grid = this.pipeline.analyse(source, { ...this.analysis, deflicker: this.deflicker, reset });
    const stats = measure(grid, this.pipeline.gridW, this.pipeline.gridH, this.face);
    const decision = control(this.state, stats, dt, this.tuning);
    this.state = decision.state;
    this.analysis = decision.analysis;
    this.pipeline.output({ ...decision.render, bypass: !this.enabled }, [width, height]);
    return { stats, decision };
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.pipeline = null;
  }
}
