"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/*
 * Reusable "dirty liquid glass" pane (WebGL, raw three.js).
 *
 * Model: the glass is ALWAYS transparent. Dirt never paints over the
 * content — it diffuses it. Dirty areas show a pre-blurred (true gaussian)
 * copy of the content, distorted by the grime relief, with only a thin
 * translucent film of dirt color on top. Clean (wiped) areas show the
 * sharp content plus all the liquid-glass cues: cursor specular + ripple,
 * sheen, rim refraction. Presets pick textures + film color; a preset can
 * also use a real photo of dirty glass as the film itself (usePhoto).
 */

export interface GlassPreset {
  label: string;
  description: string;
  /** grime textures: a = primary relief (and film color if usePhoto), b = secondary */
  texA: string;
  texB: string;
  tileA: number;
  tileB: number;
  heightA: number;
  heightB: number;
  /** refraction strength of the grime relief inside the haze */
  refract: number;
  /** gaussian frost blur in px (at 1000px pane width) */
  blurPx: number;
  /** dirt film colors: thin -> thick (ignored when usePhoto) */
  fogLight: [number, number, number];
  fogDark: [number, number, number];
  /** film opacity multiplier */
  fogAmount: number;
  /** 1 = use texA's rgb as the photographic dirt film */
  usePhoto?: boolean;
  /** photo blend: 0 = screen (light smears), 1 = multiply (dark/warm films) */
  photoBlend?: number;
  /** 1 = procedural condensation droplets */
  droplets: number;
  /** dark dust speckle density 0..1 */
  speckles: number;
  /** extra dirt accumulating toward pane edges 0..1 */
  edgeDirt: number;
}

const SMUDGE_A = "/images/prototype/smudge-fingerprints.jpg";
const SMUDGE_B = "/images/prototype/smudge-imperfections.jpg";

export const GLASS_PRESETS: Record<string, GlassPreset> = {
  grimy: {
    label: "grimy window",
    description: "translucent dirt haze, dust speckles, heavy at the edges",
    texA: SMUDGE_A,
    texB: SMUDGE_B,
    tileA: 0.7,
    tileB: 1.6,
    heightA: 0.55,
    heightB: 0.75,
    refract: 0.035,
    blurPx: 26,
    fogLight: [0.86, 0.81, 0.71],
    fogDark: [0.56, 0.51, 0.42],
    fogAmount: 1.1,
    droplets: 0,
    speckles: 0.8,
    edgeDirt: 0.7,
  },
  steam: {
    label: "steamed up",
    description: "white condensation fog + water droplets, heavy diffusion",
    texA: SMUDGE_A,
    texB: SMUDGE_B,
    tileA: 0.5,
    tileB: 1.1,
    heightA: 0.3,
    heightB: 0.25,
    refract: 0.012,
    blurPx: 28,
    fogLight: [0.97, 0.97, 0.96],
    fogDark: [0.84, 0.85, 0.86],
    fogAmount: 1.3,
    droplets: 1,
    speckles: 0,
    edgeDirt: -0.4,
  },
  smear: {
    label: "smeared glass (Smear 007)",
    description: "dense diagonal brushed smears — real photographic dirt film",
    texA: "/images/prototype/glass/dirt-2.jpg",
    texB: SMUDGE_B,
    tileA: 0.6,
    tileB: 1.6,
    heightA: 0.7,
    heightB: 0.3,
    refract: 0.04,
    blurPx: 20,
    fogLight: [0.9, 0.88, 0.83],
    fogDark: [0.5, 0.47, 0.41],
    fogAmount: 0.5,
    usePhoto: true,
    photoBlend: 0,
    droplets: 0,
    speckles: 0,
    edgeDirt: 0.3,
  },
  smudged: {
    label: "smudged liquid glass",
    description: "fingerprint smears, neutral frost, strong refraction",
    texA: SMUDGE_A,
    texB: SMUDGE_B,
    tileA: 0.7,
    tileB: 1.6,
    heightA: 0.8,
    heightB: 0.55,
    refract: 0.05,
    blurPx: 12,
    fogLight: [0.93, 0.90, 0.84],
    fogDark: [0.62, 0.58, 0.51],
    fogAmount: 0.85,
    droplets: 0,
    speckles: 0.25,
    edgeDirt: 0.3,
  },
};

