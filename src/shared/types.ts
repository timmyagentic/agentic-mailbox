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

export type AttachmentItem = {
  id: string;
  emailId: string;
  aliasId: string;
  aliasAddress: string;
  emailSubject: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
};

export type EmailSummary = {
  id: string;
  aliasId: string;
  aliasAddress: string;
  aliasLabel: string;
  fromAddress: string;
  fromName: string;
  toAddress: string;
  subject: string;
  preview: string;
  receivedAt: string;
  readAt: string | null;
  rawSize: number;
  attachmentCount: number;
};

export type MailFolder = 'inbox' | 'sent' | 'archive' | 'trash';
export type ConversationSummary = EmailSummary & {
  threadCount: number;
  unreadCount: number;
  starred: boolean;
  outgoing: boolean;
};

export type EmailDetail = EmailSummary & {
  messageId: string;
  bodyText: string;
  bodyHtml?: string;
  outgoing?: boolean;
  replyAddress?: string;
  cc?: string;
  sentAt: string | null;
  attachments: AttachmentItem[];
};

export type DashboardStats = {
  aliasCount: number;
  activeAliasCount: number;
  emailCount: number;
  unreadCount: number;
  attachmentCount: number;
  attachmentBytes: number;
};

export type ImapProvider = 'qq' | 'netease163' | 'gmail_app';
export type OAuthProvider = 'gmail' | 'outlook';
export type MailProvider = ImapProvider | OAuthProvider;

export type MailAccount = {
  id: string;
  provider: MailProvider;
  address: string;
  lastSyncAt: string | null;
};

export type MailRefreshResult = {
  id: string;
  imported: number;
  oversized: number;
  hasMore: boolean;
  lastSyncAt: string | null;
  error?: string;
  requiresReauthorization?: boolean;
};

export type ChatGPTConnection = { linked: boolean; email: string; planEnabled: boolean };

export type BootstrapPayload = {
  chatGPT?: ChatGPTConnection;
  appName: string;
  primaryDomain: string;
  adminEmail: string;
  stats: DashboardStats;
  recentEmails: EmailSummary[];
  recentAliases: MailAlias[];
  mailAccounts: MailAccount[];
  local?: boolean;
  externalOnly?: boolean;
  oauthProviders?: OAuthProvider[];
};

export type SessionPayload = {
  chatGPTLogin?: boolean;
  edition?: 'local' | 'hosted';
  authenticated: boolean;
  user: { email: string } | null;
};

export type ApiErrorPayload = {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
};

export type Conversation = { messages: EmailDetail[]; total: number };
export type DraftMode = 'new' | 'reply' | 'forward';
export type DraftFile = { id: string; filename: string; contentType: string; size: number };
export type DraftInput = {
  aliasId: string;
  mode: DraftMode;
  sourceEmailId: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  includeOriginalFiles: boolean;
};
export type MailDraft = DraftInput & {
  id: string;
  fromAddress: string;
  status: 'draft' | 'sending' | 'uncertain' | 'sent';
  updatedAt: string;
  files: DraftFile[];
};
