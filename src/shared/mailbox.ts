export const presetHosts = {
  gmail: { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
  qq: { imap: 'imap.qq.com', smtp: 'smtp.qq.com' },
  '163': { imap: 'imap.163.com', smtp: 'smtp.163.com' },
} as const;

export type Provider = keyof typeof presetHosts | 'custom';
export type Server = { host: string; port: number; tls: 'implicit' | 'starttls' };

export type MailboxProfile = {
  provider: Provider;
  address: string;
  destination: string;
  name: string;
  imap: Server;
  smtp: Server;
  imapUser: string;
  smtpUser: string;
  auth: 'password' | 'google';
};

export type RelayIssue =
  'imap' | 'smtp' | 'rejected' | 'oauth' | 'message' | 'oversize' | 'uncertain' | 'reset';

export type MailboxStatus = {
  googleEnabled: boolean;
  active: {
    profile: MailboxProfile;
    generation: string;
    uidValidity: string;
    inFlight: number | null;
    checkedAt: number | null;
    sentAt: number | null;
    issue: RelayIssue | null;
    busy: boolean;
  } | null;
  pending: { id: string; destination: string } | null;
};
