"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Act I — Attention.
 * The "snitch": a canvas golden snitch (gradient gold sphere, engraved
 * bands, translucent gold wings with motion-blur ghosting) flying on a
 * force-based steering agent (Reynolds): hover = arrive at an anchor +
 * hummingbird figure-8 micro-drift, cruise = wander, dart = seek with
 * Lévy-flight distances, pull-back anticipation and banking into turns.
 * Catching it (a click) plays the "drop" ending — slow-mo, wings fold,
 * the ball falls, bounces, rolls to rest and fades — while the CSS
 * reveal underneath staggers the copy in.
 */

type AgentState = "hover" | "cruise" | "anticipate" | "dart";

const HOVER_MS: [number, number] = [700, 1600];
const CRUISE_MS: [number, number] = [900, 1800];
const HOVER_SPEED = 90;
const CRUISE_SPEED = 175;
const DART_SPEED = 720;
const FLAP_HZ = 14;

const CATCH_RADIUS = 48;
const BALL_R = 9;

/** Seeded 1D value noise, two octaves, returns 0..1. */
function makeNoise(seed: number) {
  const vals = new Float32Array(256);
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < 256; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    vals[i] = (s % 100000) / 100000;
  }
  const base = (x: number) => {
    const xf = Math.floor(x);
    const f = x - xf;
    const u = f * f * (3 - 2 * f);
    const a = vals[xf & 255];
    const b = vals[(xf + 1) & 255];
    return a + (b - a) * u;
  };
  return (x: number) => base(x) * 0.72 + base(x * 2.7 + 31.4) * 0.28;
}

const clampMag = (x: number, y: number, max: number): [number, number] => {
  const m = Math.hypot(x, y);
  if (m <= max || m === 0) return [x, y];
  return [(x / m) * max, (y / m) * max];
};

interface TrailPoint {
  x: number;
  y: number;
  speed: number;
  age: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  rot: number;
  vrot: number;
}

const spawnParticle = (
  x: number,
  y: number,
  vx: number,
  vy: number,
  life: number,
  size: number,
  vrot = 0
): Particle => ({
  x,
  y,
  vx,
  vy,
  life,
  maxLife: life,
  size,
  rot: Math.random() * Math.PI,
  vrot,
});

