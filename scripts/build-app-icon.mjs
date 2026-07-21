#!/usr/bin/env node
// Builds the rounded macOS Ambient Bridge app icon.
//
// Inputs:
//   resources/bridge-icon-mark.png  — raw square mark (lock glyph)
//
// Outputs:
//   resources/bridge-icon-source.png  — 1024x1024 squircle (transparent corners)
//   resources/bridge-icon.icns        — multi-size .icns for electron-builder
//   resources/bridge-icon.ico          — multi-size, full-bleed .ico for Windows
//
// Strategy mirrors ambient-app/devtools/scripts/build-rounded-app-icon.mjs: a
// tiny Swift helper rasterises the mark inside a squircle clip path using Core
// Graphics (which honours alpha), then we pack each iconset slot into an .icns.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("[build-app-icon] must run on macOS.");
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const resourcesRoot = path.join(projectRoot, "resources");
const markPath = path.join(resourcesRoot, "bridge-icon-mark.png");
const sourceOut = path.join(resourcesRoot, "bridge-icon-source.png");
const icnsOut = path.join(resourcesRoot, "bridge-icon.icns");
const icoOut = path.join(resourcesRoot, "bridge-icon.ico");

// macOS (.icns) + dev dock: match the main app icon's safe area exactly (see
// ambient-app/devtools/scripts/build-rounded-app-icon.mjs): an 824×824 squircle
// centred in a 1024×1024 canvas, leaving 100 px of transparent padding on every
// side so both apps read the same size in the dock.
const CANVAS = 1024;
const SQUIRCLE_SIZE = 824;
const SQUIRCLE_RADIUS = 185; // ~22.5% of 824, Apple's squircle approximation

// Windows (.ico): no dock safe-area convention — taskbar/tray icons fill their
// frame. Render the .ico full-bleed (squircle fills the whole canvas, corners
// clipped) so it matches the Ambient app's .ico. Keep in sync with that script.
const ICO_CANVAS = 1024;
const ICO_RADIUS = 230; // ~22.5% of 1024

const SQUIRCLE_SWIFT = `
import Cocoa
import CoreGraphics

let args = CommandLine.arguments
guard args.count == 7 else {
    fatalError("usage: squircle <input.png> <output.png> <canvas> <squircle> <radius> <inset>")
}
let inputPath = args[1]
let outputPath = args[2]
let canvas = Int(args[3])!
let squircle = CGFloat(Double(args[4])!)
let radius = CGFloat(Double(args[5])!)
let inset = CGFloat(Double(args[6])!)

guard let src = NSImage(contentsOfFile: inputPath) else { fatalError("cannot load \\(inputPath)") }
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bytesPerRow = canvas * 4
guard let ctx = CGContext(
    data: nil,
    width: canvas,
    height: canvas,
    bitsPerComponent: 8,
    bytesPerRow: bytesPerRow,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("cannot create context") }

let canvasRect = CGRect(x: 0, y: 0, width: canvas, height: canvas)
ctx.clear(canvasRect)

let squircleRect = CGRect(x: inset, y: inset, width: squircle, height: squircle)
let clipPath = CGPath(roundedRect: squircleRect, cornerWidth: radius, cornerHeight: radius, transform: nil)

ctx.saveGState()
ctx.addPath(clipPath)
ctx.clip()

ctx.setFillColor(NSColor.white.cgColor)
ctx.fill(squircleRect)

var imageRect = squircleRect
guard let cgSrc = src.cgImage(forProposedRect: &imageRect, context: nil, hints: nil) else { fatalError("cannot get cgImage") }
ctx.draw(cgSrc, in: squircleRect)
ctx.restoreGState()

guard let cgOut = ctx.makeImage() else { fatalError("cannot finalise image") }
let rep = NSBitmapImageRep(cgImage: cgOut)
rep.size = NSSize(width: canvas, height: canvas)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("cannot encode png") }
try png.write(to: URL(fileURLWithPath: outputPath))
`;

