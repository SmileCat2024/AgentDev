/**
 * LSP 服务器定义
 *
 * 支持 14 种语言的 LSP 服务器
 * 每个服务器通过 ServerDefaults 声明启动模式与包名，
 * resolveSpawn() 根据 mode/runtime 统一派生 spawn 参数。
 */

import { spawn } from 'child_process';
import path from 'path';
import { access } from 'fs/promises';
import type { ServerInfo, ServerSpawnConfig, ServerDefaults } from './types.js';
import { findExecutable } from './which.js';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.abap': 'abap', '.bat': 'bat', '.bib': 'bibtex', '.clj': 'clojure',
  '.cljs': 'clojure', '.cljc': 'clojure', '.coffee': 'coffeescript',
  '.c': 'c', '.cpp': 'cpp', '.cxx': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.css': 'css', '.d': 'd', '.pas': 'pascal',
  '.diff': 'diff', '.patch': 'diff', '.dart': 'dart',
  '.dockerfile': 'dockerfile', '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang', '.hrl': 'erlang', '.fs': 'fsharp', '.fsi': 'fsharp',
  '.fsx': 'fsharp', '.go': 'go', '.groovy': 'groovy', '.gleam': 'gleam',
  '.hbs': 'handlebars', '.hs': 'haskell', '.lhs': 'haskell',
  '.html': 'html', '.htm': 'html', '.ini': 'ini', '.java': 'java',
  '.js': 'javascript', '.kt': 'kotlin', '.kts': 'kotlin',
  '.jsx': 'javascriptreact', '.json': 'json', '.tex': 'latex',
  '.less': 'less', '.lua': 'lua', '.md': 'markdown', '.markdown': 'markdown',
  '.m': 'objective-c', '.mm': 'objective-cpp', '.pl': 'perl', '.pm': 'perl',
  '.php': 'php', '.ps1': 'powershell', '.py': 'python', '.r': 'r',
  '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby', '.erb': 'erb',
  '.rs': 'rust', '.scss': 'scss', '.sass': 'sass', '.scala': 'scala',
  '.sh': 'shellscript', '.bash': 'shellscript', '.zsh': 'shellscript',
  '.sql': 'sql', '.svelte': 'svelte', '.swift': 'swift',
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript',
  '.cts': 'typescript', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
  '.mjs': 'javascript', '.cjs': 'javascript', '.vue': 'vue',
  '.zig': 'zig', '.astro': 'astro', '.ml': 'ocaml', '.mli': 'ocaml',
  '.tf': 'terraform', '.nix': 'nix',
};

