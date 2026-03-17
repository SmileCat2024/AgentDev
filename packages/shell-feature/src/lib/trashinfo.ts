/**
 * TrashInfo 文件解析和处理
 */

import { join, basename } from 'path';
import { FileSystem } from './fs.js';
import { ErrorCode, type TrashedFileInfo } from './types.js';
import { SafeRmError } from './errors.js';

export function validateOperator(operator: string | null | undefined): void {
  if (operator === null || operator === undefined) return;
  if (typeof operator !== 'string') {
    throw new SafeRmError(ErrorCode.ERROR_INVALID_OPERATOR, '操作者名称必须是字符串');
  }
  if (!operator) {
    throw new SafeRmError(ErrorCode.ERROR_INVALID_OPERATOR, '操作者名称不能为空');
  }
  const illegalChars = '<>:"|?*\\/()[]{}';
  for (const char of illegalChars) {
    if (operator.includes(char)) {
      throw new SafeRmError(ErrorCode.ERROR_INVALID_OPERATOR, `操作者名称包含非法字符: '${char}'`, { operator, illegal_char: char });
    }
  }
  if (operator.length > 64) {
    throw new SafeRmError(ErrorCode.ERROR_INVALID_OPERATOR, '操作者名称过长（最大 64 字符）', { operator, length: operator.length });
  }
}

export function encodePath(path: string): string {
  const normalized = FileSystem.normalizePath(path);
  return encodeURIComponent(normalized).replace(/%2F/g, '/');
}

export function decodePath(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function generateTrashName(originalPath: string): string {
  const base = basename(originalPath);
  const extIndex = base.lastIndexOf('.');
  let name: string;
  let ext: string;

  if (extIndex > 0) {
    name = base.substring(0, extIndex);
    ext = base.substring(extIndex);
  } else {
    name = base;
    ext = '';
  }

  const now = new Date();
  const timestamp = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0') +
    now.getHours().toString().padStart(2, '0') +
    now.getMinutes().toString().padStart(2, '0') +
    now.getSeconds().toString().padStart(2, '0');

  const randomSuffix = Math.floor(Math.random() * 9000) + 1000;

  return `${name}_${timestamp}_${randomSuffix}${ext}`;
}

export function createTrashInfo(
  originalPath: string,
  trashName: string,
  trashDir: string,
  operator: string | null
): string {
  const infoDir = join(trashDir, 'info');
  const infoPath = join(infoDir, `${trashName}.trashinfo`);
  const encodedPath = encodePath(originalPath);
  const now = new Date();
  const deletionDate = now.toISOString().replace(/\.\d{3}Z$/, '');

  let content = `[Trash Info]
Path=${encodedPath}
DeletionDate=${deletionDate}
`;
  if (operator) {
    content += `Operator=${operator}\n`;
  }

  FileSystem.writeFile(infoPath, content);
  return infoPath;
}

export function parseTrashInfo(infoPath: string, trashDir: string): TrashedFileInfo | null {
  try {
    const content = FileSystem.readFile(infoPath);
    let originalPath: string | null = null;
    let deletionDate: string | null = null;
    let operator: string | null = null;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Path=')) {
        originalPath = decodePath(trimmed.substring(5));
      } else if (trimmed.startsWith('DeletionDate=')) {
        deletionDate = trimmed.substring(13);
      } else if (trimmed.startsWith('Operator=')) {
        operator = trimmed.substring(9);
      }
    }

    if (!originalPath || !deletionDate) return null;

    try {
      FileSystem.validatePath(originalPath);
    } catch {
      return null;
    }

    const infoBasename = basename(infoPath);
    const trashBasename = infoBasename.replace(/\.trashinfo$/, '');
    const trashFile = join(trashDir, 'files', trashBasename);

    if (!FileSystem.exists(trashFile)) return null;

    const size = FileSystem.getFileSize(trashFile);

    return {
      index: -1,
      originalPath,
      deletionDate,
      operator,
      trashFile,
      infoFile: infoPath,
      size,
    };
  } catch {
    return null;
  }
}

export function parseRmCommand(rmCommand: string): {
  files: string[];
  force: boolean;
  interactive: boolean;
  recursive: boolean;
} {
  const trimmed = rmCommand.trim();
  if (!trimmed) {
    return { files: [], force: false, interactive: false, recursive: false };
  }

  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    const nextChar = trimmed[i + 1] || '';

    if (inQuote) {
      if (char === quoteChar) {
        if (nextChar === quoteChar) {
          current += char;
          i++;
        } else {
          inQuote = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'" || char === '`') {
      inQuote = true;
      quoteChar = char;
    } else if (char === ' ' || char === '\t') {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) parts.push(current);

  const files: string[] = [];
  let force = false;
  let interactive = false;
  let recursive = false;

  for (let part of parts) {
    if ((part.startsWith('"') && part.endsWith('"')) ||
        (part.startsWith("'") && part.endsWith("'")) ||
        (part.startsWith('`') && part.endsWith('`'))) {
      part = part.slice(1, -1);
    }
    if (!part) continue;
    if (part.startsWith('-')) {
      if (part.includes('f') || part === '--force') force = true;
      if (part.includes('i') || part === '--interactive') interactive = true;
      if (part.includes('r') || part.includes('R') || part === '--recursive') recursive = true;
    } else {
      files.push(part);
    }
  }

  return { files, force, interactive, recursive };
}
