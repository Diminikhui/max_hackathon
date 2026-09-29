import { randomBytes } from "node:crypto";

export const SESSION_TTL_MS = 60 * 60 * 1000;

export interface Session {
  readonly token: string;
  readonly maxUserId: number;
  readonly dialogId: string;
  readonly companyId: string;
  readonly expiresAt: string;
}

export interface SessionStore {
  create(subject: Omit<Session, "token" | "expiresAt">): Session;
  get(token: string): Session | undefined;
  revoke(token: string): void;
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly token: () => string = () => randomBytes(32).toString("base64url"),
  ) {}

  create(subject: Omit<Session, "token" | "expiresAt">): Session {
    const session: Session = {
      ...subject,
      token: this.token(),
      expiresAt: new Date(this.now() + SESSION_TTL_MS).toISOString(),
    };
    this.#sessions.set(session.token, session);
    return session;
  }

  get(token: string): Session | undefined {
    const session = this.#sessions.get(token);
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) <= this.now()) {
      this.#sessions.delete(token);
      return undefined;
    }
    return session;
  }

  revoke(token: string): void {
    this.#sessions.delete(token);
  }
}