function nearestRoot(
  markers: string[],
  excludeMarkers?: string[]
): (file: string) => Promise<string | undefined> {
  return async (file: string) => {
    let current = path.dirname(file);
    while (true) {
      for (const marker of markers) {
        if (await pathExists(path.join(current, marker))) {
          if (excludeMarkers) {
            for (const exclude of excludeMarkers) {
              if (await pathExists(path.join(current, exclude))) {
                return undefined;
              }
            }
          }
          return current;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  };
}

// ── resolveSpawn ────────────────────────────────────────────────

function resolveSpawn(
  defaults: ServerDefaults,
  config: ServerSpawnConfig,
  root: string,
  extraInit?: Record<string, any>
): { process: any; initialization?: Record<string, any> } | undefined {
  const mode = config.mode || defaults.defaultMode;
  const args = config.args || [];

  if (mode === 'exec') {
    const bin = config.binary || findExecutable(defaults.execBinary || '');
    if (!bin) return undefined;
    const proc = spawn(bin, [...(defaults.execArgs || []), ...args], {
      cwd: root,
      env: { ...process.env, ...config.env },
    });
    return { process: proc, initialization: { ...extraInit, ...config.initialization } };
  }

  // runtime mode
  const runtime = config.runtime || defaults.defaultRuntime || 'nodejs';

  if (runtime === 'uv') {
    const bin = config.runtimes?.uv || findExecutable('uv');
    if (!bin) return undefined;
    const pkg = config.uvPackage || config.package || defaults.uvPackage || defaults.runtimePackage || '';
    const proc = spawn(bin, ['tool', 'run', ...(pkg ? [pkg] : []), ...(defaults.runtimeArgs || []), ...args], {
      cwd: root,
      env: { ...process.env, ...config.env },
    });
    return { process: proc, initialization: { ...extraInit, ...config.initialization } };
  }

  // nodejs — npx semantics
  const npxBin = config.runtimes?.nodejs
    ? path.join(path.dirname(config.runtimes.nodejs), process.platform === 'win32' ? 'npx.cmd' : 'npx')
    : findExecutable('npx');
  if (!npxBin) return undefined;
  const pkg = config.package || defaults.runtimePackage || '';
  const proc = spawn(npxBin, ['-y', ...(pkg ? [pkg] : []), ...(defaults.runtimeArgs || []), ...args], {
    cwd: root,
    env: { ...process.env, ...config.env },
    shell: true,
  });
  return { process: proc, initialization: { ...extraInit, ...config.initialization } };
}

// ── Server definitions ──────────────────────────────────────────

export const Typescript: ServerInfo = {
  id: 'typescript',
  defaults: {
    defaultMode: 'runtime', defaultRuntime: 'nodejs',
    execBinary: 'typescript-language-server', execArgs: ['--stdio'],
    runtimePackage: 'typescript-language-server', runtimeArgs: ['--stdio'],
  },
  root: nearestRoot(
    ['package-lock.json', 'bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock'],
    ['deno.json', 'deno.jsonc']
  ),
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Python: ServerInfo = {
  id: 'pyright',
  defaults: {
    defaultMode: 'runtime', defaultRuntime: 'nodejs',
    execBinary: 'pyright-langserver', execArgs: ['--stdio'],
    runtimePackage: 'pyright-langserver', runtimeArgs: ['--stdio'],
    uvPackage: 'pyright',
  },
  root: nearestRoot([
    'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'pyrightconfig.json',
  ]),
  extensions: ['.py', '.pyi'],
  async spawn(root, config) {
    const initialization: Record<string, any> = {};
    const venvPaths = [
      process.env.VIRTUAL_ENV,
      path.join(root, '.venv'),
      path.join(root, 'venv'),
    ].filter(Boolean) as string[];
    for (const venvPath of venvPaths) {
      const pythonPath =
        process.platform === 'win32'
          ? path.join(venvPath, 'Scripts', 'python.exe')
          : path.join(venvPath, 'bin', 'python');
      if (await pathExists(pythonPath)) {
        initialization.pythonPath = pythonPath;
        break;
      }
    }
    return resolveSpawn(this.defaults, config, root, initialization);
  },
};

export const Go: ServerInfo = {
  id: 'gopls',
  defaults: {
    defaultMode: 'exec',
    execBinary: 'gopls',
  },
  root: async (file: string) => {
    const workRoot = await nearestRoot(['go.work'])(file);
    if (workRoot) return workRoot;
    return nearestRoot(['go.mod', 'go.sum'])(file);
  },
  extensions: ['.go'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Rust: ServerInfo = {
  id: 'rust-analyzer',
  defaults: {
    defaultMode: 'exec',
    execBinary: 'rust-analyzer',
  },
  root: nearestRoot(['Cargo.toml', 'Cargo.lock']),
  extensions: ['.rs'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Clangd: ServerInfo = {
  id: 'clangd',
  defaults: {
    defaultMode: 'exec',
    execBinary: 'clangd',
    execArgs: ['--background-index', '--clang-tidy'],
  },
  root: nearestRoot(['compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt', 'Makefile']),
  extensions: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Vue: ServerInfo = {
  id: 'vue',
  defaults: {
    defaultMode: 'runtime', defaultRuntime: 'nodejs',
    execBinary: 'vue-language-server', execArgs: ['--stdio'],
    runtimePackage: '@vue/language-server', runtimeArgs: ['--stdio'],
  },
  root: nearestRoot(['package-lock.json', 'bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock']),
  extensions: ['.vue'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Svelte: ServerInfo = {
  id: 'svelte',
  defaults: {
    defaultMode: 'runtime', defaultRuntime: 'nodejs',
    execBinary: 'svelteserver', execArgs: ['--stdio'],
    runtimePackage: 'svelte-language-server', runtimeArgs: ['--stdio'],
  },
  root: nearestRoot(['package-lock.json', 'bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock']),
  extensions: ['.svelte'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const ESLint: ServerInfo = {
  id: 'eslint',
  defaults: {
    defaultMode: 'runtime', defaultRuntime: 'nodejs',
    runtimePackage: 'vscode-eslint-language-server', runtimeArgs: ['--stdio'],
  },
  root: nearestRoot(['package-lock.json', 'bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock']),
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue'],
  async spawn(root, config) {
    const localBin = path.join(root, 'node_modules', '.bin', 'eslint');
    if (!(await pathExists(localBin))) return undefined;
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Deno: ServerInfo = {
  id: 'deno',
  defaults: {
    defaultMode: 'exec',
    execBinary: 'deno',
    execArgs: ['lsp'],
  },
  root: async (file: string) => {
    const files = ['deno.json', 'deno.jsonc'];
    let current = path.dirname(file);
    while (true) {
      for (const f of files) {
        if (await pathExists(path.join(current, f))) return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  },
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Bash: ServerInfo = {
  id: 'bash',
  defaults: {
    defaultMode: 'runtime', defaultRuntime: 'nodejs',
    execBinary: 'bash-language-server', execArgs: ['start'],
    runtimePackage: 'bash-language-server', runtimeArgs: ['start'],
  },
  root: async () => process.cwd(),
  extensions: ['.sh', '.bash', '.zsh', '.ksh'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Yaml: ServerInfo = {
  id: 'yaml',
  defaults: {
    defaultMode: 'runtime', defaultRuntime: 'nodejs',
    execBinary: 'yaml-language-server', execArgs: ['--stdio'],
    runtimePackage: 'yaml-language-server', runtimeArgs: ['--stdio'],
  },
  root: async () => process.cwd(),
  extensions: ['.yaml', '.yml'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Json: ServerInfo = {
  id: 'json',
  defaults: {
    defaultMode: 'runtime', defaultRuntime: 'nodejs',
    execBinary: 'vscode-json-language-server', execArgs: ['--stdio'],
    runtimePackage: 'vscode-languageserver-json', runtimeArgs: ['--stdio'],
  },
  root: async () => process.cwd(),
  extensions: ['.json', '.jsonc'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Html: ServerInfo = {
  id: 'html',
  defaults: {
    defaultMode: 'runtime', defaultRuntime: 'nodejs',
    execBinary: 'vscode-html-language-server', execArgs: ['--stdio'],
    runtimePackage: 'vscode-languageserver-html', runtimeArgs: ['--stdio'],
  },
  root: async () => process.cwd(),
  extensions: ['.html', '.htm'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const Css: ServerInfo = {
  id: 'css',
  defaults: {
    defaultMode: 'runtime', defaultRuntime: 'nodejs',
    execBinary: 'vscode-css-language-server', execArgs: ['--stdio'],
    runtimePackage: 'vscode-languageserver-css', runtimeArgs: ['--stdio'],
  },
  root: async () => process.cwd(),
  extensions: ['.css', '.scss', '.less'],
  async spawn(root, config) {
    return resolveSpawn(this.defaults, config, root);
  },
};

export const SERVERS: Record<string, ServerInfo> = {
  typescript: Typescript,
  pyright: Python,
  gopls: Go,
  'rust-analyzer': Rust,
  clangd: Clangd,
  vue: Vue,
  svelte: Svelte,
  eslint: ESLint,
  deno: Deno,
  bash: Bash,
  yaml: Yaml,
  json: Json,
  html: Html,
  css: Css,
};
