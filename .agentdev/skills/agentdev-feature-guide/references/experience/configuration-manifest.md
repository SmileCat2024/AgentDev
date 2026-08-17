# Feature 配置与 Manifest

## 目录

- [装配与配置](#装配与配置)
- [配置来源和优先级](#配置来源和优先级)
- [Manifest 结构](#manifest-结构)
- [属性类型](#属性类型)
- [解析与校验](#解析与校验)
- [路径和凭据](#路径和凭据)
- [重载](#重载)
- [验证](#验证)

## 装配与配置

配置不创建 Feature。先装配实例，再由核心按 `feature.name` 传入配置：

```ts
const agent = new Agent({
  llm,
  workspaceDir,
  features: {
    search: { enabled: true, timeoutMs: 5_000 },
  },
}).use(new SearchFeature());
```

`AgentConfig.features.enabled` 可供宿主决定装配列表，核心不会自动安装、排序或移除 Feature。

## 配置来源和优先级

常见来源：

- 构造参数：依赖实例、测试替身、程序化覆盖；
- `ctx.featureConfig`：项目级可编辑设置；
- `ctx.config.workspaceDir/projectRoot`：Agent 路径；
- 环境或 secret provider：凭据；
- Feature 默认值。

固定优先级，例如：

```text
显式构造参数 > featureConfig > Agent 路径 > Feature 默认值
```

集中在纯解析函数中实现，不在工具、hooks 和客户端中分别读取。

## Manifest 结构

```ts
getFeatureManifest(): FeatureManifestDefinition {
  return {
    schemaVersion: 1,
    settings: {
      properties: {
        enabled: {
          type: 'boolean',
          title: '启用搜索',
          description: '关闭后保留 Feature，但工具返回不可用状态。',
          default: true,
        },
        strategy: {
          type: 'select',
          title: '搜索策略',
          options: [
            { label: '快速', value: 'fast' },
            { label: '完整', value: 'thorough' },
          ],
          default: 'fast',
        },
      },
      sections: [
        { id: 'general', title: '通用', properties: ['enabled', 'strategy'] },
      ],
    },
  };
}
```

manifest 声明 UI 契约，不会自动把默认值写入 Feature。实现必须解析和应用相同默认语义。

## 属性类型

`FeatureManifestSettingProperty` 支持：

- `string`：文本、URL、模型名、非敏感标识；
- `number`：配合 `min`、`max`、`step`；
- `boolean`：真正的 boolean 默认值；
- `select`：`options[].value` 类型与运行时完全一致；
- `file`：配合 `accept`，可用数组值表示多个文件；
- `directory`：目录或目录列表，配合 `maxItems`；
- `group`：通过嵌套 `properties` 组织对象。

通用字段：`title`、`description`、`default`、`placeholder`、`showWhen`。

`showWhen` 只控制展示。隐藏字段可能仍存在于配置中，运行时根据主开关决定是否应用。

`sections` 定义分组和顺序。每个属性只放入一个明确分区。

## 解析与校验

输入始终按 `unknown` 处理：

```ts
function parseConfig(raw: unknown): SearchConfig {
  const value = raw && typeof raw === 'object'
    ? raw as Record<string, unknown>
    : {};

  const timeoutMs = typeof value.timeoutMs === 'number'
    && Number.isFinite(value.timeoutMs)
    ? Math.min(60_000, Math.max(100, value.timeoutMs))
    : 5_000;

  return {
    enabled: value.enabled !== false,
    strategy: value.strategy === 'thorough' ? 'thorough' : 'fast',
    timeoutMs,
  };
}
```

注意：

- 合法 `false`、`0` 和空数组不能被 `||` 覆盖；
- 数值排除 `NaN` 和 Infinity；
- 数组逐项验证并限制数量；
- group 逐层验证；
- 未知字段忽略或明确拒绝；
- 错误指出字段、期望类型和允许范围。

## 路径和凭据

- 用户文件相对 `workspaceDir`；
- 包资源相对 package root；
- 配置相对路径只选择一个基准；
- 解析后验证路径仍在允许范围；
- manifest 不包含真实 token、cookie 或密码默认值；
- 日志不输出 headers、环境变量和完整配置；
- 凭据不进入 snapshot 和工具结果。

## 重载

配置决定客户端、server 或 worker 时，优先替换 Feature 实例。需要在线重载时：

1. 解析并验证新配置；
2. 在局部变量创建新资源；
3. 健康检查；
4. 原子交换配置和资源引用；
5. 等待旧活动操作；
6. 释放旧资源；
7. 失败时保持旧状态。

## 验证

- manifest 与运行时默认值一致；
- 每种属性类型有解析测试；
- false、0、空列表得到保留；
- 非法对象、NaN、超界和未知枚举安全处理；
- 配置键等于 Feature name；
- 配置存在但未装配 Feature 时不会产生隐式行为；
- 路径基准和越界检查正确；
- 凭据不出现在 manifest、日志、结果和快照；
- 重载失败不污染当前资源。
