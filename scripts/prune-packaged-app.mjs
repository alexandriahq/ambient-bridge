import { createPackageWithOptions, extractAll, uncache } from "@electron/asar";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export async function prunePackagedApp({
  archive,
  dependencyResolutionRoot,
  dependencySourceRoot,
  runtimeDependencyRoots,
}) {
  const workDir = await mkdtemp(path.join(path.dirname(archive), ".ambient-bridge-prune-"));
  const extractedDir = path.join(workDir, "extracted");
  const slimDir = path.join(workDir, "slim");
  const slimArchive = path.join(workDir, "app.asar");
  const archiveUnpacked = `${archive}.unpacked`;
  const slimArchiveUnpacked = `${slimArchive}.unpacked`;

  try {
    await mkdir(extractedDir);
    await mkdir(slimDir);
    extractAll(archive, extractedDir);

    for (const entry of await readdir(extractedDir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      await cpWithoutSourceMaps(
        path.join(extractedDir, entry.name),
        path.join(slimDir, entry.name),
      );
    }

    const sourceRoot = dependencySourceRoot ?? extractedDir;
    const resolutionRoot = dependencyResolutionRoot ?? sourceRoot;
    const packages = await resolveRuntimePackages({
      resolutionRoot,
      sourceRoot,
      runtimeDependencyRoots,
    });
    for (const record of packages) {
      const destination = path.join(slimDir, "node_modules", record.name);
      await cpWithoutSourceMaps(record.directory, destination, { excludeNestedNodeModules: true });
    }

    await createPackageWithOptions(slimDir, slimArchive, {
      unpack: "**/*.node",
    });

    uncache(archive);
    await rm(archive, { force: true });
    await rm(archiveUnpacked, { force: true, recursive: true });
    await rename(slimArchive, archive);
    if (await exists(slimArchiveUnpacked)) {
      await rename(slimArchiveUnpacked, archiveUnpacked);
    }

    return {
      archiveBytes: (await stat(archive)).size,
      packages: packages.map((record) => record.name).sort(),
    };
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

async function resolveRuntimePackages({ resolutionRoot, runtimeDependencyRoots, sourceRoot }) {
  const resolvedDirectories = new Set();
  const resolvedNames = new Map();
  const queue = runtimeDependencyRoots.map((name) => ({ name, parentDirectory: sourceRoot }));

  while (queue.length > 0) {
    const { name, parentDirectory } = queue.shift();
    const directory = await resolvePackageDirectory({ name, parentDirectory, resolutionRoot });
    if (!directory) {
      throw new Error(`Packaged Bridge runtime dependency ${name} is missing from the installed dependency tree.`);
    }
    const canonicalDirectory = await realpath(directory);
    if (resolvedDirectories.has(canonicalDirectory)) continue;

    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    const packageName = typeof manifest.name === "string" ? manifest.name : name;
    const packageVersion = typeof manifest.version === "string" ? manifest.version : "unknown";
    const existing = resolvedNames.get(packageName);
    if (existing && existing.version !== packageVersion) {
      throw new Error(
        `Packaged Bridge runtime graph contains conflicting ${packageName} versions ` +
          `(${existing.version} and ${packageVersion}); the flat runtime archive cannot represent both.`,
      );
    }
    resolvedDirectories.add(canonicalDirectory);
    if (existing) continue;
    resolvedNames.set(packageName, { directory, name: packageName, version: packageVersion });

    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name: dependency, parentDirectory: directory });
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      if (await resolvePackageDirectory({ name: dependency, parentDirectory: directory, resolutionRoot })) {
        queue.push({ name: dependency, parentDirectory: directory });
      }
    }
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[dependency]?.optional === true) continue;
      queue.push({ name: dependency, parentDirectory: directory });
    }
  }

  return [...resolvedNames.values()];
}

async function resolvePackageDirectory({ name, parentDirectory, resolutionRoot }) {
  let cursor = parentDirectory;
  while (isWithin(resolutionRoot, cursor)) {
    const candidate = path.join(cursor, "node_modules", name);
    if (await exists(path.join(candidate, "package.json"))) return candidate;
    if (cursor === resolutionRoot) break;
    cursor = path.dirname(cursor);
  }
  return null;
}

async function cpWithoutSourceMaps(source, destination, options = {}) {
  const excludeNestedNodeModules = options.excludeNestedNodeModules === true;
  await cp(source, destination, {
    dereference: true,
    recursive: true,
    filter: (candidate) => {
      if (candidate.endsWith(".map")) return false;
      if (!excludeNestedNodeModules) return true;
      const relative = path.relative(source, candidate);
      return relative === "" || !relative.split(path.sep).includes("node_modules");
    },
  });
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}
