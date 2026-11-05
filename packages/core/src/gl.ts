// Minimal WebGL2 helpers: fullscreen-triangle programs, float render targets, uniform dispatch.

export type GL = WebGL2RenderingContext;

export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
  mips: boolean;
}

export interface Program {
  prog: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

export type UniformValue = number | readonly number[] | { tex: WebGLTexture };

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function compile(gl: GL, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}\n${src}`);
  }
  return sh;
}

export function createProgram(gl: GL, frag: string): Program {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  return { prog, uniforms: new Map() };
}

export type TargetFormat = 'rgba16f' | 'rgba8';

export function createTarget(gl: GL, w: number, h: number, format: TargetFormat, mips = false): Target {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (format === 'rgba16f') {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete for ${format} ${w}x${h}`);
  return { tex, fbo, w, h, mips };
}

export function deleteTarget(gl: GL, t: Target): void {
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.tex);
}

/** Draws one fullscreen pass into `target` (null = the canvas at `canvasSize`). */
export function draw(
  gl: GL,
  p: Program,
  target: Target | null,
  uniforms: Record<string, UniformValue>,
  canvasSize?: readonly [number, number],
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
  const w = target ? target.w : canvasSize![0];
  const h = target ? target.h : canvasSize![1];
  gl.viewport(0, 0, w, h);
  gl.useProgram(p.prog);
  let unit = 0;
  for (const name in uniforms) {
    let loc = p.uniforms.get(name);
    if (loc === undefined) {
      loc = gl.getUniformLocation(p.prog, name);
      p.uniforms.set(name, loc);
    }
    if (loc === null) continue; // optimised out by the compiler
    const v = uniforms[name]!;
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else if ('tex' in v) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, v.tex);
      gl.uniform1i(loc, unit++);
    } else if (v.length === 2) gl.uniform2f(loc, v[0]!, v[1]!);
    else if (v.length === 3) gl.uniform3f(loc, v[0]!, v[1]!, v[2]!);
    else gl.uniform4f(loc, v[0]!, v[1]!, v[2]!, v[3]!);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (target?.mips) {
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
}
