"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { Color, Fog, Group, PerspectiveCamera, Vector3 } from "three";
import ThreeGlobe from "three-globe";
import { useThree, Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import countries from "../../../data/globe.js";

const RING_PROPAGATION_SPEED = 3;
const cameraZ = 300;

type Position = {
  order: number;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  arcAlt: number;
  color: string;
};

export type GlobeConfig = {
  pointSize?: number;
  globeColor?: string;
  showAtmosphere?: boolean;
  atmosphereColor?: string;
  atmosphereAltitude?: number;
  emissive?: string;
  emissiveIntensity?: number;
  shininess?: number;
  polygonColor?: string;
  ambientLight?: string;
  directionalLeftLight?: string;
  directionalTopLight?: string;
  pointLight?: string;
  arcTime?: number;
  arcLength?: number;
  rings?: number;
  maxRings?: number;
  initialPosition?: { lat: number; lng: number };
  autoRotate?: boolean;
  autoRotateSpeed?: number;
};

interface WorldProps {
  globeConfig: GlobeConfig;
  data: Position[];
}

function GlobeObject({ globeConfig, data }: WorldProps) {
  const globeRef = useRef<ThreeGlobe | null>(null);
  const groupRef = useRef<Group>(null);

  const defaults = useMemo(() => ({
    pointSize: 1,
    atmosphereColor: "#ffffff",
    showAtmosphere: true,
    atmosphereAltitude: 0.1,
    polygonColor: "rgba(255,255,255,0.7)",
    globeColor: "#1d072e",
    emissive: "#000000",
    emissiveIntensity: 0.1,
    shininess: 0.9,
    arcTime: 2000,
    arcLength: 0.9,
    rings: 1,
    maxRings: 3,
    ...globeConfig,
  }), [globeConfig]);

  const globeData = useMemo(() => {
    const points: {
      size: number;
      order: number;
      color: (t: number) => string;
      lat: number;
      lng: number;
    }[] = [];

    for (const arc of data) {
      const rgb = hexToRgb(arc.color);
      if (!rgb) continue;
      points.push({
        size: defaults.pointSize,
        order: arc.order,
        color: (t: number) => `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${1 - t})`,
        lat: arc.startLat,
        lng: arc.startLng,
      });
      points.push({
        size: defaults.pointSize,
        order: arc.order,
        color: (t: number) => `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${1 - t})`,
        lat: arc.endLat,
        lng: arc.endLng,
      });
    }

    return points.filter(
      (v, i, a) =>
        a.findIndex((v2) => v2.lat === v.lat && v2.lng === v.lng) === i
    );
  }, [data, defaults.pointSize]);

  useEffect(() => {
    const globe = new ThreeGlobe({ waitForGlobeReady: true, animateIn: true });
    globeRef.current = globe;

    // Material
    const mat = globe.globeMaterial() as unknown as {
      color: Color;
      emissive: Color;
      emissiveIntensity: number;
      shininess: number;
    };
    mat.color = new Color(defaults.globeColor);
    mat.emissive = new Color(defaults.emissive);
    mat.emissiveIntensity = defaults.emissiveIntensity;
    mat.shininess = defaults.shininess;

    // Hex polygons (countries)
    globe
      .hexPolygonsData(countries.features)
      .hexPolygonResolution(3)
      .hexPolygonMargin(0.7)
      .showAtmosphere(defaults.showAtmosphere)
      .atmosphereColor(defaults.atmosphereColor)
      .atmosphereAltitude(defaults.atmosphereAltitude)
      .hexPolygonColor(() => defaults.polygonColor);

    // Arcs
    globe
      .arcsData(data)
      .arcStartLat((d) => (d as Position).startLat)
      .arcStartLng((d) => (d as Position).startLng)
      .arcEndLat((d) => (d as Position).endLat)
      .arcEndLng((d) => (d as Position).endLng)
      .arcColor((e: unknown) => (e as Position).color)
      .arcAltitude((e) => (e as Position).arcAlt)
      .arcStroke(() => [0.32, 0.28, 0.3][Math.round(Math.random() * 2)])
      .arcDashLength(defaults.arcLength)
      .arcDashInitialGap((e) => (e as Position).order)
      .arcDashGap(15)
      .arcDashAnimateTime(() => defaults.arcTime);

    // Points
    globe
      .pointsData(globeData)
      .pointColor((e) => (e as (typeof globeData)[0]).color(0))
      .pointsMerge(true)
      .pointAltitude(0.0)
      .pointRadius(2);

    // Rings
    globe
      .ringsData([])
      .ringColor((e: unknown) => (t: number) => (e as { color: (t: number) => string }).color(t))
      .ringMaxRadius(defaults.maxRings)
      .ringPropagationSpeed(RING_PROPAGATION_SPEED)
      .ringRepeatPeriod(
        (defaults.arcTime * defaults.arcLength) / defaults.rings
      );

    if (groupRef.current) {
      groupRef.current.add(globe);
    }

    // Ring animation interval
    const interval = setInterval(() => {
      if (!globeRef.current) return;
      const nums = genRandomNumbers(0, data.length, Math.floor((data.length * 4) / 5));
      globeRef.current.ringsData(
        globeData.filter((_, i) => nums.includes(i))
      );
    }, 2000);

    return () => {
      clearInterval(interval);
      if (groupRef.current) {
        groupRef.current.remove(globe);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <group ref={groupRef} />;
}

function SceneSetup() {
  const { gl, size, scene } = useThree();

  useEffect(() => {
    gl.setPixelRatio(window.devicePixelRatio);
    gl.setSize(size.width, size.height);
    gl.setClearColor(0x000000, 0);
    scene.fog = new Fog(0x000000, 400, 2000);
  }, [gl, size, scene]);

  return null;
}

export function World({ globeConfig, data }: WorldProps) {
  return (
    <Canvas
      style={{ width: "100%", height: "100%" }}
      camera={{ fov: 50, near: 180, far: 1800, position: [0, 0, cameraZ] }}
    >
      <SceneSetup />
      <ambientLight color={globeConfig.ambientLight} intensity={0.6} />
      <directionalLight
        color={globeConfig.directionalLeftLight}
        position={[-400, 100, 400]}
      />
      <directionalLight
        color={globeConfig.directionalTopLight}
        position={[-200, 500, 200]}
      />
      <pointLight
        color={globeConfig.pointLight}
        position={[-200, 500, 200]}
        intensity={0.8}
      />
      <GlobeObject globeConfig={globeConfig} data={data} />
      <OrbitControls
        enablePan={false}
        enableZoom={false}
        minDistance={cameraZ}
        maxDistance={cameraZ}
        autoRotate={globeConfig.autoRotate}
        autoRotateSpeed={globeConfig.autoRotateSpeed || 1}
        minPolarAngle={Math.PI / 3.5}
        maxPolarAngle={Math.PI - Math.PI / 3}
      />
    </Canvas>
  );
}

function hexToRgb(hex: string) {
  const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
  hex = hex.replace(shorthandRegex, (_, r, g, b) => r + r + g + g + b + b);
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : null;
}

function genRandomNumbers(min: number, max: number, count: number) {
  const arr: number[] = [];
  while (arr.length < count) {
    const r = Math.floor(Math.random() * (max - min)) + min;
    if (arr.indexOf(r) === -1) arr.push(r);
  }
  return arr;
}