function squircleArgsFor(size) {
  // Scale the safe-area math so every iconset slot keeps the same proportions.
  const scale = size / CANVAS;
  const squircle = SQUIRCLE_SIZE * scale;
  const radius = SQUIRCLE_RADIUS * scale;
  const inset = (size - squircle) / 2;
  return [String(size), String(squircle), String(radius), String(inset)];
}

function fullBleedArgsFor(size) {
  // Full-bleed: the squircle fills the whole canvas (no safe-area inset).
  const scale = size / ICO_CANVAS;
  return [String(size), String(size), String(ICO_RADIUS * scale), "0"];
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${result.status})`);
  }
}

function writeIcns(iconsetPath, outputPath, entries) {
  const chunks = entries.map(([, name, icnsType]) => {
    if (typeof icnsType !== "string" || icnsType.length !== 4) {
      throw new Error(`invalid ICNS type for ${name}`);
    }
    const data = readFileSync(path.join(iconsetPath, name));
    const header = Buffer.alloc(8);
    header.write(icnsType, 0, "ascii");
    header.writeUInt32BE(data.length + header.length, 4);
    return Buffer.concat([header, data]);
  });
  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(totalLength, 4);
  writeFileSync(outputPath, Buffer.concat([header, ...chunks], totalLength));
}

function writeIco(outputPath, entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  const images = [];
  let imageOffset = header.length + directory.length;

  entries.forEach(({ size, filePath }, index) => {
    const data = readFileSync(filePath);
    const offset = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, offset);
    directory.writeUInt8(size >= 256 ? 0 : size, offset + 1);
    directory.writeUInt8(0, offset + 2);
    directory.writeUInt8(0, offset + 3);
    directory.writeUInt16LE(1, offset + 4);
    directory.writeUInt16LE(32, offset + 6);
    directory.writeUInt32LE(data.length, offset + 8);
    directory.writeUInt32LE(imageOffset, offset + 12);
    images.push(data);
    imageOffset += data.length;
  });

  writeFileSync(outputPath, Buffer.concat([header, directory, ...images]));
}

const workDir = mkdtempSync(path.join(tmpdir(), "ambient-bridge-icon-"));
const swiftSrc = path.join(workDir, "squircle.swift");
const iconset = path.join(workDir, "icon.iconset");

try {
  writeFileSync(swiftSrc, SQUIRCLE_SWIFT);
  run("mkdir", ["-p", iconset]);

  // Render the 1024 master with transparent corners and Apple safe-area inset.
  run("swift", [swiftSrc, markPath, sourceOut, ...squircleArgsFor(CANVAS)]);

  // Render each iconset size directly from the mark so the corner radius scales
  // exactly with the bitmap (avoids alpha blurring from sips downscaling).
  const sizes = [
    [16, "icon_16x16.png", "icp4"],
    [32, "icon_16x16@2x.png", "ic11"],
    [32, "icon_32x32.png", "icp5"],
    [64, "icon_32x32@2x.png", "ic12"],
    [128, "icon_128x128.png", "ic07"],
    [256, "icon_128x128@2x.png", "ic13"],
    [256, "icon_256x256.png", "ic08"],
    [512, "icon_256x256@2x.png", "ic14"],
    [512, "icon_512x512.png", "ic09"],
    [1024, "icon_512x512@2x.png", "ic10"],
  ];

  for (const [size, name] of sizes) {
    run("swift", [
      swiftSrc,
      markPath,
      path.join(iconset, name),
      ...squircleArgsFor(size),
    ]);
  }

  writeIcns(iconset, icnsOut, sizes);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoEntries = [];
  for (const size of icoSizes) {
    const filePath = path.join(iconset, `ico_${size}.png`);
    run("swift", [
      swiftSrc,
      markPath,
      filePath,
      ...fullBleedArgsFor(size),
    ]);
    icoEntries.push({ size, filePath });
  }
  writeIco(icoOut, icoEntries);

  console.log(`[build-app-icon] wrote ${sourceOut}`);
  console.log(`[build-app-icon] wrote ${icnsOut}`);
  console.log(`[build-app-icon] wrote ${icoOut}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
