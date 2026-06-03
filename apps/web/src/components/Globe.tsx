"use client";

import { useEffect, useRef } from "react";
import createGlobe from "cobe";

export default function Globe({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    let phi = 0;
    const width = canvasRef.current.offsetWidth;

    const globe = createGlobe(canvasRef.current, {
      devicePixelRatio: 2,
      width: width * 2,
      height: width * 2,
      phi: 0,
      theta: 0.3,
      dark: 1,
      diffuse: 3,
      mapSamples: 16000,
      mapBrightness: 1.2,
      baseColor: [0.15, 0.15, 0.15],
      markerColor: [251 / 255, 200 / 255, 120 / 255],
      glowColor: [0.08, 0.08, 0.08],
      markers: [
        { location: [37.7749, -122.4194], size: 0.05 },
        { location: [40.7128, -74.006], size: 0.05 },
        { location: [51.5074, -0.1278], size: 0.05 },
        { location: [35.6762, 139.6503], size: 0.05 },
        { location: [-33.8688, 151.2093], size: 0.05 },
        { location: [48.8566, 2.3522], size: 0.05 },
        { location: [1.3521, 103.8198], size: 0.05 },
        { location: [-23.5505, -46.6333], size: 0.05 },
        { location: [19.076, 72.8777], size: 0.05 },
        { location: [55.7558, 37.6173], size: 0.05 },
      ],
      arcs: [
        { from: [37.7749, -122.4194], to: [35.6762, 139.6503] },
        { from: [40.7128, -74.006], to: [51.5074, -0.1278] },
        { from: [51.5074, -0.1278], to: [48.8566, 2.3522] },
        { from: [48.8566, 2.3522], to: [55.7558, 37.6173] },
        { from: [55.7558, 37.6173], to: [19.076, 72.8777] },
        { from: [19.076, 72.8777], to: [1.3521, 103.8198] },
        { from: [1.3521, 103.8198], to: [35.6762, 139.6503] },
        { from: [35.6762, 139.6503], to: [-33.8688, 151.2093] },
        { from: [-33.8688, 151.2093], to: [1.3521, 103.8198] },
        { from: [40.7128, -74.006], to: [-23.5505, -46.6333] },
        { from: [-23.5505, -46.6333], to: [51.5074, -0.1278] },
        { from: [37.7749, -122.4194], to: [40.7128, -74.006] },
        { from: [19.076, 72.8777], to: [35.6762, 139.6503] },
      ],
      arcColor: [232 / 255, 185 / 255, 136 / 255],
    });

    const frame = () => {
      phi += 0.003;
      globe.update({ phi });
      requestAnimationFrame(frame);
    };
    const raf = requestAnimationFrame(frame);

    canvasRef.current.style.opacity = "1";

    return () => {
      cancelAnimationFrame(raf);
      globe.destroy();
    };
  }, []);

  return (
    <div className={className} style={{ width: "100%", maxWidth: 600, aspectRatio: "1", margin: "auto", position: "relative" }}>
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          opacity: 0,
          transition: "opacity 1s ease",
        }}
      />
    </div>
  );
}
