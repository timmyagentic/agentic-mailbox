# Mailbox Vault Goal

## 推荐执行版（中文，可直接复制）

/goal 新建并交付一个可用的邮箱资产管理 MVP：实现受保护的 Cloudflare Workers 管理端，用于创建和停用自有域名邮箱别名、查看收件、保存并下载附件；使用 Email Routing 和 Email Worker 接收邮件，D1 保存结构化数据，R2 保存附件，部署到 `mailbox.timmyagentic.si`，并交付到 GitHub private 仓库。
验证：核对 Cloudflare 和 GitHub 登录与现有路由；运行 `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`npm run cf:types` 和 `npx wrangler deploy --dry-run`；本地实际走通登录、创建邮箱、投递 MIME 邮件、查看邮件和下载附件；部署后验证 HTTPS、鉴权、健康检查、远端 D1/R2/Worker/Email Routing 状态以及桌面和移动端截图。
约束：保留现有 `emomo.net` 显式转发规则与 `codex@emomo.net` 行为；不提交密钥、真实邮件正文或附件；不增加付费第三方服务；只管理用户控制域名下的路由别名，不实现第三方账号批量注册或 IMAP/SMTP 登录邮箱。
边界：只写入本项目目录、本项目新建的 Worker、D1、R2、catch-all 路由和新 GitHub private 仓库；不删除、覆盖或重构无关资源。
迭代策略：先读取官方文档和实时账户状态，一次实现一个聚焦工作流；每次有意义改动后重跑最小检查；同一问题连续失败两次后改用运行日志、配置 schema、官方文档或最小复现；最多做 3 轮聚焦产品和视觉改进。
完成条件：线上管理端可访问且匿名数据请求被拒绝；新邮箱创建后能由 catch-all Worker 接收，邮件和附件可查看下载；相关检查通过；GitHub private 仓库包含完整可复现源码和部署说明。
暂停条件：现有登录失效且需要交互式认证、必须购买付费服务、需要删除或迁移现有生产数据或路由、域名所有权不明确，或 Cloudflare 权限客观不支持生产链路时暂停并报告精确证据。

默认选择理由：Cloudflare Email Routing、Workers、D1 和 R2 已在同一账户可用，这条路径能以最少新增基础设施交付完整收件与附件工作流。

## Goal Draft (English-compatible)

/goal Build and deliver a usable mailbox asset management MVP: implement a protected Cloudflare Workers admin app for creating and disabling owned-domain aliases, viewing received mail, and storing and downloading attachments; receive mail through Email Routing and an Email Worker, store structured data in D1, store attachments in R2, deploy to `mailbox.timmyagentic.si`, and deliver the source to a private GitHub repository.
Verification: inspect current Cloudflare and GitHub authentication and existing routes; run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run cf:types`, and `npx wrangler deploy --dry-run`; locally complete login, alias creation, MIME delivery, email viewing, and attachment download; after deployment verify HTTPS, authentication, health, remote D1/R2/Worker/Email Routing state, and desktop/mobile screenshots.
Constraints: preserve existing `emomo.net` explicit forwarding rules and the behavior of `codex@emomo.net`; do not commit secrets, real email bodies, or attachments; add no paid third-party service; manage only aliases on domains owned by the user and do not implement bulk third-party account registration or IMAP/SMTP login mailboxes.
Boundaries: write only in this project directory, newly created project Worker/D1/R2/catch-all resources, and a new private GitHub repository; do not delete, overwrite, or refactor unrelated resources.
Iteration policy: inspect authoritative documentation and live account state first, implement one focused workflow at a time, rerun the smallest checks after meaningful changes, switch evidence sources after two repeated failures, and perform at most three focused product and visual improvement rounds.
Stop when: the deployed admin app is reachable while anonymous data requests are denied; a new alias can receive through the catch-all Worker and its message and attachments can be viewed and downloaded; checks pass; and the private GitHub repository contains reproducible source and deployment documentation.
Pause if: existing authentication expires and requires interactive login, a paid service is required, existing production data or routes must be deleted or migrated, domain ownership is unclear, or Cloudflare permissions objectively cannot support the production path.
