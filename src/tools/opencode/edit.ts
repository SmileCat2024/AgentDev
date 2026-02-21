/**
 * Edit 工具 - 文件编辑
 * 来自 opencode 项目的优秀实现
 * 包含多种智能匹配策略
 */

import { createTool } from '../../core/tool.js';
import { readFile, writeFile, stat } from 'fs/promises';
import { createTwoFilesPatch, diffLines } from 'diff';
import path from 'path';

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
