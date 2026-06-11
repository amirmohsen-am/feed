"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import "./landing-acts.css";
import "./landing-v2.css";
import FlySection from "@/components/landing/FlySection";
import GlassSection from "@/components/landing/GlassSection";

/*
 * Landing page — the interactive prototype, promoted.
 * Flow: catch-the-snitch (attention) → wipe-the-glass (transparency),
 * both scroll-gated with a skip; then the main pitch (headline, three
 * pillars, waitlist + demo), mission, team.
 */

function useScrollReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".p-reveal");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.14 }
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
}

/** deterministic pseudo-random (SSR-safe) for the per-char reveal */
function charRand(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** ouro-style headline: each character slides up out of a word mask with
 *  randomized delay, duration and a slight rotation. The reveal is driven
 *  by the parent section's `revealed` class. */
function HeadlineReveal({
  words,
  className,
  as: Tag = "h1",
}: {
  words: { text: string; em?: boolean }[];
  className?: string;
  as?: "h1" | "p";
}) {
  let charIndex = 0;
  return (
    <Tag className={className} aria-label={words.map((w) => w.text).join(" ")}>
      {words.map((word, wi) => (
        <span key={wi} aria-hidden="true">
          <span className={`hl-word${word.em ? " hl-em" : ""}`}>
            {Array.from(word.text).map((ch, ci) => {
              const i = charIndex++;
              const delay = charRand(i + 1) * 0.26 + wi * 0.04;
              const dur = 0.75 + charRand(i + 31) * 0.55;
              const rot = (charRand(i + 67) - 0.5) * 5;
              return (
                <span
                  key={ci}
                  className="hl-char"
                  style={
                    {
                      "--cdel": `${delay.toFixed(2)}s`,
                      "--cd": `${dur.toFixed(2)}s`,
                      "--cr": `${rot.toFixed(1)}deg`,
                    } as React.CSSProperties
                  }
                >
                  {ch}
                </span>
              );
            })}
          </span>
          {wi < words.length - 1 ? " " : ""}
        </span>
      ))}
    </Tag>
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
      setEmail("");
    } catch {
      setStatus("error");
      setMessage("Something went wrong. Try again?");
    }
  }

  if (status === "ok") {
    return (
      <div className="lv-subscribe-success">
        <span>{"✦"}</span> You&rsquo;re on the list.
      </div>
    );
  }

  return (
    <form className="lv-subscribe" onSubmit={onSubmit} noValidate>
      <div className="lv-subscribe-pill">
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
        <button type="submit" disabled={status === "loading"}>
          {status === "loading" ? "Joining…" : "Join the waitlist"}
        </button>
      </div>
      {status === "error" && <div className="lv-subscribe-error">{message}</div>}
    </form>
  );
}

function BlueskyIcon() {
  return (
    <svg width="17" height="15" viewBox="0 0 600 530" fill="currentColor" aria-hidden="true">
      <path d="m135.72 44.03c66.496 49.921 138.02 151.14 164.28 205.46 26.262-54.316 97.782-155.54 164.28-205.46 47.98-36.021 125.72-63.892 125.72 24.795 0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.3797-3.6904-10.832-3.7077-7.8964-0.017304-2.9357-1.1937 0.51669-3.7077 7.8964-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.4491-163.25-81.433-5.9562-21.282-16.111-152.36-16.111-170.07 0-88.687 77.742-60.816 125.72-24.795z" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
    </svg>
  );
}

const TEAM = [
  {
    name: "Christian Neizonek",
    role: "Engineer, Father",
    photo: "/images/christian.jpg",
    bio: "Worked in robotics for 10 years. Pivoting to the most important problems in our world today. My goal: to build online spaces that make people their best selves.",
    bsky: "https://bsky.app/profile/wawrio.bsky.social",
    linkedin: "https://www.linkedin.com/in/christian-neizonek-613b9ba0/",
  },
  {
    name: "Ohm Patel",
    role: "Engineer",
    photo: "/images/ohm.jpg",
    bio: "Former content creator turned engineer. Building better incentive systems for social media, feeds that serve people, not platforms.",
    bsky: "https://bsky.app/profile/ohmcpatel.bsky.social",
    linkedin: "https://www.linkedin.com/in/ohm-patel-84856223b/",
  },
  {
    name: "Amir Ahanchi",
    role: "Engineer",
    photo: "/images/amir.jpg",
    bio: "Engineer with years in social media space. Growing up in Iran, seeing how centralized power can control/exploit people and going through Meditation retreats have helped me deeply care about intentional living, agency, and the need for open platforms people can truly trust.",
    bsky: "https://bsky.app/profile/amirmasti.bsky.social",
    linkedin: "https://www.linkedin.com/in/ahanchi/",
  },
];

const PILLARS = [
  {
    icon: "/images/pillars/feed-curation.png",
    label: "Feed curation",
    sub: "Choose your feed",
  },
  {
    icon: "/images/pillars/user-identification.png",
    label: "User identification",
    sub: "See who's real",
  },
  {
    icon: "/images/pillars/content-validation.png",
    label: "Content validation",
    sub: "See what's true",
  },
];

