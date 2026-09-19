# 更新日志

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

所有重要变更都记录在此。本项目遵循语义化版本。

## [尚未发布]

### 新增

- 无

### 变更

- 无

### 修复

- 无

### 安全

- 无

## [0.1.0-alpha.8] - 2026-09-19

### 新增

- 无

### 变更

- 上一版本升级 smoke 在 alpha.6 及更新工作区中改为创建合法的合成只读邮箱配置
- 升级门禁会自动识别并保留当前 CAREER JOURNAL 标识或旧 Job Search Ops 标识

### 修复

- 修复 alpha.6 升级到当前版本时仍传入已删除的 `--skip-email` 选项，导致尚未测试迁移就立即失败的问题
- 去除跨版本 smoke 中对 `.jobops`、`jobops-local-backup` 和 `jobops.db` 的硬编码假设

### 安全

- 合成升级测试数据只保存环境变量引用，不会连接任何邮箱

## [0.1.0-alpha.7] - 2026-09-19

### 新增

- 增加 `--jev-secret-ref env:VARIABLE` 配置方式，不保存字面 API Key 即可启用 Jev
- 增加 TypeSafe v1 请求、Choice 响应、格式错误、低置信度、凭据缺失、临时过载和非可信端点的契约测试
- 根据官方 TypeSafe Agent Skill 与最新 API 文档，增加中英文 Jev 配置和架构说明

### 变更

- Jev 成为模糊招聘邮件的主要语义分类器；明确场景继续先走确定性规则
- Jev 不可用、shadow、格式错误或低于阈值时进入人工复核，不再回退通用大模型
- 将招聘邮件的 Choice 问题和 criteria 集中到一个位置，便于审核与校准

### 修复

- 用 v1 `state`、`model`、`questions` 契约替换过期的 `question` 与 `choices` 请求结构
- 正确读取 `answers.classification.choice` 和 `confidence`，不再把整个回答对象误当分类结果
- 对官方说明的 HTTP 429 与 529 增加有限重试，认证失败不重试

### 安全

- Jev 凭据仅允许 `env:VARIABLE` 引用，并将携带凭据的请求固定到 `https://api.typesafe.ai/v1/systemone`
- 字面 API Key 不进入配置、日志、示例、导出、备份或 Git

## [0.1.0-alpha.6] - 2026-09-19

### 新增

- 增加 `career-journal`，作为主 CLI、仓库 Skill、启动器、包命令和全新安装标识
- 增加旧 `.jobops` 工作区、`jobops-*` 自动化和 `jobops` CLI 别名的升级验证
- 增加可复现的合成看板数据脚本，并使用 SHA-256 清单校验发布截图
- 增加有大小限制的宿主邮件批次导入，支持确定性岗位匹配、去重、独立游标和安全重试
- 增加内置 IMAPS 客户端，通过证书校验完成真实账号验证，并以 `EXAMINE` / `BODY.PEEK[]` 只读同步
- 增加直接执行的 `email verify-imap` 和 `email sync-imap` 命令
- 增加 Codex heartbeat、launchd、cron 和 Windows Task Scheduler 的实时探测，以及四项每日任务的匹配外部运行证据
- 增加成对的英文与简体中文编排 Skill 和产品需求文档，并用发布检查约束两种语言的核心契约

### 变更

- GitHub 仓库和标准包信息统一改为 CAREER JOURNAL 与 `career-journal`
- 新工作区的配置、数据、材料、备份和调度定义统一存放在 `.career-journal/`
- 新工作区使用 `career-journal-*`、`io.career-journal.*` 和 `CareerJournal-*` 调度标识；升级任务继续使用原有平台标识
- 产品截图改用容易识别的大厂演示记录，每家公司都明确标注 `Demo`，编号统一使用 `DEMO-*`
- 完成初始化现在必须由用户明确选择只读求职邮箱，并在过去 36 小时内成功同步一次，且四项每日任务都有与宿主注册 ID 匹配的成功运行
- 手动 EML 导入保留为单次备用方式，但不再满足每日邮箱健康检查
- 重新运行 setup 会保留用户自定义时间、通知策略、启用状态和仍有效的注册信息，除非用户明确修改
- 备份现在保留明确的材料元数据索引，并默认不复制材料原文件
- 邮箱初始化只有在实时 IMAPS 验证和有效期内的成功只读同步都完成后才会通过；宿主连接器 JSON 仍然只是可导入的自我声明

### 修复

