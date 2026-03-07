/**
 * OpencodeBasic 工具定义
 * 来自 opencode 项目的优秀基础文件工具实现
 */

import { createTool } from '../../core/tool.js';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { glob } from 'glob';
import { spawn } from 'child_process';
import { createTwoFilesPatch, diffLines } from 'diff';
import path from 'path';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 50 * 1024;
const LS_LIMIT = 100;
const SEARCH_LIMIT = 100;

const IGNORE_PATTERNS = [
  'node_modules/**',
  '__pycache__/**',
  '.git/**',
  'dist/**',
  'build/**',
  'target/**',
  'vendor/**',
  'bin/**',
  'obj/**',
  '.idea/**',
  '.vscode/**',
  '.zig-cache/**',
  'zig-out/**',
  '.coverage/**',
  'coverage/**',
  'tmp/**',
  'temp/**',
  '.cache/**',
  'cache/**',
  'logs/**',
  '.venv/**',
  'venv/**',
  'env/**'
];

// ============================================================================
// Read Tool - 文件读取
// ============================================================================

/**
 * 检测是否为二进制文件
 */
async function isBinaryFile(filepath: string): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase();

  const binaryExts = [
    '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.class', '.jar', '.war',
    '.7z', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
    '.ods', '.odp', '.bin', '.dat', '.obj', '.o', '.a', '.lib', '.wasm',
    '.pyc', '.pyo'
  ];

  if (binaryExts.includes(ext)) {
    return true;
  }

  try {
    const content = await readFile(filepath, { encoding: null });
    if (content.length === 0) return false;

    const bufferSize = Math.min(4096, content.length);
    const bytes = content.subarray(0, bufferSize);

    let nonPrintableCount = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) return true;
      if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
        nonPrintableCount++;
      }
    }

    return nonPrintableCount / bytes.length > 0.3;
  } catch {
    return false;
  }
}

/**
 * 文件读取工具
 */
export const readTool = createTool({
  name: 'read',
  description: 'Read a file from the local filesystem. Can read files with offset/limit for pagination, and can also read directory contents. For large files, use offset and limit parameters to read in chunks.',
  render: 'read',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'The absolute path to the file or directory to read'
      },
      offset: {
        type: 'number',
        description: 'The line number to start reading from (1-indexed, defaults to 1)'
      },
      limit: {
        type: 'number',
        description: 'The maximum number of lines to read (defaults to 2000)'
      }
    },
    required: ['filePath']
  },
  execute: async ({ filePath, offset: offsetParam, limit: limitParam }) => {
    console.log(`[read] ${filePath}`);

    if (offsetParam !== undefined && offsetParam < 1) {
      throw new Error('offset must be greater than or equal to 1');
    }

    const stats = await stat(filePath).catch(() => null);
    if (!stats) {
      throw new Error(`File not found: ${filePath}`);
    }

    // 处理目录
    if (stats.isDirectory()) {
      const dirents = await readdir(filePath, { withFileTypes: true });
      const entries: string[] = [];

      for (const dirent of dirents) {
        if (dirent.isDirectory()) {
          entries.push(dirent.name + path.sep);
        } else if (dirent.isSymbolicLink()) {
          try {
            const targetStats = await stat(path.join(filePath, dirent.name));
            entries.push(targetStats.isDirectory() ? dirent.name + path.sep : dirent.name);
          } catch {
            entries.push(dirent.name);
          }
        } else {
          entries.push(dirent.name);
        }
      }

      entries.sort((a, b) => a.localeCompare(b));

      const limit = limitParam ?? DEFAULT_READ_LIMIT;
      const offset = offsetParam ?? 1;
      const start = offset - 1;
      const sliced = entries.slice(start, start + limit);
      const truncated = start + sliced.length < entries.length;

      return {
        type: 'directory',
        path: filePath,
        totalEntries: entries.length,
        offset,
        limit,
        truncated,
        entries: sliced
      };
    }

    // 处理文件
    const isBinary = await isBinaryFile(filePath);
    if (isBinary) {
      throw new Error(`Cannot read binary file: ${filePath}`);
    }

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    const limit = limitParam ?? DEFAULT_READ_LIMIT;
    const offset = offsetParam ?? 1;
    const start = offset - 1;

    if (start >= lines.length) {
      throw new Error(`Offset ${offset} is out of range for this file (${lines.length} lines)`);
    }

    // 读取并处理行
    const raw: string[] = [];
    let bytes = 0;
    let truncatedByBytes = false;

    for (let i = start; i < Math.min(lines.length, start + limit); i++) {
      const line = lines[i].length > MAX_LINE_LENGTH
        ? lines[i].substring(0, MAX_LINE_LENGTH) + '...'
        : lines[i];
      const size = Buffer.byteLength(line, 'utf-8') + (raw.length > 0 ? 1 : 0);

      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true;
        break;
      }

      raw.push(line);
      bytes += size;
    }

    // 生成带行号的输出
    const contentWithLines = raw.map((line, index) => {
      return `${index + offset}: ${line}`;
    });

    const totalLines = lines.length;
    const lastReadLine = offset + raw.length - 1;
    const hasMoreLines = totalLines > lastReadLine;
    const truncated = hasMoreLines || truncatedByBytes;

    return {
      type: 'file',
      path: filePath,
      totalLines,
      offset,
      limit,
      truncated,
      truncatedByBytes,
      lastReadLine,
      content: contentWithLines.join('\n')
    };
  }
});