export default function Landing() {
  const [flyDone, setFlyDone] = useState(false);
  const [glassDone, setGlassDone] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const flyWrapRef = useRef<HTMLDivElement>(null);
  const glassWrapRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  useScrollReveal();

  // scroll gate: locked to the current act until it's completed (or skipped)
  useEffect(() => {
    if (skipped || (flyDone && glassDone)) return;
    const onScroll = () => {
      const max =
        (flyDone ? glassWrapRef.current : flyWrapRef.current)?.offsetTop ?? 0;
      if (window.scrollY > max) window.scrollTo(0, max);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [flyDone, glassDone, skipped]);

  const skip = () => {
    setSkipped(true);
    requestAnimationFrame(() =>
      document
        .getElementById("mission")
        ?.scrollIntoView({ behavior: "smooth" })
    );
  };

  const keepGoing = () => {
    flyWrapRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // one choreography for the main pitch: headline chars, then pillars,
  // then the CTA row. Replays every time the section scrolls into view.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        el.classList.toggle("revealed", entries[0].isIntersecting);
      },
      { threshold: 0.35 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const gateOpen = skipped || (flyDone && glassDone);

  return (
    <div className="proto lv">
      <header className="proto-nav">
        <span className="proto-brand">willow</span>
      </header>

      {/* MAIN PITCH — headline, pillars, waitlist + demo */}
      <section ref={mainRef} className="lv-main" id="feed">
        <div className="proto-wrap">
          <HeadlineReveal className="lv-title" words={[{ text: "Willow" }]} />
          <HeadlineReveal
            as="p"
            className="lv-subtitle"
            words={[
              { text: "Transparency" },
              { text: "into" },
              { text: "your", em: true },
              { text: "feed." },
            ]}
          />
          <div className="lv-pillars">
            {PILLARS.map((p, i) => (
              <div
                key={p.label}
                className="lv-pillar"
                style={{ "--pd": `${(0.85 + i * 0.16).toFixed(2)}s` } as React.CSSProperties}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.icon} alt="" aria-hidden="true" />
                <span className="lv-pillar-label">{p.label}</span>
                <span className="lv-pillar-sub">{p.sub}</span>
              </div>
            ))}
          </div>
          <div className="lv-cta-row">
            <SubscribeForm />
            <Link href="/curator" className="lv-demo-btn">
              Try it out &rarr;
            </Link>
          </div>
        </div>
        <button className="lv-scroll-cue" onClick={keepGoing}>
          <span>keep going</span>
          <span className="arrow">&darr;</span>
        </button>
      </section>

      <div className="act-wrap" ref={flyWrapRef}>
        <FlySection onCaught={() => setFlyDone(true)} />
        {!gateOpen && (
          <button className="act-skip" onClick={skip}>
            skip &darr;
          </button>
        )}
      </div>

      <div className="act-wrap" ref={glassWrapRef}>
        <GlassSection onInteract={() => setGlassDone(true)} />
        {!gateOpen && (
          <button className="act-skip" onClick={skip}>
            skip &darr;
          </button>
        )}
      </div>

      {/* MISSION */}
      <section className="proto-mission" id="mission">
        <div className="proto-wrap">
          <div className="proto-head p-reveal">
            <span className="hairline" />
            <span className="label">The Mission</span>
            <span className="hairline" />
          </div>
          <div className="proto-mission-body">
            <p className="p-reveal">
              Modern social feeds are built to maximize a single metric:{" "}
              <em>engagement</em>. This is not a novel insight. However, as
              algorithms have gotten better, the problem has become more acute.
              At the same time, new technologies have made fake users, content
              and interactions indistinguishable from real ones.
            </p>
            <p className="p-reveal">
              The old solution was &ldquo;just stop using social media.&rdquo;
              But as our lives have moved online more and more, the lines
              around what is and isn&apos;t social media have blurred.
              Avoidance is both more difficult and more restrictive to our own
              growth and goals. New technologies that create new problems
              require better technology, not avoidance. The solution to fatal
              car crashes is <em>seatbelts</em>, not ditching cars for horses.
            </p>
            <p className="p-reveal">
              So <em>why now</em>? Multiple things are converging to change the
              way we engage with content online. New open protocols eliminate
              walled gardens and bake transparency into algorithms and
              platforms. Authentication technologies make fake content
              explicit. LLMs give users more fine grained control of their
              information stream. Together these can make our digital
              experiences radically healthier.
            </p>
          </div>
        </div>
      </section>

      {/* TEAM */}
      <section className="proto-team" id="team">
        <div className="proto-wrap">
          <div className="proto-head p-reveal">
            <span className="hairline" />
            <span className="label">The Team</span>
            <span className="hairline" />
          </div>
          <div className="proto-team-grid">
            {TEAM.map((member, i) => (
              <div
                key={member.name}
                className="proto-team-card p-reveal"
                style={{ transitionDelay: `${i * 120}ms` }}
              >
                <div className="proto-team-photo">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={member.photo} alt={member.name} />
                </div>
                <h3>{member.name}</h3>
                <p className="proto-team-role">{member.role}</p>
                <div className="proto-team-links">
                  <a
                    href={member.bsky}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${member.name} on Bluesky`}
                  >
                    <BlueskyIcon />
                  </a>
                  <a
                    href={member.linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${member.name} on LinkedIn`}
                  >
                    <LinkedInIcon />
                  </a>
                </div>
                <p className="proto-team-bio">{member.bio}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="proto-footer">
        <span className="proto-brand">willow</span>
        <span>&copy; 2026</span>
      </footer>
    </div>
  );
}
