"use client";

import { useEffect, useRef, useState } from "react";

interface ShaderSendButtonProps {
  disabled?: boolean;
  onClick?: () => void;
}

export default function ShaderSendButton({ disabled, onClick }: ShaderSendButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<any>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    async function init() {
      try {
        const { ShaderMount, liquidMetalFragmentShader } = await import(
          "@paper-design/shaders"
        );

        if (disposed || !containerRef.current) return;

        const mount = new ShaderMount(
          containerRef.current,
          liquidMetalFragmentShader,
          {
            u_colorBack: [0.14, 0.06, 0.02, 1.0],          // warm dark base
            u_colorTint: [0.91, 0.725, 0.533, 0.7],        // --amber tint
            u_repetition: 4,
            u_softness: 0.7,
            u_shiftRed: 0.0,
            u_shiftBlue: 0.15,
            u_distortion: 0.4,
            u_contour: 0.5,
            u_angle: 135,
            u_shape: 1, // circle
            u_isImage: false,
            u_scale: 1.0,
            u_rotation: 0,
            u_offsetX: 0,
            u_offsetY: 0,
            u_originX: 0.5,
            u_originY: 0.5,
            u_worldWidth: 48,
            u_worldHeight: 48,
            u_fit: 2, // cover
          },
          undefined,
          0.5, // speed
          0,
          1 // minPixelRatio
        );

        mountRef.current = mount;
        setReady(true);
      } catch (e) {
        console.warn("[ShaderSendButton] Failed to init shader:", e);
      }
    }

    init();

    return () => {
      disposed = true;
      if (mountRef.current) {
        mountRef.current.dispose();
        mountRef.current = null;
      }
    };
  }, []);

  return (
    <button
      className="shader-send-btn"
      type="submit"
      disabled={disabled}
      onClick={onClick}
      title="Send"
    >
      {/* Shader background */}
      <div
        ref={containerRef}
        className="shader-send-bg"
      />

      {/* Send arrow icon overlay */}
      <svg
        className="shader-send-icon"
        viewBox="0 0 24 24"
        fill="none"
        width="16"
        height="16"
      >
        <path
          d="M12 19V5M5 12l7-7 7 7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
