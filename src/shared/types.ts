export type AliasStatus = 'active' | 'disabled';
export type RoutingMode = 'managed' | 'external';

export type MailAlias = {
  id: string;
  localPart: string;
  domain: string;
  address: string;
  label: string;
  status: AliasStatus;
  routingMode: RoutingMode;
  note: string;
  createdAt: string;
  updatedAt: string;
  lastReceivedAt: string | null;
  messageCount: number;
};

export type SessionPayload = {
  authenticated: boolean;
  user: { email: string } | null;
  edition?: 'hosted' | 'imap';
  admin?: boolean;
};

export type ApiErrorPayload = {
  error: { code: string; message: string; requestId?: string };
};

export type ForwardingSettings = {
  relay: string;
  senderName: string | null;
  senderAddress: string;
  destination: string | null;
  pending: string | null;
  step: 'provider' | 'code' | null;
};

export type LegacySource = { address: string; provider: string };