const MASK_W = 384;
const CLEAR_THRESHOLD = 0.58;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uContent;
uniform sampler2D uContentBlur;
uniform sampler2D uSmudgeA;
uniform sampler2D uSmudgeB;
uniform sampler2D uMask;
uniform vec2 uRes;
uniform vec2 uMouse;
uniform float uTime;
uniform float uReveal;
uniform float uTileA;
uniform float uTileB;
uniform float uHeightA;
uniform float uHeightB;
uniform float uRefract;
uniform vec3 uFogLight;
uniform vec3 uFogDark;
uniform float uFogAmount;
uniform float uUsePhoto;
uniform float uPhotoBlend;
uniform float uDroplets;
uniform float uSpeckles;
uniform float uEdgeDirt;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float height(vec2 uv) {
  vec2 suv = uv * vec2(uRes.x / uRes.y, 1.0);
  float a = texture2D(uSmudgeA, suv * uTileA).r;
  float b = texture2D(uSmudgeB, suv * uTileB + 0.37).r;
  return a * uHeightA + b * uHeightB;
}

vec3 content(vec2 uv) {
  return texture2D(uContent, clamp(uv, 0.003, 0.997)).rgb;
}

vec3 frosted(vec2 uv) {
  return texture2D(uContentBlur, clamp(uv, 0.003, 0.997)).rgb;
}

// static condensation droplets on a jittered grid; returns (mask, normal.xy)
vec3 droplets(vec2 uv, float cell) {
  vec2 suv = uv * vec2(uRes.x / uRes.y, 1.0);
  vec2 g = suv * cell;
  vec2 id = floor(g);
  vec2 f = fract(g);
  float rnd = hash21(id);
  if (rnd < 0.55) return vec3(0.0);
  vec2 center = 0.3 + 0.4 * vec2(hash21(id + 1.7), hash21(id + 9.1));
  float radius = 0.10 + 0.16 * hash21(id + 4.3);
  vec2 d = f - center;
  float dist = length(d);
  float mask = smoothstep(radius, radius * 0.55, dist);
  vec2 n = dist > 0.0001 ? (d / dist) * pow(min(dist / radius, 1.0), 1.5) : vec2(0.0);
  return vec3(mask, n);
}

