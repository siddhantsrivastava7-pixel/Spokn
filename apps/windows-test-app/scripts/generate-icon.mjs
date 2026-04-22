#!/usr/bin/env node
// Rasterize the Spokn brand mark to a 1024x1024 PNG so `tauri icon` can
// generate the full Windows icon set. The source mark lives at
// src/components/SpoknMark.tsx — this script duplicates its path data with
// baked-in gradient colors (CSS vars can't survive outside the running app).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const OUT_DIR = join(APP_ROOT, "src-tauri", "icons");
const OUT_PNG = join(OUT_DIR, "source-1024.png");

// Gradient stops approximated from the theme's --accent OKLCH:
//   start: oklch(0.82 0.108 300) ≈ #C8ADFF  (light violet)
//   end:   oklch(0.56 0.09  275) ≈ #6D6FC6  (deep indigo)
const SVG = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="200" y1="200" x2="824" y2="824" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#C8ADFF"/>
      <stop offset="100%" stop-color="#6D6FC6"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="220" ry="220" fill="#141318"/>
  <g transform="translate(224 224) scale(18)" stroke="url(#g)" stroke-width="3.0" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M4 16 L10.5 16 C 13.5 16 14.6 14.2 15.5 10.8 L 16.6 7.5"/>
    <path d="M10.5 16 C 13.5 16 14.6 17.8 15.5 21.2 L 16.6 24.5"/>
    <path d="M20 9.5 L28 9.5"/>
    <path d="M20 16 L28 16"/>
    <path d="M20 22.5 L28 22.5"/>
  </g>
</svg>`;

mkdirSync(OUT_DIR, { recursive: true });

await sharp(Buffer.from(SVG))
  .png({ compressionLevel: 9 })
  .toFile(OUT_PNG);

console.log(`[generate-icon] wrote ${OUT_PNG}`);
