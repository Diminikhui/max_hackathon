import { describe, expect, it } from "vitest";
import { CompanyRolesService, InMemoryCompanyRolesStore } from "../../../src/roles/model/index.js";

const clock = () => new Date("2026-09-26T08:00:00Z");

describe("CompanyRolesService", () => {
  it("создаёт и читает модельную роль и участника", async () => {
    const service = new CompanyRolesService(new InMemoryCompanyRolesStore(), clock);
    const role = await service.createRole({
      id: "owner",
      organizationId: "model-company-1",
      name: "Владелец",
      permissions: ["profile:read", "roles:manage"],
      isModel: true,
    });
    const participant = await service.createParticipant({
      id: "participant-1",
      organizationId: "model-company-1",
      subjectId: "model-subject-1",
      roleIds: [role.id],
      isModel: true,
    });

    expect(await service.getRole("model-company-1", "owner")).toEqual({
      ...role,
      createdAt: "2026-09-26T08:00:00.000Z",
    });
    expect(await service.getParticipant("model-company-1", "participant-1")).toEqual(participant);
    expect(participant).toMatchObject({ isModel: true, subjectId: "model-subject-1" });
  });

  it("изолирует одинаковые идентификаторы между организациями", async () => {
    const service = new CompanyRolesService(new InMemoryCompanyRolesStore(), clock);
    for (const organizationId of ["company-a", "company-b"]) {
      await service.createRole({ id: "viewer", organizationId, name: organizationId, isModel: true });
      await service.createParticipant({
        id: "member",
        organizationId,
        subjectId: `subject-${organizationId}`,
        roleIds: ["viewer"],
        isModel: true,
      });
    }

    expect((await service.getRole("company-a", "viewer"))?.name).toBe("company-a");
    expect((await service.getRole("company-b", "viewer"))?.name).toBe("company-b");
    expect((await service.getParticipant("company-a", "member"))?.subjectId).toBe("subject-company-a");
    expect(await service.getParticipant("company-c", "member")).toBeUndefined();
  });

  it("не позволяет назначить роль другой организации", async () => {
    const service = new CompanyRolesService(new InMemoryCompanyRolesStore(), clock);
    await service.createRole({ id: "admin", organizationId: "company-a", name: "Администратор", isModel: true });

    await expect(
      service.createParticipant({
        id: "member",
        organizationId: "company-b",
        subjectId: "model-subject",
        roleIds: ["admin"],
        isModel: true,
      }),
    ).rejects.toThrow("Роль admin не найдена в организации company-b");
  });

  it("проверяет обязательные поля, даты, повторы и существование записи", async () => {
    const service = new CompanyRolesService(new InMemoryCompanyRolesStore(), clock);
    await expect(
      service.createRole({ id: "bad id", organizationId: "company", name: "Роль", isModel: true }),
    ).rejects.toThrow("role id имеет неверный формат");
    await expect(
      service.createRole({
        id: "role",
        organizationId: "company",
        name: "Роль",
        permissions: ["read", "read"],
        isModel: true,
      }),
    ).rejects.toThrow("permissions не должен содержать повторов");
    await service.createRole({ id: "role", organizationId: "company", name: "Роль", isModel: true });
    await expect(
      service.createRole({ id: "role", organizationId: "company", name: "Другая", isModel: true }),
    ).rejects.toThrow("уже существует");
    await expect(
      service.createParticipant({
        id: "member",
        organizationId: "company",
        subjectId: "subject",
        roleIds: [],
        isModel: true,
      }),
    ).rejects.toThrow("хотя бы одна роль");
  });

  it("возвращает копии и не позволяет изменить сохранённые данные снаружи", async () => {
    const service = new CompanyRolesService(new InMemoryCompanyRolesStore(), clock);
    const role = await service.createRole({
      id: "viewer",
      organizationId: "company",
      name: "Читатель",
      permissions: ["profile:read"],
      isModel: true,
    });
    role.permissions.push("roles:manage");

    expect((await service.getRole("company", "viewer"))?.permissions).toEqual(["profile:read"]);
  });
});
