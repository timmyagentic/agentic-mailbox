import { type FormEvent, useState } from "react";
import { Tabs } from "@heroui/react/tabs";
import { Button } from "@heroui/react/button";
import { Input } from "@heroui/react/input";
import { TextField } from "@heroui/react/textfield";
import { Label } from "@heroui/react/label";
import {
  ArrowDownToLine,
  ArrowRight,
  Eye,
  EyeOff,
  Inbox,
  LockKeyhole,
  Mail,
  ShieldCheck,
} from "lucide-react";
type Mode = "member" | "register" | "admin";
const modes = [
  { key: "member", label: "个人登录" },
  { key: "register", label: "注册账号" },
  { key: "admin", label: "管理员登录" },
] as const;
type Props = {
  error: string;
  busy: boolean;
  edition?: "local" | "hosted";
  onLogin: (
    password: string,
    member?: { username: string; register: boolean },
  ) => Promise<void>;
  onCertificateLogin: () => Promise<void>;
  onChatGPTLogin?: () => void;
};
export function LoginView({
  edition,
  error,
  busy,
  onLogin,
  onCertificateLogin,
  onChatGPTLogin,
}: Props) {
  const [mode, setMode] = useState<Mode>(
      edition === "hosted" ? "member" : "admin",
    ),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [visible, setVisible] = useState(false);
  const member = mode !== "admin",
    local = edition === "local";
  const heading =
    mode === "register"
      ? "创建个人邮箱空间"
      : member
        ? "登录个人邮箱空间"
        : local
          ? "本地邮箱"
          : "管理员登录";
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onLogin(
      password,
      member ? { username, register: mode === "register" } : undefined,
    );
  }
  const fields = (
    <>
      <form onSubmit={submit} className="mail-entry-fields" aria-busy={busy}>
        {member && (
          <TextField
            value={username}
            onChange={setUsername}
            isRequired
            minLength={3}
            maxLength={40}
          >
            <Label>用户名</Label>
            <Input
              autoComplete="username"
              title="3–40 位字母、数字、下划线或短横线"
            />
          </TextField>
        )}
        <TextField
          value={password}
          onChange={setPassword}
          isRequired
          isInvalid={!!error}
          minLength={member ? 12 : undefined}
          maxLength={member ? 256 : undefined}
        >
          <Label>{member ? "密码（至少 12 位）" : "管理员密码"}</Label>
          <div className="mail-entry-password">
            <LockKeyhole size={17} aria-hidden="true" />
            <Input
              id="admin-password"
              type={visible ? "text" : "password"}
              autoComplete={
                mode === "register" ? "new-password" : "current-password"
              }
              placeholder={member ? "输入个人密码" : "输入管理员密码"}
              aria-describedby={error ? "login-error" : undefined}
              autoFocus={local}
            />
            <Button
              type="button"
              className="mail-icon"
              aria-label={visible ? "隐藏密码" : "显示密码"}
              aria-pressed={visible}
              onPress={() => setVisible(!visible)}
            >
              {visible ? <EyeOff size={17} /> : <Eye size={17} />}
            </Button>
          </div>
        </TextField>
        {error && (
          <p role="alert" id="login-error" className="mail-entry-error">
            {error}
          </p>
        )}
        <Button
          type="submit"
          isDisabled={busy || !password}
          className="mail-entry-submit"
        >
          {busy
            ? "请稍候…"
            : mode === "register"
              ? "创建账号"
              : member
                ? "登录"
                : "进入管理端"}
          <ArrowRight size={17} />
        </Button>
      </form>
      {!member && !local && (
        <Button
          type="button"
          className="mail-entry-alternative"
          isDisabled={busy}
          onPress={() => void onCertificateLogin()}
        >
          <ShieldCheck size={17} />
          使用设备证书登录
        </Button>
      )}
      {local && onChatGPTLogin && (
        <Button
          type="button"
          className="mail-entry-alternative"
          isDisabled={busy}
          onPress={onChatGPTLogin}
        >
          Continue with ChatGPT
        </Button>
      )}
    </>
  );
  return (
    <main className="mail-entry">
      <div className="mail-entry-wrap">
        <div className="mail-entry-brand">
          <span>
            <Inbox size={24} />
            Agentic Mailbox
          </span>
          <small>{local ? "Mac 本地版" : "托管工作台"}</small>
        </div>
        <div className="mail-entry-layout">
          <section className="mail-entry-intro">
            <h1>{local ? "你的本地收件箱。" : <>一个空间，<br />收齐所有来信。</>}</h1>
            <p>
              {local
                ? "在这台 Mac 管理邮件、附件和账号。"
                : "连接邮箱后，可以按会话阅读、回复和保存草稿。每个账号独立管理自己的邮件与附件。"}
            </p>
            <div className="mail-entry-providers" aria-label="支持的邮箱">
              {["QQ 邮箱", "网易 163", "Gmail", "Outlook"].map((name) => (
                <span key={name}>
                  <Mail size={14} />
                  {name}
                </span>
              ))}
            </div>
            {!local && (
              <a href="https://agentic-mailbox.timmyagentic.si/">
                查看产品介绍 <ArrowRight size={15} />
              </a>
            )}
          </section>
          <section className="mail-entry-card" aria-labelledby="login-title">
            <h2 id="login-title">{heading}</h2>
            <p>
              {member
                ? "使用个人账号进入自己的收件箱。"
                : local
                  ? "使用启动器打开，或输入本机密码。"
                  : "使用管理员密码或已登记的设备证书。"}
            </p>
            {edition === "hosted" ? (
              <Tabs
                selectedKey={mode}
                onSelectionChange={(key) => {
                  const next = modes.find((m) => m.key === key);
                  if (next) {
                    setMode(next.key);
                    setPassword("");
                    setVisible(false);
                  }
                }}
              >
                <Tabs.List
                  className="mail-entry-tabs"
                  aria-label="选择登录方式"
                >
                  {modes.map((m) => (
                    <Tabs.Tab id={m.key} key={m.key} isDisabled={busy}>
                      {m.label}
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
                {modes.map((m) => (
                  <Tabs.Panel key={m.key} id={m.key}>
                    {mode === m.key && fields}
                  </Tabs.Panel>
                ))}
              </Tabs>
            ) : (
              fields
            )}
            {!local && (
              <a
                href="/downloads/agentic-mailbox-mac-arm64.zip"
                className="mail-entry-download"
              >
                <ArrowDownToLine size={15} />
                下载 Mac 本地版
              </a>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
