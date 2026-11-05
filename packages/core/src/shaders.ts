// Fragment shaders for the enhancement pipeline. All colour math is in linear light;
// "enc" (square root) is the variance-stabilised space used for noise and motion decisions.

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 enc(vec3 lin) { return sqrt(max(lin, 0.0)); }
`;

/** Current frame, linear luminance, area-averaged down to the analysis grid. */
export const CUR_SMALL = HEAD + `
uniform sampler2D u_in;
uniform vec2 u_px; // one source pixel in uv
void main() {
  float s = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 off = (vec2(float(i), float(j)) - 1.5) * 2.0 * u_px;
    s += luma(toLin(texture(u_in, v_uv + off).rgb));
  }
  o = vec4(s / 16.0, 0.0, 0.0, 1.0);
}`;

/** Slow running average of CUR_SMALL: the band-free brightness reference. */
export const REF_SMALL = HEAD + `
uniform sampler2D u_cur;
uniform sampler2D u_ref;
uniform float u_alpha;
void main() {
  float c = texture(u_cur, v_uv).r;
  float r = texture(u_ref, v_uv).r;
  o = vec4(mix(r, c, u_alpha), 0.0, 0.0, 1.0);
}`;

/**
 * Per-row log gain that maps this frame's brightness onto the reference. Rolling mains-flicker
 * bands show up as a smooth row pattern; a moving person does not, and is rejected by the
 * reweighted mean. Output is 1 x ROWS.
 */
export const ROW_GAIN = HEAD + `
uniform sampler2D u_cur;
uniform sampler2D u_ref;
void main() {
  const int N = 40;
  float m = 0.0;
  for (int it = 0; it < 3; it++) {
    float tau = it == 0 ? 0.35 : 0.08;
    float sw = 0.0, sr = 0.0;
    for (int i = 0; i < N; i++) {
      vec2 uv = vec2((float(i) + 0.5) / float(N), v_uv.y);
      float c = texture(u_cur, uv).r;
      float r = log((texture(u_ref, uv).r + 0.003) / (c + 0.003));
      float w = exp(-(r - m) * (r - m) / (tau * tau)) * smoothstep(0.003, 0.03, c) * (1.0 - smoothstep(0.8, 0.95, c));
      sw += w; sr += w * r;
    }
    m = sw > 1e-3 ? sr / sw : 0.0;
  }
  o = vec4(m, 0.0, 0.0, 1.0);
}`;

/** Smooths the row gains and separates the whole-frame component (kept only when small). */
export const ROW_FINAL = HEAD + `
uniform sampler2D u_rows;
uniform float u_rowCount;
uniform float u_enable;
void main() {
  float g = 0.0;
  int n = int(u_rowCount);
  for (int i = 0; i < n; i++) g += texelFetch(u_rows, ivec2(0, i), 0).r;
  g /= u_rowCount;
  float t = 1.0 / u_rowCount;
  float s = texture(u_rows, v_uv).r * 0.4
          + (texture(u_rows, v_uv + vec2(0.0, t)).r + texture(u_rows, v_uv - vec2(0.0, t)).r) * 0.2
          + (texture(u_rows, v_uv + vec2(0.0, 2.0 * t)).r + texture(u_rows, v_uv - vec2(0.0, 2.0 * t)).r) * 0.1;
  float band = clamp(s - g, -0.22, 0.22);
  float frame = g * (1.0 - smoothstep(0.06, 0.16, abs(g)));
  o = vec4((band + frame) * u_enable, 0.0, 0.0, 1.0);
}`;

/**
 * Motion-adaptive temporal accumulation. rgb = denoised linear colour, a = how many frames of
 * history this pixel carries. Where the picture moved, history is dropped, so faces do not smear.
 */
export const TEMPORAL = HEAD + `
uniform sampler2D u_in;
uniform sampler2D u_hist;
uniform sampler2D u_rowGain;
uniform vec2 u_px;
uniform float u_sigmaDark;   // noise sigma in enc units where the picture is dark
uniform float u_sigmaBright; // and where it is bright
uniform float u_maxAge;
uniform float u_reset;
void main() {
  float gain = exp(texture(u_rowGain, vec2(0.5, v_uv.y)).r);
  vec3 c0 = toLin(texture(u_in, v_uv).rgb) * gain;
  vec3 e0 = enc(c0);
  vec4 h0 = texture(u_hist, v_uv);
  vec3 cb = e0, hb = enc(h0.rgb), mn = e0, mx = e0;
  const vec2 OFF[4] = vec2[4](vec2(1.5, 0.5), vec2(-0.5, 1.5), vec2(-1.5, -0.5), vec2(0.5, -1.5));
  for (int i = 0; i < 4; i++) {
    vec2 uv = v_uv + OFF[i] * u_px;
    vec3 t = enc(toLin(texture(u_in, uv).rgb) * gain);
    cb += t; mn = min(mn, t); mx = max(mx, t);
    hb += enc(texture(u_hist, uv).rgb);
  }
  vec3 d3 = abs(cb - hb) / 5.0;
  float d = dot(d3, vec3(0.25, 0.5, 0.25));
  float sigma = mix(u_sigmaDark, u_sigmaBright, smoothstep(0.12, 0.55, luma(hb) / 5.0));
  float still = 1.0 - smoothstep(1.8 * sigma, 4.5 * sigma, d);
  // keep history inside what the current neighbourhood allows: kills ghost trails
  vec3 hc = clamp(enc(h0.rgb), mn - sigma, mx + sigma);
  float age = min(h0.a * still + 1.0, u_maxAge);
  vec3 outc = mix(hc * hc, c0, 1.0 / age);
  o = u_reset > 0.5 ? vec4(c0, 1.0) : vec4(outc, age);
}`;

/** Analysis readback: rgb = enc(denoised linear colour), a = one raw noise sample per cell. */
export const METER = HEAD + `
uniform sampler2D u_in;
uniform sampler2D u_den;
uniform sampler2D u_prev;
uniform sampler2D u_rowGain;
uniform float u_lod;
void main() {
  vec3 c = textureLod(u_den, v_uv, u_lod).rgb;
  ivec2 p = ivec2(v_uv * vec2(textureSize(u_in, 0)));
  float gain = exp(texture(u_rowGain, vec2(0.5, v_uv.y)).r);
  float cur = sqrt(luma(toLin(texelFetch(u_in, p, 0).rgb)) * gain);
  float prev = sqrt(luma(texelFetch(u_prev, p, 0).rgb));
  o = vec4(enc(c), min(abs(cur - prev) * 16.0, 1.0));
}`;

/** Guided filter step 1: log luminance and its square on the base grid. */
export const GUIDE_INIT = HEAD + `
uniform sampler2D u_den;
uniform float u_lod;
void main() {
  float i = log2(luma(textureLod(u_den, v_uv, u_lod).rgb) + 1e-4);
  o = vec4(i, i * i, 0.0, 1.0);
}`;

/** Separable Gaussian over two channels. */
export const BLUR2 = HEAD + `
uniform sampler2D u_tex;
uniform vec2 u_dir; // one texel along the blur axis, in uv
void main() {
  vec2 s = vec2(0.0);
  float sw = 0.0;
  for (int i = -7; i <= 7; i++) {
    float w = exp(-float(i * i) / 32.0);
    s += texture(u_tex, v_uv + u_dir * float(i)).rg * w;
    sw += w;
  }
  o = vec4(s / sw, 0.0, 1.0);
}`;

/** Guided filter step 2: per-cell linear model base = a * I + b. */
export const GUIDE_AB = HEAD + `
uniform sampler2D u_mean;
uniform float u_eps;
void main() {
  vec2 m = texture(u_mean, v_uv).rg;
  float var = max(m.g - m.r * m.r, 0.0);
  float a = var / (var + u_eps);
  o = vec4(a, m.r - a * m.r, 0.0, 1.0);
}`;

/**
 * Tone, colour, detail and output encode in one pass.
 * The edge-aware base (large-scale light) is compressed around the anchor (the face) so the face
 * lands on target and bright backgrounds fold down instead of clipping; fine detail rides on top.
 */
export const TONE = HEAD + `
uniform sampler2D u_den;
uniform sampler2D u_ab;
uniform vec3 u_wb;
uniform float u_anchor;   // log2 scene luminance that should land on u_target
uniform float u_target;   // log2 display-linear luminance
uniform float u_cHi;      // slope above the anchor (1 = untouched)
uniform float u_cLo;      // slope below the anchor
uniform float u_detail;
uniform float u_sharpen;
uniform float u_chromaLod;
uniform float u_saturation;
uniform float u_shadowDesat;
uniform float u_spatial;
uniform float u_sigmaDark;
uniform float u_sigmaBright;
uniform vec2 u_px;
uniform float u_seed;
uniform float u_bypass;
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y); // canvas rows run bottom-up, image rows top-down
  vec4 c4 = texture(u_den, uv);
  vec3 c = c4.rgb;
  vec3 raw = c;
  float el = luma(enc(c));
  // where little history has accumulated (something moved), smooth across space instead,
  // only between pixels that differ by less than the noise that is still left
  float left = mix(u_sigmaDark, u_sigmaBright, smoothstep(0.12, 0.55, el)) * inversesqrt(max(c4.a, 1.0));
  float k = 1.0 / (2.0 * 9.0 * left * left + 1e-9);
  vec3 acc = c;
  float wsum = 1.0;
  const vec2 OFF[4] = vec2[4](vec2(1.5, 0.5), vec2(-0.5, 1.5), vec2(-1.5, -0.5), vec2(0.5, -1.5));
  for (int i = 0; i < 4; i++) {
    vec3 t = texture(u_den, uv + OFF[i] * u_px).rgb;
    float dl = luma(enc(t)) - el;
    float w = exp(-dl * dl * k) * u_spatial;
    acc += t * w; wsum += w;
  }
  c = acc / wsum;
  float L = luma(c) + 1e-5;
  float I = log2(L);
  vec2 ab = texture(u_ab, uv).rg;
  float base = ab.x * I + ab.y;
  float x = base - u_anchor;
  float y = u_target + x * (x > 0.0 ? u_cHi : u_cLo);
  float fine = I - log2(luma(textureLod(u_den, uv, 1.5).rgb) + 1e-5);
  fine *= 1.0 - smoothstep(0.25, 0.8, abs(fine)); // leave strong edges alone: no halos
  float Lout = exp2(y + (I - base) * u_detail + fine * u_sharpen);

  // colour from a slightly coarser level: chroma noise is the ugliest part of a lifted shadow
  vec3 cc = textureLod(u_den, uv, u_chromaLod).rgb;
  vec3 chroma = cc / (luma(cc) + 1e-5) * u_wb;
  chroma /= luma(chroma) + 1e-5;
  float sat = u_saturation * (1.0 - u_shadowDesat * (1.0 - smoothstep(0.03, 0.10, el)));
  vec3 rgb = mix(vec3(1.0), chroma, sat) * Lout;

  // soft shoulder: highlights roll off instead of clipping
  float Y = luma(rgb);
  const float T = 0.62;
  float Ys = Y > T ? T + (1.0 - T) * (1.0 - exp(-(Y - T) / (1.0 - T))) : Y;
  rgb *= Ys / max(Y, 1e-5);
  float over = max(rgb.r, max(rgb.g, rgb.b));
  rgb = mix(rgb, vec3(Ys), smoothstep(1.0, 1.6, over));

  vec3 outc = toSrgb(rgb);
  // triangular dither hides the 8-bit steps that a lifted shadow would otherwise show
  float n = hash(gl_FragCoord.xy + u_seed) + hash(gl_FragCoord.xy + u_seed + 17.0) - 1.0;
  outc += n / 255.0;
  o = vec4(mix(outc, toSrgb(raw), u_bypass), 1.0);
}`;

/** Plain copy of the source frame (used for split-view and as a failure fallback). */
export const COPY = HEAD + `
uniform sampler2D u_in;
void main() { o = vec4(texture(u_in, v_uv).rgb, 1.0); }`;
