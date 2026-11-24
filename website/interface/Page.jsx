import React, { useState } from "react";
import { Monitor, Globe2, Download, ArrowUpRight } from "lucide-react";
import { Action, Choices, Figure } from "./ui.jsx";
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
    <section className="pi-hero post-hero" aria-labelledby="hero-title">
      <div className="pi-container post-spread">
        <div className="post-details">
          <h1 id="hero-title">Agentic Mailbox</h1>
          <p>
            把 QQ、163、Gmail 和 Outlook
            的邮件放在一起，按会话阅读，用原邮箱回复。
          </p>
          <Choices
            label="选择使用方式"
            tabs={editions}
            value={edition}
            onChange={setEdition}
          >
            {(item) => (
              <div className="post-download">
                <Action
                  href={item.href}
                  icon={item.id === "mac" ? Download : ArrowUpRight}
                >
                  {item.action}
                </Action>
                <p>{item.detail}</p>
              </div>
            )}
          </Choices>
        </div>
        <figure className="post-sample">
          <Figure
            src="/assets/mailbox-inbox.webp"
            width={1344}
            height={756}
            alt="真实邮箱界面，左侧是不同邮箱账户和会话列表，右侧打开了一封示例账单邮件。"
            title="统一收件箱"
            priority
          />
          <figcaption>
            收件箱里的一个会话<span>示例邮件</span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
