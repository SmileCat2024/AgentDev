/**
 * Shell command quoting utilities.
 *
 * Ported from Claude Code's shellQuoting.ts + shellQuote.ts.
 *
 * 核心思路：用单引号整体包裹命令字符串，使所有特殊字符（括号、管道符、
 * 分号、$、反引号等）被 bash 视为字面量。然后通过 `eval` 进行二次解析。
 *
 * 这彻底解决了 `syntax error near unexpected token '('` 问题：
 *   - 旧方案：command.replace(/"/g, '\\"') 只转义双引号，
 *     导致 `(`, `)`, `;`, `|` 等裸露在 bash 面前
 *   - 新方案：单引号包裹整个命令，eval 二次解析
 */

// ---------------------------------------------------------------------------
// Heredoc detection
// ---------------------------------------------------------------------------

/**
 * 检测命令是否包含 heredoc 语法（<<EOF, <<'EOF', <<"EOF", <<-EOF 等）。
 * 排除位运算左移（<<）的误判。
 */
export function containsHeredoc(command: string): boolean {
  // 排除位运算：数字 << 数字、[[ 数字 << 数字 ]]、$(( ... << ... ))
  if (
    /\d\s*<<\s*\d/.test(command) ||
    /\[\[\s*\d+\s*<<\s*\d+\s*\]\]/.test(command) ||
    /\$\(\(.*<<.*\)\)/.test(command)
  ) {
    return false;
  }

  const heredocRegex = /<<-?\s*(?:(['"]?)(\w+)\1|\\(\w+))/;
  return heredocRegex.test(command);
}

// ---------------------------------------------------------------------------
// Multiline string detection
// ---------------------------------------------------------------------------

/**
 * 检测命令中是否包含跨行的引号字符串。
 * 这些命令需要特殊引用处理。
 */
function containsMultilineString(command: string): boolean {
  const singleQuoteMultiline = /'(?:[^'\\]|\\.)*\n(?:[^'\\]|\\.)*'/;
  const doubleQuoteMultiline = /"(?:[^"\\]|\\.)*\n(?:[^"\\]|\\.)*"/;
  return singleQuoteMultiline.test(command) || doubleQuoteMultiline.test(command);
}

// ---------------------------------------------------------------------------
// Stdin redirect
// ---------------------------------------------------------------------------

/**
 * 检测命令是否已有 stdin 重定向（如 < file, </path, < /dev/null）。
 * 排除 << (heredoc)、<< (位运算)、<(进程替换)。
 */
export function hasStdinRedirect(command: string): boolean {
  return /(?:^|[\s;&|])<(?![<(])\s*\S+/.test(command);
}

/**
 * 判断是否应该为命令添加 `< /dev/null` stdin 重定向。
 *
 * - heredoc 命令不需要（它们有自己的输入）
 * - 已有 stdin 重定向的命令不需要
 */
export function shouldAddStdinRedirect(command: string): boolean {
  if (containsHeredoc(command)) {
    return false;
  }
  if (hasStdinRedirect(command)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Windows null redirect rewrite
// ---------------------------------------------------------------------------

/**
 * 将 Windows CMD 风格的 `>nul` 重写为 POSIX 的 `>/dev/null`。
 *
 * Git Bash 看到 `2>nul` 时会创建一个名为 `nul` 的字面量文件——这是
 * Windows 保留设备名，极难删除且会破坏 git 操作。
 *
 * 匹配：`>nul`, `> NUL`, `2>nul`, `&>nul`, `>>nul`（不区分大小写）
 * 不匹配：`>null`, `>nullable`, `>nul.txt`
 */
const NUL_REDIRECT_REGEX = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

export function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(NUL_REDIRECT_REGEX, '$1/dev/null');
}

// ---------------------------------------------------------------------------
// Single-quote escaping
// ---------------------------------------------------------------------------

/**
 * 将字符串用 bash 单引号包裹，内部的 `'` 替换为 `'"'"'`。
 *
 * 这是 bash 中在单引号字符串内嵌入单引号的标准技巧：
 *   - 结束当前单引号
 *   - 用双引号包裹单引号
 *   - 重新开始单引号
 *
 * @example
 * escapeForSingleQuote("it's") → "it'\"'\"'s"
 * wrapSingleQuote("echo hello") → "'echo hello'"
 * wrapSingleQuote("echo it's") → "'echo it'\"'\"'s'"
 */
function escapeForSingleQuote(str: string): string {
  return str.replace(/'/g, `'"'"'`);
}

function wrapSingleQuote(str: string): string {
  return `'${escapeForSingleQuote(str)}'`;
}

// ---------------------------------------------------------------------------
// Main quoting function
// ---------------------------------------------------------------------------

/**
 * 对 shell 命令进行安全引用，保留 heredoc 和多行字符串的完整性。
 *
 * 返回的字符串可直接用于 `eval`，例如：
 *   const quoted = quoteShellCommand('echo "hello (world)"');
 *   // quoted === "'echo \"hello (world)\"' < /dev/null"
 *   // 完整命令: eval 'echo "hello (world)"' < /dev/null
 *
 * @param command 要引用的原始命令
 * @param addStdinRedirect 是否追加 `< /dev/null` stdin 重定向
 * @returns 安全引用后的命令字符串
 */
export function quoteShellCommand(
  command: string,
  addStdinRedirect: boolean = true,
): string {
  // heredoc 和多行字符串需要特殊处理
  // shell-quote 库会错误地转义这些内容中的 ! 为 \!
  if (containsHeredoc(command) || containsMultilineString(command)) {
    const quoted = wrapSingleQuote(command);

    // heredoc 自带输入，不加 stdin redirect
    if (containsHeredoc(command)) {
      return quoted;
    }

    return addStdinRedirect ? `${quoted} < /dev/null` : quoted;
  }

  // 普通命令：单引号包裹
  const quoted = wrapSingleQuote(command);

  if (addStdinRedirect) {
    return `${quoted} < /dev/null`;
  }

  return quoted;
}
