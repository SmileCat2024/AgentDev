# Feature 依赖、公开 API 与组合

## 目录

- [依赖声明](#依赖声明)
- [公开 API](#公开-api)
- [解析依赖](#解析依赖)
- [可选依赖](#可选依赖)
- [避免循环](#避免循环)
- [继承与组合](#继承与组合)
- [验证](#验证)

## 依赖声明

```ts
static inject = ['search-index'];
```

`static inject` 声明在类的静态属性上，值为依赖 Feature 的 `name` 列表。装配时框架据此做拓扑排序：依赖先于依赖方初始化；缺失依赖、循环依赖、重名都会在装配时报错。

初始化时用 `ctx.getFeature()` 解析依赖实例。`static inject` 保证顺序，不注入实例。

Feature 的 `name` 是依赖查找键。不要使用类名、包名或工具名前缀代替。

## 公开 API

把跨 Feature 能力定义为小接口：

```ts
export interface SearchIndexApi {
  readonly readiness: 'ready' | 'degraded';
  search(query: string, signal?: AbortSignal): Promise<ReadonlyArray<SearchHit>>;
}
```

公开 API 要求：

- 返回值或只读视图；
- 不泄漏客户端、锁、controller 和内部集合；
- 明确未就绪、取消和业务失败；
- 方法数量少且围绕同一职责；
- 类型从包根导出；
- 变更经过消费方契约测试。

## 解析依赖

```ts
private index?: SearchIndexApi;

async onInitiate(ctx: FeatureInitContext): Promise<void> {
  const index = ctx.getFeature<AgentFeature & SearchIndexApi>('search-index');
  if (!index) throw new Error('search-index feature is required');
  this.index = index;
}
```

## 可选依赖

可选依赖使用能力检测：

```ts
const cache = ctx.getFeature<AgentFeature & Partial<CacheApi>>('cache');
if (typeof cache?.get === 'function') this.cache = cache as CacheApi;
```

缺失时提供明确降级路径，不在工具执行中反复打印相同警告。

## 避免循环

`static inject` 成环会在装配时报错（错误信息含完整环路径）。需要跨 Feature 循环协作时，不要用 inject 硬连，改用：

- 提取更小的共享 Feature；
- 通过值事件或 callback 接口解耦；
- 由 Agent 装配层协调；
- 让一个方向只依赖纯类型和数据，不依赖实例；
- 禁止在构造函数中互相查找。

## 继承与组合

继承适合保留同一能力边界并增加小型策略。覆盖父类钩子方法时复用同一方法名，`static hooks` 声明从父类继承；子类新增钩子时在子类 `static hooks` 中展开父类声明再补充。

组合适合：

- 不同生命周期；
- 独立安装和禁用；
- 不同资源所有权；
- 需要替换实现；
- 扩展必须访问大量父类私有细节。

包装状态契约时始终调用父类 capture/restore。包装生命周期时保证父类初始化失败和清理顺序正确。

## 验证

- 缺失必需依赖时错误清晰；
- 可选依赖缺失时降级正常；
- 依赖存在但未就绪时不会执行；
- API 返回值无法修改内部状态；
- 注册顺序符合初始化需求；
- 没有循环实例依赖；
- 继承后父类 hooks 和快照仍生效；
- 动态移除依赖时消费方行为明确。
