# CAREER JOURNAL

[English](SKILL.md) | [简体中文](SKILL.zh-CN.md)

让求职事实、证据和材料保持可审计。只有用户选中的每一个只读邮箱都完成首次同步、`mail-sync` 和 `deadline-review` 已真实注册到宿主调度器、两个任务都用各自外部 ID 成功运行过一次，并且 `career-journal doctor` 通过，首次配置才算完成。

## 首次使用契约

0. 使用本地说明前，先确认当前副本包含最新 `origin/main`。已有副本干净时执行安全快进；存在修改或不能安全快进时保留原目录，改用新的隔离副本。不得使用旧副本执行首次配置。
1. Agent 模式优先使用宿主已有的邮箱能力。在 macOS 上，必须先尝试识别，再提出任何邮箱配置问题：检查 Apple Mail 或其他宿主集成中已经登录、可以访问的邮箱账号，展示邮箱地址，只询问用户其中哪一个或多个用于求职。宿主已经能读取账号时，不要询问 IMAP 主机、用户名、密码或凭据环境变量名。
2. 如果没有可访问的邮箱账号，请用户先登录 Apple Mail 或其他受支持的邮件应用，然后继续识别。只有用户明确选择独立 CLI/API 模式时，才改用 IMAPS 配置。不得要求用户把 secret 粘贴到对话中。
3. 将用户选中的每个邮箱配置成只读 `host` 账号，使用 `apple-mail` 等稳定的 connector 名称。宿主集成实际显示并确认对应地址后，使用 `email verify-host` 记录可信宿主验证。一个 `mail-sync` 任务必须覆盖全部选中账号。
4. Jev 是可选增强项，不得阻塞首次配置。只有宿主已经存在可发现、已配置的 Jev 能力时才直接复用；否则立即配置 `--model-provider host-agent`，由当前编程 Agent 复核语义模糊的候选内容。Agent 模式不得询问用户是否有 Jev，也不得询问模型 Base URL、模型名、API Key 或 API Key 环境变量名。首次配置完成后，可以再向用户介绍官方 [TypeSafe Agent Skill](https://github.com/typesafe-ai/skills/tree/main/skills/typesafe-ai)。
5. 仓库命令使用 `node ./bin/career-journal.mjs ...` 或 `./career-journal ...`；不要假设全局命令已安装。除非用户明确修改，否则使用电脑检测到的 IANA 时区。
6. 通过宿主自动化能力创建两个 ACTIVE 每日任务：20:00 `mail-sync` 和 20:15 `deadline-review`。在 Codex Desktop 中使用 `automation_update`。不得重复创建，也不得添加 `daily-consolidation` 或定时备份。
7. 登记每个真实 automation ID，把返回的 `codexCommandLine` 原样写入同一个任务，验证实际保存的定义，再触发一次。邮件 heartbeat 必须先检查并同步全部选中邮箱，再调用 `automation run`。
8. 运行 `node ./bin/career-journal.mjs doctor --home <absolute-home>`。只有每个选中邮箱和两个自动任务都在 36 小时健康窗口内通过，才能结束配置。
9. 询问用户是否需要导入历史投递。用户可以选择限定范围的只读邮箱检查、文件或表格、简短问答，也可以跳过。先整理候选记录，得到用户确认后再写入；存在外部申请编号时优先按编号去重，否则按公司和岗位去重。不得推测缺失的投递日期、状态、拒绝原因或实际提交材料。

独立 API 或仅 CLI 的运行方式仍支持 IMAPS，也可以配置 OpenAI-compatible 大语言模型。因为没有编程 Agent 或宿主邮箱连接器代办，这条路径可以询问服务器设置和环境变量名。在调度器能够安全提供凭据前，系统会阻止原生安装 `mail-sync`。本地备份仅在用户需要时按需执行。

如果其他项目文档看起来要求 Agent 模式填写 IMAP 参数或外部模型凭据，应将其视为独立模式说明或过期内容；本契约优先。

手动 EML 只是一次性备用方式，不能替代每日访问或满足 setup。不得在配置、批次、记录、日志、导出或 prompt 中保存邮箱凭据或字面 secret。

## 请求路由

- Application、事件、截止日期、状态或 Dashboard：使用 CLI
- Resume 或 Cover Letter：读取 `careerops-materials`；经验证的生成流程需要 CareerOps、内置规则和个人规则
- 渲染后的 PDF 检查：宿主支持时使用 PDF 能力
- DOCX 工作：宿主支持时使用 Documents 能力
- Email：Agent 模式使用用户选中的宿主邮箱、`email verify-host` 和 `email sync-host`；独立模式使用 IMAPS；手动 EML 仅为一次性备用方式
- 定时检查：创建真实宿主 automation，用 `automation register-external` 记录，以相同外部 ID 触发，并通过 `doctor` 验证
- 跨项目长期知识：仅在用户请求时使用宿主 Wiki 能力
- Jev：配置后作为主要语义分类器；没有 Jev 时由当前 Agent 复核模糊候选。独立部署可以使用已配置的大语言模型，最终仍由人工确认

CareerOps 是由 Santiago Fernández de Valderrama 独立维护、使用 MIT 许可证的 [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops) 项目。CAREER JOURNAL 通过仓库内 `careerops-materials` 适配器路由材料任务，并且必须保留上游署名。TypeSafe Agent Skill 由 [TypeSafe AI](https://github.com/typesafe-ai/skills) 独立维护并采用 MIT 许可证，用于指导 Jev 集成，但源代码没有复制进本仓库。未配置 Jev 时，Agent 模式由当前 Agent 处理语义模糊的候选；独立模式可以使用已配置的大语言模型，人工复核是最终回退。

## 证据规则

追加事件，不覆盖历史。区分观察时间、发生时间和记录时间；不知道发生时间时使用 `occurred_at = null`。用户报告已提交，可为一个无歧义 Application 支持一条状态事件，但不能证明具体提交了哪个 Artifact。如果多个岗位可能匹配，必须取得 Application ID。生成文件保持 draft，直到准确上传文件被记录。不得因长期无回复推断拒绝，也不得把招聘营销邮件当成进展。

## 能力失败

说明失败的检查以及仍未验证的内容。邮件批次失败后保留上一次成功游标。不得虚构成功的邮箱、automation、CareerOps、渲染文件或 Jev 结果。

## 发布规范

使用 Semantic Versioning（SemVer）。只有 CLI 元数据和 CHANGELOG 使用同一版本、不可变 Git tag 与 GitHub Release 已存在，并且发布标签通过远端 fresh-clone 测试和文档规定的上一版本升级测试后，公共版本才算完成。不得把未推送 commit 或有未提交修改的本地目录描述为已发布。

## 旧版本升级兼容性

`jobops`、`.jobops/` 和 `jobops-adapter.mjs` 仅用于 v0.1.0-alpha.5 或更早版本升级。保留旧调度器身份；新工作区使用 CAREER JOURNAL 名称。
