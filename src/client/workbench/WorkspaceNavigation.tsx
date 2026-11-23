import { Button } from "@heroui/react/button";
import { Dropdown } from "@heroui/react/dropdown";
import { Modal } from "@heroui/react/modal";
import {
  Archive,
  ChartColumn,
  Check,
  ChevronDown,
  Files,
  FilePenLine,
  Inbox,
  LogOut,
  Mail,
  Pencil,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type { MailFolder } from "../../shared/types";
import type { ViewName } from "./InboxWorkbench";
type Folder = MailFolder | "drafts";
const folders = [
  { id: "inbox", label: "收件箱", Icon: Inbox },
  { id: "sent", label: "已发送", Icon: Send },
  { id: "drafts", label: "草稿", Icon: FilePenLine },
  { id: "archive", label: "归档", Icon: Archive },
  { id: "trash", label: "废纸篓", Icon: Trash2 },
] as const;
type Props = {
  open: boolean;
  onOpen: (open: boolean) => void;
  appName: string;
  primaryDomain: string;
  userLabel: string;
  sources: { id: string; address: string }[];
  sourceId: string;
  folder: Folder;
  activeView: ViewName;
  unread: number;
  draftCount: number;
  busy: boolean;
  onSource: (value: string) => void;
  onFolder: (id: Folder) => void;
  onNavigate: (view: ViewName) => void;
  onCompose: () => void;
  onLogout: () => void;
};
export default function WorkspaceNavigation(p: Props) {
  const selectedSource = p.sources.find((s) => s.id === p.sourceId)?.address;
  const nav = (
    <div className="mail-navigation">
      <div className="mail-nav-identity">
        <span>
          <Inbox size={22} />
          {p.appName}
        </span>
        <small>{selectedSource || p.primaryDomain}</small>
      </div>
      <Button
        className="mail-compose-action"
        isDisabled={p.busy}
        onPress={p.onCompose}
      >
        <Pencil size={17} />
        写信
      </Button>
      <nav aria-label="邮箱导航" className="mail-folders">
        {folders.map(({ id, label, Icon }) => {
          const count =
            id === "inbox" ? p.unread : id === "drafts" ? p.draftCount : 0;
          return (
            <Button
              key={id}
              className="mail-nav-link"
              aria-current={
                p.activeView === "inbox" && p.folder === id ? "page" : undefined
              }
              onPress={() => p.onFolder(id)}
            >
              <Icon size={17} />
              {label}
              {count > 0 && <span>{count}</span>}
            </Button>
          );
        })}
      </nav>
      <div className="mail-source-block">
        <span>邮箱来源</span>
        <Dropdown>
          <Dropdown.Trigger
            className="mail-source-trigger"
            aria-label="筛选邮箱"
          >
            <span>{selectedSource || "全部邮箱"}</span>
            <ChevronDown size={15} />
          </Dropdown.Trigger>
          <Dropdown.Popover
            className="mail-source-menu"
            placement="bottom start"
          >
            <Dropdown.Menu
              aria-label="邮箱来源"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={
                new Set([p.sourceId ? "source:" + p.sourceId : "all"])
              }
              onSelectionChange={(keys) => {
                if (keys === "all") return;
                const key = [...keys][0];
                if (key !== undefined)
                  p.onSource(key === "all" ? "" : String(key).slice(7));
              }}
            >
              {[{ id: "", address: "全部邮箱" }, ...p.sources].map((s) => (
                <Dropdown.Item
                  key={s.id || "all"}
                  id={s.id ? "source:" + s.id : "all"}
                  textValue={s.address}
                >
                  <span>{s.address}</span>
                  <Dropdown.ItemIndicator>
                    <Check size={15} />
                  </Dropdown.ItemIndicator>
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
      <div className="mail-nav-secondary">
        {(
          [
            { id: "aliases", label: "邮箱地址", Icon: Mail },
            { id: "overview", label: "概览", Icon: ChartColumn },
            { id: "files", label: "附件", Icon: Files },
          ] as const
        ).map(({ id, label, Icon }) => (
          <Button
            key={id}
            className="mail-nav-link"
            aria-current={p.activeView === id ? "page" : undefined}
            onPress={() => p.onNavigate(id)}
          >
            <Icon size={17} />
            {label}
          </Button>
        ))}
      </div>
      <div className="mail-nav-account">
        <span>{p.userLabel}</span>
        <Button
          className="mail-icon"
          aria-label="退出登录"
          onPress={p.onLogout}
        >
          <LogOut size={17} />
        </Button>
      </div>
    </div>
  );
  return (
    <>
      <aside className="mail-nav-desktop">{nav}</aside>
      <Modal.Backdrop
        isOpen={p.open}
        onOpenChange={p.onOpen}
        isDismissable
        className="mail-nav-scrim"
      >
        <Modal.Container className="mail-overlay-container">
          <Modal.Dialog className="mail-nav-drawer" aria-label="邮箱导航">
            <div className="mail-drawer-head">
              <Modal.Heading>邮箱导航</Modal.Heading>
              <Button
                className="mail-icon"
                aria-label="关闭导航"
                onPress={() => p.onOpen(false)}
              >
                <X size={19} />
              </Button>
            </div>
            {nav}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
