import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const DEFAULT_PRODUCT_SLUG = "ambient-bridge";
const DEFAULT_APP_ID = "app.ambient.bridge";
const DEFAULT_SERVER_URL = "https://api.alexandria.so";

const args = parseArgs(process.argv.slice(2));
const packageJsonPath = args["package-json"]
  ? resolve(args["package-json"])
  : fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

const productSlug = args["product-slug"] ?? DEFAULT_PRODUCT_SLUG;
const appId = args["app-id"] ?? DEFAULT_APP_ID;
const dryRun = args["dry-run"] === "true";
const logPrefix = args["log-prefix"] ?? (productSlug === DEFAULT_PRODUCT_SLUG ? "bridge" : productSlug);
const version = args.version ?? packageJson.version;
const channel = args.channel ?? process.env.AMBIENT_BRIDGE_RELEASE_CHANNEL ?? "alpha";
const platform = args.platform ?? "darwin";
const arch = args.arch ?? "arm64";
const distDir = resolve(args.dist ?? "dist-packaged");
const serverUrl = normalizeBaseUrl(args["server-url"] ?? process.env.AMBIENT_RELEASE_SERVER_URL ?? process.env.AMBIENT_SERVER_URL ?? DEFAULT_SERVER_URL);
const commitSha = args["commit-sha"] ?? process.env.GIT_COMMIT_SHA ?? gitCommitSha();
const notes = args.notes ?? process.env.RELEASE_NOTES ?? null;

const files = await listFiles(distDir);
const dmg = expectReleaseArtifact(files, ".dmg", "DMG");
const zip = expectReleaseArtifact(files, ".zip", "ZIP");
const zipBlockmap = files.find((file) => basename(file.relativePath) === `${basename(zip.relativePath)}.blockmap`) ?? null;
const updateYmlFile = updateYmlFileName(files, channel);
const updateYml = updateYmlFile ? YAML.parse(await readFile(updateYmlFile.path, "utf8")) : null;

const prefix = `apps/${productSlug}/${channel}/${platform}/${arch}/${version}/`;
const artifactsWithSources = [
  await artifactMetadata({ sourcePath: dmg.path, fileName: basename(dmg.relativePath), kind: "dmg", prefix, contentType: "application/x-apple-diskimage" }),
  await artifactMetadata({ sourcePath: zip.path, fileName: basename(zip.relativePath), kind: "zip", prefix, contentType: "application/zip" }),
];
if (zipBlockmap) {
  artifactsWithSources.push(await artifactMetadata({
    sourcePath: zipBlockmap.path,
    fileName: basename(zipBlockmap.relativePath),
    kind: "blockmap",
    prefix,
    contentType: "application/octet-stream",
  }));
}
const artifacts = artifactsWithSources.map(({ sourcePath: _sourcePath, ...artifact }) => artifact);

verifyMacUpdateYml(updateYml, updateYmlFile, version, artifacts.find((artifact) => artifact.kind === "zip"));

if (dryRun) {
  console.log(`[${logPrefix}:release] dry run validated ${productSlug} ${version} (${channel}/${platform}/${arch})`);
  for (const artifact of artifacts) console.log(`[${logPrefix}:release] would publish ${artifact.objectKey}`);
  process.exit(0);
}

const bucketConfig = releaseBucketConfig(process.env);
const adminToken = requiredEnv("RELEASE_ADMIN_TOKEN");

const s3 = new S3Client({
  endpoint: bucketConfig.endpoint,
  region: bucketConfig.region,
  credentials: {
    accessKeyId: bucketConfig.accessKeyId,
    secretAccessKey: bucketConfig.secretAccessKey,
  },
});

for (const artifact of artifactsWithSources) {
  await s3.send(new PutObjectCommand({
    Body: await readFile(artifact.sourcePath),
    Bucket: bucketConfig.bucketName,
    ContentType: artifact.contentType,
    Key: artifact.objectKey,
  }));
  console.log(`[${logPrefix}:release] uploaded ${artifact.objectKey}`);
}

const response = await fetch(new URL(`/admin/releases/apps/${productSlug}`, serverUrl), {
  body: JSON.stringify({
    appId,
    version,
    channel,
    platform,
    arch,
    commitSha,
    notes,
    artifacts,
  }),
  headers: {
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/json",
  },
  method: "POST",
});

const responseText = await response.text();
if (!response.ok) {
  throw new Error(`Release registration failed with ${response.status}: ${responseText}`);
}

console.log(`[${logPrefix}:release] registered ${productSlug} ${version} (${channel}/${platform}/${arch})`);

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (!value.startsWith("--")) continue;
    const [key, rawValue = "true"] = value.slice(2).split(/=(.*)/s, 2);
    parsed[key] = rawValue;
  }
  return parsed;
}

async function artifactMetadata({ sourcePath, fileName, kind, prefix, contentType }) {
  const bytes = await readFile(sourcePath);
  const fileStat = await stat(sourcePath);
  return {
    sourcePath,
    kind,
    fileName: basename(fileName),
    objectKey: `${prefix}${basename(fileName)}`,
    contentType,
    sizeBytes: fileStat.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("base64"),
  };
}

function updateYmlFileName(files, channel) {
  const candidates = [`${channel}-mac.yml`, "latest-mac.yml"];
  return candidates.map((fileName) => files.find((file) => basename(file.relativePath) === fileName)).find(Boolean) ?? null;
}

function verifyMacUpdateYml(updateYml, updateYmlFile, version, zipArtifact) {
  if (!updateYml || !zipArtifact) return;
  if (updateYml.version !== version) {
    throw new Error(`${basename(updateYmlFile.relativePath)} version ${updateYml.version} does not match package version ${version}.`);
  }
  if (typeof updateYml.sha512 === "string" && updateYml.sha512 !== zipArtifact.sha512) {
    throw new Error(`${basename(updateYmlFile.relativePath)} sha512 does not match the generated ZIP checksum.`);
  }
}

function expectReleaseArtifact(files, extension, label) {
  const matches = files.filter((file) => file.relativePath.endsWith(extension));
  const versionMatches = matches.filter((file) => basename(file.relativePath).includes(version));
  const candidates = versionMatches.length > 0 ? versionMatches : matches;
  if (candidates.length === 1) return candidates[0];
  throw new Error(`Expected exactly one ${label} artifact for version ${version} in ${distDir}, found ${candidates.length}.`);
}

async function listFiles(root) {
  const files = [];
  await visit(root, "", files);
  return files;
}

async function visit(root, relativeRoot, files) {
  const entries = await readdir(join(root, relativeRoot), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = join(relativeRoot, entry.name);
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      await visit(root, relativePath, files);
    } else if (entry.isFile()) {
      files.push({ path: absolutePath, relativePath });
    }
  }
}

function releaseBucketConfig(env) {
  return {
    bucketName: requiredEnv("RELEASE_BUCKET_NAME"),
    endpoint: requiredEnv("RELEASE_BUCKET_ENDPOINT"),
    region: requiredEnv("RELEASE_BUCKET_REGION"),
    accessKeyId: requiredEnv("RELEASE_BUCKET_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("RELEASE_BUCKET_SECRET_ACCESS_KEY"),
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeBaseUrl(rawValue) {
  const url = new URL(rawValue);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function gitCommitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Could not read git commit SHA. Pass --commit-sha=<sha> or set GIT_COMMIT_SHA.");
  }
}
