export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  APP_NAME: string;
  PRIMARY_DOMAIN: string;
  ADMIN_EMAIL: string;
  FORWARD_TO?: string;
  ADMIN_PASSWORD: string;
  ADMIN_CERT_FINGERPRINTS?: string;
  SESSION_SECRET: string;
  MAIL_ACCOUNT_KEY?: string;
  MAIL_OAUTH_ORIGIN?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  OUTLOOK_CLIENT_ID?: string;
  OUTLOOK_CLIENT_SECRET?: string;
  EMAIL?: SendEmail;
  AI?: Ai;
}

export type EmailWorkerMessage = ForwardableEmailMessage;

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

export type EmailRow = {
  id: string;
  alias_id: string;
  alias_address: string;
  alias_label: string;
  message_id: string;
  from_address: string;
  from_name: string;
  to_address: string;
  subject: string;
  preview: string;
  body_text: string;
  body_html: string;
  headers_json: string;
  thread_key: string;
  outgoing: number;
  starred: number;
  received_at: string;
  sent_at: string | null;
  raw_size: number;
  read_at: string | null;
  attachment_count: number;
};

export type AttachmentRow = {
  id: string;
  email_id: string;
  alias_id: string;
  alias_address: string;
  email_subject: string;
  filename: string;
  content_type: string;
  size: number;
  content_id: string;
  disposition: string;
  r2_key: string;
  created_at: string;
};
