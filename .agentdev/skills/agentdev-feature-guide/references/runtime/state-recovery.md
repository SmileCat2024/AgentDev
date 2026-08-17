# 状态快照、回滚与会话恢复

## 目录

- [状态分类](#状态分类)
- [快照形状](#快照形状)
- [捕获与恢复](#捕获与恢复)
- [恢复顺序](#恢复顺序)
- [外部副作用](#外部副作用)
- [状态迁移](#状态迁移)
- [验证](#验证)

## 状态分类

| 类型 | 示例 | 是否快照 |
|---|---|---:|
| 逻辑状态 | 模式、队列、计数、已读集合 | 是 |
| 派生缓存 | 格式化文本、可重建索引 | 通常否 |
| 运行时资源 | client、socket、timer、worker | 否 |
| 外部真实状态 | 数据库、远端记录、文件 | 否，保存稳定引用或 revision |
| 活动操作 | Promise、流、进程 | 否，恢复为明确状态 |

只有同时实现 `captureState()` 和 `restoreState()` 的 Feature 才进入框架快照。

## 快照形状

使用纯数据和值语义：

```ts
interface QueueSnapshot {
  schemaVersion: 1;
  mode: 'idle' | 'running' | 'paused';
  items: Array<{ id: string; text: string; status: string }>;
  seenIds: string[];
}
```

快照必须能被 `structuredClone()` 复制。避免函数、Promise、客户端、循环引用和巨大二进制数据。

Set/Map 转为数组或对象；Date 转为 ISO 字符串或时间戳；错误对象转为明确字段。

## 捕获与恢复

捕获时复制可变值：

```ts
captureState(): QueueSnapshot {
  return {
    schemaVersion: 1,
    mode: this.mode,
    items: this.items.map(item => ({ ...item })),
    seenIds: [...this.seenIds],
  };
}
```

恢复时先归一化，再完整覆盖：

```ts
restoreState(raw: unknown): void {
  const state = parseSnapshot(raw);
  this.mode = state.mode;
  this.items = state.items;
  this.seenIds = new Set(state.seenIds);
}
```

恢复必须幂等。禁止向现有数组追加、保留快照之外的旧字段或修改传入对象。

## 恢复顺序

step rollback 会：

1. 为每个 Feature 调用 `beforeRollback(snapshot)`；
2. 调用 `restoreState(snapshot)`；
3. 调用 `afterRollback(snapshot)`；
4. 恢复 Context。

session 和其他 runtime restore 直接依赖 `restoreState()`。必要逻辑全部放入 restore；before/after 只做暂停、派生缓存刷新和诊断。

初始化建立外部资源，恢复覆盖逻辑状态。恢复后需要重新订阅时，使用已有客户端根据状态重建订阅，不恢复旧连接对象。

## 外部副作用

rollback 不自动撤销：

- 文件写入；
- shell 命令；
- 远端更新；
- 消息发送；
- 数据库事务；
- 已启动进程。

采用外部事务、版本机制、补偿操作、幂等键或重新读取真实状态。返回结果明确区分“Agent 逻辑已恢复”和“外部操作已撤销”。

## 状态迁移

复杂快照包含 `schemaVersion`，归一化到唯一内部形状：

```ts
function parseSnapshot(raw: unknown): QueueSnapshot {
  if (!isRecord(raw)) return defaultSnapshot();
  if (raw.schemaVersion === 1) return parseV1(raw);
  return migrateUnversioned(raw);
}
```

规则：

- 缺失字段填安全默认值；
- 未知字段忽略；
- 非法枚举拒绝或归一化；
- 不修改原始对象；
- 无法解释的关键状态显式失败；
- 迁移后再应用领域不变量。

## 验证

- capture 返回值不共享可变引用；
- 新实例 restore 后行为等价；
- 连续 restore 两次结果一致；
- false、0、空数组得到保留；
- 缺失、未知和非法字段有预期结果；
- Set/Map/Date 往返正确；
- 继承 Feature 保留父类字段；
- step rollback 调用 before/restore/after 顺序正确；
- session restore 后资源可用但不是旧对象；
- 外部副作用不会被错误声明为已撤销。
