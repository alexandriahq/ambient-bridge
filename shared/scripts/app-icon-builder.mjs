import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeIco } from "./icon-file.mjs";

const rendererSource = fileURLToPath(new URL("./app-icon-renderer.swift", import.meta.url));
const macEntries = [
  [16, "icp4"], [32, "ic11"], [32, "icp5"], [64, "ic12"],
  [128, "ic07"], [256, "ic13"], [256, "ic08"], [512, "ic14"],
  [512, "ic09"], [1024, "ic10"],
];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0) {
    const output = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})${output ? `\n${output}` : ""}`);
  }
}

function writeIcns(output, entries) {
  const chunks = entries.map(({ type, filePath }) => {
    const bytes = readFileSync(filePath), header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(bytes.length + 8, 4);
    return Buffer.concat([header, bytes]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
  writeFileSync(output, Buffer.concat([header, ...chunks]));
}

/** Product policy is explicit: App resamples a gradient master; Bridge renders each size. */
export function buildAppIcon({ foregroundPath, sourceOut, icnsOut, icoOut, backgroundGradientRgb,
  rendering, legacyMacSlots, logPrefix }) {
  if (process.platform !== "darwin") throw new Error(`[${logPrefix}] must run on macOS.`);
  if (rendering !== "resample" && rendering !== "direct") throw new Error("Unknown app icon rendering policy.");
  const workDir = mkdtempSync(path.join(tmpdir(), "ambient-app-icon-"));
  try {
    const executable = path.join(workDir, "render-icon");
    run("swiftc", [rendererSource, "-o", executable]);
    const background = backgroundGradientRgb?.flat().map(String) ?? [];
    const render = (size, fullBleed, output) => {
      // macOS uses an 824/1024 safe area; Windows uses the full canvas.
      const squircle = fullBleed ? size : 824 * (size / 1024);
      const radius = (fullBleed ? 230 : 185) * (size / 1024);
      run(executable, [foregroundPath, output, String(size), String(squircle),
        String(radius), String((size - squircle) / 2), ...background]);
    };
    render(1024, false, sourceOut);
    const masters = [sourceOut, path.join(workDir, "ico-master.png")];
    if (rendering === "resample") render(1024, true, masters[1]);
    const images = new Map();
    const image = (size, fullBleed) => {
      const key = `${fullBleed ? "windows" : "mac"}-${size}`;
      if (images.has(key)) return images.get(key);
      const output = path.join(workDir, `${key}.png`);
      if (rendering === "resample") {
        run("sips", ["--resampleHeightWidth", String(size), String(size), masters[Number(fullBleed)], "--out", output]);
      } else if (!fullBleed && size === 1024) {
        copyFileSync(sourceOut, output);
      } else {
        render(size, fullBleed, output);
      }
      images.set(key, output);
      return output;
    };
    writeIcns(icnsOut, macEntries.filter(([, type]) => legacyMacSlots || (type !== "icp4" && type !== "icp5"))
      .map(([size, type]) => ({ type, filePath: image(size, false) })));
    writeIco(icoOut, icoSizes.map(size => ({ size, filePath: image(size, true) })));
    for (const output of [sourceOut, icnsOut, icoOut]) console.log(`[${logPrefix}] wrote ${output}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
