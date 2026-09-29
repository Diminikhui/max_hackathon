// Доступ к данным: пользователь MAX видит только профили, привязанные к нему.

export interface CompanyBinding {
  maxUserId: number;
  companyId: string;
}

/** Субъект запроса — только из проверенного initData или сессии, не из тела запроса. */
export interface AccessSubject {
  maxUserId: number;
}

/**
 * Отказ в доступе. Наружу отдаётся как «не найдено» (404), чтобы по ответу нельзя было
 * узнать, существует ли чужой профиль.
 */
export class AccessDeniedError extends Error {
  constructor() {
    super("Нет доступа к профилю");
    this.name = "AccessDeniedError";
  }
}

export function canAccessCompany(
  subject: AccessSubject,
  companyId: string,
  bindings: Iterable<CompanyBinding>,
): boolean {
  for (const binding of bindings) {
    if (binding.maxUserId === subject.maxUserId && binding.companyId === companyId) return true;
  }
  return false;
}

export function assertCompanyAccess(
  subject: AccessSubject,
  companyId: string,
  bindings: Iterable<CompanyBinding>,
): void {
  if (!canAccessCompany(subject, companyId, bindings)) throw new AccessDeniedError();
}
