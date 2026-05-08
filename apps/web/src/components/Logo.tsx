"use client";

import { motion, useMotionValue, useTransform, animate } from "framer-motion";
import { useEffect, useId } from "react";

interface LogoProps {
  /** Show full wordmark or just the icon */
  variant?: "wordmark" | "icon";
  /** Height in px */
  height?: number;
  /** Enable the shimmer animation */
  shimmer?: boolean;
  /** Enable the glow pulse */
  glow?: boolean;
}

export default function Logo({
  variant = "icon",
  height = 22,
  shimmer = true,
  glow = true,
}: LogoProps) {
  if (variant === "wordmark") {
    return <Wordmark height={height} shimmer={shimmer} />;
  }
  return <IconMark size={height} glow={glow} />;
}

// --- Icon (the concentric circles) ---

function IconMark({ size = 22, glow = true }: { size?: number; glow?: boolean }) {
  const pulseScale = useMotionValue(1);

  useEffect(() => {
    if (!glow) return;
    const controls = animate(pulseScale, [1, 1.08, 1], {
      duration: 3,
      repeat: Infinity,
      ease: "easeInOut",
    });
    return controls.stop;
  }, [glow, pulseScale]);

  return (
    <motion.svg
      viewBox="0 0 40 40"
      fill="none"
      width={size}
      height={size}
      style={{ scale: pulseScale }}
    >
      {glow && (
        <defs>
          <radialGradient id="icon-glow">
            <stop offset="0%" stopColor="var(--aurora)" stopOpacity="0.4" />
            <stop offset="100%" stopColor="var(--aurora)" stopOpacity="0" />
          </radialGradient>
        </defs>
      )}
      {glow && <circle cx="20" cy="20" r="20" fill="url(#icon-glow)" />}
      <motion.circle
        cx="20" cy="20" r="4"
        fill="currentColor"
      />
      <motion.circle
        cx="20" cy="20" r="10"
        stroke="currentColor" strokeWidth="0.8"
        opacity="0.7"
        initial={{ scale: 0.95, opacity: 0.5 }}
        animate={{ scale: 1, opacity: 0.7 }}
        transition={{ duration: 2, repeat: Infinity, repeatType: "reverse", ease: "easeInOut" }}
      />
      <motion.circle
        cx="20" cy="20" r="16"
        stroke="currentColor" strokeWidth="0.6"
        initial={{ scale: 0.97, opacity: 0.3 }}
        animate={{ scale: 1, opacity: 0.45 }}
        transition={{ duration: 2.5, repeat: Infinity, repeatType: "reverse", ease: "easeInOut", delay: 0.3 }}
      />
      <motion.circle
        cx="20" cy="20" r="19"
        stroke="currentColor" strokeWidth="0.5"
        initial={{ opacity: 0.1 }}
        animate={{ opacity: 0.22 }}
        transition={{ duration: 3, repeat: Infinity, repeatType: "reverse", ease: "easeInOut", delay: 0.6 }}
      />
    </motion.svg>
  );
}

// --- Wordmark (the full "ripple Feed" SVG) ---

