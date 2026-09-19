# CareerOps JSON 桥接契约

[English](careerops-bridge.md) | [简体中文](careerops-bridge.zh-CN.md)

API 模式的 CareerOps 适配器会调用用户单独安装并锁定版本的 `career-ops` checkout。Job Search Ops 不会复制 CareerOps 源代码，也不会将 CareerOps 的工作声称为自己的成果。

## 可用性

配置的 CareerOps 根目录必须包含 `jobops-adapter.mjs`。当前锁定的上游版本并未提供这个桥接，因此在用户安装兼容桥接之前，API 模式的申请材料生成不可用。Codex 原生用户仍可以直接配合 CareerOps 使用仓库内的 `careerops-materials` Skill。缺少桥接只会显示健康检查警告，不会被冒充为成功结果。

## 调用方式

Job Search Ops 运行：

```text
node <careerops-root>/jobops-adapter.mjs material prepare|verify
```

它通过标准输入发送一个 JSON 对象。必填字段如下：

```json
{
  "action": "prepare",
  "applicationId": "stable-application-id",
  "materialKind": "resume",
  "lifecycle": "draft",
  "jdPath": "/path/to/jd.txt",
  "evidencePath": "/path/to/profile.md",
  "ruleFiles": [
    "/path/to/job-search-ops/config/material-rules/us-resume-default.md",
    "/path/to/personal-resume-skill/SKILL.md"
  ],
  "requestedOutput": "/path/to/output.pdf"
}
```

对于简历请求，`ruleFiles` 先包含 Job Search Ops 内置简历默认规则，然后才是已配置的个人规则文件。求职信请求不包含简历默认规则文件。桥接必须按顺序应用，后出现的文件优先级更高；用户当前的明确指令仍然拥有最高优先级。简历专用规则不得应用到求职信正文。

桥接必须通过标准输出返回一个 JSON 对象：

```json
{
  "ok": true,
  "applicationId": "stable-application-id",
  "lifecycle": "draft",
  "outputPath": "/path/to/output.pdf",
  "verification": "passed",
  "verificationEvidence": { "factGate": "passed", "renderedFile": "passed" }
}
```

Job Search Ops 会拒绝以下结果：输出文件不存在、应用 ID 不一致、生命周期被标记为已提交、JSON 格式错误或子进程执行失败。合法文件会在报告成功前被计算哈希，并复制到不可变的草稿材料存储区。
