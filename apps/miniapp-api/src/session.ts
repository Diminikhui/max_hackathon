import { randomBytes } from "node:crypto";

export const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 10_000;

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
    this.#prune();
    if (this.#sessions.size >= MAX_ACTIVE_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest !== undefined) this.#sessions.delete(oldest);
    }
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

  get size(): number {
    return this.#sessions.size;
  }

  #prune(): void {
    const now = this.now();
    for (const [token, session] of this.#sessions) {
      if (Date.parse(session.expiresAt) <= now) this.#sessions.delete(token);
    }
  }
}