function Wordmark({ height = 32, shimmer = true }: { height?: number; shimmer?: boolean }) {
  const id = useId();
  const shimmerX = useMotionValue(-1);
  const gradientX1 = useTransform(shimmerX, (v) => `${v * 100}%`);
  const gradientX2 = useTransform(shimmerX, (v) => `${(v + 0.4) * 100}%`);

  useEffect(() => {
    if (!shimmer) return;
    const controls = animate(shimmerX, [-0.2, 1.2], {
      duration: 3,
      repeat: Infinity,
      repeatDelay: 2,
      ease: "easeInOut",
    });
    return controls.stop;
  }, [shimmer, shimmerX]);

  // The SVG viewBox is 150 x 33.4
  const aspect = 150 / 33.4;
  const width = height * aspect;

  const fillColor = shimmer
    ? `url(#shimmer-${id})`
    : "var(--cream, #f3ecdd)";

  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 150 33.4"
      width={width}
      height={height}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6 }}
    >
      <defs>
        <motion.linearGradient
          id={`shimmer-${id}`}
          gradientUnits="objectBoundingBox"
          x1={gradientX1}
          y1="0"
          x2={gradientX2}
          y2="0"
        >
          <stop offset="0%" stopColor="var(--parchment-dim, #a8b5a8)" />
          <stop offset="40%" stopColor="var(--amber, #e8b988)" />
          <stop offset="60%" stopColor="var(--cream, #f3ecdd)" />
          <stop offset="100%" stopColor="var(--parchment-dim, #a8b5a8)" />
        </motion.linearGradient>
      </defs>

      <g fill={fillColor}>
        {/* R */}
        <path d="m15.1 0.8c-1.7-0.1-3.7 0-5.1 0-1.7 0-3.6-0.2-4.4 0-0.6 0.2-1.2 1.6-0.7 2.4s1 1 0.9 2.5c0 0.9-2.1 11.8-2.5 14.2-0.5 2.8-0.8 2.6-2.1 4.1-1.1 1.2-0.7 2.7 0.6 2.6 1.2 0 2.6-0.1 3.2 0 0.7 0 2.4 0.2 2.9-0.3 0.7-0.7 1.4-1.7 0.3-3-0.8-0.9-0.5-1.9-0.4-2.3l0.7-3.3c0.2-1.3 0.8-1.4 1.5-1.2 1.4 0.5 1.2 5.2 2.2 8.2 0.6 1.7 1.6 2.4 5.4 2 0.9-0.1 1.2-0.5 1.2-1.6 0-1.2-0.9-1.2-1.6-3.4-0.7-2-0.3-4.4-2.1-7 2.6-0.9 5.3-3.4 5.4-7.9 0.1-3.2-1.8-5.8-5.4-6zm-4.8 11.8c-1.1 0-1-0.3-0.9-0.9l1.1-6.8c0.1-0.6 0.5-0.8 1.1-0.8 1.7 0 2.6 1 2.6 3.4 0 1.8-0.8 5.2-3.9 5.1z"/>
        {/* i */}
        <path d="m23.1 12.8c-0.2-0.1-1.8 0.3-1.3-1.4 0.4-1.2 2.2-3.6 4.4-3.6 1.2-0.1 2.4 1.1 2.4 2.5 0 1.5-2.5 10.1-2.6 11.1-0.1 1.5 0.7 0.5 1 0 0.6-0.9 1.5-1 1.5 0.3-0.1 1.8-2.2 5.1-5.2 5-1.9-0.1-2.7-1.4-2.5-3.7 0.3-2.3 2.3-10.2 2.3-10.2zm3.2-6.3c-1.1-0.2-1.8-1.7-1.4-3.1 0.4-1.7 1.9-3.3 3.7-3.2 1.3 0 2.1 1 2 2.2-0.2 1.8-2.1 4.2-4.3 4.1z"/>
        {/* p */}
        <path d="m42.5 7.6c-2.6 0.1-4.1 3-5.1 4.3l-0.1-0.1c0.3-1.2 0-3.6-2.3-4.1-2-0.2-3.7 2.8-4.2 3.7-0.3 1.3 0.8 1.4 1.3 1.4l0.1 0.2c-0.6 3.3-3.1 14.1-3.7 16.1-0.3 1.2-2.2 1.6-2 2.9 0.2 0.9 0.9 1.1 1.7 1 1.9-0.2 3.4-0.2 5 0 1.7 0.1 2.3-1.4 1.5-2.2l-0.9-1c-0.2-0.3 0.6-3.1 0.8-3.7 1 0.4 1.8 0.6 2.7 0.6 4.6 0 7.3-4.9 8.5-9.8 0.5-2.2 1.1-8.9-3.3-9.3zm-5.5 15.6c-3.5 0.5-0.1-7.1 1.2-9.3 1.6-2.8 3.3-1.9 2.7 2.1-0.4 2.3-2.2 6.9-3.9 7.2z"/>
        {/* p */}
        <path d="m59.5 7.6c-2.1 0.1-3.4 2.2-4.8 4.3l-0.2-0.2c0.1-1.4-0.1-3.5-2.1-4.1-2-0.2-3.5 2.2-4.5 3.7-0.3 1.4 1 1.4 1.4 1.5l0.1 0.2c-0.5 3.3-3 13.6-3.7 16-0.4 1.6-2.5 1.5-2.3 3 0.2 1.2 1.3 1.1 2.2 1 1.8-0.3 3.8 0 4.9 0 1.4 0 2.1-1.2 1.3-2.2l-0.7-0.9c-0.2-0.3 0.5-2.8 0.7-3.4l0.3-0.4c0.8 0.4 1.4 0.7 2.6 0.7 4.8 0.1 7.4-5.5 8.3-9.8 0.8-3.1 1.2-9.4-3.5-9.4zm-5.1 15.6c-3-0.2-0.8-5.5 1-8.9 2-3.6 3.6-1.6 2.8 2.3-0.4 2.1-2 6.6-3.8 6.6z"/>
        {/* l */}
        <path d="m66.9 1.2c1-0.3 2.3-0.3 4.1-0.8 1.6-0.4 1.9 0 1.6 1.4l-4.2 19.5c-0.3 1.6 0.7 0.6 0.8 0.2 0.9-1.2 1.6-0.4 1.3 0.8s-1.7 4.6-4.3 4.6c-1.5 0-3.1-0.7-2.6-3.7l3.6-18.2c0.3-1.2-0.6-0.9-1.1-1.8-0.3-0.7 0.1-1.8 0.8-2z"/>
        {/* e */}
        <path d="m80.4 7.7c-5.3 0.5-8.3 7-8.8 12-0.4 5.2 1.5 7.2 5 7 3.3-0.1 5.6-2.8 6.2-4.4 0.7-1.8-0.6-2.9-1.5-1.8-0.9 0.9-1.4 1.9-2.9 1.8-1.8 0-2-1.9-1.9-3.1l0.1-0.1c3.5-0.7 7.4-2.2 7.9-6.7 0.2-3.4-2.1-4.8-4.1-4.7zm-3.8 8.8c-0.1-0.4 1-5.7 2.8-5.7 1 0 1.2 1.1 1 2-0.8 2.8-3 3.8-3.8 3.7z"/>
        {/* F */}
        <path d="m96.5 0.4c-1.4 0-2.3 1.6-1.4 2.8 0.8 0.9 0.8 1.1 0.7 2.1l-3.2 15.4c-0.5 2.3-1 2-2.2 3-0.9 0.5-1 2.7 0.2 2.7 1.4 0.1 3.3-0.3 5-0.1 1.6 0 2.6 0.6 3.4-0.7 1-2-1-2.2-1-3.6 0.1-0.9 1.4-6.3 1.6-6.4 1-0.5 2.4-0.1 2.6 1 0.4 1.3 1.7 1.8 2.3 0.4l1.3-5.9c0.1-1.4-1.2-2-2-1-0.9 1.2-1.2 2.2-3.2 2l-0.1-0.3 1.1-6.1c0.3-1.5 1.4-1.7 2.4-1.6 3.2 0 2.9 3 3.6 3.7 0.8 0.5 1.8 0 1.9-1v-4.7c0-1.5-0.3-1.7-2-1.7l-6.1 0.2c-2.4 0-3.3-0.2-4.9-0.2z"/>
        {/* e */}
        <path d="m116 7.6c-5.4 0.2-9 6.3-10 11.6-0.6 5 1.4 7.7 5.9 7.5 3.2-0.1 5.5-2.3 6.3-4.2 0.8-2-0.6-3.3-1.6-2-1 0.9-1.4 1.9-2.8 1.8-1.8 0-2-2-1.8-3.2 3-0.4 7.6-1.7 8.1-6.4 0.3-3.6-2-5.1-4.1-5.1zm-3.8 8.9c-0.2-0.4 1.3-5.6 3.3-5.7 0.7 0 1.1 1.1 0.7 2.3-0.8 2.8-3.2 3.6-4 3.4z"/>
        {/* e */}
        <path d="m130 7.6c-5.6-0.2-9 5.8-9.8 10.7-0.7 4.2 0.4 6.6 2.8 7.8 1.4 0.5 5.4 0.8 8-0.7 1-1.7 2.5-3 1.9-4.4-0.5-1-1.3-1.3-2.3 0-0.7 0.7-1.2 1.4-2.7 1.3-1.8 0-2.3-1.9-1.9-3.2 2.4-0.4 3.9-0.7 7-2.7 1.1-1.3 2-2.5 2.1-4.1 0.1-3.2-2.1-4.7-5.1-4.7zm-3.9 8.9c-0.2-0.4 1-5.6 3.1-5.7 1 0 1.7 1.5 0.3 3.6-0.9 1.6-3 2.2-3.4 2.1z"/>
        {/* d */}
        <path d="M 148.166 0.693 L 145 1 C 143.9 1.1 143.6 2.7 144.5 3.4 C 145.2 3.8 145.2 4.1 145.1 5 L 144.6 8.3 C 144.1 8.5 143.6 7.6 142 7.6 C 137.6 7.6 135.6 13.4 135 15.7 C 133.9 19.2 132.9 26.7 137.4 26.8 C 140 26.9 140.7 25.1 142.1 23.5 C 142.4 23.9 141.5 26.8 144.6 26.8 C 146.5 26.8 148 23.9 148.1 22.5 C 148.2 21.4 147.2 21 146.6 22 L 146.2 22.2 C 145.9 22.1 146.1 21.4 146.2 21 L 148.9 5.3 C 148.9 5.3 149.404 3.35 149.457 3.399 L 149.785 2.388 C 150.285 0.688 149.166 0.493 148.166 0.693 Z M 141.4 11.1 C 142.6 10.8 143.6 11.7 143.4 13.4 C 143.2 16.4 141.1 22.1 139.9 22 C 138.6 22.4 138.5 18.9 139.2 15.9 C 139.9 13.1 141 11.4 141.4 11.1 Z"/>
      </g>
    </motion.svg>
  );
}
