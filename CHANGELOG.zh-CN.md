# 更新日志

[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

所有重要变更都记录在此。本项目遵循语义化版本。

## [尚未发布]

### 新增

- 发布 `v0.1.0-alpha.3` 公开标签的中英文 dogfood 验证记录

### 变更

- 无

### 修复

- 无

### 安全

- 无

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

[尚未发布]: https://github.com/haowenchen0811/job-search-ops/compare/v0.1.0-alpha.3...HEAD
[0.1.0-alpha.3]: https://github.com/haowenchen0811/job-search-ops/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/haowenchen0811/job-search-ops/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/haowenchen0811/job-search-ops/releases/tag/v0.1.0-alpha.1
