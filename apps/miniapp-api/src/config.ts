export interface MiniappApiConfig {
  readonly botToken: string;
  readonly databaseUrl: string;
  readonly port: number;
}

export const readConfig = (env: NodeJS.ProcessEnv): MiniappApiConfig => {
  if (!env.MAX_BOT_TOKEN) throw new Error("MAX_BOT_TOKEN is required");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const port = Number(env.MINIAPP_API_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("MINIAPP_API_PORT must be a valid port");
  return { botToken: env.MAX_BOT_TOKEN, databaseUrl: env.DATABASE_URL, port };
};
