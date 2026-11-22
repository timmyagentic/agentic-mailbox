// Copyright (c) 2026 Cloudflare, Inc.
// Adapted from Agentic Inbox under Apache-2.0. See LICENSE.agentic-inbox.
import type { ReactNode } from 'react';

export default function MailboxSplitView({
  isPanelOpen, reading, children,
}: { isPanelOpen: boolean; reading: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0">
      <div
        className={`flex flex-col min-w-0 shrink-0 ${isPanelOpen
          ? 'hidden md:flex md:w-[min(46%,380px)] md:border-r md:border-kumo-line'
          : 'w-full'}`}
      >
        {children}
      </div>
      {isPanelOpen && (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden w-full md:w-auto">
          {reading}
        </div>
      )}
    </div>
  );
}
