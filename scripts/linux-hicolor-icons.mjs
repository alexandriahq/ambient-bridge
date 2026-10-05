#!/usr/bin/env node
// Ubuntu's hicolor index lists app icons through 512px and does not list
// 1024x1024/apps. electron-builder installs a single source PNG at its native
// size, so a 1024px icon is invisible to the dock and GNOME shows a gear.
import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharp = createRequire(path.join(repoRoot, "package.json"))("sharp");

const [sourceArg, outArg] = process.argv.slice(2);
if (!sourceArg || !outArg) {
  console.error("Usage: linux-hicolor-icons.mjs <source.png> <out-dir>");
  process.exit(1);
}

const source = path.resolve(sourceArg);
const outDir = path.resolve(outArg);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
for (const size of sizes) {
  const file = path.join(outDir, `${size}x${size}.png`);
  await sharp(source).resize(size, size).png().toFile(file);
}
console.log(`[linux icons] wrote ${sizes.length} sizes to ${outDir}`);
