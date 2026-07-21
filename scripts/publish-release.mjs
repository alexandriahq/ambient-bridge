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
const expectedContextVaultCohort = productSlug === "ambient-app"
  ? parseExpectedContextVaultCohort(process.env.AMBIENT_CONTEXT_VAULT_BUILD_COHORT)
  : null;

const files = await listFiles(distDir);
const prefix = `apps/${productSlug}/${channel}/${platform}/${arch}/${version}/`;
const updateMetadata = await releaseUpdateMetadata({
  channel,
  expectedContextVaultCohort,
  files,
  platform,
  productSlug,
});
const artifactsWithSources = await collectReleaseArtifacts({ arch, channel, files, platform, prefix, version });
const artifacts = artifactsWithSources.map(({ sourcePath: _sourcePath, ...artifact }) => artifact);

if (dryRun) {
  console.log(`[${logPrefix}:release] dry run validated ${productSlug} ${version} (${channel}/${platform}/${arch})`);
  if (updateMetadata?.ambientContextVault) {
    console.log(`[${logPrefix}:release] Context Vault cohort ${updateMetadata.ambientContextVault.cohort} metadata validated`);
  }
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

await registerRelease();

console.log(`[${logPrefix}:release] registered ${productSlug} ${version} (${channel}/${platform}/${arch})`);

async function registerRelease() {
  // Registration runs after minutes of building and uploading, so transient
  // edge/origin failures (e.g. Cloudflare 530 Origin DNS errors) should not
  // fail the whole job. Retry those; 4xx responses are real errors.
  const maxAttempts = 5;
  const registrationUrl = new URL(`/admin/releases/apps/${productSlug}`, serverUrl);
  let registrationUpdateMetadata = updateMetadata;
  const requestInit = () => ({
    body: JSON.stringify({
      appId,
      version,
      channel,
      platform,
      arch,
      commitSha,
      notes,
      ...(registrationUpdateMetadata ? { updateMetadata: registrationUpdateMetadata } : {}),
      artifacts,
    }),
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let failure;
    try {
      const response = await fetch(registrationUrl, requestInit());
      const responseText = await response.text();
      if (response.ok) return;
      failure = `Release registration failed with ${response.status}: ${responseText}`;
      if (response.status === 400
        && registrationUpdateMetadata?.ambientContextVault?.cohort === 1
        && responseText.includes("validation failed")) {
        // Release 1 intentionally remains on schema/epoch 1. During its
        // Experimental PR Release the already-deployed server may predate the
        // optional updateMetadata column. One metadata-free retry is safe for
        // cohort 1 only; cohorts 2/3 must fail closed until the server contract
        // that preserves their downgrade guard has been deployed.
        registrationUpdateMetadata = null;
        console.warn(`[${logPrefix}:release] server predates Context Vault update metadata; retrying cohort 1 registration without it`);
        continue;
      }
      if (response.status < 500 && response.status !== 429) throw new Error(failure);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      failure = `Release registration request failed: ${error.cause?.message ?? error.message}`;
    }
    if (attempt === maxAttempts) throw new Error(`${failure} (after ${maxAttempts} attempts)`);
    const delaySeconds = 2 ** attempt;
    console.warn(`[${logPrefix}:release] attempt ${attempt}/${maxAttempts}: ${truncate(failure, 300)}; retrying in ${delaySeconds}s`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delaySeconds * 1000));
  }
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

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

async function collectReleaseArtifacts({ arch, channel, files, platform, prefix, version }) {
  if (platform === "darwin" && arch === "arm64") {
    const dmg = expectReleaseArtifact(files, ".dmg", "DMG", version);
    const zip = expectReleaseArtifact(files, ".zip", "ZIP", version);
    const zipBlockmap = files.find((file) => basename(file.relativePath) === `${basename(zip.relativePath)}.blockmap`) ?? null;
    const updateYmlFiles = macUpdateYmlFiles(files, channel);
    const artifacts = [
      await artifactMetadata({ sourcePath: dmg.path, fileName: basename(dmg.relativePath), kind: "dmg", prefix, contentType: "application/x-apple-diskimage" }),
      await artifactMetadata({ sourcePath: zip.path, fileName: basename(zip.relativePath), kind: "zip", prefix, contentType: "application/zip" }),
    ];

    if (zipBlockmap) {
      artifacts.push(await artifactMetadata({
        sourcePath: zipBlockmap.path,
        fileName: basename(zipBlockmap.relativePath),
        kind: "blockmap",
        prefix,
        contentType: "application/octet-stream",
      }));
    }

    for (const updateYmlFile of updateYmlFiles) {
      verifyMacUpdateYml(
        YAML.parse(await readFile(updateYmlFile.path, "utf8")),
        updateYmlFile,
        version,
        artifacts.find((artifact) => artifact.kind === "zip"),
      );
    }
    return artifacts;
  }

  if (platform === "win32" && arch === "x64") {
    const exeFiles = releaseFiles(files, ".exe", version);
    if (exeFiles.length < 1) throw new Error(`Expected at least one Windows EXE artifact for version ${version} in ${distDir}.`);

    const artifacts = [];
    for (const file of exeFiles) {
      artifacts.push(await artifactMetadata({
        sourcePath: file.path,
        fileName: basename(file.relativePath),
        kind: "exe",
        prefix,
        contentType: "application/vnd.microsoft.portable-executable",
      }));
    }

    for (const file of releaseFiles(files, ".nupkg", version)) {
      artifacts.push(await artifactMetadata({
        sourcePath: file.path,
        fileName: basename(file.relativePath),
        kind: "nupkg",
        prefix,
        contentType: "application/octet-stream",
      }));
    }

    for (const file of files.filter((candidate) => basename(candidate.relativePath) === "RELEASES")) {
      artifacts.push(await artifactMetadata({
        sourcePath: file.path,
        fileName: basename(file.relativePath),
        kind: "releases",
        prefix,
        contentType: "text/plain; charset=utf-8",
      }));
    }

    for (const file of windowsUpdateYmlFiles(files, channel)) {
      verifyWindowsUpdateYml(YAML.parse(await readFile(file.path, "utf8")), file, version, artifacts.find((artifact) => artifact.kind === "exe"));
      artifacts.push(await artifactMetadata({
        sourcePath: file.path,
        fileName: basename(file.relativePath),
        kind: "yml",
        prefix,
        contentType: "application/x-yaml",
      }));
    }

    const exeBlockmapNames = new Set(exeFiles.map((file) => `${basename(file.relativePath)}.blockmap`));
    for (const file of files.filter((candidate) => exeBlockmapNames.has(basename(candidate.relativePath)))) {
      artifacts.push(await artifactMetadata({
        sourcePath: file.path,
        fileName: basename(file.relativePath),
        kind: "blockmap",
        prefix,
        contentType: "application/octet-stream",
      }));
    }

    return artifacts;
  }

  throw new Error(`Unsupported release target: ${platform}/${arch}.`);
}

function macUpdateYmlFiles(files, channel) {
  const candidates = new Set([`${channel}-mac.yml`, "latest-mac.yml"]);
  return files.filter((file) => candidates.has(basename(file.relativePath)));
}

function windowsUpdateYmlFiles(files, channel) {
  return files.filter((file) => {
    const fileName = basename(file.relativePath);
    return fileName === "latest.yml" || fileName === `${channel}.yml`;
  });
}

async function releaseUpdateMetadata({ channel, expectedContextVaultCohort, files, platform, productSlug }) {
  if (productSlug !== "ambient-app") return null;
  const updateFiles = platform === "darwin"
    ? macUpdateYmlFiles(files, channel)
    : platform === "win32"
      ? windowsUpdateYmlFiles(files, channel)
      : [];
  if (updateFiles.length === 0) {
    throw new Error(`Ambient App release is missing an update feed with Context Vault metadata for ${platform}.`);
  }
  const metadata = [];
  for (const file of updateFiles) {
    const feed = YAML.parse(await readFile(file.path, "utf8"));
    metadata.push(parseContextVaultUpdateMetadata(feed?.ambientContextVault, basename(file.relativePath)));
  }
  const canonical = JSON.stringify(metadata[0]);
  if (metadata.some((candidate) => JSON.stringify(candidate) !== canonical)) {
    throw new Error("Ambient App update feeds disagree about Context Vault capabilities.");
  }
  if (metadata[0].cohort !== expectedContextVaultCohort) {
    throw new Error(
      `Ambient App update feed cohort ${metadata[0].cohort} does not match the packaged cohort ${expectedContextVaultCohort}.`,
    );
  }
  return { ambientContextVault: metadata[0] };
}

function parseExpectedContextVaultCohort(value) {
  if (value === undefined || value === "") return 1;
  const cohort = Number(value);
  if (!Number.isInteger(cohort) || ![1, 2, 3].includes(cohort)) {
    throw new Error(`AMBIENT_CONTEXT_VAULT_BUILD_COHORT must be 1, 2, or 3 (received ${value}).`);
  }
  return cohort;
}

function parseContextVaultUpdateMetadata(value, fileName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fileName} is missing ambientContextVault metadata.`);
  }
  const expectedKeys = [
    "cohort",
    "metadataVersion",
    "readerCapabilityEpoch",
    "schemaVersion",
    "writerCapabilityEpoch",
  ];
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${fileName} ambientContextVault metadata has unsupported fields.`);
  }
  const { metadataVersion, cohort, schemaVersion, readerCapabilityEpoch, writerCapabilityEpoch } = value;
  if (metadataVersion !== 1 || ![1, 2, 3].includes(cohort)) {
    throw new Error(`${fileName} has invalid Context Vault metadata version or cohort.`);
  }
  const graphCapable = cohort >= 2;
  const expectedSchema = graphCapable ? 11 : 10;
  const expectedEpoch = graphCapable ? 2 : 1;
  if (schemaVersion !== expectedSchema
    || readerCapabilityEpoch !== expectedEpoch
    || writerCapabilityEpoch !== expectedEpoch) {
    throw new Error(`${fileName} Context Vault capabilities do not match cohort ${cohort}.`);
  }
  return { metadataVersion, cohort, schemaVersion, readerCapabilityEpoch, writerCapabilityEpoch };
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

function verifyWindowsUpdateYml(updateYml, updateYmlFile, version, exeArtifact) {
  if (!updateYml || !exeArtifact) return;
  if (updateYml.version !== version) {
    throw new Error(`${basename(updateYmlFile.relativePath)} version ${updateYml.version} does not match package version ${version}.`);
  }
  if (typeof updateYml.sha512 === "string" && updateYml.sha512 !== exeArtifact.sha512) {
    throw new Error(`${basename(updateYmlFile.relativePath)} sha512 does not match the generated EXE checksum.`);
  }
}

function expectReleaseArtifact(files, extension, label, version) {
  const candidates = releaseFiles(files, extension, version);
  if (candidates.length === 1) return candidates[0];
  throw new Error(`Expected exactly one ${label} artifact for version ${version} in ${distDir}, found ${candidates.length}.`);
}

function releaseFiles(files, extension, version) {
  const matches = files.filter((file) => file.relativePath.endsWith(extension));
  const versionMatches = matches.filter((file) => basename(file.relativePath).includes(version));
  return versionMatches.length > 0 ? versionMatches : matches;
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
