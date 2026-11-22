# Agentic Mailbox 本地版

解压整个文件夹，双击 **打开本地邮箱.command**。浏览器会自动进入本机邮箱。使用期间保留启动窗口，按 Ctrl+C 停止。需 macOS Apple Silicon，压缩包内置运行时。系统可能要求确认首次打开下载的命令行程序。

打开「邮箱设置 → 接入邮箱」。QQ、Foxmail 和 163 使用邮箱服务商签发的客户端授权码。个人 Gmail 可以选择「Gmail 应用专用密码」，在开启两步验证的 Google 账号中生成密码，填入后同步。部分 Google 账号没有应用专用密码选项。

如果希望通过自己的 Google 或 Microsoft OAuth 应用连接，双击 **配置本机 OAuth.command**。它会显示本机回调地址，并让你选择 Google 客户端 JSON 或填写 Microsoft 客户端凭据。Google 应用需启用 Gmail API 并允许 gmail.readonly、gmail.send。Microsoft 使用 Web 客户端与 Graph 委托权限 User.Read、Mail.Read、Mail.Send。保存后重启本地邮箱。

本地版直接连接服务商。数据位于 ~/Library/Application Support/Agentic Mailbox，已有安装会沿用旧数据目录。数据包含邮件、附件、加密的邮箱凭据和仅当前系统用户可读的密钥文件。停止运行后备份整个目录即可保留数据。如果浏览器未自动登录，在 identity.json 中找到 ADMIN_PASSWORD 并在本机登录页输入。本版不调用托管站点的 AI 或自有域名收发服务。
