"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { motion } from "motion/react";
import Link from "next/link";
import "./landing.css";
import Logo from "@/components/Logo";
import ShaderLogo from "@/components/ShaderLogo";
import ShaderSendButton from "@/components/ShaderSendButton";

const World = dynamic(() => import("@/components/ui/globe").then((m) => m.World), { ssr: false });

const globeConfig = {
  pointSize: 4,
  globeColor: "#1c3a2e",
  showAtmosphere: true,
  atmosphereColor: "#7dcba5",
  atmosphereAltitude: 0.1,
  emissive: "#1c3a2e",
  emissiveIntensity: 0.1,
  shininess: 0.9,
  polygonColor: "rgba(125, 203, 165, 0.4)",
  ambientLight: "#7dcba5",
  directionalLeftLight: "#a8d5bd",
  directionalTopLight: "#a8d5bd",
  pointLight: "#e8b988",
  arcTime: 1000,
  arcLength: 0.9,
  rings: 1,
  maxRings: 3,
  initialPosition: { lat: 22.3193, lng: 114.1694 },
  autoRotate: true,
  autoRotateSpeed: 0.5,
};

const arcColors = ["#7dcba5", "#3e8a6c", "#e8b988"];
const rc = () => arcColors[Math.floor(Math.random() * arcColors.length)];

const sampleArcs = [
  { order: 1, startLat: -19.885592, startLng: -43.951191, endLat: -22.9068, endLng: -43.1729, arcAlt: 0.1, color: rc() },
  { order: 1, startLat: 28.6139, startLng: 77.209, endLat: 3.139, endLng: 101.6869, arcAlt: 0.2, color: rc() },
  { order: 1, startLat: -19.885592, startLng: -43.951191, endLat: -1.303396, endLng: 36.852443, arcAlt: 0.5, color: rc() },
  { order: 2, startLat: 1.3521, startLng: 103.8198, endLat: 35.6762, endLng: 139.6503, arcAlt: 0.2, color: rc() },
  { order: 2, startLat: 51.5072, startLng: -0.1276, endLat: 3.139, endLng: 101.6869, arcAlt: 0.3, color: rc() },
  { order: 2, startLat: -15.785493, startLng: -47.909029, endLat: 36.162809, endLng: -115.119411, arcAlt: 0.3, color: rc() },
  { order: 3, startLat: -33.8688, startLng: 151.2093, endLat: 22.3193, endLng: 114.1694, arcAlt: 0.3, color: rc() },
  { order: 3, startLat: 21.3099, startLng: -157.8581, endLat: 40.7128, endLng: -74.006, arcAlt: 0.3, color: rc() },
  { order: 3, startLat: -6.2088, startLng: 106.8456, endLat: 51.5072, endLng: -0.1276, arcAlt: 0.3, color: rc() },
  { order: 4, startLat: 11.986597, startLng: 8.571831, endLat: -15.595412, endLng: -56.05918, arcAlt: 0.5, color: rc() },
  { order: 4, startLat: -34.6037, startLng: -58.3816, endLat: 22.3193, endLng: 114.1694, arcAlt: 0.7, color: rc() },
  { order: 4, startLat: 51.5072, startLng: -0.1276, endLat: 48.8566, endLng: -2.3522, arcAlt: 0.1, color: rc() },
  { order: 5, startLat: 14.5995, startLng: 120.9842, endLat: 51.5072, endLng: -0.1276, arcAlt: 0.3, color: rc() },
  { order: 5, startLat: 1.3521, startLng: 103.8198, endLat: -33.8688, endLng: 151.2093, arcAlt: 0.2, color: rc() },
  { order: 5, startLat: 34.0522, startLng: -118.2437, endLat: 48.8566, endLng: -2.3522, arcAlt: 0.2, color: rc() },
  { order: 6, startLat: -15.432563, startLng: 28.315853, endLat: 1.094136, endLng: -63.34546, arcAlt: 0.7, color: rc() },
  { order: 6, startLat: 37.5665, startLng: 126.978, endLat: 35.6762, endLng: 139.6503, arcAlt: 0.1, color: rc() },
  { order: 6, startLat: 22.3193, startLng: 114.1694, endLat: 51.5072, endLng: -0.1276, arcAlt: 0.3, color: rc() },
  { order: 7, startLat: -19.885592, startLng: -43.951191, endLat: -15.595412, endLng: -56.05918, arcAlt: 0.1, color: rc() },
  { order: 7, startLat: 48.8566, startLng: -2.3522, endLat: 52.52, endLng: 13.405, arcAlt: 0.1, color: rc() },
  { order: 7, startLat: 52.52, startLng: 13.405, endLat: 34.0522, endLng: -118.2437, arcAlt: 0.2, color: rc() },
  { order: 8, startLat: -8.833221, startLng: 13.264837, endLat: -33.936138, endLng: 18.436529, arcAlt: 0.2, color: rc() },
  { order: 8, startLat: 49.2827, startLng: -123.1207, endLat: 52.3676, endLng: 4.9041, arcAlt: 0.2, color: rc() },
  { order: 8, startLat: 1.3521, startLng: 103.8198, endLat: 40.7128, endLng: -74.006, arcAlt: 0.5, color: rc() },
  { order: 9, startLat: 51.5072, startLng: -0.1276, endLat: 34.0522, endLng: -118.2437, arcAlt: 0.2, color: rc() },
  { order: 9, startLat: 22.3193, startLng: 114.1694, endLat: -22.9068, endLng: -43.1729, arcAlt: 0.7, color: rc() },
  { order: 9, startLat: 1.3521, startLng: 103.8198, endLat: -34.6037, endLng: -58.3816, arcAlt: 0.5, color: rc() },
  { order: 10, startLat: -22.9068, startLng: -43.1729, endLat: 28.6139, endLng: 77.209, arcAlt: 0.7, color: rc() },
  { order: 10, startLat: 34.0522, startLng: -118.2437, endLat: 31.2304, endLng: 121.4737, arcAlt: 0.3, color: rc() },
  { order: 10, startLat: -6.2088, startLng: 106.8456, endLat: 52.3676, endLng: 4.9041, arcAlt: 0.3, color: rc() },
  { order: 11, startLat: 41.9028, startLng: 12.4964, endLat: 34.0522, endLng: -118.2437, arcAlt: 0.2, color: rc() },
  { order: 11, startLat: -6.2088, startLng: 106.8456, endLat: 31.2304, endLng: 121.4737, arcAlt: 0.2, color: rc() },
  { order: 11, startLat: 22.3193, startLng: 114.1694, endLat: 1.3521, endLng: 103.8198, arcAlt: 0.2, color: rc() },
  { order: 12, startLat: 34.0522, startLng: -118.2437, endLat: 37.7749, endLng: -122.4194, arcAlt: 0.1, color: rc() },
  { order: 12, startLat: 35.6762, startLng: 139.6503, endLat: 22.3193, endLng: 114.1694, arcAlt: 0.2, color: rc() },
  { order: 12, startLat: 22.3193, startLng: 114.1694, endLat: 34.0522, endLng: -118.2437, arcAlt: 0.3, color: rc() },
  { order: 13, startLat: 52.52, startLng: 13.405, endLat: 22.3193, endLng: 114.1694, arcAlt: 0.3, color: rc() },
  { order: 13, startLat: 11.986597, startLng: 8.571831, endLat: 35.6762, endLng: 139.6503, arcAlt: 0.3, color: rc() },
  { order: 13, startLat: -22.9068, startLng: -43.1729, endLat: -34.6037, endLng: -58.3816, arcAlt: 0.1, color: rc() },
  { order: 14, startLat: -33.936138, startLng: 18.436529, endLat: 21.395643, endLng: 39.883798, arcAlt: 0.3, color: rc() },
];

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
          ? "You\u2019re on the list."
          : "You\u2019re on the list."
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
        <span className="subscribe-success-mark">{"\u2726"}</span>
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
        <ShaderSendButton disabled={status === "loading" || email.trim().length === 0} />
      </div>
      {status === "error" && message && (
        <div className="subscribe-error">{message}</div>
      )}
    </form>
  );
}

