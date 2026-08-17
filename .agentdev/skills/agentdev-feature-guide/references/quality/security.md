# Feature 安全设计

## 目录

- [信任边界](#信任边界)
- [输入验证](#输入验证)
- [路径安全](#路径安全)
- [网络与进程](#网络与进程)
- [凭据](#凭据)
- [Hook 安全](#hook-安全)
- [输出与日志](#输出与日志)
- [安全测试](#安全测试)

## 信任边界

以下输入全部视为不可信：

- LLM 生成的工具参数；
- 用户消息和附件；
- 工作区文件；
- 远端 API/MCP 返回的描述和数据；
- 环境变量和项目配置；
- 其他 Feature 返回的数据；
- session 和 snapshot 文件。

先定义允许范围，再实现校验。不要依赖提示词或工具描述承担安全边界。

## 输入验证

执行函数重复验证安全关键字段：

- 类型、长度、枚举和数量；
- ID 格式和租户归属；
- revision/etag；
- URL scheme 和 host；
- 文件扩展名与真实类型；
- 命令和参数的允许集合；
- 批量操作上限；
- 是否处于允许模式。

拒绝时返回具体但不过度暴露内部信息的错误。

## 路径安全

将相对路径解析到 `workspaceDir`，再验证最终绝对路径仍位于允许根目录：

```ts
import { isAbsolute, relative, resolve, sep } from 'path';

const root = resolve(workspaceDir);
const target = resolve(root, userPath);
const relativePath = relative(root, target);
if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
  throw new Error('path is outside workspace');
}
```

还要处理：

- 符号链接和 junction；
- 大小写不敏感文件系统；
- UNC 与盘符；
- `..`、绝对路径和混合分隔符；
- 删除、移动和递归操作的精确目标；
- 临时文件的权限与清理。

破坏性文件操作先做只读解析与目标核对。

## 网络与进程

网络工具防止 SSRF：

- 只允许所需 scheme；
- 验证域名和端口；
- 限制重定向；
- 按策略阻止 loopback、link-local 和内网地址；
- 限制响应大小和超时；
- 不把用户 URL 直接拼入 shell。

进程工具：

- 使用参数数组，不拼接命令字符串；
- 明确工作目录；
- 过滤环境变量；
- 限制执行时间和输出大小；
- 将 signal 传给子进程；
- 清理子进程树；
- 不把密钥放进命令行参数。

## 凭据

- 构造参数或专用 secret 机制接收凭据；
- manifest 只声明非敏感配置或 secret 引用；
- 不提供真实默认密钥；
- 不进入快照、Context、工具结果和日志；
- 只向需要的客户端传递最小凭据；
- 清理错误对象中的 request headers；
- 工具不得返回配置对象的完整副本。

## Hook 安全

安全关键 ToolUse guard 采用 fail-closed。registry 会记录并跳过抛错 hook，因此异常必须在 hook 内捕获并转为 `Decision.Deny`。

工具自身仍执行相同不变量校验，防止工具被其他装配路径直接调用。Hook 负责统一策略，工具负责局部安全。

`Decision.Approve` 会短路后续 Feature 决策。普通安全规则未阻止时返回 `Continue`，保留其他规则的判断机会。

## 输出与日志

- 工具结果移除内部字段和秘密；
- 模板对动态文本 HTML 转义；
- 远端文本进入 system message 前加明确数据边界，不当作指令；
- 限制结果和日志大小；
- 错误不返回堆栈和本机绝对敏感路径；
- 审计日志记录动作、目标 ID、结果和规则，不记录正文与凭据。

## 安全测试

- schema 绕过和错误类型；
- 路径穿越、符号链接、盘符和 UNC；
- URL 重定向与内网地址；
- shell 元字符和参数注入；
- 超大输入、数组和响应；
- snapshot 恶意字段；
- 远端描述中的提示注入文本；
- 权限服务超时或抛错时 fail-closed；
- 日志、结果、模板和 session 中无密钥；
- 中断和重试不会重复副作用。
