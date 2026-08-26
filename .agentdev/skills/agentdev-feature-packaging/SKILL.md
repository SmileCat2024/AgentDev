---
name: agentdev-feature-packaging
description: AgentDev 独立 Feature npm 包的构建、资源复制、打包（npm pack）、tgz 内容验证与同步到 AgentDevClaw 消费端的完整规范。覆盖双路径 feature 两侧同步、构建产物完整性检查、integrity hash 处理与消费验证。修改 packages/* 下的 feature、发布 tgz、或排查"tgz 安装后行为与源码不一致"问题时必读。
---

# AgentDev Feature 打包与交付规范

独立 Feature 包（`packages/<name>-feature/`）从源码到被 AgentDevClaw 消费，要走完五步：**构建 → 打包 → 验证 → 同步 → 重装**。任何一步偷懒都会产生"源码明明改了但运行时没生效"或"资源文件丢失"的隐蔽故障。

## 构建链的两个事实

1. `tsup` 只编译 TypeScript，**不复制** mp3、模板、skills 等静态资源。每个包的 `npm run build` = `tsup && node scripts/copy-assets.mjs`，两步共同产出完整的 `dist/`。
2. `npm pack` 按文件实际存在情况打包，**空目录不会进入 tgz**。因此构建产物里缺失的资源，打包后无法找回。

由此推出两条强制规范：

- **构建只用 `npm run build`**，不要用裸 `npx tsup` 替代（它会跳过 copy-assets，产出缺资源的 dist）；
- **打包后必须用 `tar tzf` 核对产物清单**，交付前确认资源目录齐全且非空。

## 包结构与构建链

```
packages/<name>-feature/
├── package.json        # files 字段决定 tgz 包含什么（通常 ["dist", "README.md"]）
├── tsup.config.ts      # 编译配置（通常内嵌在 package.json 的 tsup 字段）
├── scripts/copy-assets.mjs  # 把 src/ 下的非 TS 资源复制到 dist/
├── src/
│   ├── index.ts        # Feature 实现
│   ├── media/          # 静态资源（mp3/图片等，按扩展名被 copy-assets 复制）
│   └── templates/      # .render.js 模板
└── dist/               # 构建产物（tsup 编译 + copy-assets 复制）
```

标准构建命令（在包目录内）：

```bash
cd packages/<name>-feature
npm run build     # tsup 编译 + copy-assets 复制资源，缺一不可
npm pack          # 生成 agentdev-<name>-feature-<version>.tgz
```

copy-assets 按扩展名白名单复制：音频（.mp3/.wav/.ogg/.flac）、图片、.json、脚本（.py/.sh）、文档、配置、.html/.css、.wasm/.bin 等。新增资源类型时先确认扩展名在 `scripts/copy-assets.mjs` 的 `ASSET_EXTENSIONS` 白名单内，不在就先加白名单。

## 打包后验证（强制，不可跳过）

```bash
tar tzf agentdev-<name>-feature-<version>.tgz
```

逐项核对：

1. `package/dist/index.js` 存在；
2. **src/ 下有哪些资源目录（media/、templates/、skills/），dist/ 下就必须有对应目录且非空**；
3. 文件总数与预期一致（对比上次打包的清单）。

对于含二进制资源的包，额外验证文件大小：

```bash
tar tzvf agentdev-<name>-feature-<version>.tgz | grep media
# 资源文件应显示真实字节数，缺失即为打包不完整
```

## 双路径 feature：两侧都要改、都要构建

同一 feature 可能同时存在于两个位置：

| 位置 | 角色 | 消费方式 |
|---|---|---|
| `packages/<name>-feature/` | 独立 npm 包源码 | `npm pack` → tgz → Claw 以 `@agentdevjs/<name>-feature` 安装 |
| `src/features/<name>/` | 框架内部副本 | 被 tsup bundle 进框架 dist，随 `agentdev` npm 包发布 |

当前已知双路径 feature：`shell`、`audit`、`audio-feedback`、`memory`、`qqbot`、`tts`、`visual`、`websearch`、`plugin-compat`。

修改双路径 feature 时的完整动作：

1. 改 `packages/<name>-feature/src/`；
2. 同步改 `src/features/<name>/`（import 路径不同：包内从 `'agentdev'` 导入，框架副本从 `'../../core/*.js'` 相对导入，注意适配）；
3. `cd packages/<name>-feature && npm run build && npm pack`；
4. `cd <AgentDev 仓库根> && npm run build`（重建框架 dist）；
5. 按下节同步 tgz 到 Claw。

只改一侧 = 有一条消费路径吃旧代码。只构建一侧 = 同上。

## 同步到 AgentDevClaw

tgz 不是交付终点。Claw 通过 `file:resources/features/*.tgz` 依赖消费：

```bash
cp agentdev-<name>-feature-<version>.tgz <Claw>/resources/features/
```

然后更新 Claw 安装（见下节 integrity 处理），并按变更范围重启：

| 变更内容 | 重启范围 |
|---|---|
| 仅 tgz 包（`node_modules/@agentdevjs/*`） | 重启对应 agent 子进程即可 |
| 框架 dist（`node_modules/agentdev` → junction） | 必须重启整个 Claw 服务 |

## integrity hash 处理

tgz **文件名不变但内容变更**（版本号未升级）时，npm 会因 `package-lock.json` 中记录的旧 integrity 拒绝安装（`EINTEGRITY`）。`npm install --force` 无法绕过。

标准处理：

```bash
cd <Claw>
# 方案 1（推荐）：删掉 lock 中该包条目的 integrity 字段，让 npm 重算
# 方案 2：从 npm install 报错信息中取 "got" 后的新 hash，替换 lock 中旧值
rm -rf node_modules/@agentdevjs/<name>
npm install
```

file: 依赖的 lock 条目通常没有 integrity 字段，此时直接 `rm -rf` + `npm install` 即可。

## 消费端验证

安装完成后，在 Claw 仓库验证（**必须用工具 grep，不要用 bash grep**——Windows 编码问题会假阴性）：

1. 新代码已就位：grep 新增的标识性代码片段，确认 `node_modules/@agentdevjs/<name>/dist/index.js` 包含本次改动；
2. 资源已就位：确认 `node_modules/@agentdevjs/<name>/dist/media/`（或 templates/、skills/）存在且非空；
3. 运行时生效：重启 agent 后在 inspector 或日志中确认新行为。

## 批量流水线

`scripts/build-and-pack-features.mjs` 批量构建 + 打包所有列出的 feature 包，产物直接落到 `<AgentDevClaw>/resources/features/`。修改多个 feature 包时优先用它，避免逐个手动操作出错：

```bash
cd <AgentDev 仓库根>
node scripts/build-and-pack-features.mjs
```

流水线对每个包执行 `npm install --legacy-peer-deps` → `npm run build` → `npm pack` → 移动 tgz 到 Claw。**任何一个包失败都会让脚本以非零退出码结束**——看到非零退出必须修复后重跑，不允许忽略失败继续交付。

流水线列表新增 feature 包时，把包名加进脚本的 `featuresToBuild` 数组。

## 完成检查

- [ ] 用的是 `npm run build`（含 copy-assets），不是裸 `npx tsup`
- [ ] `tar tzf` 核对过 tgz 内容，资源目录齐全且非空
- [ ] 双路径 feature 两侧源码都改了、两个构建都跑了
- [ ] tgz 已复制到 Claw `resources/features/`
- [ ] integrity 冲突已处理，`npm install` 完成
- [ ] `node_modules` 中的新代码和资源已用 grep/ls 验证
- [ ] 按变更范围重启了 agent 或整个 Claw 服务
- [ ] 运行时行为已实际验证（不是"应该没问题"）
