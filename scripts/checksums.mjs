import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DISTRIBUTABLE_EXTENSIONS = new Set([
  ".AppImage",
  ".blockmap",
  ".deb",
  ".dmg",
  ".exe",
  ".msi",
  ".rpm",
  ".yml",
  ".zip",
]);

const args = parseArgs(process.argv.slice(2));
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = resolve(args.dist ?? "dist-packaged");
const outputDir = resolve(args.out ?? distDir);
const packageJsonPath = resolve(args["package-json"] ?? "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const lockfilePath = resolve(args.lockfile ?? "pnpm-lock.yaml");

if (args.verify === "true") {
  await verifySha256Sums(resolve(args.file ?? join(outputDir, "SHA256SUMS")));
  process.exit(0);
}

const files = await listDistributableFiles(distDir);
if (files.length === 0) {
  throw new Error(`No distributable artifacts found in ${distDir}. Build release artifacts before generating checksums.`);
}

const artifacts = [];
for (const file of files) {
  const hashes = await hashFile(file.path);
  const fileStat = await stat(file.path);
  artifacts.push({
    fileName: basename(file.path),
    relativePath: normalizePath(relative(distDir, file.path)),
    sizeBytes: fileStat.size,
    sha256: hashes.sha256,
    sha512: hashes.sha512Base64,
    sha512Hex: hashes.sha512Hex,
  });
}

artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

const manifest = {
  app: packageJson.name,
  version: packageJson.version,
  gitCommit: args["commit-sha"] ?? gitCommitSha(),
  sourceTreeStatus: gitTreeStatus(),
  nodeVersion: process.version,
  pnpmVersion: pnpmVersion(),
  lockfileSha256: await optionalFileSha256(lockfilePath),
  generatedAt: new Date().toISOString(),
  distDir: normalizePath(relative(projectRoot, distDir)),
  artifacts,
};

await mkdir(outputDir, { recursive: true });
await writeFile(
  join(outputDir, "SHA256SUMS"),
  artifacts.map((artifact) => `${artifact.sha256}  ${artifact.relativePath}`).join("\n") + "\n",
);
await writeFile(
  join(outputDir, "SHA512SUMS"),
  artifacts.map((artifact) => `${artifact.sha512Hex}  ${artifact.relativePath}`).join("\n") + "\n",
);
await writeFile(join(outputDir, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[bridge:checksums] wrote ${artifacts.length} artifact checksums to ${outputDir}`);

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (!value.startsWith("--")) continue;
    const [key, rawValue = "true"] = value.slice(2).split(/=(.*)/s, 2);
    parsed[key] = rawValue;
  }
  return parsed;
}

async function listDistributableFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = join(root, entry.name);
    if (isDistributableFile(entry.name)) {
      files.push({ path: absolutePath });
    }
  }
  return files;
}

function isDistributableFile(fileName) {
  const ext = extension(fileName);
  if (ext === ".yml") {
    return fileName === "latest.yml" || /^[a-z0-9.-]+-mac\.yml$/i.test(fileName);
  }
  return DISTRIBUTABLE_EXTENSIONS.has(ext);
}

function extension(path) {
  if (path.endsWith(".AppImage")) return ".AppImage";
  if (path.endsWith(".blockmap")) return ".blockmap";
  return path.slice(path.lastIndexOf("."));
}

async function hashFile(path) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      sha256.update(chunk);
      sha512.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });

  const sha512Buffer = sha512.digest();
  return {
    sha256: sha256.digest("hex"),
    sha512Base64: sha512Buffer.toString("base64"),
    sha512Hex: sha512Buffer.toString("hex"),
  };
}

async function optionalFileSha256(path) {
  try {
    return (await hashFile(path)).sha256;
  } catch {
    return null;
  }
}

async function verifySha256Sums(filePath) {
  const baseDir = dirname(filePath);
  const lines = (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"));

  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    const [, expected, relativePath] = match;
    const actual = (await hashFile(resolve(baseDir, relativePath))).sha256;
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${relativePath} checksum mismatch: expected ${expected}, got ${actual}`);
    }
  }

  console.log(`[bridge:checksums] verified ${lines.length} SHA-256 checksums from ${filePath}`);
}

function gitCommitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitTreeStatus() {
  try {
    return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() ? "dirty" : "clean";
  } catch {
    return "unknown";
  }
}

function pnpmVersion() {
  try {
    return execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function normalizePath(path) {
  return path.split("\\").join("/");
}
