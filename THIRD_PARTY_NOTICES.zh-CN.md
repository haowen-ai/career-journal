# 第三方开源声明

[English](THIRD_PARTY_NOTICES.md) | [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

CAREER JOURNAL 会对它所集成的独立开源成果保留完整署名。在此列出项目不代表任何一方为另一方背书。

## career-ops

- 项目：[career-ops](https://github.com/career-ops-hq/career-ops)
- 作者与维护者：Santiago Fernández de Valderrama 及贡献者
- 许可证：MIT；原文保存于 `LICENSES/career-ops-MIT.txt`
- 在本项目中的用途：锁定版本的可选集成、申请材料路由 Skill、能力检查和适配器契约
- 商标：`career-ops` 名称和品牌受其独立商标政策管理。CAREER JOURNAL 只在说明兼容性和开源归属时使用该名称

本仓库没有复制 career-ops 的源代码。只有在需要其申请材料工作流时，用户才需要单独安装它。

## TypeSafe Agent Skills 与 Jev

- 项目：[typesafe-ai/skills](https://github.com/typesafe-ai/skills)
- 作者：TypeSafe AI
- 许可证：MIT；原文保存于 `LICENSES/typesafe-ai-skills-MIT.txt`
- 在本项目中的用途：用户配置权限后，用该 Agent Skill 指导主要 Jev 语义决策适配器；项目不会假设用户已经获得访问权限

本仓库没有复制 TypeSafe Agent Skill 的源代码。未配置 Jev 时仍可使用记录功能。启用 Jev 后，每封求职邮件都先交给 Jev；已配置的大语言模型、本地规则和人工复核负责后续兜底。

## 岗位扫描的数据来源

CAREER JOURNAL 2.0 的岗位扫描只在用户自己的电脑上、在扫描时为用户本人的求职读取岗位信息。项目不打包任何岗位数据，不在仓库中保存，也不再分发。只有用户保留的、整理后的职位线索会写入用户自己的本地数据库。

### Greenhouse、Lever 与 Ashby 公开职位接口（默认）

- 接口：`boards-api.greenhouse.io`、`api.lever.co` 和 `api.ashbyhq.com` 的公开职位板接口
- 在本项目中的用途：只读、无需登录地读取用户在个人资料中列出的公司职位板。不会向这些服务提交任何内容，也不会再分发职位数据
- 商标：Greenhouse、Lever 和 Ashby 是其各自所有者的商标，本项目仅在说明兼容性时使用这些名称。这些厂商与本项目无关，也不为本项目背书

### SimplifyJobs 职位列表（用户自选开启）

- 项目：[SimplifyJobs](https://github.com/SimplifyJobs) 公开发布的实习和应届生职位列表
- 许可证：未发布任何许可证
- 在本项目中的用途：仅作为需要用户主动开启的岗位扫描来源。默认关闭；用户在自己的个人资料中开启并填写列表地址后，扫描时才在用户自己的电脑上实时读取

本仓库不打包、不缓存、不镜像，也不再分发任何 SimplifyJobs 数据。

### CareerOps 门户扫描（用户自选开启）

CareerOps 门户扫描通过上面所述的 career-ops 集成运行，沿用其 MIT 许可证和署名；只有用户自己开启且已安装 CareerOps 时才会运行。

## Tabler Icons

- 项目：[tabler/tabler-icons](https://github.com/tabler/tabler-icons)
- 作者与维护者：Paweł Kuna 及贡献者
- 版本：3.47.0
- 许可证：MIT；原文保存于 `LICENSES/tabler-icons-MIT.txt`
- 在本项目中的用途：本地看板使用的箭头、时钟、搜索、语言切换、展开和收起 SVG 图标

所选图标保存在仓库内，因此看板无需连接 CDN 也可以正常显示。
