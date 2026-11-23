import React, { useState } from "react";
import {
  Mail,
  Monitor,
  Globe2,
  Download,
  ArrowUpRight,
  FolderLock,
  Inbox,
} from "lucide-react";
import { Action, Choices, Figure, HeroCopy, Mark } from "./ui.jsx";
const hosted = "https://mailbox.timmyagentic.si/";
const download = hosted + "downloads/agentic-mailbox-mac-arm64.zip";
export const site = {
  name: "Agentic Mailbox",
  lang: "zh",
  nav: [
    ["Agent 演示", "#demo"],
    ["版本对照", "#editions"],
    ["打开邮箱", hosted],
  ],
};
const editions = [
  {
    id: "mac",
    label: "Mac 本地版",
    icon: Monitor,
    action: "下载 Mac Beta",
    href: download,
    detail: "Apple Silicon Mac · 邮件与附件留在本机",
  },
  {
    id: "hosted",
    label: "浏览器托管版",
    icon: Globe2,
    action: "打开托管收件箱",
    href: hosted,
    detail: "用浏览器登录个人空间，跨设备访问同步后的邮件",
  },
];
export function Hero() {
  const [edition, setEdition] = useState("mac");
  return (
    <section className="pi-hero post-hero">
      <div className="pi-container">
        <div className="post-heading">
          <HeroCopy
            mark={<Mark Icon={Mail}>Agentic Mailbox</Mark>}
            title={
              <>
                多个邮箱，
                <br />
                一个收件箱。
              </>
            }
            description="把 QQ、163、Gmail 和 Outlook 放进同一个收件箱。按会话查信，再用原邮箱回复。"
          />
          <div className="post-editions">
            <Choices
              label="选择使用方式"
              tabs={editions}
              value={edition}
              onChange={setEdition}
            >
              {(item) => (
                <div className="post-download">
                  <p>{item.detail}</p>
                  <Action
                    href={item.href}
                    icon={item.id === "mac" ? Download : ArrowUpRight}
                  >
                    {item.action}
                  </Action>
                </div>
              )}
            </Choices>
          </div>
        </div>
        <div className="post-window">
          <div className="post-window-header">
            <span>
              <Inbox size={19} /> 统一收件箱
            </span>
            <small>实际界面 · 示例邮件</small>
          </div>
          <Figure
            src="/assets/mailbox-inbox.webp"
            width={1344}
            height={756}
            alt="真实邮箱界面，左侧是不同邮箱账户和会话列表，右侧打开了一封示例账单邮件。"
            title="统一收件箱"
            priority
          />
        </div>
      </div>
    </section>
  );
}
