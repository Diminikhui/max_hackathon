import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const manifestName = "manifest.json";
const lockName = ".pack-add.lock";
const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

const safeSegment = (value, field) => {
  if (typeof value !== "string" || value.length === 0 || value === "." || value === "..") {
    throw new Error(`${field} должен быть непустым безопасным идентификатором`);
  }
  if (basename(value) !== value || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${field} не должен содержать путь`);
  }
  return value;
};

const rejectSymlink = async (path, label, { allowMissing = false } = {}) => {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error(`${label} не должен быть символической ссылкой`);
    return stats;
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return undefined;
    throw error;
  }
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const readManifest = async (root) => {
  const path = join(root, manifestName);
  try {
    await rejectSymlink(path, manifestName);
    const manifest = await readJson(path);
    if (manifest?.schemaVersion !== 1 || manifest.packs === null || typeof manifest.packs !== "object") {
      throw new Error("неподдерживаемый формат manifest.json");
    }
    return manifest;
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, packs: {} };
    throw new Error(`Не удалось прочитать реестр пакетов: ${error.message}`);
  }
};

const prepareRoot = async (registryDirectory) => {
  const requestedRoot = resolve(registryDirectory);
  await mkdir(requestedRoot, { recursive: true });
  await rejectSymlink(requestedRoot, "Каталог реестра");
  const root = await realpath(requestedRoot);
  if (!(await lstat(root)).isDirectory()) throw new Error("Путь реестра не является каталогом");
  return root;
};

const lockOwnerIsAlive = async (lock) => {
  try {
    const pid = Number.parseInt(await readFile(join(lock, "owner"), "utf8"), 10);
    if (!Number.isSafeInteger(pid) || pid < 1) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
};

const acquireLock = async (root) => {
  const lock = join(root, lockName);
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "owner"), `${process.pid}\n`, { flag: "wx" });
      return () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!(await lockOwnerIsAlive(lock))) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Истекло время ожидания блокировки реестра пакетов");
      await sleep(20);
    }
  }
};

const preparePackDirectory = async (root, packId) => {
  const path = join(root, packId);
  const existing = await rejectSymlink(path, `Каталог пакета ${packId}`, { allowMissing: true });
  if (existing && !existing.isDirectory()) throw new Error(`Путь пакета ${packId} не является каталогом`);
  if (!existing) await mkdir(path);
  await rejectSymlink(path, `Каталог пакета ${packId}`);
  const canonicalPath = await realpath(path);
  if (canonicalPath !== path || !inside(root, canonicalPath)) {
    throw new Error(`Каталог пакета ${packId} выходит за пределы реестра`);
  }
  return path;
};

const writeManifestAtomically = async (root, manifest) => {
  await rejectSymlink(join(root, manifestName), manifestName, { allowMissing: true });
  const temporary = join(root, `.manifest-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, canonicalJson(manifest), { flag: "wx" });
    await rename(temporary, join(root, manifestName));
  } finally {
    await rm(temporary, { force: true });
  }
};

/** Atomically installs a validated rulepack into a filesystem registry. */
export const addRulepack = async ({ pack, registryDirectory, validate }) => {
  const validationErrors = await validate(pack);
  if (validationErrors.length > 0) {
    throw new Error(
      `Пакет правил невалиден (${validationErrors.length}):\n${validationErrors.map((e) => `- ${e}`).join("\n")}`,
    );
  }
  const packId = safeSegment(pack.packId, "packId");
  if (!Number.isSafeInteger(pack.packVersion) || pack.packVersion < 1) {
    throw new Error("packVersion должен быть положительным целым числом");
  }

  const root = await prepareRoot(registryDirectory);
  const releaseLock = await acquireLock(root);
  try {
    const packDirectory = await preparePackDirectory(root, packId);
    const version = pack.packVersion;
    const destination = join(packDirectory, `${version}.json`);
    const serialized = canonicalJson(pack);
    const manifest = await readManifest(root);
    const current = manifest.packs[packId];
    if (current && version < current.activeVersion) {
      throw new Error(`Версия ${version} старее активной версии ${current.activeVersion} пакета ${packId}`);
    }

    let packageExists = false;
    try {
      await rejectSymlink(destination, `Файл пакета ${packId} версии ${version}`);
      if ((await readFile(destination, "utf8")) !== serialized) {
        throw new Error(`Пакет ${packId} версии ${version} уже установлен с другим содержимым`);
      }
      packageExists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const nextEntry = { activeVersion: version, path: `${packId}/${version}.json` };
    const manifestIsCurrent = current?.activeVersion === version && current?.path === nextEntry.path;
    if (packageExists) {
      if (!manifestIsCurrent) {
        await writeManifestAtomically(root, {
          schemaVersion: 1,
          packs: { ...manifest.packs, [packId]: nextEntry },
        });
        return { status: "recovered", packId, version, path: destination };
      }
      return { status: "already-installed", packId, version, path: destination };
    }

    const staging = join(root, `.pack-add-${randomUUID()}`);
    try {
      await mkdir(staging);
      const stagedPack = join(staging, `${version}.json`);
      await writeFile(stagedPack, serialized, { flag: "wx" });
      await rename(stagedPack, destination);
      await writeManifestAtomically(root, {
        schemaVersion: 1,
        packs: { ...manifest.packs, [packId]: nextEntry },
      });
      return { status: "installed", packId, version, path: destination };
    } catch (error) {
      throw new Error(`Пакет ${packId} версии ${version} не установлен: ${error.message}`);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } finally {
    await releaseLock();
  }
};

export const loadActiveRulepacks = async (registryDirectory) => {
  const root = await prepareRoot(registryDirectory);
  const manifest = await readManifest(root);
  return Promise.all(
    Object.entries(manifest.packs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([packId, entry]) => {
        safeSegment(packId, "packId");
        const path = resolve(root, entry.path);
        if (!inside(root, path)) throw new Error(`Путь пакета ${packId} выходит за пределы реестра`);
        await rejectSymlink(join(root, packId), `Каталог пакета ${packId}`);
        await rejectSymlink(path, `Файл пакета ${packId}`);
        const canonicalPath = await realpath(path);
        if (!inside(root, canonicalPath)) throw new Error(`Путь пакета ${packId} выходит за пределы реестра`);
        return readJson(canonicalPath);
      }),
  );
};