// ============================================================================
// Write Tool - 文件写入
// ============================================================================

/**
 * 文件写入工具
 */
export const writeTool = createTool({
  name: 'write',
  description: 'Write content to a file. Creates new files or overwrites existing files. THIS TOOL WILL OVERWRITE THE EXISTING FILE IF it exists. Only use this tool when explicitly requested to do so. Always prefer editing existing files using the edit tool when the file already exists.',
  render: 'write',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'The absolute path to the file to write'
      },
      content: {
        type: 'string',
        description: 'The content to write to the file'
      }
    },
    required: ['filePath', 'content']
  },
  execute: async ({ filePath, content }) => {
    console.log(`[write] ${filePath}`);

    const exists = await stat(filePath).then(() => true).catch(() => false);
    const contentOld = exists ? await readFile(filePath, 'utf-8') : '';

    // 生成 diff
    const diff = createTwoFilesPatch(filePath, filePath, contentOld, content);

    // 写入文件
    await writeFile(filePath, content, 'utf-8');

    return {
      filePath,
      existed: exists,
      diff,
      message: `File ${exists ? 'updated' : 'created'} successfully`
    };
  }
});

// ============================================================================
// Edit Tool - 文件编辑
// ============================================================================

/**
 * Levenshtein 距离算法
 */
function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') {
    return Math.max(a.length, b.length);
  }

  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

/**
 * Replacer 类型
 */
type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

/**
 * 精确匹配替换器
 */
const simpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

/**
 * 行修剪匹配替换器
 */
const lineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;

    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }

    if (matches) {
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1;
      }

      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length;
        if (k < searchLines.length - 1) {
          matchEndIndex += 1;
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex);
    }
  }
};

/**
 * 块锚点匹配替换器（基于首尾行匹配）
 */
const blockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');

  if (searchLines.length < 3) return;

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue;

    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j });
        break;
      }
    }
  }

  if (candidates.length === 0) return;

  const SINGLE_CANDIDATE_THRESHOLD = 0.0;
  const MULTIPLE_CANDIDATES_THRESHOLD = 0.3;

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0];
    const searchBlockSize = searchLines.length;
    const actualBlockSize = endLine - startLine + 1;

    let similarity = 0;
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim();
        const searchLine = searchLines[j].trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        const distance = levenshtein(originalLine, searchLine);
        similarity += (1 - distance / maxLen) / linesToCheck;
        if (similarity >= SINGLE_CANDIDATE_THRESHOLD) break;
      }
    } else {
      similarity = 1.0;
    }

    if (similarity >= SINGLE_CANDIDATE_THRESHOLD) {
      let matchStartIndex = 0;
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1;
      }
      let matchEndIndex = matchStartIndex;
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length;
        if (k < endLine) matchEndIndex += 1;
      }
      yield content.substring(matchStartIndex, matchEndIndex);
    }
    return;
  }

  // 多个候选，找最佳匹配
  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate;
    const searchBlockSize = searchLines.length;
    const actualBlockSize = endLine - startLine + 1;

    let similarity = 0;
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim();
        const searchLine = searchLines[j].trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        const distance = levenshtein(originalLine, searchLine);
        similarity += 1 - distance / maxLen;
      }
      similarity /= linesToCheck;
    } else {
      similarity = 1.0;
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  if (maxSimilarity >= MULTIPLE_CANDIDATES_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch;
    let matchStartIndex = 0;
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1;
    }
    let matchEndIndex = matchStartIndex;
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length;
      if (k < endLine) matchEndIndex += 1;
    }
    yield content.substring(matchStartIndex, matchEndIndex);
  }
};

