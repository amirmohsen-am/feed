"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import "./landing.css";
import Logo from "@/components/Logo";
import ShaderLogo from "@/components/ShaderLogo";

function Stars() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    for (let i = 0; i < 70; i++) {
      const s = document.createElement("span");
      s.className = "star";
      s.style.left = Math.random() * 100 + "%";
      s.style.top = Math.random() * 90 + "%";
      s.style.animationDelay = Math.random() * 6 + "s";
      s.style.animationDuration = 4 + Math.random() * 5 + "s";
      s.style.transform = `scale(${0.5 + Math.random() * 1.5})`;
      ref.current.appendChild(s);
    }
  }, []);
  return <div className="stars" ref={ref} />;
}

function useScrollReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".reveal");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -60px 0px" }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function useNavScroll() {
  useEffect(() => {
    const nav = document.getElementById("rf-nav");
    if (!nav) return;
    const onScroll = () => {
      if (window.scrollY > 40) nav.classList.add("scrolled");
      else nav.classList.remove("scrolled");
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
}

function Snitch() {
  const snitchRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ x: 200, y: 300 });
  const velRef = useRef({ x: 2.5, y: 1.8 });
  const mouseRef = useRef({ x: -1000, y: -1000 });
  const [caught, setCaught] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const frameRef = useRef<number>(0);

  // Track mouse position
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // Show hint toast after 3 seconds
  useEffect(() => {
    const t = setTimeout(() => setShowToast(true), 3000);
    const t2 = setTimeout(() => setShowToast(false), 9000);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, []);

  const animate = useCallback(() => {
    if (caught) return;
    const el = snitchRef.current;
    if (!el) return;

    const pos = posRef.current;
    const vel = velRef.current;
    const mouse = mouseRef.current;
    const w = window.innerWidth - 50;
    const h = window.innerHeight - 50;

    // Cursor proximity — gentle scale up (no fleeing)
    const dx = pos.x - mouse.x;
    const dy = pos.y - mouse.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const hoverRadius = 120;
    const nearScale = dist < hoverRadius ? 1 + (1 - dist / hoverRadius) * 0.2 : 1;
    el.style.transform = `scale(${nearScale})`;

    // Erratic movement — random direction shifts
    if (Math.random() < 0.03) {
      vel.x += (Math.random() - 0.5) * 3;
      vel.y += (Math.random() - 0.5) * 3;
    }

    // Gentle drift
    vel.x += (Math.random() - 0.5) * 0.3;
    vel.y += (Math.random() - 0.5) * 0.3;

    // Speed clamping
    const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
    const maxSpeed = 3.5;
    const minSpeed = 1.2;
    if (speed > maxSpeed) { vel.x *= maxSpeed / speed; vel.y *= maxSpeed / speed; }
    if (speed < minSpeed) { vel.x *= minSpeed / speed; vel.y *= minSpeed / speed; }

    // Friction
    vel.x *= 0.98;
    vel.y *= 0.98;

    pos.x += vel.x;
    pos.y += vel.y;

    // Bounce off edges
    if (pos.x < 30 || pos.x > w) { vel.x *= -1; pos.x = Math.max(30, Math.min(w, pos.x)); }
    if (pos.y < 30 || pos.y > h) { vel.y *= -1; pos.y = Math.max(30, Math.min(h, pos.y)); }

    el.style.left = pos.x + "px";
    el.style.top = pos.y + "px";

    frameRef.current = requestAnimationFrame(animate);
  }, [caught]);

  useEffect(() => {
    if (!caught) {
      frameRef.current = requestAnimationFrame(animate);
      return () => cancelAnimationFrame(frameRef.current);
    }
  }, [caught, animate]);

  function handleCatch() {
    if (caught) return;
    setCaught(true);
    setShowToast(false);
  }

  if (dismissed) return null;

  return (
    <>
      {/* Hint toast */}
      {showToast && !caught && (
        <div className="snitch-toast snitch-hint">
          <span className="snitch-toast-dot" />
          Catch the golden snitch for a surprise
        </div>
      )}

      {/* Caught modal */}
      {caught && (
        <div className="snitch-overlay" onClick={() => setDismissed(true)}>
          <div className="snitch-modal" onClick={(e) => e.stopPropagation()}>
            <div className="snitch-modal-glow" />
            <div className="snitch-caught-icon">✦</div>
            <h3>You caught it.</h3>
            <p className="snitch-hero-line">
              You just caught your attention in this moment.
              Let&apos;s hope you can hang onto it — instead of giving it back
              to the algorithms you don&apos;t control.
            </p>
            <div className="snitch-reward">
              <span className="snitch-reward-label">Your reward</span>
              One free month of credits to talk to our AI and curate your feed.
            </div>
            <button className="snitch-claim" onClick={() => setDismissed(true)}>
              Claim
            </button>
          </div>
        </div>
      )}

      {/* The snitch */}
      {!caught && (
        <div
          ref={snitchRef}
          className="snitch"
          onClick={handleCatch}
          style={{ left: 200, top: 300 }}
        >
          <svg viewBox="0 0 40 40" width="52" height="52">
            <defs>
              <radialGradient id="snitchGlow" cx="40%" cy="35%" r="60%">
                <stop offset="0%" stopColor="#ffe08a" />
                <stop offset="50%" stopColor="#e8b988" />
                <stop offset="100%" stopColor="#d4a574" />
              </radialGradient>
            </defs>
            {/* Body */}
            <ellipse cx="20" cy="20" rx="7" ry="6.5" fill="url(#snitchGlow)" />
            <ellipse cx="20" cy="20" rx="7" ry="6.5" fill="none" stroke="#c4943a" strokeWidth="0.5" opacity="0.6" />
            {/* Wings */}
            <path d="M12 18 Q6 10 2 12 Q6 14 10 18" fill="#f3ecdd" opacity="0.7" className="snitch-wing-l" />
            <path d="M12 16 Q7 8 4 10 Q8 12 11 16" fill="#f3ecdd" opacity="0.5" className="snitch-wing-l" />
            <path d="M28 18 Q34 10 38 12 Q34 14 30 18" fill="#f3ecdd" opacity="0.7" className="snitch-wing-r" />
            <path d="M28 16 Q33 8 36 10 Q32 12 29 16" fill="#f3ecdd" opacity="0.5" className="snitch-wing-r" />
            {/* Highlight */}
            <ellipse cx="18" cy="18" rx="2.5" ry="2" fill="white" opacity="0.45" />
          </svg>
        </div>
      )}
    </>
  );
}

function SubscribeForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "loading") return;
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error || "Something went wrong. Try again?");
        return;
      }
      setStatus("ok");
      setMessage(
        data.created
          ? "You're on the list. We'll write when there's something worth your time."
          : "You're already on the list — we'll be in touch."
      );
      setEmail("");
    } catch {
      setStatus("error");
      setMessage("Something went wrong. Try again?");
    }
  }

  if (status === "ok") {
    return (
      <div className="subscribe-success">
        <span className="subscribe-success-mark">✦</span>
        <p>{message}</p>
      </div>
    );
  }

  return (
    <form className="subscribe-form" onSubmit={onSubmit} noValidate>
      <div className="subscribe-row">
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="your@email.com"
          aria-label="Email address"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === "error") setStatus("idle");
          }}
          disabled={status === "loading"}
        />
        <button
          type="submit"
          className="btn btn-primary subscribe-submit"
          disabled={status === "loading" || email.trim().length === 0}
        >
          {status === "loading" ? "Sending…" : "Notify me"}
          <span className="arrow">→</span>
        </button>
      </div>
      {status === "error" && message && (
        <div className="subscribe-error">{message}</div>
      )}
    </form>
  );
}

