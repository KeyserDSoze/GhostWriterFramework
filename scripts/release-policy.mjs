export const publishOrder = [
  "narrarium",
  "narrarium-sdk",
  "narrarium-astro-reader",
  "narrarium-mcp-server",
  "create-narrarium-book",
];

export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) return null;
  const separator = tag.indexOf("@", 1);
  if (separator <= 1) return null;

  const name = tag.slice(1, separator);
  const version = tag.slice(separator + 1);
  if (!publishOrder.includes(name) || !parseVersion(version)) return null;
  return { name, version };
}

export function validateReleaseTarget(target, packageRecords) {
  const packagesByName = new Map(packageRecords.map((record) => [record.name, record]));
  const packageRecord = packagesByName.get(target.name);
  if (!packageRecord) {
    throw new Error(`Unknown release package: ${target.name}.`);
  }

  if (packageRecord.version !== target.version) {
    throw new Error(`Release tag version mismatch for ${target.name}. Expected ${packageRecord.version} but received ${target.version}.`);
  }

  const targetIndex = publishOrder.indexOf(target.name);
  for (const [dependencyName, dependencyRange] of Object.entries(packageRecord.dependencies ?? {})) {
    const dependency = packagesByName.get(dependencyName);
    if (!dependency) continue;

    const dependencyIndex = publishOrder.indexOf(dependencyName);
    if (dependencyIndex >= targetIndex) {
      throw new Error(`Publication order mismatch: ${target.name} depends on ${dependencyName}, which must be published first.`);
    }
    if (!satisfiesVersionRange(dependency.version, dependencyRange)) {
      throw new Error(`Workspace dependency mismatch: ${target.name} requires ${dependencyName}@${dependencyRange}, but the workspace has ${dependency.version}.`);
    }
  }

  return packageRecord;
}

export function isSiteApplicationPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.startsWith("src/narrarium-site/")
    && normalized !== "src/narrarium-site/src/content/patch-notes.json";
}

export function assertSiteReleaseBump(input) {
  const siteChanged = input.changedFiles.some(isSiteApplicationPath);
  if (!siteChanged) return;

  if (!isGreaterVersion(input.currentVersion, input.baseVersion)) {
    throw new Error(`Narrarium site changes require a version bump above ${input.baseVersion}; found ${input.currentVersion}.`);
  }
  if (input.currentLockVersion !== input.currentVersion || input.currentLockVersion === input.baseLockVersion) {
    throw new Error(`package-lock.json must update the src/narrarium-site version from ${input.baseLockVersion} to ${input.currentVersion}.`);
  }
  if (input.basePatchNoteVersions.includes(input.currentVersion)) {
    throw new Error(`Narrarium site version ${input.currentVersion} already existed in the base patch-note history; add a new versioned entry.`);
  }
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value));
  return match ? match.slice(1, 4).map(Number) : null;
}

function isGreaterVersion(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return false;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index];
  }
  return false;
}

function satisfiesVersionRange(version, range) {
  const versionParts = parseVersion(version);
  const normalizedRange = String(range ?? "").trim();
  if (!versionParts || !normalizedRange) return false;

  if (normalizedRange === version) return true;
  if (!normalizedRange.startsWith("^")) return false;

  const minimumParts = parseVersion(normalizedRange.slice(1));
  if (!minimumParts || !isGreaterOrEqual(versionParts, minimumParts)) return false;
  if (minimumParts[0] > 0) return versionParts[0] === minimumParts[0];
  if (minimumParts[1] > 0) return versionParts[0] === 0 && versionParts[1] === minimumParts[1];
  return versionParts[0] === 0 && versionParts[1] === 0 && versionParts[2] === minimumParts[2];
}

function isGreaterOrEqual(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}