/**
 * 空白标准化替换器
 */
const whitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();
  const normalizedFind = normalizeWhitespace(find);

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (normalizeWhitespace(lines[i]) === normalizedFind) {
      yield lines[i];
    }
  }

  const findLines = find.split('\n');
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n');
      if (normalizeWhitespace(block) === normalizedFind) {
        yield block;
      }
    }
  }
};

/**
 * 缩进灵活替换器
 */
const indentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split('\n');
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) return text;

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
      })
    );

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n');
  };

  const normalizedFind = removeIndentation(find);
  const contentLines = content.split('\n');
  const findLines = find.split('\n');

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n');
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

/**
 * 转义符标准化替换器
 */
const escapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_, capturedChar) => {
      switch (capturedChar) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case "'": return "'";
        case '"': return '"';
        case '`': return '`';
        case '\\': return '\\';
        case '\n': return '\n';
        case '$': return '$';
        default: return _;
      }
    });
  };

  const unescapedFind = unescapeString(find);

  if (content.includes(unescapedFind)) {
    yield unescapedFind;
  }

  const lines = content.split('\n');
  const findLines = unescapedFind.split('\n');

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (unescapeString(block) === unescapedFind) {
      yield block;
    }
  }
};

/**
 * 边界修剪替换器
 */
const trimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();

  if (trimmedFind === find) return;

  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  const lines = content.split('\n');
  const findLines = find.split('\n');

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
};

/**
 * 上下文感知替换器
 */
const contextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split('\n');
  if (findLines.length < 3) return;

  if (findLines[findLines.length - 1] === '') {
    findLines.pop();
  }

  const contentLines = content.split('\n');
  const firstLine = findLines[0].trim();
  const lastLine = findLines[findLines.length - 1].trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue;

    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1);

        if (blockLines.length === findLines.length) {
          let matchingLines = 0;
          let totalNonEmptyLines = 0;

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim();
            const findLine = findLines[k].trim();

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++;
              if (blockLine === findLine) {
                matchingLines++;
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield blockLines.join('\n');
            break;
          }
        }
        break;
      }
    }
  }
};

/**
 * 多次出现替换器
 */
const multiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0;

  while (true) {
    const index = content.indexOf(find, startIndex);
    if (index === -1) break;

    yield find;
    startIndex = index + find.length;
  }
};

/**
 * 所有替换器列表
 */
const REPLACERS: Replacer[] = [
  simpleReplacer,
  lineTrimmedReplacer,
  blockAnchorReplacer,
  whitespaceNormalizedReplacer,
  indentationFlexibleReplacer,
  escapeNormalizedReplacer,
  trimmedBoundaryReplacer,
  contextAwareReplacer,
  multiOccurrenceReplacer,
];

/**
 * 执行替换
 */
function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error('No changes to apply: oldString and newString are identical.');
  }

  let notFound = true;

  for (const replacer of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) continue;

      notFound = false;

      if (replaceAll) {
        return content.replaceAll(search, newString);
      }

      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) continue;

      return content.substring(0, index) + newString + content.substring(index + search.length);
    }
  }

  if (notFound) {
    throw new Error(
      'Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.'
    );
  }

  throw new Error('Found multiple matches for oldString. Provide more surrounding context to make the match unique.');
}

/**
 * 文件编辑工具
 */
