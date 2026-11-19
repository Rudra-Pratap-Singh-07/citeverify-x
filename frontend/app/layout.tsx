import type { Metadata } from "next";
import localFont from "next/font/local";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import "@react-pdf-viewer/core/lib/styles/index.css";
import "@react-pdf-viewer/highlight/lib/styles/index.css";
import "@react-pdf-viewer/zoom/lib/styles/index.css";
import "./brand.css";
const bogle = localFont({
  src: "./fonts/BBHBogle-Regular.ttf",
  variable: "--font-bogle",
  weight: "400",
  display: "swap",
});
const fredoka = localFont({
  src: "./fonts/Fredoka-Variable.ttf",
  variable: "--font-fredoka",
  weight: "300 700",
  display: "swap",
});
export const metadata: Metadata = {
  title: "CiteVerify-X | Evidence workbench",
  description: "Review manuscript claims alongside their cited evidence.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bogle.variable} ${fredoka.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
