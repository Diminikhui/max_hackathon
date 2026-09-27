import type { CompanyParticipant, CompanyRole } from "./entities.js";

export interface CompanyRolesStore {
  saveRole(role: CompanyRole): Promise<void>;
  getRole(organizationId: string, roleId: string): Promise<CompanyRole | undefined>;
  saveParticipant(participant: CompanyParticipant): Promise<void>;
  getParticipant(organizationId: string, participantId: string): Promise<CompanyParticipant | undefined>;
}

/** Простое хранилище для локального и модельного контура. Продакшен-адаптер может реализовать тот же порт. */
export class InMemoryCompanyRolesStore implements CompanyRolesStore {
  readonly #roles = new Map<string, CompanyRole>();
  readonly #participants = new Map<string, CompanyParticipant>();

  async saveRole(role: CompanyRole): Promise<void> {
    this.#roles.set(key(role.organizationId, role.id), structuredClone(role));
  }

  async getRole(organizationId: string, roleId: string): Promise<CompanyRole | undefined> {
    return clone(this.#roles.get(key(organizationId, roleId)));
  }

  async saveParticipant(participant: CompanyParticipant): Promise<void> {
    this.#participants.set(key(participant.organizationId, participant.id), structuredClone(participant));
  }

  async getParticipant(organizationId: string, participantId: string): Promise<CompanyParticipant | undefined> {
    return clone(this.#participants.get(key(organizationId, participantId)));
  }
}

const key = (organizationId: string, id: string): string => `${organizationId.length}:${organizationId}${id}`;

const clone = <T>(value: T | undefined): T | undefined => (value === undefined ? undefined : structuredClone(value));