export const editTool = createTool({
  name: 'edit',
  description: 'Make exact string replacements in a file. Uses multiple intelligent matching strategies including block anchor matching, whitespace normalization, and indentation flexibility. Always provides a diff preview of changes.',
  render: 'edit',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'The absolute path to the file to modify'
      },
      oldString: {
        type: 'string',
        description: 'The text to replace'
      },
      newString: {
        type: 'string',
        description: 'The text to replace it with (must be different from oldString)'
      },
      replaceAll: {
        type: 'boolean',
        description: 'Replace all occurrences of oldString (default false)'
      }
    },
    required: ['filePath', 'oldString', 'newString']
  },
  execute: async ({ filePath, oldString, newString, replaceAll = false }) => {
    console.log(`[edit] ${filePath}`);

    if (oldString === newString) {
      throw new Error('No changes to apply: oldString and newString are identical.');
    }

    // 检查文件是否存在
    const exists = await stat(filePath).then(() => true).catch(() => false);
    if (!exists) {
      throw new Error(`File not found: ${filePath}`);
    }

    const contentOld = await readFile(filePath, 'utf-8');
    const contentNew = replace(contentOld, oldString, newString, replaceAll);

    // 生成 diff
    const diff = createTwoFilesPatch(filePath, filePath, contentOld, contentNew);

    // 计算变更统计
    let additions = 0;
    let deletions = 0;
    for (const change of diffLines(contentOld, contentNew)) {
      if (change.added) additions += change.count || 0;
      if (change.removed) deletions += change.count || 0;
    }

    // 写入文件
    await writeFile(filePath, contentNew, 'utf-8');

    return {
      filePath,
      diff,
      additions,
      deletions,
      message: 'Edit applied successfully'
    };
  }
});

// ============================================================================
// LS Tool - 目录列表
// ============================================================================

/**
 * 目录列表工具
 */
export const lsTool = createTool({
  name: 'ls',
  description: 'List files in a directory with tree structure output. Automatically ignores common build/cache directories.',
  render: 'ls',
  parameters: {
    type: 'object',
    properties: {
      dirPath: {
        type: 'string',
        description: 'The absolute path to the directory to list'
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of glob patterns to ignore'
      }
    },
    required: ['dirPath']
  },
  execute: async ({ dirPath, ignore = [] }) => {
    console.log(`[ls] ${dirPath}`);

    const ignoreGlobs = [...IGNORE_PATTERNS, ...ignore.map((p: string) => `${p}/**`)];

    // glob 返回 Promise<string[]>，不是异步迭代器
    const matches = await glob('**/*', {
      cwd: dirPath,
      absolute: false,
      dot: true,
      ignore: ignoreGlobs,
      nodir: true
    });

    const files: string[] = [];
    for (const file of matches) {
      files.push(file);
      if (files.length >= LS_LIMIT) break;
    }

    // 构建目录结构
    const dirs = new Set<string>();
    const filesByDir = new Map<string, string[]>();

    for (const file of files) {
      const dir = path.dirname(file);
      const parts = dir === '.' ? [] : dir.split(path.sep);

      // 添加所有父目录
      for (let i = 0; i <= parts.length; i++) {
        const dirPath = i === 0 ? '.' : parts.slice(0, i).join(path.sep);
        dirs.add(dirPath);
      }

      // 将文件添加到其目录
      if (!filesByDir.has(dir)) {
        filesByDir.set(dir, []);
      }
      filesByDir.get(dir)!.push(path.basename(file));
    }

    // 渲染目录树
    function renderDir(dirPath: string, depth: number): string {
      const indent = '  '.repeat(depth);
      let output = '';

      if (depth > 0) {
        output += `${indent}${path.basename(dirPath)}/\n`;
      }

      const children = Array.from(dirs)
        .filter((d) => path.dirname(d) === dirPath && d !== dirPath)
        .sort();

      // 先渲染子目录
      for (const child of children) {
        output += renderDir(child, depth + 1);
      }

      // 渲染文件
      const dirFiles = filesByDir.get(dirPath) || [];
      for (const file of dirFiles.sort()) {
        output += `${'  '.repeat(depth + 1)}${file}\n`;
      }

      return output;
    }

    const treeOutput = `${dirPath}${path.sep}\n${renderDir('.', 0)}`;

    return {
      path: dirPath,
      count: files.length,
      truncated: files.length >= LS_LIMIT,
      tree: treeOutput
    };
  }
});

// ============================================================================
// Glob Tool - 文件模式搜索
// ============================================================================

/**
 * Glob 文件搜索工具
 */
export const globTool = createTool({
  name: 'glob',
  description: 'Fast file pattern matching tool that works with any codebase size. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.',
  render: 'glob',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against'
      },
      searchPath: {
        type: 'string',
        description: 'The directory to search in (defaults to current working directory)'
      }
    },
    required: ['pattern']
  },
  execute: async ({ pattern, searchPath = process.cwd() }) => {
    console.log(`[glob] ${pattern} in ${searchPath}`);

    const files: Array<{ path: string; mtime: number }> = [];

    // 使用 glob 进行文件搜索
    const matches = await glob(pattern, {
      cwd: searchPath,
      absolute: true,
      windowsPathsNoEscape: true,
      nodir: true,
    });

    for (const file of matches) {
      if (files.length >= SEARCH_LIMIT) break;

      try {
        const stats = await stat(file);
        files.push({
          path: file,
          mtime: stats.mtimeMs
        });
      } catch {
        // File may have been deleted, skip
      }
    }

    // 按修改时间排序
    files.sort((a, b) => b.mtime - a.mtime);

    return {
      count: files.length,
      truncated: files.length >= SEARCH_LIMIT,
      files: files.map(f => f.path)
    };
  }
});

