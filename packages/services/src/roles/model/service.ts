import type { CompanyParticipant, CompanyRole, CreateCompanyParticipant, CreateCompanyRole } from "./entities.js";
import type { CompanyRolesStore } from "./store.js";

export class CompanyRolesService {
  constructor(
    private readonly store: CompanyRolesStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createRole(input: CreateCompanyRole): Promise<CompanyRole> {
    assertId("organizationId", input.organizationId);
    assertId("role id", input.id);
    const name = requiredText("name", input.name);
    const permissions = uniqueValues("permissions", input.permissions ?? []);
    if (await this.store.getRole(input.organizationId, input.id)) {
      throw new Error(`Роль ${input.id} уже существует в организации ${input.organizationId}`);
    }
    const role: CompanyRole = {
      id: input.id,
      organizationId: input.organizationId,
      name,
      ...(input.description === undefined ? {} : { description: requiredText("description", input.description) }),
      permissions,
      isModel: input.isModel,
      createdAt: timestamp(input.createdAt, this.now),
    };
    await this.store.saveRole(role);
    return structuredClone(role);
  }

  getRole(organizationId: string, roleId: string): Promise<CompanyRole | undefined> {
    assertId("organizationId", organizationId);
    assertId("role id", roleId);
    return this.store.getRole(organizationId, roleId);
  }

  async createParticipant(input: CreateCompanyParticipant): Promise<CompanyParticipant> {
    assertId("organizationId", input.organizationId);
    assertId("participant id", input.id);
    assertId("subjectId", input.subjectId);
    const roleIds = uniqueValues("roleIds", input.roleIds);
    if (roleIds.length === 0) throw new Error("У участника должна быть хотя бы одна роль");
    if (await this.store.getParticipant(input.organizationId, input.id)) {
      throw new Error(`Участник ${input.id} уже существует в организации ${input.organizationId}`);
    }
    for (const roleId of roleIds) {
      if (!(await this.store.getRole(input.organizationId, roleId))) {
        throw new Error(`Роль ${roleId} не найдена в организации ${input.organizationId}`);
      }
    }
    const participant: CompanyParticipant = {
      id: input.id,
      organizationId: input.organizationId,
      subjectId: input.subjectId,
      roleIds,
      isModel: input.isModel,
      createdAt: timestamp(input.createdAt, this.now),
    };
    await this.store.saveParticipant(participant);
    return structuredClone(participant);
  }

  getParticipant(organizationId: string, participantId: string): Promise<CompanyParticipant | undefined> {
    assertId("organizationId", organizationId);
    assertId("participant id", participantId);
    return this.store.getParticipant(organizationId, participantId);
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const assertId = (field: string, value: string): void => {
  if (!ID_PATTERN.test(value)) throw new Error(`${field} имеет неверный формат`);
};

const requiredText = (field: string, value: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200)
    throw new Error(`${field} должен содержать от 1 до 200 символов`);
  return normalized;
};

const uniqueValues = (field: string, values: readonly string[]): string[] => {
  const normalized = values.map((value) => requiredText(field, value));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} не должен содержать повторов`);
  return normalized;
};

const timestamp = (value: string | undefined, now: () => Date): string => {
  const result = value ?? now().toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new Error("createdAt должен быть датой ISO 8601");
  return result;
};
