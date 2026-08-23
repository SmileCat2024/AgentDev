/**
 * Shell 共享核心（ticket 024 / ADR-0005）
 *
 * bash 与 powershell 共用的「spawn + collect + 截断落盘 + 终止收集」管线：
 * - 正常完成：沿用既有语义（成功 stdout/stderr 独立截断落盘；失败合并截断后 reject）。
 * - 终止收集（toolContext.signal aborted，ticket 023 合并 signal 契约）：
 *   kill（Windows taskkill /PID <pid> /T /F 进程树；POSIX 进程组 SIGKILL）
 *   → 继续读 stdout/stderr 到 EOF（上限 1s，孙进程占 pipe 兜底）
 *   → resolve（不再 reject），结果文本为部分输出 + 尾部 <shell_metadata> 块。
 *
 * 计时职责归框架 executor（Tool.timeout 声明契约）：本模块不设内部 setTimeout
 * race；args.timeout 由 executor 经 fromArg 消费并 clamp。
 */

import { spawn } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import type { ToolTerminationReason } from '@agentdev/core';

/** drain 上限：kill 后等待管道 EOF 的时间（孙进程占 pipe 兜底）。 */
const TERMINATION_DRAIN_MS = 1000;

/** 元数据块标记（仅终止态出现在结果尾部）。 */
export const SHELL_METADATA_OPEN = '<shell_metadata>';
export const SHELL_METADATA_CLOSE = '</shell_metadata>';

export interface ShellRunResult {
  stdout: string;
  stderr: string;
  output: string;
}

export interface ShellRunContext {
  /** 框架注入的合并 signal（用户打断与框架超时共用，见 ticket 023） */
  signal?: AbortSignal;
  /** 终止原因查询（executor 注入；未走终止协议时恒返回 null） */
  termination?: () => ToolTerminationReason | null;
}

// ---------------------------------------------------------------------------
// 输出截断 + 落盘持久化（自 tools.ts 迁入共享；bash-output-* 落盘机制不变）
// ---------------------------------------------------------------------------

const MAX_OUTPUT_LENGTH = 30_000;