- 防止新目录静默遮蔽有效旧工作区；新旧配置同时存在时明确报告冲突
- 重新配置旧自动化时继续使用原 ID，避免升级后出现重复定时任务
- 新安装优先使用 `career-journal-adapter.mjs`，并为已经公开的 CareerOps `jobops-adapter.mjs` 桥接保留回退兼容
- Doctor 不再把邮箱地址、手动 EML 导入或生成调度定义视为每日流程已经可用的证据
- 修改邮箱连接器或任务时间后，旧验证会失效，直到同步或外部任务登记再次成功
- 将 `mail-sync` 重新绑定到其他邮箱时会清除旧游标和执行健康状态，onboarding 状态只反映当前绑定的邮箱
- setup、doctor 和普通运行命令只报告旧数据库待迁移项，不会静默修改现有数据库
- migration dry-run 现在以只读方式检查现有数据库，不会改变 journal mode
- 宿主邮件批次会拒绝过期游标、乱序获取、内容被修改的重放、账号或 connector 不匹配，以及调度 ID 不匹配
- IMAP 分页会先处理最早的一页 UID，并只推进到本页最高 UID，避免超过 200 封匹配邮件时永久跳过旧邮件
- 宿主批次的邮件证据、事件和两个游标现在使用同一事务提交；过期批次或并发失败批次不会留下部分写入
- 调度验证现在会拒绝待验证声明、命令不匹配、损坏的 cron marker block 和未经验证的外部运行
- Codex、launchd、cron 和 Windows 探测会拒绝损坏或重复的定义、额外的循环字段、额外的触发器或动作，以及不按配置的本地时间每天准确运行一次的任务
- Launchd 验证会同时核对 `launchd` 实际加载的时区与计划和磁盘 plist，避免修改但尚未重新加载的文件通过门禁
- Windows 任务创建现在使用正确的命令行转义，不会覆盖查询后由其他进程创建的同名任务；只有 CAREER JOURNAL 成功创建、随后验证失败的任务才会被删除
- 调用方提交的宿主批次不能再以 IMAPS 账号为目标，也不能建立实时邮箱健康状态；只有成功的直接 TLS 获取才能推进 IMAP 验证与同步状态
- 直接同步邮箱不再被视为已观察到的调度器运行；只有携带已验证外部 ID 的 `automation run` 才能建立这项证据
- Windows 调度器发现结果存在歧义或安装失败后的清理无法确认时，现在会直接失败
- 生成的 OS 调度命令会带已注册外部 ID；在有安全调度凭据提供器之前，系统会阻止原生安装 `mail-sync`

### 安全

- 工作区冲突检测避免本地写入分散到两个数据根目录
- 原有仅限本机环回、凭据引用和导出脱敏边界保持不变
- README 声明与截图测试明确说明示例公司不代表真实投递、结果、关联或背书
- CAREER JOURNAL 只保存宿主连接器名称和标准化证据；邮箱密码、OAuth Token、Cookie 和连接器凭据继续由宿主管理
- 邮件批次失败时邮箱与任务游标都不会推进，输入大小限制同时约束宿主同步接口
- 宿主邮箱拒绝保存凭据引用，账号列表不回显引用；备份会清除邮箱验证、同步健康状态和调度注册证明，恢复后必须重新验证
- 无密钥备份不再复制可能包含凭据或其他私密内容的任意材料文件
- 公开 setup 会拒绝保留域名和示例邮箱域名；IMAP 凭据只保存为环境变量引用，不进入配置、导出、heartbeat prompt 或备份

## [0.1.0-alpha.5] - 2026-09-19

### 新增

- 增加中英文 CAREER JOURNAL 看板，包括五项申请统计、搜索与状态组合筛选，以及可展开的时间线和材料记录
- 增加经过隐私过滤的 `/api/dashboard` 快照接口；返回申请详情时不包含材料存储路径或原始事件来源内容
- 增加由真实浏览器和临时工作区生成的产品截图，截图只使用虚构申请与材料数据
- 增加本地打包的 Tabler Icons 3.47.0 图标、上游 MIT 许可证和中英文开源归属
- 发布 `v0.1.0-alpha.4` 公开标签的中英文 dogfood 验证记录

### 变更

- 公开产品统一命名为 CAREER JOURNAL；为兼容已有安装，继续保留 `jobops` 命令名
- 友好的本地看板地址改为 `http://career-journal.localhost:<port>`
- 看板首次打开时使用浏览器语言，保存用户显式选择的中文或英文，并按照最新记录时间排序申请
- 中英文 README 改为展示真实响应式申请界面，不再使用绘制的示意图

### 修复

- 用经过个人看板验证的信息层级替换独立开发的极简公开页面：统计、搜索、筛选、申请事实、建议下一步、事件历史和材料生命周期保持一致
- 修复本地数据库已有时间线和材料记录、公开看板却无法查看的问题

### 安全

