# CAREER JOURNAL

[English](SKILL.md) | [简体中文](SKILL.zh-CN.md)

让求职事实、证据和材料保持可审计。首次配置只要求两个每日任务：`mail-sync` 和 `deadline-review`。只有在用户明确选择的一个只读邮箱完成首次同步、这两个任务真实注册到宿主调度器、都存在一次与各自外部 ID 匹配的已观察运行，并且 `career-journal doctor` 通过后，新的工作区才算配置完成。

## 首次使用契约

1. 向用户取得准确邮箱地址。不得推测学校、工作或个人邮箱。Provider 允许时优先使用内置实时 IMAPS 路径。App password 或 Provider 凭据只能保存在 secret 环境变量中。IMAPS 不可用时，宿主管理的 Connector 可以只读导入邮件，但其 JSON 属于自我声明；在独立实时验证适配器可用前，onboarding 仍未完成。不得用手动 EML 替代实时验证。
2. 询问用户是否已获得 TypeSafe 权限。如已获得，只询问保存 Jev Key 的环境变量名称，并增加 `--jev-secret-ref env:<VARIABLE>`；不得询问或保存真实密钥。修改问题或阈值前，必须读取官方 [TypeSafe Agent Skill](https://github.com/typesafe-ai/skills/tree/main/skills/typesafe-ai) 和最新 API 文档。如果没有 TypeSafe 权限，询问 OpenAI-compatible 服务的 base URL、模型名和保存 API Key 的环境变量名称，再配置大语言模型回退。不得要求用户粘贴真实 Key。
3. 在克隆目录中运行 `node ./bin/career-journal.mjs setup --home <absolute-home> --email-provider imap --email-address <address> --imap-host <host> --imap-user <username> --secret-ref env:<VARIABLE>`，并根据用户情况增加 `--jev-secret-ref env:<JEV_VARIABLE>`，或增加 `--model-provider openai-compatible --model-base-url <url> --model-name <model> --model-secret-ref env:<MODEL_VARIABLE>`。除非用户明确覆盖，否则使用当前电脑检测到的 IANA 时区。不得使用保留的示例邮箱。仓库命令应使用 `node ./bin/career-journal.mjs ...` 或 `./career-journal ...`；不要假设全局 `career-journal` 命令已存在。
4. 运行 `node ./bin/career-journal.mjs email verify-imap --home <absolute-home> --account imap:<address>`。如实报告认证或邮箱错误，不能用 Connector JSON 替代。
5. 使用宿主自动化能力，在同一时区真实创建两个 ACTIVE 每日任务：20:00 `mail-sync` 和 20:15 `deadline-review`。在 Codex Desktop 中使用 `automation_update`，不得手写 `automation.toml`。如果已有匹配任务，不得创建第二套。首次配置不得创建 `daily-consolidation`，也不得安排每日 `local-backup`。
6. 每个 Codex heartbeat 返回 ID 后，运行 `node ./bin/career-journal.mjs automation register-external --home <absolute-home> --task <task> --driver codex --external-id <real-id>`。从 JSON 结果读取 `codexCommandLine`，更新同一个 heartbeat，将该命令原样作为独立一行放入 prompt，并写明检测到的 IANA 时区。不得重构命令，也不得把任何 secret 值写入 prompt。邮件 heartbeat 的宿主环境必须安全提供邮箱、Jev 或大语言模型 secret 引用指定的变量。
7. 对每个任务运行 `node ./bin/career-journal.mjs automation verify --home <absolute-home> --task <task>`。验证必须读取实际保存的调度定义，并核对 ACTIVE 状态、计划、时区、可执行文件、CLI、任务 ID、数据目录和外部 ID。注册声明、生成文件、截图、占位 ID 或相似命令都不算验证。
8. 使用准确的 `codexCommandLine` 分别触发两个已验证任务。首次 IMAPS 同步可以没有相关新邮件。直接同步会刷新邮箱验证，且只有在本地证据全部提交后才推进 UID 游标。
9. 运行 `node ./bin/career-journal.mjs doctor --home <absolute-home>`；只有邮箱和自动化都通过才结束配置。邮箱 PASS 要求过去 36 小时内有实时 IMAPS 验证和一次成功的只读同步。自动化 PASS 要求两个必需任务都有一次实时调度器探测，以及同一窗口内一次与外部 ID 匹配的成功运行。
10. 技术配置通过后，询问用户是否需要导入历史投递。用户可以选择限定范围的只读邮箱检查、文件或表格导入、简短问答，也可以跳过。先整理候选记录，得到用户确认后再写入；存在外部申请编号时优先按编号去重，否则按公司和岗位去重。不得推测缺失的投递日期、状态、拒绝原因或实际提交材料，未知字段保持为空，也不能把旧的简历草稿当成实际提交版本。

对于 API 或仅 CLI 的宿主，`automation install` 可以通过 launchd、cron 或 Windows Task Scheduler 安装并探测 `deadline-review`。当前 alpha 有意阻止原生安装 `mail-sync`，因为生成的定义没有安全的跨平台 secret provider。应使用能够注入被引用环境变量的可信外部调度器，再通过相同门禁进行注册、验证和运行。本地备份是可选的按需操作，只在用户要求时运行 `backup create`，不属于每日必需任务。

手动 EML 只是一次性备用方式，不能替代每日访问或满足 setup。不得在配置、批次、记录、日志、导出或 prompt 中保存邮箱凭据或字面 secret。

## 请求路由

- Application、事件、截止日期、状态或 Dashboard：使用 CLI
- Resume 或 Cover Letter：读取 `careerops-materials`；经验证的生成流程需要 CareerOps、内置规则和个人规则
- 渲染后的 PDF 检查：宿主支持时使用 PDF 能力
- DOCX 工作：宿主支持时使用 Documents 能力
- Email：使用实时 IMAPS 和已验证的 `career-journal-mail-sync` 命令；宿主 `email sync-host` 批次只用于导入且属于自我声明，手动 EML 仅为一次性 fallback
- 定时检查：创建真实宿主 automation，用 `automation register-external` 记录，以相同外部 ID 触发，并通过 `doctor` 验证
- 跨项目长期知识：仅在用户请求时使用宿主 Wiki 能力
- Jev：配置权限后作为主要语义分类器；先执行明确的固定规则，再验证类型化输出。没有 Jev，或者 Jev 不可用、处于 `shadow` 模式、格式错误、结果未知或置信度不足时，自动改用已配置的大语言模型；两者都无法可靠判断时进入人工复核

CareerOps 是由 Santiago Fernández de Valderrama 独立维护、使用 MIT 许可证的 [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops) 项目。CAREER JOURNAL 通过仓库内 `careerops-materials` 适配器路由材料任务，并且必须保留上游署名。TypeSafe Agent Skill 由 [TypeSafe AI](https://github.com/typesafe-ai/skills) 独立维护并采用 MIT 许可证，用于指导 Jev 集成，但源代码没有复制进本仓库。未配置 Jev 时仍可使用已配置的大语言模型判断语义模糊的邮件；人工复核是最终回退。

## 证据规则

追加事件，不覆盖历史。区分观察时间、发生时间和记录时间；不知道发生时间时使用 `occurred_at = null`。用户报告已提交，可为一个无歧义 Application 支持一条状态事件，但不能证明具体提交了哪个 Artifact。如果多个岗位可能匹配，必须取得 Application ID。生成文件保持 draft，直到准确上传文件被记录。不得因长期无回复推断拒绝，也不得把招聘营销邮件当成进展。

## 能力失败

说明失败的检查以及仍未验证的内容。邮件批次失败后保留上一次成功游标。不得虚构成功的邮箱、automation、CareerOps、渲染文件或 Jev 结果。

## 发布规范

使用 Semantic Versioning（SemVer）。只有 CLI 元数据和 CHANGELOG 使用同一版本、不可变 Git tag 与 GitHub Release 已存在，并且发布标签通过远端 fresh-clone 测试和文档规定的上一版本升级测试后，公共版本才算完成。不得把未推送 commit 或有未提交修改的本地目录描述为已发布。

## 旧版本升级兼容性

`jobops`、`.jobops/` 和 `jobops-adapter.mjs` 仅用于 v0.1.0-alpha.5 或更早版本升级。保留旧调度器身份；新工作区使用 CAREER JOURNAL 名称。
