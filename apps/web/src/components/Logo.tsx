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
      style={{ width, height }}
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
      <text
        x="0"
        y="26"
        fontFamily="'Merriweather', serif"
        fontStyle="italic"
        fontWeight="900"
        fontSize="27"
        fill={fillColor}
        textLength="150"
        lengthAdjust="spacingAndGlyphs"
      >
        Willow
      </text>
    </motion.svg>
  );
}
