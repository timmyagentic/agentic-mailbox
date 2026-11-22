# Agentic Mailbox 本地版

解压整个文件夹，双击 **打开本地邮箱.command**。浏览器会自动进入本机邮箱。使用期间保留启动窗口，按 Ctrl+C 停止。需 macOS Apple Silicon，压缩包内置运行时。系统可能要求确认首次打开下载的命令行程序。

打开「邮箱设置 → 接入邮箱」。QQ、Foxmail 和 163 使用邮箱服务商签发的客户端授权码。个人 Gmail 可以选择「Gmail 应用专用密码」，在开启两步验证的 Google 账号中生成密码，填入后同步。部分 Google 账号没有应用专用密码选项。

包含 Outlook 支持的安装包中，点击 **Outlook** 会打开微软授权页。授权后，应用在本机连接 Microsoft Graph，邮箱凭据随本地数据加密保存。

如果希望通过自己的 Google 或 Microsoft OAuth 应用连接，双击 **配置本机 OAuth.command**。它会显示本机回调地址，并让你选择 Google 客户端 JSON 或填写 Microsoft 客户端凭据。Google 应用需启用 Gmail API 并允许 gmail.readonly、gmail.send。Microsoft 使用 Web 客户端与 Graph 委托权限 User.Read、Mail.Read、Mail.Send。保存后重启本地邮箱。

本地版直接连接服务商。数据位于 ~/Library/Application Support/Agentic Mailbox，已有安装会沿用旧数据目录。数据包含邮件、附件、加密的邮箱凭据和仅当前系统用户可读的密钥文件。停止运行后备份整个目录即可保留数据。如果浏览器未自动登录，在 identity.json 中找到 ADMIN_PASSWORD 并在本机登录页输入。本版不调用托管站点的 AI 或自有域名收发服务。

## Mac 设备证书登录

在 Mac App 启动器点 **登记设备证书**，选择设备的 `.p12` 或 `.pfx` 并输入该证书包的导入密码。私钥导入 macOS 钥匙串，应用数据目录只登记公开证书。之后点 **使用设备证书登录**，由钥匙串为本机的一次性挑战签名。钥匙串可能在首次使用时要求允许。打开邮箱页面时也可以直接用原来的本机密码。

## 打包 Outlook 接入

维护者在 Microsoft Entra 为本地版单独注册「移动和桌面应用程序」，支持组织帐户和个人 Microsoft 帐户，启用公共客户端并登记 `http://127.0.0.1:8787/api/oauth/outlook/callback` 为公共客户端的重定向 URI。所需的 Microsoft Graph 委托权限为 User.Read、Mail.Read、Mail.Send，授权请求同时包含 offline_access。将公开的 Application (client) ID 通过 `AGENTIC_MAILBOX_OUTLOOK_CLIENT_ID` 传给 `node scripts/package-mac.mjs`。安装包无需客户端密钥。已经用自己的 Web 客户端接入的用户会继续使用原配置。
