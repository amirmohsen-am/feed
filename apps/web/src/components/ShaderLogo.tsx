"use client";

interface ShaderLogoProps {
  height?: number;
  color?: string;
}

export default function ShaderLogo({ height = 200, color = "#e8b988" }: ShaderLogoProps) {
  const aspect = 150 / 33.4;
  const width = Math.round(height * aspect);
  const fontSize = Math.round(height * 0.86);
  const y = Math.round(height * 0.84);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ width, height }}
    >
      <text
        x="0"
        y={y}
        fontFamily="'Merriweather', serif"
        fontStyle="normal"
        fontWeight="900"
        fontSize={fontSize}
        fill={color}
        textLength={width}
        lengthAdjust="spacingAndGlyphs"
      >
        Willow
      </text>
    </svg>
  );
}