export default function FlySection({ onCaught }: { onCaught?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [caught, setCaught] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const caughtRef = useRef(false);
  const onCaughtRef = useRef(onCaught);
  useEffect(() => {
    onCaughtRef.current = onCaught;
  }, [onCaught]);

  useEffect(() => {
    const hintTimer = setTimeout(() => {
      if (!caughtRef.current) setShowHint(true);
    }, 4500);
    return () => clearTimeout(hintTimer);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    let raf = 0;
    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const nx = makeNoise(1297);
    const ny = makeNoise(7411);
    const nz = makeNoise(3061);
    const nw = makeNoise(5519);

    const agent = {
      x: width * 0.5,
      y: height * 0.42,
      vx: 0,
      vy: 0,
      roll: 0,
      heading: 0,
      flapPhase: 0,
      hoverPhase: Math.random() * Math.PI * 2,
      wanderAngle: Math.random() * Math.PI * 2,
      state: "hover" as AgentState,
      stateUntil: 600,
      anchorX: width * 0.5,
      anchorY: height * 0.42,
      targetX: width * 0.5,
      targetY: height * 0.42,
    };

    const trail: TrailPoint[] = [];
    let sparks: Particle[] = [];
    let last = performance.now();

    // "drop" catch state
    let fx: {
      t: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
      rot: number;
      bounces: number;
      floorY: number;
      particles: Particle[];
    } | null = null;

    const pad = 110;

    /** Lévy-flight dart target: heavy-tailed distance, kept in bounds. */
    const pickDart = () => {
      const diag = Math.hypot(width, height);
      const minD = diag * 0.14;
      const maxD = diag * 0.65;
      const d = Math.min(maxD, minD * Math.pow(Math.random(), -0.55));
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2;
        const tx = agent.x + Math.cos(a) * d;
        const ty = agent.y + Math.sin(a) * d;
        if (tx > pad && tx < width - pad && ty > pad && ty < height * 0.72) {
          agent.targetX = tx;
          agent.targetY = ty;
          return;
        }
      }
      agent.targetX = pad + Math.random() * Math.max(1, width - pad * 2);
      agent.targetY = pad + Math.random() * Math.max(1, height * 0.6);
    };

    // ---------- drawing ----------

    const drawWingShape = (
      r: number,
      phase: number,
      alpha: number,
      fold: number
    ) => {
      const sweep = Math.sin(phase) * 0.85 - 0.12;
      ctx.save();
      ctx.rotate(-sweep + fold * 1.1);
      ctx.scale(1, 0.45 + 0.55 * Math.abs(Math.cos(phase)));
      const L = r * 3.2;
      const grad = ctx.createLinearGradient(0, 0, L, 0);
      grad.addColorStop(0, `rgba(255, 248, 228, ${0.92 * alpha})`);
      grad.addColorStop(0.55, `rgba(238, 216, 160, ${0.6 * alpha})`);
      grad.addColorStop(1, `rgba(201, 158, 64, ${0.18 * alpha})`);
      ctx.fillStyle = grad;
      ctx.strokeStyle = `rgba(170, 130, 50, ${0.5 * alpha})`;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(L * 0.22, -r * 1.15, L * 0.68, -r * 1.0, L, -r * 0.3);
      ctx.bezierCurveTo(L * 0.78, r * 0.12, L * 0.34, r * 0.3, 0, r * 0.24);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = `rgba(170, 130, 50, ${0.3 * alpha})`;
      ctx.lineWidth = 0.5;
      for (const f of [0.3, 0.55, 0.8]) {
        ctx.beginPath();
        ctx.moveTo(r * 0.4, -r * 0.1);
        ctx.quadraticCurveTo(L * f * 0.6, -r * 0.9 * f, L * f, -r * 0.55 * f);
        ctx.stroke();
      }
      ctx.restore();
    };

    const drawBall = (r: number) => {
      const ball = ctx.createRadialGradient(
        -r * 0.35,
        -r * 0.4,
        r * 0.15,
        0,
        0,
        r * 1.15
      );
      ball.addColorStop(0, "#fdf0c0");
      ball.addColorStop(0.45, "#e8c258");
      ball.addColorStop(0.8, "#c0922e");
      ball.addColorStop(1, "#8a661c");
      ctx.fillStyle = ball;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(122, 88, 24, 0.55)";
      ctx.lineWidth = 0.8;
      for (const k of [0.45, 0.78]) {
        ctx.beginPath();
        ctx.ellipse(0, 0, r * k * 0.42, r * 0.96, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.98, r * 0.3, 0, 0, Math.PI);
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 252, 235, 0.95)";
      ctx.beginPath();
      ctx.ellipse(
        -r * 0.38,
        -r * 0.42,
        r * 0.22,
        r * 0.13,
        -0.6,
        0,
        Math.PI * 2
      );
      ctx.fill();
    };

    const drawHalo = (r: number, strength = 0.3) => {
      const halo = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 4);
      halo.addColorStop(0, `rgba(255, 214, 110, ${strength})`);
      halo.addColorStop(1, "rgba(255, 214, 110, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, r * 4, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawSparkle = (p: Particle) => {
      const a = Math.max(0, Math.min(1, (p.life / p.maxLife) * 1.6));
      ctx.strokeStyle = `rgba(255, 230, 150, ${a})`;
      ctx.lineWidth = 1;
      const d = p.size * (0.4 + p.life / p.maxLife);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.beginPath();
      ctx.moveTo(-d, 0);
      ctx.lineTo(d, 0);
      ctx.moveTo(0, -d);
      ctx.lineTo(0, d);
      ctx.stroke();
      ctx.restore();
    };

    const drawSnitchBody = (t: number, dt: number) => {
      const z = nz(t * 0.00018);
      const scale = 0.78 + z * 0.5;
      const r = BALL_R * scale;

      const speed = Math.hypot(agent.vx, agent.vy);
      const flapHz = reducedMotion ? 4 : FLAP_HZ + (speed / DART_SPEED) * 8;
      agent.flapPhase += dt * flapHz * Math.PI * 2;

      ctx.save();
      ctx.translate(agent.x, agent.y);
      ctx.rotate(agent.roll);
      ctx.globalAlpha = 0.82 + z * 0.18;

      drawHalo(r);

      const ghosts: [number, number][] = reducedMotion
        ? [[0, 0.9]]
        : [
            [0, 0.85],
            [-1.0, 0.32],
            [-2.0, 0.13],
          ];
      for (const side of [-1, 1] as const) {
        ctx.save();
        ctx.translate(side * r * 0.72, -r * 0.28);
        ctx.scale(side, 1);
        for (const [dp, a] of ghosts) {
          drawWingShape(r, agent.flapPhase + dp, a, 0);
        }
        ctx.restore();
      }

      drawBall(r);
      ctx.restore();
    };

    // ---------- "drop" catch: slow-mo, wings fold, fall, bounce, rest ----------

    const updateAndDrawFx = (dt: number) => {
      if (!fx) return;
      const f = fx;
      // time dilates at the moment of the catch, recovers over ~0.7s
      const fdt = dt * Math.min(1, 0.22 + f.t * 1.2);
      f.t += dt;

      if (f.y < f.floorY || Math.abs(f.vy) > 20) {
        f.vy += 1500 * fdt;
        f.x += f.vx * fdt;
        f.y += f.vy * fdt;
        if (f.y >= f.floorY) {
          f.y = f.floorY;
          if (Math.abs(f.vy) > 60 && f.bounces < 3) {
            f.vy = -f.vy * 0.42;
            f.vx *= 0.6;
            f.bounces++;
            for (let i = 0; i < 5; i++) {
              f.particles.push(
                spawnParticle(
                  f.x + (Math.random() - 0.5) * 10,
                  f.floorY,
                  (Math.random() - 0.5) * 60,
                  -20 - Math.random() * 50,
                  0.35,
                  1 + Math.random() * 1.2
                )
              );
            }
          } else {
            f.vy = 0;
          }
        }
      } else {
        // rolling to rest
        f.vx *= 1 - 2.2 * fdt;
        f.x += f.vx * fdt;
      }
      f.rot += (f.vx / BALL_R) * fdt;

      f.particles = f.particles.filter((p) => p.life > 0);
      for (const p of f.particles) {
        p.x += p.vx * fdt;
        p.y += p.vy * fdt;
        p.rot += p.vrot * fdt;
        p.life -= fdt;
        drawSparkle(p);
      }

      const fold = Math.min(1, f.t * 2.8);
      const settle = f.vy === 0 && f.y >= f.floorY - 0.5;
      const fadeStart = 2.4;
      const alpha =
        f.t > fadeStart ? Math.max(0, 1 - (f.t - fadeStart) * 1.2) : 1;
      if (alpha <= 0) return;

      // contact shadow
      ctx.fillStyle = `rgba(110, 85, 40, ${
        0.18 * alpha * Math.max(0.2, 1 - (f.floorY - f.y) / 200)
      })`;
      ctx.beginPath();
      ctx.ellipse(
        f.x,
        f.floorY + BALL_R,
        BALL_R * 1.6,
        BALL_R * 0.4,
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();

      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      ctx.globalAlpha = alpha;
      if (!settle) drawHalo(BALL_R, 0.2);
      for (const side of [-1, 1] as const) {
        ctx.save();
        ctx.translate(side * BALL_R * 0.72, -BALL_R * 0.28);
        ctx.scale(side, 1);
        drawWingShape(BALL_R, 0.25, 0.8, fold);
        ctx.restore();
      }
      drawBall(BALL_R);
      ctx.restore();
    };

    // ---------- main loop ----------

    const tick = (t: number) => {
      const dt = Math.min((t - last) / 1000, 0.05);
      last = t;
      ctx.clearRect(0, 0, width, height);

      if (!caughtRef.current) {
        // state machine: hover ⇄ cruise, either may break into a dart
        if (t > agent.stateUntil) {
          if (agent.state === "hover" || agent.state === "cruise") {
            if (reducedMotion) {
              agent.state = "hover";
              agent.stateUntil = t + 99999;
            } else {
              const roll = Math.random();
              const dartChance = agent.state === "hover" ? 0.45 : 0.4;
              if (roll < dartChance) {
                pickDart();
                agent.state = "anticipate";
                agent.stateUntil = t + 130;
              } else if (agent.state === "hover") {
                agent.state = "cruise";
                agent.stateUntil =
                  t +
                  CRUISE_MS[0] +
                  Math.random() * (CRUISE_MS[1] - CRUISE_MS[0]);
              } else {
                agent.state = "hover";
                agent.anchorX = agent.x;
                agent.anchorY = agent.y;
                agent.stateUntil =
                  t + HOVER_MS[0] + Math.random() * (HOVER_MS[1] - HOVER_MS[0]);
              }
            }
          } else if (agent.state === "anticipate") {
            agent.state = "dart";
            agent.stateUntil = t + 1500;
          } else {
            agent.state = "hover";
            agent.anchorX = agent.x;
            agent.anchorY = agent.y;
            agent.stateUntil =
              t + HOVER_MS[0] + Math.random() * (HOVER_MS[1] - HOVER_MS[0]);
          }
        }

        // steering: desired velocity → force-capped correction
        let desiredX = 0;
        let desiredY = 0;
        let maxForce = 600;
        let maxSpeed = HOVER_SPEED;

        if (agent.state === "hover") {
          // arrive at anchor + hummingbird figure-8 micro-drift
          agent.hoverPhase += dt * 1.7;
          const f8x = Math.sin(agent.hoverPhase) * 30;
          const f8y = Math.sin(agent.hoverPhase * 2) * 13;
          const tx = agent.anchorX + (nx(t * 0.0005) - 0.5) * 150 + f8x;
          const ty = agent.anchorY + (ny(t * 0.0005) - 0.5) * 110 + f8y;
          const dx = tx - agent.x;
          const dy = ty - agent.y;
          const d = Math.hypot(dx, dy) || 1;
          const speed = HOVER_SPEED * Math.min(1, d / 60);
          desiredX = (dx / d) * speed;
          desiredY = (dy / d) * speed;
          maxForce = 520;
        } else if (agent.state === "cruise") {
          // Reynolds wander: seek a point on a circle projected ahead
          agent.wanderAngle += (nw(t * 0.0013) - 0.5) * 7 * dt * 60;
          const h = agent.heading;
          let tx =
            agent.x + Math.cos(h) * 95 + Math.cos(agent.wanderAngle) * 60;
          let ty =
            agent.y + Math.sin(h) * 95 + Math.sin(agent.wanderAngle) * 60;
          tx = Math.max(pad, Math.min(width - pad, tx));
          ty = Math.max(pad, Math.min(height * 0.72, ty));
          const dx = tx - agent.x;
          const dy = ty - agent.y;
          const d = Math.hypot(dx, dy) || 1;
          desiredX = (dx / d) * CRUISE_SPEED;
          desiredY = (dy / d) * CRUISE_SPEED;
          maxForce = 480;
          maxSpeed = CRUISE_SPEED;
        } else if (agent.state === "anticipate") {
          // pull back opposite the upcoming dart direction
          const ddx = agent.targetX - agent.x;
          const ddy = agent.targetY - agent.y;
          const dd = Math.hypot(ddx, ddy) || 1;
          desiredX = (-ddx / dd) * 150;
          desiredY = (-ddy / dd) * 150;
          maxForce = 2200;
          maxSpeed = 160;
        } else {
          // dart: seek hard; arrive only in the last 90px → slight overshoot
          const dx = agent.targetX - agent.x;
          const dy = agent.targetY - agent.y;
          const d = Math.hypot(dx, dy) || 1;
          const speed = DART_SPEED * Math.min(1, d / 90);
          desiredX = (dx / d) * speed;
          desiredY = (dy / d) * speed;
          maxForce = 5600;
          maxSpeed = DART_SPEED;
          if (d < 26) agent.stateUntil = 0;
        }

        const [fxs, fys] = clampMag(
          desiredX - agent.vx,
          desiredY - agent.vy,
          maxForce
        );
        agent.vx += fxs * dt;
        agent.vy += fys * dt;
        const [cvx, cvy] = clampMag(agent.vx, agent.vy, maxSpeed);
        agent.vx = cvx;
        agent.vy = cvy;
        agent.x += agent.vx * dt;
        agent.y += agent.vy * dt;
        agent.x = Math.max(50, Math.min(width - 50, agent.x));
        agent.y = Math.max(50, Math.min(height - 60, agent.y));

        // banking: roll into turns, proportional to turn rate
        const sp = Math.hypot(agent.vx, agent.vy);
        if (sp > 4) {
          const heading = Math.atan2(agent.vy, agent.vx);
          let dh = heading - agent.heading;
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          agent.heading = heading;
          const speedNorm = Math.min(1, sp / DART_SPEED);
          const rollTarget = Math.max(
            -0.65,
            Math.min(0.65, (dh / Math.max(dt, 0.001)) * 0.06 * speedNorm)
          );
          agent.roll += (rollTarget - agent.roll) * Math.min(1, dt * 9);
        } else {
          agent.roll += (0 - agent.roll) * Math.min(1, dt * 4);
        }

        trail.push({ x: agent.x, y: agent.y, speed: sp, age: 0 });
        if (sp > DART_SPEED * 0.55 && Math.random() < 0.35) {
          sparks.push(
            spawnParticle(
              agent.x + (Math.random() - 0.5) * 14,
              agent.y + (Math.random() - 0.5) * 14,
              (Math.random() - 0.5) * 20,
              (Math.random() - 0.5) * 20,
              0.5 + Math.random() * 0.3,
              1.5 + Math.random() * 2
            )
          );
        }
      }

      // light-ribbon trail: two-pass tapered stroke, opacity ∝ speed
      for (const tp of trail) tp.age += dt;
      while (trail.length && trail[0].age > 0.55) trail.shift();
      if (trail.length > 2) {
        ctx.lineCap = "round";
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 1; i < trail.length; i++) {
            const a = trail[i - 1];
            const b = trail[i];
            const fade = 1 - b.age / 0.55;
            const speedF = Math.min(1, b.speed / 420);
            const alpha = fade * fade * speedF;
            if (alpha < 0.01) continue;
            ctx.strokeStyle =
              pass === 0
                ? `rgba(205, 152, 42, ${alpha * 0.35})`
                : `rgba(255, 236, 170, ${alpha * 0.6})`;
            ctx.lineWidth = (pass === 0 ? 5 : 2) * fade;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // ambient sparkles
      sparks = sparks.filter((s) => s.life > 0);
      for (const s of sparks) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.rot += s.vrot * dt;
        s.life -= dt;
        drawSparkle(s);
      }

      if (!caughtRef.current) {
        drawSnitchBody(t, dt);
      } else {
        updateAndDrawFx(dt);
      }

      const fxAlive = fx !== null && fx.t < 3.4;
      if (
        !caughtRef.current ||
        sparks.length > 0 ||
        trail.length > 0 ||
        fxAlive
      ) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);

    const onClick = (e: MouseEvent) => {
      if (caughtRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (Math.hypot(mx - agent.x, my - agent.y) < CATCH_RADIUS) {
        caughtRef.current = true;
        fx = {
          t: 0,
          x: agent.x,
          y: agent.y,
          vx: agent.vx * 0.15,
          vy: agent.vy * 0.15,
          rot: 0,
          bounces: 0,
          floorY: Math.min(agent.y + 180, height - 80),
          particles: [],
        };
        canvas.style.cursor = "default";
        setCaught(true);
        setShowHint(false);
        onCaughtRef.current?.();
      }
    };

    const onMove = (e: MouseEvent) => {
      if (caughtRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const near =
        Math.hypot(
          e.clientX - rect.left - agent.x,
          e.clientY - rect.top - agent.y
        ) <
        CATCH_RADIUS + 14;
      canvas.style.cursor = near ? "pointer" : "default";
    };

    canvas.addEventListener("click", onClick);
    canvas.addEventListener("mousemove", onMove);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("mousemove", onMove);
    };
  }, []);

  return (
    <section className={`fly-section${caught ? " caught" : ""}`}>
      <canvas ref={canvasRef} className="fly-canvas" />
      <div className={`fly-hint${showHint && !caught ? " visible" : ""}`}>
        ( catch it )
      </div>
      <div className="fly-reveal">
        <p className="fly-eyebrow">that caught your attention.</p>
        <h1>
          Everything online is <em>designed</em> to.
        </h1>
        <p className="fly-sub">
          What if we imagined a world&hellip; where <em>you</em> have more
          control?
        </p>
        <div className="fly-scroll-cue">
          <span>keep going</span>
          <span className="arrow">↓</span>
        </div>
      </div>
    </section>
  );
}
