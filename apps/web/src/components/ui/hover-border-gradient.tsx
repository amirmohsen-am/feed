"use client";

import React, { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

type HoverBorderGradientProps = {
  children: React.ReactNode;
  containerClassName?: string;
  className?: string;
  as?: React.ElementType;
  duration?: number;
  clockwise?: boolean;
} & React.HTMLAttributes<HTMLElement>;

export function HoverBorderGradient({
  children,
  containerClassName,
  className,
  as: Tag = "button",
  duration = 1,
  clockwise = true,
  ...props
}: HoverBorderGradientProps) {
  const [hovered, setHovered] = useState(false);
  const [direction, setDirection] = useState<"TOP" | "LEFT" | "BOTTOM" | "RIGHT">("TOP");

  const rotateDirection = (currentDirection: string) => {
    const directions = clockwise
      ? ["TOP", "RIGHT", "BOTTOM", "LEFT"]
      : ["TOP", "LEFT", "BOTTOM", "RIGHT"];
    const currentIndex = directions.indexOf(currentDirection);
    return directions[(currentIndex + 1) % directions.length] as typeof direction;
  };

  const movingMap: Record<string, string> = {
    TOP: "radial-gradient(20.7% 50% at 50% 0%, rgba(125,203,165,0.5) 0%, rgba(125,203,165,0) 100%)",
    LEFT: "radial-gradient(16.6% 43.1% at 0% 50%, rgba(125,203,165,0.5) 0%, rgba(125,203,165,0) 100%)",
    BOTTOM: "radial-gradient(20.7% 50% at 50% 100%, rgba(125,203,165,0.5) 0%, rgba(125,203,165,0) 100%)",
    RIGHT: "radial-gradient(16.2% 41.2% at 100% 50%, rgba(125,203,165,0.5) 0%, rgba(125,203,165,0) 100%)",
  };

  const highlight =
    "radial-gradient(75% 181.16% at 50% 50%, rgba(125,203,165,0.15) 0%, rgba(62,138,108,0.08) 100%)";

  useEffect(() => {
    if (!hovered) {
      const interval = setInterval(() => {
        setDirection((prev) => rotateDirection(prev));
      }, duration * 1000);
      return () => clearInterval(interval);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered]);

  return (
    <Tag
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        "relative flex rounded-full content-center bg-transparent items-center flex-col flex-nowrap gap-10 h-min justify-center overflow-visible p-px decoration-clone w-fit",
        containerClassName
      )}
      {...props}
    >
      <div
        className={cn(
          "w-auto z-10 rounded-[inherit] px-4 py-1.5",
          className
        )}
      >
        {children}
      </div>
      <motion.div
        className="flex-none inset-0 overflow-hidden absolute z-0 rounded-[inherit]"
        style={{ filter: "blur(2px)", position: "absolute", width: "100%", height: "100%" }}
        initial={{ background: movingMap[direction] }}
        animate={{
          background: hovered
            ? [movingMap[direction], highlight]
            : movingMap[direction],
        }}
        transition={{ ease: "linear", duration: duration }}
      />
      <div className="absolute z-1 flex-none inset-[2px] rounded-[100px]" style={{ background: "rgba(125,203,165,0.1)" }} />
    </Tag>
  );
}
