export interface CompanyRole {
  id: string;
  organizationId: string;
  name: string;
  description?: string;
  permissions: string[];
  /** Признак синтетической или демонстрационной записи. */
  isModel: boolean;
  createdAt: string;
}

export interface CompanyParticipant {
  id: string;
  organizationId: string;
  /** Непрозрачный идентификатор пользователя; ФИО, телефон и иные ПДн здесь не хранятся. */
  subjectId: string;
  roleIds: string[];
  /** Признак синтетической или демонстрационной записи. */
  isModel: boolean;
  createdAt: string;
}

export interface CreateCompanyRole {
  id: string;
  organizationId: string;
  name: string;
  description?: string;
  permissions?: string[];
  isModel: boolean;
  createdAt?: string;
}

export interface CreateCompanyParticipant {
  id: string;
  organizationId: string;
  subjectId: string;
  roleIds: string[];
  isModel: boolean;
  createdAt?: string;
}
