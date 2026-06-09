"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { motion } from "motion/react";
import Link from "next/link";
import "./landing.css";

const World = dynamic(() => import("@/components/ui/globe").then((m) => m.World), { ssr: false });

function BlueskyIcon() {
  return (
    <svg viewBox="0 0 600 530" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M135.72 44.03C202.216 93.951 273.74 195.17 300 249.49c26.262-54.316 97.782-155.54 164.28-205.46C512.26 8.009 590-19.862 590 68.825c0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.38-3.69-10.832-3.708-7.896-.017-2.936-1.193.516-3.707 7.896-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.45-163.25-81.433C20.15 217.613 9.997 86.535 9.997 68.825c0-88.687 77.742-60.816 125.72-24.795z" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

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
      <div className="subscribe-pill">
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
          className="subscribe-join"
          disabled={status === "loading" || email.trim().length === 0}
        >
          {status === "loading" ? "Joining…" : "Join"}
        </button>
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
      <div className="landing-wordmark">willow</div>
      <nav className="landing-nav">
        <a href="#mission" className="landing-nav-link">Mission</a>
        <a href="#how" className="landing-nav-link">How it Works</a>
        <a href="#about" className="landing-nav-link">Team</a>
        <Link href="/curator" className="landing-nav-cta">
          Try Demo &rarr;
        </Link>
      </nav>



      {/* HERO with Globe */}
      <section className="hero" style={{ minHeight: "100vh", display: "flex", alignItems: "stretch", position: "relative", overflow: "hidden" }}>
        <div className="hero-globe">
          <World data={sampleArcs} globeConfig={globeConfig} />
        </div>
        <div className="hero-globe-fade" />
        <div className="wrap hero-content hero-content--centered">
          <motion.h1
            initial={{ opacity: 0, y: -60 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, ease: "easeOut" }}
            className="hero-title"
          >
            Transparency into <span className="it">your</span> feed.
          </motion.h1>
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, ease: "easeOut", delay: 0.3 }}
            className="hero-pillars"
          >
            <div className="hero-pillar">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="hero-pillar-icon" src="/images/pillars/feed-curation.png" alt="" aria-hidden="true" />
              <span className="hero-pillar-label">Feed curation</span>
              <span className="hero-pillar-sub">Choose your feed</span>
            </div>
            <div className="hero-pillar">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="hero-pillar-icon" src="/images/pillars/user-identification.png" alt="" aria-hidden="true" />
              <span className="hero-pillar-label">User identification</span>
              <span className="hero-pillar-sub">See who&apos;s real</span>
            </div>
            <div className="hero-pillar">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="hero-pillar-icon" src="/images/pillars/content-validation.png" alt="" aria-hidden="true" />
              <span className="hero-pillar-label">Content validation</span>
              <span className="hero-pillar-sub">See what&apos;s true</span>
            </div>
          </motion.div>
          <p className="hero-waitlist-label">Join the Waitlist</p>
          <div className="hero-waitlist-form">
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
                A single conversation with our agent. Tell it what you
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
                  <a href="https://bsky.app/profile/wawrio.bsky.social" className="about-link" target="_blank" rel="noopener noreferrer" aria-label="Bluesky"><BlueskyIcon /></a>
                  <a href="https://www.linkedin.com/in/christian-neizonek-613b9ba0/" className="about-link" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn"><LinkedInIcon /></a>
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
                  Former content creator turned engineer. Building better incentive systems for social media &mdash; feeds that serve people, not platforms.
                </p>
                <div className="about-links">
                  <a href="https://bsky.app/profile/ohmcpatel.bsky.social" className="about-link" target="_blank" rel="noopener noreferrer" aria-label="Bluesky"><BlueskyIcon /></a>
                  <a href="https://www.linkedin.com/in/ohm-patel-84856223b/" className="about-link" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn"><LinkedInIcon /></a>
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
                  Engineer with years in social media space. Growing up in Iran, seeing how centralized power can control/exploit people and going through Meditation retreats have helped me deeply care about intentional living, agency, and the need for open platforms people can truly trust.
                </p>
                <div className="about-links">
                  <a href="https://bsky.app/profile/amirmasti.bsky.social" className="about-link" target="_blank" rel="noopener noreferrer" aria-label="Bluesky"><BlueskyIcon /></a>
                  <a href="https://www.linkedin.com/in/ahanchi/" className="about-link" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn"><LinkedInIcon /></a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>



      {/* FOOTER */}
      <footer className="rf-footer">
        <div className="wrap footer-row">
          <div className="foot-brand" style={{ fontFamily: "var(--rf-display), 'Instrument Serif', serif", fontSize: 22, color: "var(--cream, #f3ecdd)", letterSpacing: "-0.02em" }}>
            willow
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