const FEEDS = [
  { name: "Morning philosophy", sub: "12 new · refreshed 2m", color: "var(--amber)", desc: "Slow thinking, first thing. Read for twenty minutes, then close." },
  { name: "Climate signals", sub: "4 new · refreshed 18m", color: "var(--ember)", desc: "The slow data, the small shifts — read in steady rhythm." },
  { name: "Essays > 2,000 words", sub: "2 new · refreshed 1h", color: "var(--aurora)", desc: "Nothing short. Nothing viral. Pieces to sit with." },
  { name: "Art I haven\u2019t seen", sub: "9 new · refreshed 34m", color: "var(--aurora-deep)", desc: "Artists, moments and works you don\u2019t yet know." },
  { name: "Local, only local", sub: "1 new · refreshed 4h", color: "var(--rose)", desc: "The neighborhood, the block, the kitchen light two doors down." },
];

function MockupSection() {
  const [active, setActive] = useState(0);
  const feed = FEEDS[active];

  return (
    <div className="mockup reveal">
      <div className="mockup-bar">
        <div className="dot-row"><span className="d" /><span className="d" /><span className="d" /></div>
        <div className="mockup-url">ripple.feed &nbsp;/&nbsp; library</div>
        <div style={{ width: 50 }} />
      </div>
      <div className="mockup-body">
        <div className="mockup-side">
          <div className="side-label">Your Feeds · 05</div>
          {FEEDS.map((f, i) => (
            <div key={f.name} className={`feed-item${i === active ? " active" : ""}`} onClick={() => setActive(i)}>
              <span className="swatch" style={{ background: f.color }} />
              <div className="meta-col">
                <div className="name">{f.name}</div>
                <div className="sub">{f.sub}</div>
              </div>
            </div>
          ))}
          <Link href="/curator" className="new-feed-btn" style={{ display: "block", textDecoration: "none" }}>+ New feed</Link>
        </div>
        <div className="mockup-main">
          <div className="main-head">
            <h4>{feed.name}</h4>
            <span className="live">live</span>
          </div>
          <div className="main-desc">{feed.desc}</div>
          <div className="post">
            <div className="post-head">
              <div className="avatar" />
              <span className="handle">@agnes.bsky.social</span>
              <span className="time">7m</span>
            </div>
            <div className="post-body">
              On <em>attention</em> as a moral faculty: we do not choose what we value
              so much as we choose what we notice. To curate a feed, then, is already
              an ethical act…
            </div>
          </div>
          <div className="post">
            <div className="post-head">
              <div className="avatar" style={{ background: "linear-gradient(135deg, #e09575, #e8b988)" }} />
              <span className="handle">@sfowler</span>
              <span className="time">24m</span>
            </div>
            <div className="post-body">
              New piece up on the long history of the <em>examined life</em> — and
              why it keeps getting reinvented, feed by feed, era by era.
            </div>
          </div>
          <div className="post">
            <div className="post-head">
              <div className="avatar" style={{ background: "linear-gradient(135deg, #7dcba5, #3e8a6c)" }} />
              <span className="handle">@oliverburkeman</span>
              <span className="time">1h</span>
            </div>
            <div className="post-body">
              Four thousand weeks. That&apos;s all any of us gets. The question isn&apos;t
              how to spend them more productively — it&apos;s what we want to have
              <em>noticed</em> by the end.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  useScrollReveal();
  useNavScroll();

  return (
    <div className="rf-page">
      <div className="grain" />
      <div className="vignette" />
      <Snitch />

      {/* NAV */}
      <nav className="rf-nav" id="rf-nav">
        <a href="#" className="brand">
          <ShaderLogo height={42} />
        </a>
        <div className="nav-links">
          <a href="#manifesto">Manifesto</a>
          <a href="#how">How it works</a>
          <a href="#about">About</a>
          <Link href="/curator" className="nav-cta">Begin →</Link>
        </div>
      </nav>

      {/* HERO */}
      <section className="hero">
        <Stars />
        <div className="wrap hero-content">
          <span className="hero-eyebrow mono">
            <span className="dot" />
            Ripple Feed &nbsp;/&nbsp; built on bluesky
          </span>
          <h1>
            A feed you <span className="it">actually</span><br />chose.
          </h1>
          <p className="hero-sub">
            In the same way you <em>curate what you eat</em>, now curate what you read.
            A small, quiet experiment in returning the feed to the reader.
          </p>
          <div className="hero-subscribe">
            <p className="hero-subscribe-label">
              Leave your email — we&apos;ll write the day there&apos;s something worth your time.
            </p>
            <SubscribeForm />
          </div>
          <div className="hero-actions">
            <Link href="/curator" className="btn btn-primary">
              Try demo (feed curation) <span className="arrow">→</span>
            </Link>
            <a href="#manifesto" className="btn btn-ghost">Read the manifesto</a>
          </div>
        </div>

      </section>

      {/* MANIFESTO */}
      <section className="manifesto" id="manifesto">
        <div className="wrap">
          <div className="section-head reveal">
            <span className="idx">I.</span>
            <span className="hair" />
            <span className="title">The Manifesto</span>
          </div>
          <div className="manifesto-grid">
            <div className="manifesto-left reveal">
              <h2>Your feed <em>is not</em><br />yours.</h2>
              <div className="img-slot is-tall" style={{ maxWidth: 380 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/manifesto.jpg" alt="The overwhelming default feed" />
              </div>
            </div>
            <div className="manifesto-body reveal">
              <p>
                Modern social feeds were not built to inform you — they were built to
                <em> hold</em> you. Each scroll, each tap, each returning flick of the thumb is a
                small transaction: your attention traded for engagement, your time converted
                into revenue for a system that has never met you.
              </p>
              <p>
                The result is familiar. Hours go by. The feed churns. And at the end,
                little remains — no clearer sense of the world, no deeper understanding
                of the subjects you actually care about. Only the fatigue of having been <em>consumed</em>.
              </p>
              <p>
                We believe feeds can be something else. A feed can be chosen. A feed can
                be shaped by what you actually want to know, the way a good meal is
                shaped by what you actually want to eat. A feed can be quiet.
              </p>
              <div className="pullquote">
                &ldquo;The only radical act left in the attention economy is to&nbsp;<em>choose</em>.&rdquo;
                <span className="attr">— Ripple Feed, first principle</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* DIET */}
      <section className="diet">
        <div className="wrap">
          <div className="section-head reveal">
            <span className="idx">II.</span>
            <span className="hair" />
            <span className="title">A new metaphor</span>
          </div>
          <div className="diet-intro reveal">
            <h2>Your <em>information</em><br />diet.</h2>
            <p>You would not eat whatever fell into your mouth. Why let the feed decide what falls into your mind?</p>
          </div>
          <div className="plates">
            <div className="plate junk reveal">
              <div className="plate-label"><span className="marker" />The default feed</div>
              <h3>Engineered to <em>hold</em> you.</h3>
              <ul className="plate-items">
                <li>Outrage bait <span className="tag">+ 4h / week</span></li>
                <li>Parasocial drama <span className="tag">+ 3h / week</span></li>
                <li>Algorithmic repeats <span className="tag">+ 5h / week</span></li>
                <li>Ads dressed as content <span className="tag">+ 2h / week</span></li>
                <li>Strangers you dislike <span className="tag">+ 1h / week</span></li>
              </ul>
            </div>
            <div className="plate curated reveal">
              <div className="plate-label"><span className="marker" />A Ripple feed</div>
              <h3>Engineered to <em>nourish</em> you.</h3>
              <ul className="plate-items">
                <li>Long essays you&apos;d save <span className="tag">chosen</span></li>
                <li>Fields you&apos;re studying <span className="tag">chosen</span></li>
                <li>Thinkers you admire <span className="tag">chosen</span></li>
                <li>Quiet corners of the web <span className="tag">chosen</span></li>
                <li>Nothing, when nothing&apos;s needed <span className="tag">chosen</span></li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="how" id="how">
        <div className="wrap">
          <div className="section-head reveal">
            <span className="idx">III.</span>
            <span className="hair" />
            <span className="title">How it works</span>
          </div>
          <h2 className="reveal">
            Two simple <em>motions</em>.<br />That&apos;s the entire product.
          </h2>
          <div className="steps">
            <div className="step reveal">
              <div className="step-image">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/step-01.jpg" alt="Curating your feed through conversation" />
              </div>
              <div className="step-header">
                <span className="step-num">01</span>
                <svg className="step-icon" viewBox="0 0 60 60" fill="none">
                  <circle cx="30" cy="30" r="26" stroke="#e8b988" strokeWidth="1" opacity="0.5" />
                  <path d="M18 26 Q24 22 30 26 Q36 30 42 26" stroke="#e8b988" strokeWidth="1.2" fill="none" />
                  <path d="M18 34 Q24 30 30 34 Q36 38 42 34" stroke="#7dcba5" strokeWidth="1.2" fill="none" opacity="0.8" />
                  <circle cx="30" cy="30" r="2" fill="#f3ecdd" />
                </svg>
              </div>
              <h3>Make a new feed — by <em>talking</em>.</h3>
              <p>
                A single, quiet conversation with our agent. Tell it what you
                want to pay attention to, and what you&apos;d like to leave behind.
                It shapes a feed from that conversation alone.
              </p>
              <div className="step-foot">Step one &nbsp;·&nbsp; ~3 minutes</div>
            </div>
            <div className="step reveal">
              <div className="step-image">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/step-02.jpg" alt="Browsing your curated feeds" />
              </div>
              <div className="step-header">
                <span className="step-num">02</span>
                <svg className="step-icon" viewBox="0 0 60 60" fill="none">
                  <rect x="10" y="14" width="40" height="6" rx="1" stroke="#e8b988" strokeWidth="1" opacity="0.6" />
                  <rect x="10" y="27" width="40" height="6" rx="1" stroke="#e8b988" strokeWidth="1" opacity="0.9" />
                  <rect x="10" y="40" width="40" height="6" rx="1" stroke="#e8b988" strokeWidth="1" opacity="0.4" />
                  <circle cx="14" cy="30" r="1.5" fill="#7dcba5" />
                </svg>
              </div>
              <h3>Browse your feeds. <em>Live.</em></h3>
              <p>
                Every feed you&apos;ve built sits in a single quiet library.
                Click one, and it opens — running live on Bluesky, updating
                as the world updates, but only with what you asked for.
              </p>
              <div className="step-foot">Step two &nbsp;·&nbsp; continuous</div>
            </div>
          </div>
        </div>
      </section>

      {/* PREVIEW */}
      <section className="preview-section">
        <div className="wrap">
          <div className="section-head reveal">
            <span className="idx">IV.</span>
            <span className="hair" />
            <span className="title">Inside Ripple Feed</span>
          </div>
          <div className="preview-head reveal">
            <h2>What a feed you <em>chose</em> looks like.</h2>
            <p>Your library, on the left. The feed, on the right. That&apos;s it.</p>
          </div>
          <MockupSection />
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="final" id="final">
        <div className="final-ripples">
          <svg viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg">
            <circle className="ripple-ring" cx="400" cy="400" r="60" stroke="#e8b988" strokeWidth="0.8" fill="none" opacity="0.5" />
            <circle className="ripple-ring" cx="400" cy="400" r="150" stroke="#7dcba5" strokeWidth="0.7" fill="none" opacity="0.45" />
            <circle className="ripple-ring" cx="400" cy="400" r="250" stroke="#7dcba5" strokeWidth="0.6" fill="none" opacity="0.35" />
            <circle className="ripple-ring" cx="400" cy="400" r="360" stroke="#e8b988" strokeWidth="0.5" fill="none" opacity="0.25" />
            <circle className="ripple-ring" cx="400" cy="400" r="470" stroke="#e09575" strokeWidth="0.4" fill="none" opacity="0.16" />
          </svg>
        </div>
        <div className="wrap final-content">
          <h2 className="reveal">Return to a feed that<br />is <em>genuinely</em> yours.</h2>
          <p className="reveal">Start curating your feed now. No waitlist.</p>
          <div className="reveal">
            <Link href="/curator" className="btn btn-primary" style={{ fontSize: 14 }}>
              Try demo (feed curation) <span className="arrow">→</span>
            </Link>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="rf-footer">
        <div className="wrap footer-row">
          <div className="foot-brand">
            <Logo variant="wordmark" height={32} shimmer={false} />
          </div>
          <div className="foot-links">
            <a href="#manifesto">Manifesto</a>
            <a href="#how">How</a>
            <a href="#about">Team</a>
          </div>
          <div className="foot-meta">© 2026 &nbsp;·&nbsp; A quiet experiment</div>
        </div>
      </footer>
    </div>
  );
}
