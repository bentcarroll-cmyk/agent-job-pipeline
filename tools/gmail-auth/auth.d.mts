export const GMAIL_SCOPE: "https://www.googleapis.com/auth/gmail.readonly";
export type AuthStatus = { ok: true; instanceId: string; workerName: string } | { ok: false; error: string };
export type AuthDependencies = {
  workspace?: string;
  cloudflareApiToken?: string;
  authorize?: (client: { client_id: string; client_secret: string }) => Promise<{ refresh_token: string; scope: string; access_token?: string }>;
  writeSecret?: (target: { accountId: string; workerName: string }, name: string, value: string) => Promise<void>;
};
export function authorizeAndStore(instance: unknown, client: unknown, dependencies?: AuthDependencies): Promise<AuthStatus>;
export function main(args?: string[], dependencies?: AuthDependencies): Promise<AuthStatus>;
