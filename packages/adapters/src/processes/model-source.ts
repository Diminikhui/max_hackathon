import type { Id, SourceInfo } from "@max-hackathon/domain";
import type { ProcessStatus, ProcessStatusSource } from "./types.js";

export class ModelProcessStatusSource implements ProcessStatusSource {
  readonly info: SourceInfo;

  constructor(
    readonly authority: string,
    private readonly statuses: readonly ProcessStatus[],
  ) {
    this.info = { name: `${authority} (модельный источник)`, isModel: true };
    if (statuses.some((item) => !item.source.isModel))
      throw new Error("Модельный источник содержит немодельный статус");
  }

  async list(companyId: Id): Promise<ProcessStatus[]> {
    return this.statuses.filter((item) => item.companyId === companyId).map((item) => structuredClone(item));
  }
}

export const createModelSources = (statuses: readonly ProcessStatus[]): ProcessStatusSource[] =>
  ["ФНС России", "Роспотребнадзор", "МЧС России"].map(
    (authority) =>
      new ModelProcessStatusSource(
        authority,
        statuses.filter((item) => item.authority === authority),
      ),
  );