function timestampSlug(): string {
  const now = new Date();
  const ts = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '-' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${ts}-${suffix}`;
}

/**
 * 截断输出并持久化完整内容到磁盘。
 *
 * 当输出超过 limit 时：
 * 1. 将完整输出写入 workdir/.agentdev/temp/bash-output-<timestamp>-<random>.log
 * 2. 返回截断版本（头 60% + 尾 40%），中间插入截断提示和文件路径引用
 *
 * 如果写盘失败，fallback 到纯截断（不丢失截断提示，但完整内容不可恢复）。
 *
 * @param forcePersist true 时无论长度一律落盘（终止态使用：被杀进程的已积累
 *   输出必须可恢复），并返回 logPath 供元数据引用。
 */
export async function processOutputWithPersistence(
  output: string,
  workdir: string,
  limit: number = MAX_OUTPUT_LENGTH,
  forcePersist: boolean = false,
): Promise<[string, string | null]> {
  if (!forcePersist && output.length <= limit) return [output, null];

  // 尝试将完整输出持久化到磁盘
  let filePath: string | null = null;
  try {
    const tempDir = path.join(workdir, '.agentdev', 'temp');
    const fileName = `bash-output-${timestampSlug()}.log`;
    filePath = path.join(tempDir, fileName);

    await mkdir(tempDir, { recursive: true });
    await writeFile(filePath, output, 'utf-8');
  } catch (err) {
    console.error(`[shell] Failed to persist output: ${err}`);
    filePath = null;
  }

  if (output.length <= limit) return [output, filePath];

  const headSize = Math.floor(limit * 0.6);
  const tailSize = limit - headSize;
  const head = output.slice(0, headSize);
  const tail = output.slice(-tailSize);
  const omitted = output.length - limit;
  const totalKB = Math.round(output.length / 1024);

  const persistNotice = filePath
    ? `[Full output (${totalKB}KB) saved to: ${filePath}]\nUse the read tool to access the full output if needed.\n`
    : '';

  return [
    head +
    `\n\n... [truncated: omitted ${omitted} characters (${totalKB}KB total)] ...\n${persistNotice}\n` +
    tail,
    filePath,
  ];
}

// ---------------------------------------------------------------------------
// kill 工具（Windows taskkill 进程树 / POSIX 进程组）
// ---------------------------------------------------------------------------

function makeKillChild(child: import('child_process').ChildProcess): () => void {
  return () => {
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.once('error', (error) => {
          console.warn(`[shell] taskkill failed for PID=${child.pid}:`, error);
          child.kill('SIGKILL');
        });
        killer.once('close', (code) => {
          if (code !== 0) {
            console.warn(`[shell] taskkill exited with code ${code} for PID=${child.pid}; killing the direct child`);
            child.kill('SIGKILL');
          }
        });
      } else {
        process.kill(-child.pid!, 'SIGKILL');
      }
    } catch {
      // 进程可能已经退出
    }
  };
}

/** kill 后等待管道 EOF：正常在 close 触发，孙进程继承 pipe 句柄时以超时兜底。 */
function drainToEof(child: import('child_process').ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    child.once('close', finish);
  });
}

// ---------------------------------------------------------------------------
// <shell_metadata> 结果块（仅终止态出现，字段见工单 024 步骤 4）
// ---------------------------------------------------------------------------

export interface ShellMetadataFields {
  terminated: boolean;
  reason: ToolTerminationReason;
  durationMs: number;
  exitCode: number | null;
  outputBytes: number;
  truncated: boolean;
  logPath: string | null;
}

export function formatShellMetadata(meta: ShellMetadataFields): string {
  return [
    SHELL_METADATA_OPEN,
    `terminated: ${meta.terminated}`,
    `reason: ${meta.reason}`,
    `durationMs: ${Math.round(meta.durationMs)}`,
    `exitCode: ${meta.exitCode === null ? 'null' : meta.exitCode}`,
    `outputBytes: ${meta.outputBytes}`,
    `truncated: ${meta.truncated}`,
    `logPath: ${meta.logPath ?? 'null'}`,
    SHELL_METADATA_CLOSE,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 共享运行核心
// ---------------------------------------------------------------------------

export interface SharedRunOptions extends ShellRunContext {
  workdir: string;
  execPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** 日志前缀（'[shell]' / '[powershell]'） */
  logPrefix: string;
  /** stderr 清理（bash 过滤 job control 噪音；powershell 仅 trim），在截断/合并前调用 */
  cleanStderr?: (stderr: string) => string;
}

/**
 * spawn + collect + 截断落盘 + 终止收集。
 *
 * - signal 未触发：行为与历史实现一致（成功 resolve 截断输出；失败 reject 截断信息）。
 * - signal aborted：kill → drain 到 EOF（≤1s）→ resolve 部分输出 + 尾部元数据块，
 *   已积累输出无条件落盘（logPath 入元数据）。
 */
export function runCollectedProcess(
  opts: SharedRunOptions,
): Promise<ShellRunResult> {
  const { workdir, logPrefix, signal, termination } = opts;

  const startedAt = Date.now();
  const cleanForRun = (raw: string): string =>
    opts.cleanStderr ? opts.cleanStderr(raw) : raw.trim();
  const readTermination = (): ToolTerminationReason => termination?.() ?? 'user';

  return new Promise<ShellRunResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    /** 终止态收尾：已积累输出无条件落盘 → 组装「部分输出 + 元数据块」结果。 */
    const finishTerminated = async (): Promise<ShellRunResult> => {
      const combined = [stdout, cleanForRun(stderr)].filter(Boolean).join('\n');
      const [text, logPath] = await processOutputWithPersistence(
        combined || '',
        workdir,
        MAX_OUTPUT_LENGTH,
        true,
      );
      const meta: ShellMetadataFields = {
        terminated: true,
        reason: readTermination(),
        durationMs: Date.now() - startedAt,
        exitCode: null,
        outputBytes: Buffer.byteLength(combined, 'utf-8'),
        truncated: text.length < combined.length,
        logPath,
      };
      return {
        stdout: text,
        stderr: '',
        output: text ? `${text}\n${formatShellMetadata(meta)}` : formatShellMetadata(meta),
      };
    };

    const child = spawn(opts.execPath, opts.args, {
      cwd: workdir,
      env: opts.env ?? { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // On Linux/macOS, detached: true puts the child in its own process group
      // so that process.kill(-pid) can terminate the entire group on abort.
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    const killChild = makeKillChild(child);

    const cleanupSignal = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    /**
     * 终止收集（ADR-0005 中断即结果）：kill → drain 到 EOF → resolve。
     * 被杀进程拿不到 exit code，元数据中记 null。
     */
    const terminateAndCollect = () => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      console.log(`${logPrefix} signal abort detected, killing child PID=${child.pid}`);
      killChild();
      void drainToEof(child, TERMINATION_DRAIN_MS)
        .then(finishTerminated)
        .then(resolve)
        .catch(reject);
    };

    const onAbort = () => terminateAndCollect();

    if (signal) {
      if (signal.aborted) {
        // 执行前已中断：不执行命令，直接以终止态收尾
        terminateAndCollect();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanupSignal();

      const cleanStderr = cleanForRun(stderr);

      if (signal?.aborted) {
        // close 在终止收集之后到达（罕见竞态）：仍以终止态收尾
        void finishTerminated().then(resolve).catch(reject);
        return;
      }

      if (code === 0) {
        // 成功：stdout 和 stderr 分别独立截断（现状语义，无元数据块）
        Promise.all([
          processOutputWithPersistence(stdout || '', workdir),
          processOutputWithPersistence(cleanStderr || '', workdir),
        ]).then(([truncatedStdout, truncatedStderr]) => {
          resolve({
            stdout: truncatedStdout[0],
            stderr: truncatedStderr[0],
            output: truncatedStdout[0] || truncatedStderr[0],
          });
        }).catch(err => {
          reject(err);
        });
      } else {
        // 失败：合并 stdout + stderr 后统一截断（现状语义）
        const combined = [stdout, cleanStderr].filter(Boolean).join('\n\n--- stderr ---\n');
        processOutputWithPersistence(combined, workdir).then(([truncated]) => {
          reject(new Error(truncated || `Command failed with exit code ${code}`));
        }).catch(err => {
          reject(err);
        });
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      reject(err);
    });
  });
}