- 事件来源在进入浏览器前缩减为受控类别，材料存储路径继续保持私有
- 提交到仓库的产品截图只包含虚构公司、岗位、日期、编号、事件和文件名
- 服务继续只监听环回地址；除标准环回名称外，仅接受准确的 `career-journal.localhost` Host 和 Origin

## [0.1.0-alpha.4] - 2026-09-19

### 新增

- 增加保留域名 `job-search-ops.localhost`，无需配置 DNS 或修改 hosts 文件
- 增加友好看板地址、匹配的 Origin hostname 和有效 IPv6 环回 URL 格式的集成测试
- 发布 `v0.1.0-alpha.3` 公开标签的中英文 dogfood 验证记录

### 变更

- `jobops start` 默认输出和公开入门文档现在使用 `http://job-search-ops.localhost:<port>`，不再向用户展示原始环回 IP
- 产品界面预览改为显示友好的本地地址

### 修复

- 在新用户体验中以易读的本地产品地址取代面向开发者的 `127.0.0.1`

### 安全

- 服务仍然只监听环回接口；Host 和 Origin 仅允许原有环回地址以及准确的 `job-search-ops.localhost`

## [0.1.0-alpha.3] - 2026-09-19

### 新增

- 增加使用虚构申请数据的界面预览，并为 SVG 提供无障碍标题和说明
- 在中英文 README 中增加产品能力、核心工作流和适用人群章节
- 增加发布门禁，强制 README 保持产品优先顺序并包含界面预览
- 发布 `v0.1.0-alpha.2` 公开标签的中英文 dogfood 验证记录

### 变更

- 重组中英文 README 首页，让访客在安装说明前先理解产品并看到实际界面

### 修复

- 将安装优先的首页改为产品展示型项目介绍

### 安全

- 公开界面图只包含虚构公司、岗位、日期和状态

## [0.1.0-alpha.2] - 2026-09-19

### 新增

- 完整的简体中文快速开始、开源归属、CareerOps 桥接和内置简历规则文档，并提供中英文切换入口
- 将项目作者的实际简历流程整理为可复用的美国英文简历默认规则，包括 Education → Experience → Skills 结构和最终 PDF 审核
- 通过 `--material-rules` 支持叠加个人 Skill 或规则文件
- 发布 `v0.1.0-alpha.1` 的 dogfood 验证记录

### 变更

- 首次 setup 会从电脑读取时区并完成验证；每日自动化在没有显式覆盖时继承工作区已保存的时区
- CareerOps 材料请求现在先接收内置默认规则，再接收用户已配置的个人规则文件
- 公开贡献模板现在同时提供英文和简体中文提示

### 修复

- 从新用户 setup 和自动化示例中移除了开发者专属的芝加哥时区
- 当公开中英文配对文档或简历规则缺失时，发布检查会直接失败

### 安全

- 个人规则以显式文件引用保存；公开默认规则不包含候选人联系方式、教育信息或凭据

## [0.1.0-alpha.1] - 2026-09-19

### 新增

- 本地 SQLite 申请、事件、材料、邮件、自动化和决策记录
- 只监听环回地址的看板和 JSON API
- 只读 EML 手动导入、去重和身份验证链接脱敏
- macOS、Linux 和 Windows 的可移植每日任务定义
- OpenAI-compatible 结构化 provider、确定性规则以及可选 Jev shadow/active 适配器
- 仓库内的 Job Search Ops 和 CareerOps 材料 Skill
- 开源归属、发布检查和已测试的入门文档

### 变更

- 无；这是第一个公开 alpha

### 修复

- 升级 dogfood 在切换到旧版本之前先解析目标版本，避免 `HEAD` 停留在旧 commit
- 迁移失败或数据库锁定时不再替换正在使用的 SQLite 文件
- 拒绝跨域、非法 Host 和非 JSON 的本地 API 写操作
- 不可用的自动化处理器不再记录伪成功，local-backup 会实际生成备份
- 可检测相同 Message-ID 下的内容冲突，决策和事件写入保持原子性
- 事件命令重试会保留导入时间戳，文档中的命令别名可正常工作
- 重复 setup 会保留现有时区，除非用户显式替换
- doctor 会区分已配置与真正可用的模型、邮箱、Jev、存储和 CareerOps 能力
- 备份保留安全的环境变量引用，但不包含密钥值
- CareerOps 材料输出必须存在、匹配申请，并与验证状态一起归档

### 安全

- 凭据通过环境变量引用，不会进入导出文件
- 标记已提交材料时需要用户明确确认

[尚未发布]: https://github.com/haowenchen0811/career-journal/compare/v0.1.0-alpha.8...HEAD
[0.1.0-alpha.8]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.8
[0.1.0-alpha.7]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.7
[0.1.0-alpha.6]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/haowenchen0811/career-journal/releases/tag/v0.1.0-alpha.1
