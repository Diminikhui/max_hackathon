// K-29. Заранее подготовленная следующая версия модельного пакета (data/rulepacks/_demo/).
// Демо-триггер публикует только модельный пакет: реальный пакет правил не должен получить выдуманную запись.

import { readFile } from "node:fs/promises";
import type { Id, Requirement } from "@max-hackathon/domain";

export interface DemoPack {
  readonly packId: Id;
  readonly packVersion: number;
  readonly title: string;
  readonly requirements: readonly Requirement[];
}

/** Путь к подготовленной версии относительно корня репозитория. */
export const DEMO_PACK_FILE = "data/rulepacks/_demo/k28-model-v2.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Проверяет, что файл — модельный пакет, который можно опубликовать поверх предыдущей версии. Полную проверку
 * записей по схеме выполняет хранилище при публикации и тест данных; здесь — то, от чего зависит сам триггер.
 */
export const parseDemoPack = (value: unknown): DemoPack => {
  if (!isRecord(value)) throw new Error("Демо-пакет: ожидается объект пакета правил");
  const { packId, packVersion, title, isModel, requirements } = value;
  if (typeof packId !== "string" || packId.length === 0) throw new Error("Демо-пакет: нет packId");
  if (typeof packVersion !== "number" || !Number.isInteger(packVersion) || packVersion < 2) {
    throw new Error("Демо-пакет: packVersion должен быть не меньше 2 — первая публикация уведомлений не даёт");
  }
  if (typeof title !== "string" || title.length === 0) throw new Error("Демо-пакет: нет названия");
  if (!Array.isArray(requirements) || requirements.length === 0) throw new Error("Демо-пакет: нет записей");

  const items = requirements as Requirement[];
  if (isModel !== true || items.some((item) => item.source?.isModel !== true)) {
    throw new Error("Демо-пакет должен быть модельным целиком: пакет и каждая запись с isModel = true");
  }
  const foreign = items.find((item) => item.packId !== packId || item.packVersion !== packVersion);
  if (foreign) throw new Error(`Демо-пакет: запись ${foreign.id} не относится к ${packId} v${packVersion}`);

  return { packId, packVersion, title, requirements: items };
};

export const loadDemoPack = async (path: string): Promise<DemoPack> =>
  parseDemoPack(JSON.parse(await readFile(path, "utf8")));
