# CAREER JOURNAL

[English](SKILL.md) | [简体中文](SKILL.zh-CN.md)

让求职事实、证据和材料保持可审计。只有用户选中的每一个只读邮箱都完成首次同步、`mail-sync` 和 `deadline-review` 已真实注册到宿主调度器、两个任务都用各自外部 ID 成功运行过一次，并且 `career-journal doctor` 通过，首次配置才算完成。

## 首次使用契约

0. 使用本地说明前，先确认当前副本包含最新 `origin/main`。已有副本干净时执行安全快进；存在修改或不能安全快进时保留原目录，改用新的隔离副本。不得使用旧副本执行首次配置。
1. Agent 模式优先使用宿主已有的邮箱能力。在 macOS 上，必须先尝试识别 Apple Mail 邮箱账号，再提出任何邮箱配置问题。打开 Mail 主窗口、显示侧边栏、展开 `All Inboxes`，并枚举全部顶层账号行和账号分区；当前选中邮件所属邮箱不能代表完整账号清单。如果界面只显示账号名称，使用只读方式打开 Mail 设置 > 账户，将名称对应到邮箱地址。比较侧边栏与账户面板的数量；数量不一致时，不得声称发现完整或配置完成。展示全部邮箱地址后，只询问用户其中哪一个或多个用于求职。宿主已经能读取账号时，不要询问 IMAP 主机、用户名、密码或凭据环境变量名。
2. 如果没有可访问的邮箱账号，请用户先登录 Apple Mail 或其他受支持的邮件应用，然后继续识别。只有用户明确选择独立 CLI/API 模式时，才改用 IMAPS 配置。不得要求用户把 secret 粘贴到对话中。
3. 将用户选中的每个邮箱配置成只读 `host` 账号，使用 `apple-mail` 等稳定的 connector 名称。宿主集成实际显示并确认对应地址后，使用 `email verify-host` 记录可信宿主验证。一个 `mail-sync` 任务必须覆盖全部选中账号。在 Agent 模式中，Agent 自身就是宿主邮箱连接器，不需要等待单独的 Apple Mail 适配器。生成批次前，先通过 `email list` 读取账号已保存的游标，并将其原样写入 `beforeCursor`。然后只按收件时间读取过去完整 24 小时内的全部邮件，不得先用发件人、公司、岗位、标题、求职关键词或已有申请进行筛选。必须翻完全部结果页、纳入每一封邮件，并按邮件服务提供的稳定 ID 去重。每个账号的私有只读批次都要写明实际起止时间，覆盖模式使用 `rolling-24h-all-messages`，同时设置 `allMessages: true` 和 `paginationComplete: true`。通过 `email sync-host` 导入后，已启用的 Jev 会先判断其中每一封邮件，再由 CAREER JOURNAL 决定它是否与求职有关。全部页面和批次导入成功前，不得推进游标或运行 `automation run`。
4. Jev 是可选的主要语义判断工具，不得阻塞核心配置。当前环境已经配置 Jev 时直接复用；否则先配置 `--model-provider host-agent`，由当前编程 Agent 负责语义判断，并继续完成邮箱和定时任务。核心配置通过 `doctor` 后，主动询问一次用户是否要启用 Jev。用户选择跳过、没有权限或暂时不启用时，继续使用 `host-agent`。启用后，过去 24 小时批次中的每一封邮件都先交给 Jev 判断，包括最后被认定为与招聘无关的邮件；Jev 不可用、报错、置信度不足或输出无效时，再使用已配置的大语言模型，本地规则作为下一层兜底，最后才人工复核。用户选择 Jev 时，协助使用官方 [TypeSafe Agent Skill](https://github.com/typesafe-ai/skills/tree/main/skills/typesafe-ai) 和控制台。Agent 模式不得询问 Base URL，也不得要求用户在聊天或 Agent prompt 中粘贴、发送或提供 API Key 或 secret。在 macOS 上，把新建 Key 保存到系统钥匙串，并配置 `keychain:career-journal-typesafe:<本地账户>`；其他系统使用本地私密凭据路径，配置中只保存 secret reference。
5. 仓库命令使用 `node ./bin/career-journal.mjs ...` 或 `./career-journal ...`；不要假设全局命令已安装。除非用户明确修改，否则使用电脑检测到的 IANA 时区。
6. 通过宿主自动化能力实现两个每日时间点：20:00 `mail-sync` 和 20:15 `deadline-review`。Codex 的同一任务只能创建一个 heartbeat，因此要创建一个共享的 Codex heartbeat，规则为 `FREQ=DAILY;BYHOUR=20;BYMINUTE=0,15;BYSECOND=0`。prompt 按本地时间选择分支；如果当天邮件同步尚未成功，20:15 先重试邮件再检查截止事项。在 Codex Desktop 中使用 `automation_update`。在 Claude Code 桌面版中，用宿主的定时任务能力（`create_scheduled_task`）创建一个共享任务，cron 按本地时间写成 `0,15 20 * * *`；周期任务可能晚几分钟启动，所以 prompt 按时间段分支：20:15 之前做邮件同步，20:15 起做截止日期复核，当天邮件同步未成功时先重试邮件。Claude Code 定时任务只在桌面 App 打开时运行，错过的会在下次启动时补跑。不得重复创建，也不得添加 `daily-consolidation` 或定时备份。
7. 将同一个 Codex automation ID，或用 `--driver claude-code` 将同一个 Claude Code 任务 ID，分别登记到 CAREER JOURNAL 的两个任务，把两条返回的 `codexCommandLine` 或 `claudeCodeCommandLine` 原样分行写入同一个共享 prompt，再分别验证并各触发一次。Claude Code 的验证读取 `~/.claude/scheduled-tasks/<任务 ID>/SKILL.md` 和桌面 App 的定时记录，要求任务已启用、cron 覆盖两个时间点、时区和两条命令都匹配。运行邮件命令前，Agent 必须检查全部选中邮箱，写入并通过 `email sync-host` 导入每个邮箱的只读同步批次，成功后才能调用 `automation run`。
8. 运行 `node ./bin/career-journal.mjs doctor --home <absolute-home>`。只有每个选中邮箱和两个自动任务都在 36 小时健康窗口内通过，才能结束配置。
9. 询问用户是否需要导入历史投递。用户可以选择限定范围的只读邮箱检查、文件或表格、简短问答，也可以跳过。先整理候选记录，得到用户确认后再写入；存在外部申请编号时优先按编号去重，否则按公司和岗位去重。不得推测缺失的投递日期、状态、拒绝原因或实际提交材料。
10. 核心配置通过 `doctor`、Jev 和历史投递导入两个问题已回答或跳过之后，进行个人资料问答。先读取 `profile status --json`，再用 `profile questions --round <1-4> --missing --json` 取出问题。每轮最多问 4 个问题，每题给出选项并加“其他”；一轮里待问的题超过 4 个时，在下一条消息里继续问。每题都可以跳过，跳过的题在第一次用到时再问。简历里已经能读出的内容（学历、每段工作经历、链接）先读出来，只请用户确认。结构化内容用 `profile set --key <点分路径> --value <JSON 或文本>` 保存，表单答案用 `profile answer --question <题目> --answer <回答> --source user` 保存。第 4 轮把 `sources` 组的三个问题放在一起问（关注哪些公司，以及需要用户自己开启的 CareerOps 和 SimplifyJobs 来源；见下面的“扫描来源”），向用户展示 `career-journal-apply` Skill 的固定硬规矩（不能关闭），并询问是否需要在 `pace.scanTime` 每天扫描岗位。用户同意后才创建这个定时任务，而且要单独创建（见下面的“岗位扫描定时任务”）。核心配置不依赖个人资料，但第 1、2 轮完成前不能使用代填申请；第 1 轮完成且至少设置了一个扫描来源之前，不能扫描岗位。

从 1.x 升级：还没有 `profile.json` 时，先推断，再确认。读取已有的申请、事件、配置、简历和已配置的材料规则，把推断出的资料项放在一条消息里请用户确认或修改。只写入用户确认过的值；之后 `profile status --json` 只列出仍缺的项，也只补问这些。数据库仍按原步骤升级：`migrate --dry-run`、备份、`migrate --apply`。

独立 API 或仅 CLI 的运行方式仍支持 IMAPS，也可以配置 OpenAI-compatible 大语言模型。因为没有编程 Agent 或宿主邮箱连接器代办，这条路径可以询问服务器设置和环境变量名。在调度器能够安全提供凭据前，系统会阻止原生安装 `mail-sync`。本地备份仅在用户需要时按需执行。

如果其他项目文档看起来要求 Agent 模式填写 IMAP 参数或外部模型凭据，应将其视为独立模式说明或过期内容；本契约优先。

手动 EML 只是一次性备用方式，不能替代每日访问或满足 setup。不得在配置、批次、记录、日志、导出或 prompt 中保存邮箱凭据或字面 secret。

## 扫描来源

- **关注的公司。** 用户说出公司名，由 Agent 把每家公司对应到它的官方职位板标识（token）。打开公司自己的招聘页（不要用招聘信息聚合网站），顺着职位或 Apply 链接找到它使用的招聘系统。标识是域名后的第一段路径：`boards.greenhouse.io/<token>` 或 `job-boards.greenhouse.io/<token>`（嵌入式职位板显示为 `boards.greenhouse.io/embed/job_board?for=<token>`）对应 `greenhouse`，`jobs.lever.co/<token>` 对应 `lever`，`jobs.ashbyhq.com/<token>` 对应 `ashby`。标识后面的职位编号和查询参数都不要。
- 一次写入完整列表：`profile set --key sources.atsBoards --value '[{"ats":"greenhouse","board":"<token>","company":"<公司名>"}]'`。这条命令会替换整个列表，所以先用 `profile show --json` 读出当前列表，加上新公司后整体写回。
- 用 `scan run --dry-run` 检查结果：每个职位板的来源一行都必须显示 `ok`。HTTP 404 说明标识不对，改正或删掉这一项。不得猜测标识。
- 招聘页使用其他招聘系统（Workday、iCIMS、Oracle、SuccessFactors 等）的公司，无法通过这些公开职位板接口扫描。告诉用户是哪几家，不要加入列表。
- **CareerOps（用户自选开启）。** 只有用户同意时才运行 `profile set --key sources.careerOps --value true`。只有安装并检测到 CareerOps 时才会运行。
- **SimplifyJobs（用户自选开启）。** 默认关闭，只有用户主动开启才使用。询问时要告诉用户：这份列表没有许可证，只在扫描时在这台电脑上实时读取，项目从不打包、缓存或再分发其中内容。用户同意后，用用户确认过的链接保存 `profile set --key sources.simplify --value '{"enabled":true,"url":"<列表 JSON 的 https 链接>"}'`。
- 第 1 轮完成且至少设置了上面一种来源之前，`profile status --json` 会把扫描就绪状态报告为 incomplete。

## 岗位扫描定时任务

每日岗位扫描是可选的，只有用户在第 4 轮同意后才创建。它不能和 `mail-sync`、`deadline-review` 共用一个任务：那个共享的 Codex heartbeat 或 Claude Code 定时任务固定在 20:00 和 20:15 运行，`register-external` 也会拒绝把其他任务登记到它的 ID 上。要为 `role-scan` 单独创建一个定时任务，按检测到的时区在 `pace.scanTime` 运行：

1. 运行 `automation configure --task role-scan --enabled`；时间取自 `pace.scanTime`
2. 另建一个每日任务：在 Codex 中再建一个 heartbeat，例如 `FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0`；在 Claude Code 桌面版中再建一个定时任务，使用自己的任务 ID（例如 `career-journal-role-scan`），cron 按本地时间写成 `0 8 * * *`
3. 用 `automation register-external --task role-scan --driver codex|claude-code --external-id <它自己的 ID>` 登记这个任务的 ID，把返回的命令原样单独放在该任务 prompt 的一行中并写明时区，运行 `automation verify --task role-scan`，再触发一次

`doctor` 从不要求 `role-scan`；用户不需要时，核心配置依然完整。

## 请求路由

- Application、事件、截止日期、状态或 Dashboard：使用 CLI
- 在线测评、编程测试或面试邀请：用 `task add` 记录，带上邮件里的截止时间（`--due-at`，须含时区偏移；`--due-note` 写明如何推算）和邀请链接（`--link`）；完成后用 `task done` 标记
- 找岗位、看新岗位或每日岗位扫描：运行 `scan run`（加 `--dry-run` 只预览、不写入），逐个阅读新岗位的官网原文，再用 `queue verify --id <application> --result ok|skip --reason <原因> [--deadline <iso>]` 记录；每个“不投”都要写原因。`queue list` 按顺序显示队列。默认来源是用户关注的公司在官方招聘系统上的公开岗位接口；SimplifyJobs 和 CareerOps 来源需用户自己开启。`profile status --json` 报告没有扫描来源时，先按“扫描来源”把用户的公司对应到职位板
- 投递、开始投、填申请表：读取 `career-journal-apply` Skill。它要求个人资料第 1、2 轮已完成，只在用户自己的浏览器里填表，并在每次提交前停下
- 个人资料、偏好或表单答案：使用 `profile show|questions|set|answer|status`。资料文件放在 `<home>/.career-journal/profile/`（`profile.json`、`answers.md`），不进仓库
- Resume 或 Cover Letter：读取 `careerops-materials`；经验证的生成流程需要 CareerOps、内置规则和个人规则
- 渲染后的 PDF 检查：宿主支持时使用 PDF 能力
- DOCX 工作：宿主支持时使用 Documents 能力
- Email：Agent 模式不做关键词预筛，读取每个选中邮箱过去完整 24 小时的全部邮件，再使用 `email verify-host` 和 `email sync-host`；独立模式使用 IMAPS；手动 EML 仅为一次性备用方式
- 定时检查：创建真实宿主 automation，用 `automation register-external` 记录，以相同外部 ID 触发，并通过 `doctor` 验证
- 跨项目长期知识：仅在用户请求时使用宿主 Wiki 能力
- Jev：启用后先判断过去 24 小时批次中的每一封邮件；无法给出可用结果时依次使用已配置的大语言模型、本地规则和人工复核

CareerOps 是由 Santiago Fernández de Valderrama 独立维护、使用 MIT 许可证的 [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops) 项目。CAREER JOURNAL 通过仓库内 `careerops-materials` 适配器处理材料任务，并保留上游署名。TypeSafe Agent Skill 由 [TypeSafe AI](https://github.com/typesafe-ai/skills) 独立维护并采用 MIT 许可证，用于指导 Jev 集成，但源代码没有复制进本仓库。没有启用 Jev 时，Agent 模式由当前 Agent 判断邮件；独立模式可以使用已配置的大语言模型，本地规则和人工复核负责最后兜底。

## 证据规则

追加事件，不覆盖历史。区分观察时间、发生时间和记录时间；不知道发生时间时使用 `occurred_at = null`。用户报告已提交，可为一个无歧义 Application 支持一条状态事件，但不能证明具体提交了哪个 Artifact。如果多个岗位可能匹配，必须取得 Application ID。生成文件保持 draft，直到准确上传文件被记录。不得因长期无回复推断拒绝，也不得把招聘营销邮件当成进展。

## 能力失败

说明失败的检查以及仍未验证的内容。邮件批次失败后保留上一次成功游标。不得虚构成功的邮箱、automation、CareerOps、渲染文件或 Jev 结果。

## 发布规范

使用 Semantic Versioning（SemVer）。只有 CLI 元数据和 CHANGELOG 使用同一版本、不可变 Git tag 与 GitHub Release 已存在，并且发布标签通过远端 fresh-clone 测试和文档规定的上一版本升级测试后，公共版本才算完成。不得把未推送 commit 或有未提交修改的本地目录描述为已发布。

## 旧版本升级兼容性

`jobops`、`.jobops/` 和 `jobops-adapter.mjs` 仅用于 v0.1.0-alpha.5 或更早版本升级。保留旧调度器身份；新工作区使用 CAREER JOURNAL 名称。
