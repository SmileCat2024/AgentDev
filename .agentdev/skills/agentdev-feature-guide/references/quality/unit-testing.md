# Feature 测试与验证

## 目录

- [测试层级](#测试层级)
- [Vitest 结构](#vitest-结构)
- [测试工具契约](#测试工具契约)
- [测试上下文注入](#测试上下文注入)
- [测试 Hooks](#测试-hooks)
- [测试配置](#测试配置)
- [测试状态恢复](#测试状态恢复)
- [测试资源生命周期](#测试资源生命周期)
- [测试异步发现](#测试异步发现)
- [测试执行语义](#测试执行语义)
- [发布前验证](#发布前验证)

## 测试层级

### 纯函数测试

验证配置解析、路径规范化、状态迁移、参数校验和结果转换。速度最快，优先覆盖边界。

### Feature 单元测试

直接实例化 Feature，调用工具、hooks、capture/restore 和生命周期方法。

### Agent 集成测试

将 Feature 装进带假 LLM 的 Agent，验证工具注册、hook 顺序、独占/并发、Context 和 continuation。

### 包验证

从构建产物 import Feature，检查模板、skills 和非 TS 资源都进入发布包。

## Vitest 结构

AgentDev 源码仓库使用：

```text
src/features/my-feature/test/*.test.ts
```

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MyFeature } from '../index.js';

describe('MyFeature', () => {
  let feature: MyFeature;

  beforeEach(() => {
    feature = new MyFeature();
  });

  it('exposes its expected tools', () => {
    expect(feature.getTools().map(tool => tool.name)).toEqual(['my_action']);
  });
});
```

使用项目配置的测试运行器。不要把测试文件写成自行启动的 `main().catch()` 脚本。

## 测试工具契约

```ts
it('defines a narrow schema and returns structured success', async () => {
  const tool = feature.getTools().find(item => item.name === 'my_action');
  expect(tool).toBeDefined();
  expect(tool?.description).toContain('何时');
  expect(tool?.parameters?.required).toContain('value');

  const result = await tool!.execute({ value: 'x' });
  expect(result).toEqual({ ok: true, value: 'x' });
});
```

至少验证：

- 工具名和数量；
- 必填参数；
- 成功结果；
- 可修正业务失败；
- 安全关键非法输入；
- `executionMode` / `parallelizable` 标记。

## 测试上下文注入

```ts
it('injects feature state for matching tools only', () => {
  const injectors = feature.getContextInjectors();
  const injector = injectors.get('my_action');

  expect(injector).toBeTypeOf('function');
  expect(injector!({ id: '1', name: 'my_action', arguments: {} } as any))
    .toEqual({ myFeature: { enabled: true } });
});
```

正则注入器额外测试一个匹配名和一个不匹配名。工具测试中传入注入结果，验证工具读取同一字段结构。

## 测试 Hooks

通知 hook 可直接调用：

```ts
it('injects a reminder when pending work exists', async () => {
  feature.restoreState({ pending: ['a'] });
  const messages: unknown[] = [];

  await feature.injectReminder({
    step: 0,
    callIndex: 0,
    input: 'continue',
    context: { add: (message: unknown) => messages.push(message) },
  } as any);

  expect(messages).toHaveLength(1);
});
```

决策 hook 测试每个出口：

```ts
it.each([
  ['blocked', Decision.Deny],
  ['pending', Decision.Approve],
  ['idle', Decision.Continue],
])('returns the expected decision for %s', async (state, expected) => {
  feature.setMode(state as any);
  expect(await feature.decideNextStep(makeStepContext())).toBe(expected);
});
```

直接调用钩子方法只能证明方法逻辑，不能证明装配正确。用 Agent 集成测试确认 `static hooks` 声明的方法确实被 registry 收集和调用。

## 测试配置

建立最小 `FeatureInitContext`：

```ts
function makeInitContext(featureConfig?: unknown): FeatureInitContext {
  return {
    agentId: 'test-agent',
    config: {
      llm: {} as any,
      workspaceDir: 'D:/workspace',
      features: { 'my-feature': featureConfig },
    },
    logger: {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
      warn: vi.fn(), error: vi.fn(), child: vi.fn(),
    } as any,
    featureConfig,
    getFeature: () => undefined,
    registerTool: vi.fn(),
  };
}
```

覆盖：

- undefined 配置；
- 完整配置；
- false、0、空数组等合法边界；
- 错误类型；
- 构造参数与 featureConfig 优先级；
- 相对路径基准。

## 测试状态恢复

### 往返

```ts
it('round-trips logical state', () => {
  const original = new MyFeature();
  original.restoreState({ enabled: false, items: ['a'] });

  const snapshot = structuredClone(original.captureState());
  const restored = new MyFeature();
  restored.restoreState(snapshot);

  expect(restored.captureState()).toEqual(snapshot);
});
```

### 值快照

```ts
it('does not expose mutable state references', () => {
  const snapshot = feature.captureState() as { items: string[] };
  snapshot.items.push('outside');
  expect(feature.captureState()).not.toEqual(snapshot);
});
```

### 幂等恢复

连续调用两次 restore，结果不应重复追加。

### 迁移输入

测试缺失字段、未知字段、旧 schema 和非法输入。

## 测试资源生命周期

使用假客户端：

```ts
it('connects and closes its client', async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue({ close });
  const feature = new MyFeature({ connect });

  await feature.onInitiate(makeInitContext());
  await feature.onDestroy(makeFeatureContext());

  expect(connect).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
```

额外验证：

- onDestroy 重复调用安全；
- 初始化失败时没有半初始化资源泄漏；
- AbortController 能停止后台循环；
- restoreState 不创建网络连接。

## 测试异步发现

```ts
it('maps discovered actions to deterministic tools', async () => {
  const feature = new MyFeature({
    connect: async () => ({
      listActions: async () => [
        { id: 'read', description: 'Read data' },
        { id: 'write', description: 'Write data' },
      ],
    }),
  });

  const tools = await feature.getAsyncTools(makeInitContext());
  expect(tools.map(tool => tool.name)).toEqual(['domain_read', 'domain_write']);
});
```

测试发现失败、空列表、重复远端名称、非法名称和被过滤操作。

## 测试执行语义

单元测试先检查声明：

```ts
expect(checkpointTool.executionMode).toBe('exclusive');
expect(readTool.parallelizable).toBe(true);
expect(writeTool.parallelizable).not.toBe(true);
```

集成测试再验证：

- 独占工具与其他调用同批出现时整批拒绝；
- 并发工具确实重叠执行；
- 串行工具按顺序执行；
- 结果按原始 tool call 顺序写入 Context；
- `interrupt()` 后工具收到 signal；
- continuation request 只能登记一个，并在消费后清空。

## 发布前验证

- `npm test` 或项目规定测试命令通过。
- TypeScript 构建通过。
- 从 `dist/index.js` 可成功 import Feature。
- 工具、hooks、manifest 和公开 API 符合预期。
- `dist/templates/` 包含所有模板。
- `dist/skills/` 包含所有 Feature skills。
- 非 TS 资源已复制。
- `package.json.files` 包含所需产物。
- 在一个最小消费项目中安装打包结果并完成 smoke test。
