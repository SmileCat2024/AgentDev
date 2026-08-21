# Example Feature

这个目录不是业务功能，而是内置示范骨架。

推荐复制顺序：

1. 复制整个目录
2. 重命名文件夹、类名、工具名、模板名
3. 先保留 `index.ts / tools.ts / types.ts / README.md`
4. 把不需要的能力删掉，而不是留着空实现
5. 最后再补真实业务逻辑

这个骨架展示的重点：

- Feature 最小目录结构
- 一个较合理的公开 API 和内部 helper 划分
- `getTools()` + 模板渲染
- `getContextInjectors()`
- `onInitiate()` / `onDestroy()`
- `captureState()` / `restoreState()`
- `beforeRollback()` / `afterRollback()`
- `@CallStart` / `@ToolUse` / `@StepFinish`

不要机械保留所有部分。  
如果一个新 Feature 不需要某块能力，直接删掉比留下空壳更好。

## 推荐目录形状

```text
src/features/my-feature/
├── index.ts
├── tools.ts
├── types.ts
├── templates/
│   └── my-tool.render.ts
├── test/
│   └── smoke.test.ts
└── README.md
```

常见删减方式：

- 没有模板：删 `templates/`
- 没有工具：删 `tools.ts`
- 只有简单类型：把类型直接并回 `index.ts`
- 没有持久状态：删 `captureState/restoreState/beforeRollback/afterRollback`
- 没有回退需求：不要为了形式统一保留 rollback 接口

## 测试规范

Feature 测试必须写在 `test/` 目录内。测试文件必须使用标准错误处理模式：

```typescript
async function main(): Promise<void> {
  // 测试逻辑
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
```

## 一个实用判断顺序

1. 这个能力是否应该是 Feature，而不是单个工具？
2. 工具是静态的还是异步发现的？
3. 是否需要上下文注入？
4. 是否需要反向钩子控制运行时？
5. 是否真的需要 rollback / session restore？
6. 是否需要模板让调试器更可读？

## rollback 何时该实现

只有当下面任一条件成立时，才建议实现：

- Feature 有真实内存状态，并且回退后用户会看到不一致
- 会话恢复后，Feature 需要继续先前的逻辑状态

如果只是：

- 无状态工具集合
- 轻量缓存
- 可随时重建的连接资源

那就不要硬写 rollback 接口。