void main() {
  vec2 texel = 1.0 / uRes;
  float aspect = uRes.x / uRes.y;

  float wiped = texture2D(uMask, vUv).r;
  float dirtBase = wiped * (1.0 - uReveal);

  // large-scale patchiness so the grime isn't uniform
  float patchy = texture2D(uSmudgeB, vUv * vec2(aspect, 1.0) * 0.33 + 0.61).r;
  patchy = 0.45 + 1.1 * patchy;

  // dirt gathers in corners and along the frame
  float border = min(min(vUv.x, 1.0 - vUv.x) * aspect, min(vUv.y, 1.0 - vUv.y));
  float edge = (1.0 - smoothstep(0.0, 0.34, border)) * uEdgeDirt;

  float dirt = clamp(dirtBase * (patchy + max(edge, 0.0)) + dirtBase * min(edge, 0.0), 0.0, 1.0);
  float clean = 1.0 - dirt;

  float h = height(vUv);
  float e = 2.0;
  float hx = height(vUv + vec2(texel.x * e, 0.0)) - height(vUv - vec2(texel.x * e, 0.0));
  float hy = height(vUv + vec2(0.0, texel.y * e)) - height(vUv - vec2(0.0, texel.y * e));
  vec3 n = normalize(vec3(-hx, -hy, 0.16));

  vec3 dropBig = uDroplets > 0.5 ? droplets(vUv, 14.0) : vec3(0.0);
  vec3 dropSmall = uDroplets > 0.5 ? droplets(vUv + 7.3, 34.0) : vec3(0.0);
  float dropMask = max(dropBig.x, dropSmall.x * 0.85) * dirtBase;
  vec2 dropN = dropBig.x > dropSmall.x ? dropBig.yz : dropSmall.yz;

  // cursor ripple — alive on the clean glass
  vec2 toM = vUv - uMouse;
  toM.x *= aspect;
  float md = length(toM);
  float ripple = exp(-md * 7.0) * sin(uTime * 2.6 - md * 26.0) * 0.011;
  vec2 rippleDir = md > 0.0001 ? toM / md : vec2(0.0);

  // lens-edge refraction at the pane borders
  vec2 fromC = vUv - 0.5;
  float radial = length(fromC * vec2(aspect, 1.0)) * 1.35;
  float rim = smoothstep(0.62, 1.05, radial);
  vec2 rimDir = normalize(fromC + 1e-5);

  vec2 wobble = vec2(
    sin(vUv.y * 13.0 + uTime * 0.5),
    cos(vUv.x * 11.0 + uTime * 0.45)
  ) * 0.0011;

  vec2 offset =
    rippleDir * ripple * clean +
    rimDir * rim * 0.016 * clean +
    wobble * clean;
  vec2 buv = vUv + offset;

  // the glass: sharp where clean, gaussian-frosted (and grime-distorted) where dirty
  vec2 hazeUv = buv + n.xy * (uRefract * dirt);
  vec3 crisp = content(buv);
  vec3 hazy = frosted(hazeUv);
  vec3 col = mix(crisp, hazy, smoothstep(0.05, 0.5, dirt));

  // droplets lens the SHARP content through the fog
  col = mix(col, content(buv + dropN * 0.07), clamp(dropMask, 0.0, 1.0) * 0.9);

  // chromatic fringe only on the clean rim
  vec2 caDir = rimDir * rim * 0.005;
  col.r = mix(col.r, content(buv + caDir).r, 0.6 * clean * rim);
  col.b = mix(col.b, content(buv - caDir).b, 0.6 * clean * rim);

  // thin translucent dirt film — photo (screen/multiply blend) or tint
  if (uUsePhoto > 0.5) {
    vec2 suv = vUv * vec2(aspect, 1.0);
    vec3 ph = texture2D(uSmudgeA, suv * uTileA).rgb;
    vec3 screened = vec3(1.0) - (vec3(1.0) - col) * (vec3(1.0) - ph);
    vec3 multiplied = col * ph;
    vec3 blended = mix(screened, multiplied, uPhotoBlend);
    col = mix(col, blended, clamp(dirt * uFogAmount, 0.0, 1.0) * (1.0 - dropMask * 0.9));
  } else {
    vec3 film = mix(uFogLight, uFogDark, clamp(h * 0.5 + 0.12, 0.0, 1.0));
    float filmAmt = dirt * uFogAmount * (0.30 + 0.28 * h);
    col = mix(col, film, clamp(filmAmt, 0.0, 0.8) * (1.0 - dropMask * 0.9));
  }

  // dust speckles
  if (uSpeckles > 0.01) {
    float sp = step(1.0 - 0.012 * uSpeckles, hash21(floor(vUv * uRes * 0.5)));
    col = mix(col, uFogDark * 0.55, sp * dirt * 0.7);
  }

  // droplet shading: darker lower rim + a glint
  if (uDroplets > 0.5 && dropMask > 0.01) {
    col -= dropMask * max(-dropN.y, 0.0) * 0.10;
    float glint = pow(max(1.0 - length(dropN - vec2(-0.45, 0.55)), 0.0), 6.0);
    col += glint * dropMask * 0.35;
  }

  // specular from a light riding the cursor — clean glass only
  vec3 lightDir = normalize(vec3((uMouse - vUv) * vec2(aspect, 1.0), 0.55));
  vec3 halfV = normalize(lightDir + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, halfV), 0.0), 28.0);
  col += spec * 0.14 * clean;

  // diagonal sheen — glass cue, not a dirt cue
  float sheen = exp(-pow((vUv.x - vUv.y * 0.8 - 0.18) * 3.2, 2.0)) * 0.045;
  col += sheen * clean;

  // bright squeegee edge where clean meets dirty
  float mx = texture2D(uMask, vUv + vec2(texel.x * 3.0, 0.0)).r
           - texture2D(uMask, vUv - vec2(texel.x * 3.0, 0.0)).r;
  float my = texture2D(uMask, vUv + vec2(0.0, texel.y * 3.0)).r
           - texture2D(uMask, vUv - vec2(0.0, texel.y * 3.0)).r;
  float edgeGlow = clamp(length(vec2(mx, my)) * 1.8, 0.0, 1.0);
  col += edgeGlow * 0.16 * (1.0 - uReveal);

  gl_FragColor = vec4(col, 1.0);
}
`;

interface RichWord {
  text: string;
  em?: boolean;
}

function wrapRich(
  ctx: CanvasRenderingContext2D,
  words: RichWord[],
  maxWidth: number,
  font: (em: boolean) => string
): RichWord[][] {
  const lines: RichWord[][] = [];
  let line: RichWord[] = [];
  let lineW = 0;
  ctx.font = font(false);
  const sw = ctx.measureText(" ").width;
  for (const w of words) {
    ctx.font = font(!!w.em);
    const ww = ctx.measureText(w.text).width;
    if (lineW > 0 && lineW + sw + ww > maxWidth) {
      lines.push(line);
      line = [];
      lineW = 0;
    }
    line.push(w);
    lineW += (lineW > 0 ? sw : 0) + ww;
  }
  if (line.length) lines.push(line);
  return lines;
}

function drawRichLines(
  ctx: CanvasRenderingContext2D,
  lines: RichWord[][],
  cx: number,
  startY: number,
  lineHeight: number,
  font: (em: boolean) => string,
  color: (em: boolean) => string
): number {
  ctx.font = font(false);
  const sw = ctx.measureText(" ").width;
  let y = startY;
  for (const ln of lines) {
    let total = 0;
    ln.forEach((w, i) => {
      ctx.font = font(!!w.em);
      total += ctx.measureText(w.text).width + (i > 0 ? sw : 0);
    });
    let x = cx - total / 2;
    for (const w of ln) {
      ctx.font = font(!!w.em);
      ctx.fillStyle = color(!!w.em);
      ctx.fillText(w.text, x, y);
      x += ctx.measureText(w.text).width + sw;
    }
    y += lineHeight;
  }
  return y;
}

const HEADLINE: RichWord[] =
  "We have no control over how these systems work, or the intentions behind them."
    .split(" ")
    .map((text) => ({ text, em: text.startsWith("intentions") }));

const SUB: RichWord[] = "What if you had transparency into the systems?"
  .split(" ")
  .map((text) => ({ text, em: text.startsWith("transparency") }));

export default function LiquidGlass({
  preset,
  config,
  onCleared,
  onFirstWipe,
}: {
  preset?: keyof typeof GLASS_PRESETS;
  /** full preset object — overrides `preset` */
  config?: GlassPreset;
  onCleared?: () => void;
  /** fires once, on the first wipe touch */
  onFirstWipe?: () => void;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onClearedRef = useRef(onCleared);
  const onFirstWipeRef = useRef(onFirstWipe);
  useEffect(() => {
    onClearedRef.current = onCleared;
    onFirstWipeRef.current = onFirstWipe;
  }, [onCleared, onFirstWipe]);
  const cfgRef = useRef<GlassPreset>(config ?? GLASS_PRESETS[preset ?? "grimy"]);
  useEffect(() => {
    cfgRef.current = config ?? GLASS_PRESETS[preset ?? "grimy"];
  }, [config, preset]);

  useEffect(() => {
    const pane = paneRef.current;
    const canvas = canvasRef.current;
    if (!pane || !canvas) return;
    const cfg = cfgRef.current;

    const probe = document.createElement("span");
    probe.style.fontFamily = "var(--rf-display)";
    pane.appendChild(probe);
    const displayFont = getComputedStyle(probe).fontFamily || "sans-serif";
    probe.style.fontFamily = "var(--rf-mono)";
    const monoFont = getComputedStyle(probe).fontFamily || "monospace";
    probe.remove();

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = pane.clientWidth;
    let h = pane.clientHeight;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);

    const contentCanvas = document.createElement("canvas");
    const cctx = contentCanvas.getContext("2d")!;
    const contentTexture = new THREE.CanvasTexture(contentCanvas);
    contentTexture.colorSpace = THREE.SRGBColorSpace;

    // true gaussian frost: blur the painted content once on a second canvas
    const blurCanvas = document.createElement("canvas");
    const bctx = blurCanvas.getContext("2d")!;
    const blurTexture = new THREE.CanvasTexture(blurCanvas);
    blurTexture.colorSpace = THREE.SRGBColorSpace;

    const paintContent = () => {
      contentCanvas.width = w * dpr;
      contentCanvas.height = h * dpr;
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const bg = cctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, "#f7f2e7");
      bg.addColorStop(1, "#edf0e8");
      cctx.fillStyle = bg;
      cctx.fillRect(0, 0, w, h);

      const vg = cctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.95);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(110, 95, 70, 0.08)");
      cctx.fillStyle = vg;
      cctx.fillRect(0, 0, w, h);

      cctx.textAlign = "left";
      cctx.textBaseline = "alphabetic";
      const cx = w / 2;

      // sizes hold up on narrow portrait panes too
      const eyebrowSize = Math.max(10, w * 0.012);
      const hSize = Math.max(23, w * 0.036);
      const sSize = Math.max(15, w * 0.019);
      const hLine = hSize * 1.26;
      const sLine = sSize * 1.55;
      const headFont = () => `600 ${hSize}px ${displayFont}`;
      const subFont = (em: boolean) => `${em ? "500" : "400"} ${sSize}px ${displayFont}`;
      const wrapW = Math.min(w * 0.78, 760);

      // eyebrow tracking shrinks until it fits the pane
      const eyebrow = "WHAT'S NOT SHOWN TO YOU";
      cctx.font = `${eyebrowSize}px ${monoFont}`;
      let tracked = eyebrow;
      for (const join of ["  ", " ", ""]) {
        tracked = eyebrow.split("").join(join);
        if (cctx.measureText(tracked).width <= w * 0.88) break;
      }
      const ew = cctx.measureText(tracked).width;

      // measure first, then center the whole block vertically
      const headLines = wrapRich(cctx, HEADLINE, wrapW, headFont);
      const subLines = wrapRich(cctx, SUB, wrapW, subFont);
      const blockH =
        hSize * 1.9 + // eyebrow → headline gap
        headLines.length * hLine +
        sSize * 0.9 + // headline → sub gap
        subLines.length * sLine;
      const eyebrowY = Math.max(h * 0.12, (h - blockH) / 2 + eyebrowSize);

      cctx.fillStyle = "#8a7a60";
      cctx.fillText(tracked, cx - ew / 2, eyebrowY);

      const nextY = drawRichLines(
        cctx,
        headLines,
        cx,
        eyebrowY + hSize * 1.9,
        hLine,
        headFont,
        (em) => (em ? "#3e7d68" : "#4f432f")
      );

      drawRichLines(
        cctx,
        subLines,
        cx,
        nextY + sSize * 0.9,
        sLine,
        subFont,
        (em) => (em ? "#3e7d68" : "#8a7a60")
      );

      contentTexture.needsUpdate = true;

      // frosted copy — blur radius scales with pane width
      blurCanvas.width = contentCanvas.width;
      blurCanvas.height = contentCanvas.height;
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.filter = `blur(${(cfg.blurPx * (w / 1000) * dpr).toFixed(1)}px)`;
      bctx.drawImage(contentCanvas, 0, 0);
      bctx.filter = "none";
      blurTexture.needsUpdate = true;
    };
    paintContent();
    document.fonts.ready.then(paintContent).catch(() => {});

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = MASK_W;
    maskCanvas.height = Math.max(64, Math.round((MASK_W * h) / w));
    const mctx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
    mctx.fillStyle = "#ffffff";
    mctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    const maskTexture = new THREE.CanvasTexture(maskCanvas);

    const loader = new THREE.TextureLoader();
    const repeat = (t: THREE.Texture) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
    };
    const smudgeA = loader.load(cfg.texA, repeat);
    const smudgeB = loader.load(cfg.texB, repeat);

    const uniforms = {
      uContent: { value: contentTexture },
      uContentBlur: { value: blurTexture },
      uSmudgeA: { value: smudgeA },
      uSmudgeB: { value: smudgeB },
      uMask: { value: maskTexture },
      uRes: { value: new THREE.Vector2(w, h) },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uTime: { value: 0 },
      uReveal: { value: 0 },
      uTileA: { value: cfg.tileA },
      uTileB: { value: cfg.tileB },
      uHeightA: { value: cfg.heightA },
      uHeightB: { value: cfg.heightB },
      uRefract: { value: cfg.refract },
      uFogLight: { value: new THREE.Vector3(...cfg.fogLight) },
      uFogDark: { value: new THREE.Vector3(...cfg.fogDark) },
      uFogAmount: { value: cfg.fogAmount },
      uUsePhoto: { value: cfg.usePhoto ? 1 : 0 },
      uPhotoBlend: { value: cfg.photoBlend ?? 0 },
      uDroplets: { value: cfg.droplets },
      uSpeckles: { value: cfg.speckles },
      uEdgeDirt: { value: cfg.edgeDirt },
    };

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms })
    );
    scene.add(quad);

    let revealing = false;
    let strokeCount = 0;

    const brush = (u: number, v: number) => {
      const mw = maskCanvas.width;
      const mh = maskCanvas.height;
      const r = mw * 0.075;
      const x = u * mw;
      const y = (1 - v) * mh;
      const g = mctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(0,0,0,0.8)");
      g.addColorStop(0.6, "rgba(0,0,0,0.45)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      mctx.fillStyle = g;
      mctx.beginPath();
      mctx.arc(x, y, r, 0, Math.PI * 2);
      mctx.fill();
      maskTexture.needsUpdate = true;

      if (++strokeCount % 14 === 0 && !revealing) {
        const data = mctx.getImageData(0, 0, mw, mh).data;
        let clean = 0;
        let total = 0;
        for (let i = 0; i < data.length; i += 4 * 7) {
          total++;
          if (data[i] < 120) clean++;
        }
        if (clean / total > CLEAR_THRESHOLD) {
          revealing = true;
          onClearedRef.current?.();
        }
      }
    };

    let active = false;
    let lastU = 0;
    let lastV = 0;

    const uvFromEvent = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        u: (e.clientX - rect.left) / rect.width,
        v: 1 - (e.clientY - rect.top) / rect.height,
      };
    };

    let touchedOnce = false;
    const onDown = (e: PointerEvent) => {
      if (revealing) return;
      if (!touchedOnce) {
        touchedOnce = true;
        onFirstWipeRef.current?.();
      }
      active = true;
      const { u, v } = uvFromEvent(e);
      lastU = u;
      lastV = v;
      brush(u, v);
      canvas.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      const { u, v } = uvFromEvent(e);
      uniforms.uMouse.value.set(u, v);
      if (!active || revealing) return;
      const dist = Math.hypot(u - lastU, v - lastV);
      const steps = Math.max(1, Math.floor(dist / 0.025));
      for (let i = 1; i <= steps; i++) {
        brush(lastU + ((u - lastU) * i) / steps, lastV + ((v - lastV) * i) / steps);
      }
      lastU = u;
      lastV = v;
    };

    const onUp = () => {
      active = false;
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    const ro = new ResizeObserver(() => {
      w = pane.clientWidth;
      h = pane.clientHeight;
      renderer.setSize(w, h, false);
      uniforms.uRes.value.set(w, h);
      paintContent();
    });
    ro.observe(pane);

    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min((t - last) / 1000, 0.05);
      last = t;
      uniforms.uTime.value += dt;
      if (revealing && uniforms.uReveal.value < 1) {
        uniforms.uReveal.value = Math.min(uniforms.uReveal.value + dt / 1.4, 1);
      }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      contentTexture.dispose();
      blurTexture.dispose();
      maskTexture.dispose();
      smudgeA.dispose();
      smudgeB.dispose();
      quad.geometry.dispose();
      (quad.material as THREE.Material).dispose();
      renderer.dispose();
    };
     
  }, [preset, config?.label]);

  return (
    <div ref={paneRef} className="glass-window">
      <canvas ref={canvasRef} className="glass-grime" />
    </div>
  );
}
