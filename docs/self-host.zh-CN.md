# 用自己的邮箱部署 OpenPostway

准备一个支持 IMAP 和 SMTP 的中转邮箱、一个不同的目标邮箱、Cloudflare 账号以及 Node.js 24。你的实例会在 workers.dev 提供管理页。中转邮箱负责收信和代发，域名可以直接使用邮箱服务商提供的域名。

## 部署管理页和定时任务

以下命令在 macOS 或 Linux 终端中执行。选一个当前 Cloudflare 账号中尚未使用的名称，全文示例为 `my-postway`。首次登录 Wrangler 时，选中希望部署的账号。

```sh
git clone https://github.com/timmyagentic/open-postway.git
cd open-postway
npm ci
npx wrangler login
npx wrangler d1 create my-postway --no-update-config
```

复制输出的数据库 ID，替换以下命令的 `YOUR_D1_UUID`。初始化命令会生成本机专用的 `wrangler.self-hosted.jsonc`。Worker、D1 和定时任务会根据这份配置部署。

```sh
npm run init:self-hosted -- my-postway YOUR_D1_UUID
npm run db:migrate:remote
npm run deploy:self-hosted
```

如果 Cloudflare 提示开通 workers.dev，按提示选一个子域名。记下最后输出的管理页网址。首次安装再执行以下三条命令，第一条会提示你输入以后登录管理页用的密码，后两条分别生成会话签名密钥和邮箱凭证加密密钥。

```sh
npx wrangler secret put ADMIN_PASSWORD --config wrangler.self-hosted.jsonc
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET --config wrangler.self-hosted.jsonc
openssl rand -base64 32 | npx wrangler secret put MAIL_ACCOUNT_KEY --config wrangler.self-hosted.jsonc
```

从五分钟轮询版升级时，沿用现有 Worker、数据库和密钥，把本机 `wrangler.self-hosted.jsonc` 的 `triggers.crons` 改为 `["* * * * *"]`。先迁移数据库，再发布 Worker。更新代码后依次运行 `npm ci`、`npm run db:migrate:remote` 和 `npm run deploy:self-hosted` 即可。重新生成邮箱加密密钥后需要再次连接邮箱。

## 连接中转邮箱

用管理员密码打开你自己的管理页。在「连接邮箱」中选一类服务，填写中转邮箱、发件人显示名和目标邮箱。

| 服务 | 设置方法 |
| --- | --- |
| Gmail | 若 Google 账号已启用两步验证且允许应用专用密码，可创建一个并填入设置页。使用 OAuth 的方法见下文。[Google 应用专用密码](https://support.google.com/accounts/answer/185833) |
| QQ 邮箱 | 在网页版进入「设置 → 账号与安全」，开启 IMAP/SMTP，生成客户端授权码。[QQ 官方说明](https://help.mail.qq.com/detail/106/985) |
| 网易 163 | 在网页版进入「设置 → POP3/SMTP/IMAP」，开启 IMAP/SMTP 并新增授权密码。[网易邮箱](https://mail.163.com/) |
| 其他邮箱或自有域名邮箱 | 填服务商提供的 IMAP 和 SMTP 主机、端口和加密方式。常用组合是 IMAP 993 / TLS 与 SMTP 465 / TLS，也可以选 SMTP 587 / STARTTLS。两端登录名或密码不同时，展开「单独设置登录名或发信密码」。 |

选择「连接并发送确认码」。服务会实际登录中转邮箱，并用它的 SMTP 发一封确认信。到目标邮箱取出 12 位确认码，在管理页输入后选择「启用中转」。更换已启用的设置时，原配置会继续处理来信，直到新地址验证成功。

### Gmail 使用 OAuth

在 Google Cloud 创建自己的项目并启用 Gmail API。配置 OAuth 同意屏幕，允许 IMAP/SMTP 使用的 `https://mail.google.com/` 权限。如果应用处于外部测试状态，将中转 Gmail 加入测试用户。创建类型为「桌面应用」的 OAuth 客户端，把下载的 JSON 保存在仓库以外。在能打开浏览器的同一台电脑执行：

```sh
npm run authorize:gmail -- /你的路径/desktop-client.json
```

打开终端显示的 Google 链接，用中转 Gmail 同意授权。看到终端的完成提示后，回到自己的设置页，选择「Gmail → 已配置的 Google OAuth 授权」，填写刚授权的地址。刷新令牌和客户端凭证通过标准输入写入 Worker Secrets。Google 外部应用处于 Testing 状态时，此类刷新令牌可能在七天后失效，长期运行应按自己的账号类型设置授权发布状态。[Google 协议授权](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol) · [令牌有效期](https://developers.google.com/identity/protocols/oauth2#expiration)

## 收到第一封中转邮件

1. 验证完成后，**用第三个邮箱**给中转地址寄一封新信，只填中转地址为收件人，写一个容易搜索的主题并附一个小文件。
2. 刷新管理页查看收信方式。显示「正在监听来信 · IMAP IDLE」时，来信通知会触发代发。显示「正在检查来信 · 每 10 秒」时，服务会在同一条连接上检查新信。也可以点「立即检查新信」。首次部署时 Cloudflare 的 Cron 配置可能需要几分钟才生效。
3. 打开目标邮箱，按测试主题找这封信，必要时查看垃圾邮件。发件人应显示中转邮箱和设定的名字，收件人只有目标邮箱。核对附件，再点回复，地址应是原邮件的回复地址或作者。
4. 确认后，平时直接使用目标邮箱即可。如果想汇集其他邮箱的来信，在那些来源邮箱中设置自动转发到中转地址。

首次连接会记录当时收件箱的末尾。之后的新来信在目标确认后开始中转，原邮箱保留原信与已读状态。Cloudflare 每分钟检查监听任务是否需要启动。每五分钟启动下一段监听。上一段在名义交接点后可再运行最多 90 秒，以覆盖分钟触发的秒级偏移和新连接建立所需的时间。每次重连都从 D1 记住的最后一封往后补信。两段监听和手动检查共用同一份发送记录。积压、断线或服务商延迟可能使到件时间变长。单封原始邮件超过 12 MiB、收件箱标识被服务商重建、或 SMTP 最终回执中断时，打开设置页可查看具体原因并选择后续操作。看到「SMTP 的最终回执缺失」时，服务会暂停这封信的自动发送。先查目标邮箱：已经收到就选「跳过此信并继续」，选择重新尝试可能会再次投递。

有自己的域名时，可以用上面的「其他邮箱」连接已有域名邮局。也可以选择 [Cloudflare 直接收域名来信](domain-routing.md)，由域名路由把信交给 Worker。
