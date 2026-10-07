# 工具契约设计

## 目录

- [名称](#名称)
- [描述](#描述)
- [参数 Schema](#参数-schema)
- [结果契约](#结果契约)
- [调用改写](#调用改写)
- [错误分类](#错误分类)
- [副作用契约](#副作用契约)
- [契约审查](#契约审查)

## 名称

工具名采用稳定、可区分的 `snake_case`：

```text
record_get
record_search
record_update
record_archive
```

名称由“领域对象 + 动作”组成。相近工具必须仅凭名称就能区分。避免 `run`、`manage`、`handle`、`do_action` 等宽泛名称。

远端动态名称先规范化：

- 转小写；
- 非字母数字转下划线；
- 合并连续下划线；
- 加稳定领域前缀；
- 处理空名、保留名和碰撞；
- 相同远端元数据每次产生相同工具名。

## 描述

描述至少包含四部分：

1. 完成什么动作；
2. 何时调用、何时不要调用；
3. 重要限制或副作用；
4. 返回什么以及失败如何表达。

```ts
description: [
  '更新一条已有记录的标题和状态。',
  '先使用 record_get 确认记录存在并取得 revision。',
  '该操作会修改远端数据；revision 不匹配时不会写入。',
  '返回更新后的记录摘要，冲突时返回 ok=false 和 currentRevision。',
].join('\n')
```

不要把实现细节、SDK 方法名或冗长背景放进描述。工具描述会进入每次 LLM 请求，控制总长度。

## 参数 Schema

根节点使用 `type: 'object'`。为所有属性提供 `description`，并明确 `required`。

```ts
parameters: {
  type: 'object',
  properties: {
    id: { type: 'string', description: '记录 ID。' },
    revision: {
      type: 'integer',
      description: 'record_get 返回的当前修订号。',
      minimum: 0,
    },
    patch: {
      type: 'object',
      description: '要修改的字段。至少包含一个字段。',
      properties: {
        title: { type: 'string', description: '新标题，1-200 字符。' },
        status: { type: 'string', enum: ['open', 'closed'] },
      },
      additionalProperties: false,
    },
  },
  required: ['id', 'revision', 'patch'],
  additionalProperties: false,
}
```

规范：

- 数量限制使用 `minimum` / `maximum`；
- 字符长度使用 `minLength` / `maxLength`；
- 固定值使用 `enum`；
- 数组使用 `items` 并限制 `maxItems`；
- 对象不接受扩展字段时设置 `additionalProperties: false`；
- 路径字段说明相对基准；
- 日期时间说明时区和格式；
- 空字符串、空数组和 `null` 的含义必须明确。

schema 只帮助模型生成参数。执行函数仍要验证权限、路径、版本号、上限和外部副作用条件。

## 结果契约

让结果适合模型继续推理：

```ts
type UpdateResult =
  | { ok: true; record: { id: string; title: string; status: string; revision: number } }
  | { ok: false; code: 'not_found' | 'conflict' | 'invalid'; error: string; currentRevision?: number };
```

结果要求：

- 顶层字段稳定；
- 成功和业务失败可区分；
- 提供下一步修正所需信息；
- 删除 SDK 元数据和循环引用；
- 大列表分页或截断并返回 `nextCursor`；
- 二进制数据返回路径、资源标识或摘要，不直接塞入巨大字符串；
- 返回对象可被 `JSON.stringify()`。

## 调用改写

工具声明 `rewritable: true` 后，可在执行成功时经 `withRewrite(text, effectiveCall)` 声明"实际生效的调用"（ADR-0023）。框架把 assistant 历史中的该条 toolCall 替换为生效值——下一轮模型看到的就是生效调用，如同当时就是这么调的。

```ts
import { withRewrite } from '@agentdevjs/core';

const tool = createTool({
  name: 'read_file',
  description: '...',
  rewritable: true,
  execute: async (args, ctx) => {
    const normalized = { path: resolveAbsolutePath(args.path) };  // 参数规范化
    const content = readFile(normalized.path);
    return withRewrite(
      JSON.stringify({ ok: true, path: normalized.path }),
      { id: ctx.callId, name: 'read_file', arguments: normalized },
    );
  },
});
```

约束与语义：

| 项 | 规则 |
|---|---|
| `effectiveCall.id` | 必须等于原调用 id（取 `ctx.callId`），否则框架放弃改写并记 error 日志 |
| `effectiveCall.name` | 必须是本 agent 已注册工具，否则放弃改写（装配错误） |
| 前端展示数据 | `withRewrite(text, effectiveCall, display?)` 第三参数可选，与 `withDisplay` 同通道；改写发生时框架自动并入 `rewrittenCall` 快照，二者合并进同一 display 对象 |
| 适用时机 | 仅成功执行可改写；抛出异常的路径无法携带改写 |
| 原始调用去向 | 结构化日志（`tool.rewrite` 事件，agent.tool 命名空间）与 `display.rewrittenCall`（前端"已修改"标注数据源） |
| 语义解释 | 框架零语义判断：改写是等价规范化还是实质修正、要不要在结果里向模型解释，全部由工具作者决定——需要解释就写进 `text` |

适用场景：参数规范化（路径展开、默认值补全、别名大小写）、旧名向新名的迁移收敛。不适用场景：需要模型知情并重新决策的实质变更——那属于错误结果契约，不是改写。

别名迁移（模型调旧名 A、实际执行正式工具 B）时，A 与 B 都必须注册，A 的执行体转发执行并声明 `effectiveCall.name = 'B'`。模型看到自己"调了 B"，逐渐学会直接调 B；迁移效果查结构化日志。

## 错误分类

| 失败 | 表达方式 |
|---|---|
| 用户可修正参数 | `{ ok: false, code, error }` |
| 记录不存在、版本冲突 | 结构化业务失败 |
| 未配置、资源未就绪 | 明确错误结果或抛出带动作建议的异常 |
| 网络、协议、磁盘基础设施失败 | 抛出异常，由工具执行器转为失败结果 |
| 中断 | 传播 `AbortError` 或响应 signal |

错误文本写明发生了什么、哪个字段或资源有问题、Agent 可以采取什么动作。不要返回原始堆栈、密钥或整个远端响应。

## 副作用契约

写工具明确：

- 作用目标；
- 是否幂等；
- 是否支持 dry-run；
- 是否需要 revision / etag；
- 是否可撤销；
- 中断发生在提交前还是提交后；
- 重试是否会重复创建或发送。

对创建、发送、支付、发布等操作使用客户端请求 ID 或幂等键。先验证后提交，提交后返回外部系统的稳定 ID。

## 契约审查

- 单看名称能否选对工具？
- 描述是否包含调用条件和副作用？
- schema 是否拒绝模糊或无界输入？
- 运行时是否重复验证安全关键字段？
- 业务失败是否可让 Agent 修正？
- 结果是否可序列化且大小有界？
- 重试、中断和并发语义是否明确？
- 是否有相同语义却返回不同形状的工具？
