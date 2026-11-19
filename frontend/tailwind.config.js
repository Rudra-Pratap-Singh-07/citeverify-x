/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#000000",
        surface: "#1C1C1C",
        shaft: "#3D3D3D",
        boulder: "#7D7D7D",
        silver: "#B0B0B0",
        ink: "#B0B0B0",
        muted: "#B0B0B0",
        dim: "#7D7D7D",
        supported: "#B0B0B0",
        partial: "#B0B0B0",
        contradicted: "#B0B0B0",
        retracted: "#B0B0B0",
      },
      fontFamily: {
        sans: ["var(--font-fredoka)"],
        display: ["var(--font-bogle)"],
        mono: ["var(--font-geist-mono)"],
      },
      keyframes: {
        beacon: {
          "0%,100%": { opacity: ".4", transform: "scale(.85)" },
          "50%": { opacity: "1", transform: "scale(1.1)" },
        },
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        trace: {
          "0%": { strokeDashoffset: "120" },
          "100%": { strokeDashoffset: "0" },
        },
      },
      animation: {
        beacon: "beacon 2.8s ease-in-out infinite",
        shimmer: "shimmer 1.8s linear infinite",
        trace: "trace 2s linear infinite",
      },
    },
  },
  plugins: [],
};