export default function LandingPageV2() {
  useScrollReveal();
  useNavScroll();

  return (
    <div className="rf-page">
      <div className="grain" />
      <div className="vignette" />
      <Link href="/curator" style={{ position: "fixed", top: 24, right: 32, zIndex: 50, fontFamily: "var(--rf-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#000", textDecoration: "none", padding: "8px 18px", borderRadius: 999, background: "#fff", fontWeight: 700 }}>
        Try Demo &rarr;
      </Link>



      {/* HERO with Globe */}
      <section className="hero" style={{ minHeight: "100vh", display: "flex", alignItems: "flex-start", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", width: "100%", bottom: -180, height: "100%", zIndex: 1 }}>
          <World data={sampleArcs} globeConfig={globeConfig} />
        </div>
        <div style={{ position: "absolute", width: "100%", bottom: 0, height: 160, background: "linear-gradient(to bottom, transparent, #000000)", zIndex: 2, pointerEvents: "none" }} />
        <div className="wrap hero-content" style={{ position: "relative", zIndex: 3, textAlign: "center", maxWidth: 720, margin: "0 auto", paddingTop: "8vh" }}>
          <motion.h1
            initial={{ opacity: 0, y: -60 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, ease: "easeOut" }}
            style={{ fontSize: "clamp(2.4rem, 5vw, 4rem)", lineHeight: 1.15 }}
          >
            A feed you <span className="it">actually</span> choose.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: -40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, ease: "easeOut", delay: 0.3 }}
            className="hero-sub" style={{ maxWidth: 600, margin: "6px auto 2rem", fontSize: "1.25rem", lineHeight: 1.7 }}>
            In the same way you <em>curate what you eat</em>, you must curate what you consume online to stay healthy.
            We&apos;re building the tools to help you do that.
          </motion.p>
          <p style={{ fontFamily: "var(--rf-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#ffffff", fontWeight: 700, marginBottom: 10, marginTop: 550, textAlign: "center" }}>Join the Waitlist</p>
          <div style={{ maxWidth: 420, margin: "0 auto 16px" }}>
            <SubscribeForm />
          </div>
        </div>
      </section>

      {/* MANIFESTO */}
      <section className="mission" id="mission">
        <div className="wrap">
          <div className="section-head reveal">
            <span className="idx">I.</span>
            <span className="hair" />
            <span className="title">The Mission</span>
          </div>
          <div className="mission-grid">
            <div className="mission-left reveal">
              <h2>Your feed <em>is not</em><br />yours.</h2>
              <div className="img-slot is-tall" style={{ maxWidth: 380 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/manifesto.jpg" alt="The overwhelming default feed" />
              </div>
            </div>
            <div className="mission-body reveal">
              <p>
                Modern social feeds are built to maximize a single metric: <em>engagement</em>.
                This is not a novel insight. However, as algorithms have gotten better,
                the problem has become more acute. At
                the same time, new technologies have made fake users, content and interactions
                indistinguishable from real ones.
              </p>
              <p>
                The old solution was &ldquo;just stop using social media.&rdquo; But as our lives have moved online more
                and more, the lines around what is and isn&apos;t social media have blurred. Avoidance is both
                more difficult and more restrictive to our own growth and goals. New technologies that create new
                problems require better technology, not avoidance. The solution to fatal car crashes
                is <em>seatbelts</em>, not ditching cars for horses.
              </p>
              <p>
                So <em>why now</em>? Multiple
                things are converging to change the way we engage with content online.
                New open protocols eliminate walled gardens and bake transparency into algorithms and
                platforms. Authentication technologies make fake content explicit. LLMs give users more
                fine grained control of their information stream. Together these can make our digital
                experiences radically healthier.
              </p>
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
              <div className="plate-label"><span className="marker" />A Willow feed</div>
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
              </div>
              <h3>Make a new feed &mdash; by <em>talking</em>.</h3>
              <p>
                A single, quiet conversation with our agent. Tell it what you
                want to pay attention to, and what you&apos;d like to leave behind.
                It shapes a feed from that conversation alone.
              </p>
              <div className="step-foot">Step one &nbsp;&middot;&nbsp; ~3 minutes</div>
            </div>
            <div className="step reveal">
              <div className="step-image">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/step-02.jpg" alt="Browsing your curated feeds" />
              </div>
              <div className="step-header">
                <span className="step-num">02</span>
              </div>
              <h3>Browse your feeds. <em>Live.</em></h3>
              <p>
                Every feed you&apos;ve built sits in a single quiet library.
                Click one, and it opens &mdash; running live on Bluesky, updating
                as the world updates, but only with what you asked for.
              </p>
              <div className="step-foot">Step two &nbsp;&middot;&nbsp; continuous</div>
            </div>
          </div>
        </div>
      </section>

      {/* ABOUT */}
      <section className="about-section" id="about">
        <div className="wrap">
          <div className="section-head reveal">
            <span className="idx">IV.</span>
            <span className="hair" />
            <span className="title">The Team</span>
          </div>
          <div className="about-grid">
            <div className="about-card reveal" style={{ transitionDelay: "0ms" }}>
              <div className="about-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/christian.jpg" alt="Christian" />
              </div>
              <div className="about-info">
                <h3 className="about-name">Christian Neizonek</h3>
                <p className="about-role">Engineer, Father</p>
                <p className="about-bio">
                  Worked in robotics for 10 years. Pivoting to the most important problems in our world today. My goal: to build online spaces that make people their best selves.
                </p>
                <div className="about-links">
                  <a href="https://bsky.app/profile/wawrio.bsky.social" className="about-link" target="_blank" rel="noopener noreferrer">Bluesky</a>
                </div>
              </div>
            </div>
            <div className="about-card reveal" style={{ transitionDelay: "120ms" }}>
              <div className="about-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/ohm.jpg" alt="Ohm" />
              </div>
              <div className="about-info">
                <h3 className="about-name">Ohm Patel</h3>
                <p className="about-role">Engineer</p>
                <p className="about-bio">
                  Short bio goes here. What you care about, what you&apos;ve built, why this project matters to you personally.
                </p>
                <div className="about-links">
                  <a href="#" className="about-link" target="_blank" rel="noopener noreferrer">Bluesky</a>
                </div>
              </div>
            </div>
            <div className="about-card reveal" style={{ transitionDelay: "240ms" }}>
              <div className="about-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/amir.jpg" alt="Amir" />
              </div>
              <div className="about-info">
                <h3 className="about-name">Amir Ahanchi</h3>
                <p className="about-role">Engineer</p>
                <p className="about-bio">
                  Short bio goes here. What you care about, what you&apos;ve built, why this project matters to you personally.
                </p>
                <div className="about-links">
                  <a href="https://bsky.app/profile/ahanchi.bsky.social" className="about-link" target="_blank" rel="noopener noreferrer">Bluesky</a>
                </div>
              </div>
            </div>
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
            <a href="#mission">Mission</a>
            <a href="#how">How</a>
            <a href="#about">Team</a>
          </div>
          <div className="foot-meta">&copy; 2026</div>
        </div>
      </footer>
    </div>
  );
}
