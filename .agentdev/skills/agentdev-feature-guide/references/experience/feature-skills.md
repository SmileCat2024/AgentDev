# Feature 自带 Skills

## 目录

- [职责边界](#职责边界)
- [目录与发现](#目录与发现)
- [内容设计](#内容设计)
- [命名与冲突](#命名与冲突)
- [构建交付](#构建交付)
- [验证](#验证)

## 职责边界

工具描述解释单个工具。Feature skill 解释跨工具工作流：

- 工具调用顺序；
- 先读后写规则；
- 批量上限；
- 确认和安全条件；
- 并发与独占限制；
- 失败恢复和重试；
- 领域术语与结果解释。

不要把工具 schema 全量复制到 skill。工具自身仍是参数契约的唯一来源。

## 目录与发现

```text
my-feature/
├── src/index.ts
├── skills/
│   └── manage-items/
│       ├── SKILL.md
│       └── references/
└── dist/
    ├── index.js
    └── skills/manage-items/
```

设置 `feature.source`。框架按以下位置发现：

1. `source` 文件同级的 `skills/`；
2. `getPackageInfo().root/skills/`。

收集发生在 Feature 初始化前，并交给名称为 `skill` 的 Feature。未挂载 SkillFeature 时，技能无法注入 Agent。

## 内容设计

`SKILL.md` frontmatter：

```yaml
---
name: manage-items
description: 使用 item_* 工具查询、创建和更新条目。用于处理条目检索、批量修改、冲突恢复和归档工作流。
---
```

正文优先包含：

1. 工作流入口；
2. 工具选择表；
3. 必须遵守的顺序；
4. 写操作前置条件；
5. 常见错误恢复；
6. 完成检查。

将大段领域参考放入该 skill 自己的 `references/`，保持入口短且能路由。

## 命名与冲突

技能名稳定且具有领域前缀。工作区中的同名 skill 优先于 Feature 自带 skill，因此：

- 不使用 `help`、`tools`、`guide` 等通用名称；
- 记录期望覆盖行为；
- 测试工作区覆盖不会破坏 Feature 基础安全；
- 安全不变量保留在工具和 hooks，不能只写在 skill 中。

## 构建交付

TypeScript 构建不会复制 `skills/`。构建脚本必须递归复制全部文件到发布产物，并在 `package.json.files` 中包含。

验证打包结果：

```text
npm pack
→ 解包 tgz
→ 检查 dist/skills/**/SKILL.md
→ 从构建后的 Feature source 启动 Agent
→ 确认 skill 可发现
```

## 验证

- frontmatter 名称和描述有效；
- 描述覆盖真实触发场景；
- 工具名全部存在；
- 工作流顺序与工具副作用一致；
- 错误恢复可执行；
- 工作区同名覆盖行为明确；
- `source` 和 package root 正确；
- `dist/skills/` 与源码一致；
- 未挂载 SkillFeature 时有明确诊断信息。
