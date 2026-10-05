#!/usr/bin/env node
import { buildAppIcon } from "@ambient/shared/app-icon-builder";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("[build-app-icon] must run on macOS.");
  process.exitCode = 1;
} else {
  const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources");
  execFileSync("swift", [fileURLToPath(new URL("./build-tray-icon.swift", import.meta.url)), resources], { stdio: "inherit" });
  buildAppIcon({
    foregroundPath: path.join(resources, "Bridge.icon/Assets/mark.png"),
    sourceOut: path.join(resources, "bridge-icon-source.png"),
    icnsOut: path.join(resources, "bridge-icon.icns"),
    icoOut: path.join(resources, "bridge-icon.ico"),
    rendering: "resample",
    legacyMacSlots: false,
    backgroundGradientRgb: [[10 / 255, 48 / 255, 51 / 255], [4 / 255, 27 / 255, 30 / 255], [1 / 255, 9 / 255, 11 / 255]],
    logPrefix: "build-app-icon",
  });
}
