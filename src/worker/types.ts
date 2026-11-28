export interface SessionEnv {
  MEMBERS?: DurableObjectNamespace;
  MEMBER_AUTH_LIMIT?: RateLimit;
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD: string;
  ADMIN_CERT_FINGERPRINTS?: string;
  SESSION_SECRET: string;
}

export interface Env extends SessionEnv {
  EMAIL: SendEmail;
  PRIMARY_DOMAIN: string;
  FORWARD_TO?: string;
  ROUTING_ACCOUNT_ID?: string;
  ROUTING_API_TOKEN?: string;
}

export type EmailWorkerMessage = ForwardableEmailMessage & { readonly canBeForwarded?: boolean };

export type AliasRow = {
  id: string;
  local_part: string;
  domain: string;
  address: string;
  label: string;
  status: 'active' | 'disabled';
  routing_mode: 'managed' | 'external';
  note: string;
  created_at: string;
  updated_at: string;
  last_received_at: string | null;
  message_count: number;
};
