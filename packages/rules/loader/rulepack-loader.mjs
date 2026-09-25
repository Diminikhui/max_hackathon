import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const manifestName = "manifest.json";

const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

const safeSegment = (value, field) => {
  if (typeof value !== "string" || value.length === 0 || value === "." || value === "..") {
    throw new Error(`${field} должен быть непустым безопасным идентификатором`);
  }
  if (basename(value) !== value || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${field} не должен содержать путь`);
  }
  return value;
};

const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const readManifest = async (root) => {
  try {
    const manifest = await readJson(join(root, manifestName));
    if (manifest?.schemaVersion !== 1 || manifest.packs === null || typeof manifest.packs !== "object") {
      throw new Error("неподдерживаемый формат manifest.json");
    }
    return manifest;
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, packs: {} };
    throw new Error(`Не удалось прочитать реестр пакетов: ${error.message}`);
  }
};

/**
 * Atomically installs a validated rulepack into a filesystem registry.
 * A consumer discovers directions and regions from the installed JSON files,
 * so adding either never requires a source-code change.
 */
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

  const root = resolve(registryDirectory);
  const packDirectory = resolve(root, packId);
  if (!inside(root, packDirectory)) throw new Error("packId выходит за пределы реестра");

  const version = pack.packVersion;
  const destination = join(packDirectory, `${version}.json`);
  const serialized = canonicalJson(pack);
  const manifest = await readManifest(root);
  const current = manifest.packs[packId];

  if (current && version < current.activeVersion) {
    throw new Error(`Версия ${version} старее активной версии ${current.activeVersion} пакета ${packId}`);
  }

  try {
    const existing = await readFile(destination, "utf8");
    if (existing === serialized) return { status: "already-installed", packId, version, path: destination };
    throw new Error(`Пакет ${packId} версии ${version} уже установлен с другим содержимым`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const staging = join(root, `.pack-add-${randomUUID()}`);
  try {
    await mkdir(staging, { recursive: true });
    const stagedPack = join(staging, `${version}.json`);
    const nextManifest = {
      schemaVersion: 1,
      packs: {
        ...manifest.packs,
        [packId]: { activeVersion: version, path: `${packId}/${version}.json` },
      },
    };
    const stagedManifest = join(staging, manifestName);
    await writeFile(stagedPack, serialized, { flag: "wx" });
    await writeFile(stagedManifest, canonicalJson(nextManifest), { flag: "wx" });
    await mkdir(packDirectory, { recursive: true });
    await rename(stagedPack, destination);
    await rename(stagedManifest, join(root, manifestName));
    return { status: "installed", packId, version, path: destination };
  } catch (error) {
    throw new Error(`Пакет ${packId} версии ${version} не установлен: ${error.message}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

export const loadActiveRulepacks = async (registryDirectory) => {
  const root = resolve(registryDirectory);
  const manifest = await readManifest(root);
  return Promise.all(
    Object.entries(manifest.packs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([packId, entry]) => {
        const path = resolve(root, entry.path);
        if (!inside(root, path)) throw new Error(`Путь пакета ${packId} выходит за пределы реестра`);
        return readJson(path);
      }),
  );
};