// ============================================================================
// Grep Tool - 内容搜索
// ============================================================================

/**
 * 获取 ripgrep 路径
 */
async function getRipgrepPath(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', ['--version'], { windowsHide: true });
    let hasOutput = false;

    child.stdout.on('data', () => { hasOutput = true; });
    child.stderr.on('data', () => { hasOutput = true; });

    child.on('close', (code) => {
      if (hasOutput || code === 0) {
        resolve('rg');
      } else {
        reject(new Error('ripgrep (rg) is not installed. Please install it from https://github.com/BurntSushi/ripgrep'));
      }
    });

    child.on('error', () => {
      reject(new Error('ripgrep (rg) is not installed. Please install it from https://github.com/BurntSushi/ripgrep'));
    });
  });
}

/**
 * Grep 内容搜索工具
 */
export const grepTool = createTool({
  name: 'grep',
  description: 'A powerful search tool built on ripgrep. Supports full regex syntax, file type filtering, and context control. Use this tool for content searches; NEVER invoke grep or rg as Bash commands.',
  render: 'grep',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regex pattern to search for in file contents'
      },
      searchPath: {
        type: 'string',
        description: 'The directory to search in (defaults to current working directory)'
      },
      include: {
        type: 'string',
        description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'
      }
    },
    required: ['pattern']
  },
  execute: async ({ pattern, searchPath = process.cwd(), include }, context) => {
    console.log(`[grep] ${pattern} in ${searchPath}`);

    const rgPath = await getRipgrepPath();
    const args = ['-nH', '--hidden', '--no-messages', '--field-match-separator=|', '--regexp', pattern];

    if (include) {
      args.push('--glob', include);
    }
    args.push(searchPath);

    try {
      // 使用 spawn 避免在 Windows 上 shell 解析特殊字符（如 |）的问题
      const stdout = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const child = spawn(rgPath, args, {
          windowsHide: true
        });

        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => {
          // ripgrep 将匹配结果输出到 stdout，错误信息到 stderr
        });

        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
          if (context?.signal?.aborted) {
            return reject(new Error('Search was aborted'));
          }
          // code 1 表示没有匹配，不是错误
          if (code !== 0 && code !== 1) {
            return reject(new Error(`rg exited with code ${code}`));
          }
          resolve(Buffer.concat(chunks).toString('utf-8'));
        });

        // 支持取消
        if (context?.signal) {
          context.signal.addEventListener('abort', () => {
            child.kill();
          });
        }
      });

      const lines = stdout.trim().split(/\r?\n/);
      const matches: Array<{ path: string; lineNum: number; lineText: string; modTime: number }> = [];

      for (const line of lines) {
        if (!line) continue;

        const parts = line.split('|');
        if (parts.length < 3) continue;

        const [filePath, lineNumStr, ...lineTextParts] = parts;
        const lineNum = parseInt(lineNumStr, 10);
        const lineText = lineTextParts.join('|');

        try {
          const stats = await stat(filePath);
          matches.push({
            path: filePath,
            lineNum,
            lineText: lineText.length > MAX_LINE_LENGTH ? lineText.substring(0, MAX_LINE_LENGTH) + '...' : lineText,
            modTime: stats.mtimeMs
          });
        } catch {
          // File may not exist, skip
        }
      }

      // 按修改时间排序
      matches.sort((a, b) => b.modTime - a.modTime);

      const truncated = matches.length > SEARCH_LIMIT;
      const finalMatches = truncated ? matches.slice(0, SEARCH_LIMIT) : matches;

      return {
        pattern,
        matches: matches.length,
        truncated,
        results: finalMatches
      };
    } catch (error: any) {
      if (error.message?.includes('Search was aborted') || context?.signal?.aborted) {
        throw new Error('Search was aborted');
      }
      throw error;
    }
  }
});
