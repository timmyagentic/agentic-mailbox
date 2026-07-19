import {
  Archive,
  AtSign,
  Files,
  Gauge,
  Inbox,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { DashboardStats } from '../../shared/types';

export type ViewName = 'overview' | 'inbox' | 'aliases' | 'files';

type LayoutProps = {
  appName: string;
  primaryDomain: string;
  adminEmail: string;
  activeView: ViewName;
  stats: DashboardStats;
  children: ReactNode;
  onNavigate: (view: ViewName) => void;
  onLogout: () => void;
};

const items: Array<{ id: ViewName; label: string; icon: typeof Gauge }> = [
  { id: 'overview', label: '概览', icon: Gauge },
  { id: 'inbox', label: '收件箱', icon: Inbox },
  { id: 'aliases', label: '邮箱地址', icon: AtSign },
  { id: 'files', label: '附件', icon: Files },
];

export function Layout({
  appName,
  primaryDomain,
  adminEmail,
  activeView,
  stats,
  children,
  onNavigate,
  onLogout,
}: LayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const navigate = (view: ViewName) => {
    onNavigate(view);
    setMobileOpen(false);
  };

  return (
    <div className="app-shell">
      <aside id="primary-sidebar" className={`sidebar ${mobileOpen ? 'sidebar--open' : ''}`}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <Archive size={19} />
          </div>
          <div className="brand-copy">
            <strong>{appName}</strong>
            <span>{primaryDomain}</span>
          </div>
          <button
            className="icon-button sidebar__close"
            type="button"
            onClick={() => setMobileOpen(false)}
            title="关闭导航"
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="主要导航">
          {items.map((item) => {
            const Icon = item.icon;
            const count =
              item.id === 'inbox'
                ? stats.unreadCount
                : item.id === 'aliases'
                  ? stats.activeAliasCount
                  : item.id === 'files'
                    ? stats.attachmentCount
                    : null;
            return (
              <button
                key={item.id}
                className={activeView === item.id ? 'primary-nav__item primary-nav__item--active' : 'primary-nav__item'}
                type="button"
                onClick={() => navigate(item.id)}
                aria-current={activeView === item.id ? 'page' : undefined}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {count !== null ? <span className="nav-count">{count}</span> : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar__account">
          <div className="account-avatar">TZ</div>
          <div>
            <strong>管理员</strong>
            <span>{adminEmail}</span>
          </div>
          <button className="icon-button" type="button" onClick={onLogout} title="退出登录" aria-label="退出登录">
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      {mobileOpen ? <button className="sidebar-backdrop" type="button" onClick={() => setMobileOpen(false)} aria-label="关闭导航" /> : null}

      <main className="workspace">
        <header className="mobile-header">
          <button
            className="icon-button"
            type="button"
            onClick={() => setMobileOpen(true)}
            title="打开导航"
            aria-label="打开导航"
            aria-controls="primary-sidebar"
            aria-expanded={mobileOpen}
          >
            <Menu size={20} />
          </button>
          <strong>{appName}</strong>
          <span>{stats.unreadCount} 未读</span>
        </header>
        {children}
      </main>
    </div>
  );
}
