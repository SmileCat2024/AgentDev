/**
 * LSP Feature - Language Server Protocol 代码智能
 *
 * 为 AI agent 提供代码智能能力：跳转定义、查找引用、悬停提示等
 * 支持 14 种语言的 LSP 服务器，每个支持 exec / runtime 两种启动模式
 */

import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import type { AgentFeature, FeatureInitContext, FeatureManifestDefinition, PackageInfo } from '../../core/feature.js';
import type { FeatureManifestSettingProperty } from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import { LspClient } from './client.js';
import { SERVERS } from './servers.js';
import type { LspFeatureConfig, LspServerConfig, ServerInfo } from './types.js';

const __filename = fileURLToPath(import.meta.url);

export type { LspFeatureConfig, LspServerConfig, ServerInfo, ServerSpawnConfig, ServerDefaults } from './types.js';
export { LspClient } from './client.js';
export { SERVERS } from './servers.js';

function createLspTools(feature: LspFeature): Tool[] {
  const operations = [
    { name: 'lsp_go_to_definition', op: 'goToDefinition', desc: 'Go to symbol definition' },
    { name: 'lsp_find_references', op: 'findReferences', desc: 'Find all references to a symbol' },
    { name: 'lsp_hover', op: 'hover', desc: 'Get type information and documentation' },
    { name: 'lsp_document_symbol', op: 'documentSymbol', desc: 'List all symbols in a document' },
    { name: 'lsp_workspace_symbol', op: 'workspaceSymbol', desc: 'Search for symbols across workspace' },
    { name: 'lsp_go_to_implementation', op: 'goToImplementation', desc: 'Go to interface/abstract implementations' },
    { name: 'lsp_prepare_call_hierarchy', op: 'prepareCallHierarchy', desc: 'Prepare call hierarchy for a symbol' },
    { name: 'lsp_incoming_calls', op: 'incomingCalls', desc: 'Find incoming calls to a function' },
    { name: 'lsp_outgoing_calls', op: 'outgoingCalls', desc: 'Find outgoing calls from a function' },
  ];

  return operations.map(({ name, op, desc }) => ({
    name,
    description: desc,
    parallelizable: true,
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file (relative or absolute)' },
        line: { type: 'number', description: '1-based line number' },
        character: { type: 'number', description: '1-based character position' },
      },
      required: ['filePath', 'line', 'character'],
    },
    async execute(args: { filePath: string; line: number; character: number }) {
      const workdir = feature.getWorkdir();
      const filePath = path.isAbsolute(args.filePath)
        ? args.filePath
        : path.resolve(workdir, args.filePath);

      const fs = await import('fs/promises');
      try { await fs.access(filePath); } catch { throw new Error(`File not found: ${filePath}`); }

      const hasServer = await feature.hasServer(filePath);
      if (!hasServer) throw new Error('No LSP server available for this file type.');

      await feature.touchFile(filePath);

      const position = { file: filePath, line: args.line - 1, character: args.character - 1 };
      const uri = `file://${filePath}`;

      let result: any;
      switch (op) {
        case 'goToDefinition':
          result = await feature.executeOnFile(filePath, (c) => c.definition(position.file, position.line, position.character));
          break;
        case 'findReferences':
          result = await feature.executeOnFile(filePath, (c) => c.references(position.file, position.line, position.character));
          break;
        case 'hover':
          result = await feature.executeOnFile(filePath, (c) => c.hover(position.file, position.line, position.character));
          break;
        case 'documentSymbol':
          result = await feature.executeOnFile(filePath, (c) => c.documentSymbol(uri));
          break;
        case 'workspaceSymbol':
          result = await feature.executeAll((c) => c.workspaceSymbol(''));
          break;
        case 'goToImplementation':
          result = await feature.executeOnFile(filePath, (c) => c.implementation(position.file, position.line, position.character));
          break;
        case 'prepareCallHierarchy':
          result = await feature.executeOnFile(filePath, (c) => c.prepareCallHierarchy(position.file, position.line, position.character));
          break;
        case 'incomingCalls':
          result = await feature.executeOnFile(filePath, (c) => c.incomingCalls(position.file, position.line, position.character));
          break;
        case 'outgoingCalls':
          result = await feature.executeOnFile(filePath, (c) => c.outgoingCalls(position.file, position.line, position.character));
          break;
        default: throw new Error(`Unknown operation: ${op}`);
      }

      const output = Array.isArray(result) && result.length === 0
        ? `No results found for ${op}`
        : JSON.stringify(result, null, 2);

      return {
        title: `${op} ${path.relative(workdir, filePath)}:${args.line}:${args.character}`,
        output,
        metadata: { result },
      };
    },
  }));
}

export class LspFeature implements AgentFeature {
  readonly name = 'lsp';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'LSP (Language Server Protocol) - 提供代码智能能力：跳转定义、查找引用、悬停提示等';

  private config: {
    workdir: string;
    binDir: string;
    disableDownload: boolean;
    runtimes: { nodejs?: string; uv?: string };
    servers: Record<string, LspServerConfig>;
  };

  private _packageInfo: PackageInfo | null = null;
  private logger: { info: (msg: string, data?: any) => void; error: (msg: string, data?: any) => void } | null = null;

  private clients: Map<string, LspClient> = new Map();
  private spawning: Map<string, Promise<LspClient | undefined>> = new Map();
  private broken: Set<string> = new Set();

  constructor(config: LspFeatureConfig = {}) {
    this.config = {
      workdir: config.workdir || process.cwd(),
      binDir: config.binDir || path.join(os.homedir(), '.agentdev', 'lsp-bin'),
      disableDownload: config.disableDownload ?? false,
      runtimes: config.runtimes || {},
      servers: config.servers || {},
    };
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) this._packageInfo = getPackageInfoFromSource(this.source);
    return this._packageInfo;
  }

  getTemplateNames(): string[] { return []; }
  getTools(): Tool[] { return createLspTools(this); }
  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> { return []; }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;

    if (ctx.featureConfig && typeof ctx.featureConfig === 'object') {
      const fc = ctx.featureConfig as Record<string, unknown>;

      // Extract shared runtimes
      if (fc.runtimes && typeof fc.runtimes === 'object') {
        const rt = fc.runtimes as Record<string, unknown>;
        if (typeof rt.nodejs === 'string' && rt.nodejs) this.config.runtimes.nodejs = rt.nodejs;
        if (typeof rt.uv === 'string' && rt.uv) this.config.runtimes.uv = rt.uv;
      }

      // Extract per-server config
      for (const serverId of Object.keys(SERVERS)) {
        const entry = fc[serverId];
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const sc = entry as Record<string, unknown>;
          const existing = this.config.servers[serverId] || {};
          if (typeof sc.mode === 'string') (existing as any).mode = sc.mode;
          if (typeof sc.runtime === 'string') (existing as any).runtime = sc.runtime;
          if (typeof sc.binary === 'string') existing.binary = sc.binary;
          if (typeof sc.package === 'string') (existing as any).package = sc.package;
          if (typeof sc.uvPackage === 'string') (existing as any).uvPackage = sc.uvPackage;
          if (typeof sc.args === 'string' && sc.args.trim()) {
            (existing as any).args = sc.args.trim().split(/\s+/);
          }
          this.config.servers[serverId] = existing;
        }
      }
    }

    this.logger.info('LSP Feature initialized', { workdir: this.config.workdir });
  }

  async onDestroy(): Promise<void> {
    this.logger?.info('LSP Feature shutting down');
    await this.shutdownAll();
  }

  // ── Manifest ────────────────────────────────────────────────

  getFeatureManifest(): FeatureManifestDefinition {
    const serverDefs: Array<{ id: string; name: string }> = [
      { id: 'typescript', name: 'TypeScript / JavaScript' },
      { id: 'pyright', name: 'Python (Pyright)' },
      { id: 'gopls', name: 'Go (gopls)' },
      { id: 'rust-analyzer', name: 'Rust (rust-analyzer)' },
      { id: 'clangd', name: 'C/C++ (clangd)' },
      { id: 'vue', name: 'Vue' },
      { id: 'svelte', name: 'Svelte' },
      { id: 'eslint', name: 'ESLint' },
      { id: 'deno', name: 'Deno' },
      { id: 'bash', name: 'Bash' },
      { id: 'yaml', name: 'YAML' },
      { id: 'json', name: 'JSON' },
      { id: 'html', name: 'HTML' },
      { id: 'css', name: 'CSS' },
    ];

    const properties: Record<string, FeatureManifestSettingProperty> = {
      runtimes: {
        type: 'group',
        title: 'Runtimes',
        description: 'Shared runtime paths. Leave empty to auto-detect from PATH.',
        properties: {
          nodejs: { type: 'file', title: 'Node.js', placeholder: 'Auto-detect' },
          uv: { type: 'file', title: 'uv / uvx', placeholder: 'Auto-detect' },
        },
      },
    };

    for (const server of serverDefs) {
      const defaults = SERVERS[server.id]?.defaults;
      properties[server.id] = {
        type: 'group',
        title: server.name,
        properties: {
          mode: {
            type: 'select',
            title: 'Mode',
            default: defaults?.defaultMode,
            options: [
              { label: 'Exec (Binary)', value: 'exec' },
              { label: 'Runtime (npx/uvx)', value: 'runtime' },
            ],
          },
          binary: {
            type: 'file',
            title: 'Binary',
            placeholder: 'Auto-detect',
            default: defaults?.execBinary,
            showWhen: { property: 'mode', values: ['exec'] },
          },
          runtime: {
            type: 'select',
            title: 'Runtime',
            default: defaults?.defaultRuntime || 'nodejs',
            options: [
              { label: 'Node.js (npx)', value: 'nodejs' },
              { label: 'uv (uvx)', value: 'uv' },
            ],
            showWhen: { property: 'mode', values: ['runtime'] },
          },
          package: {
            type: 'string',
            title: 'Package (npx)',
            description: defaults?.runtimePackage ? `Default: ${defaults.runtimePackage}` : '',
            placeholder: defaults?.runtimePackage || 'e.g. typescript-language-server',
            showWhen: { property: 'mode', values: ['runtime'] },
          },
          uvPackage: {
            type: 'string',
            title: 'Package (uvx)',
            description: defaults?.uvPackage ? `Default: ${defaults.uvPackage}` : (defaults?.runtimePackage ? `Default: ${defaults.runtimePackage}` : ''),
            placeholder: defaults?.uvPackage || defaults?.runtimePackage || '',
            showWhen: { property: 'runtime', values: ['uv'] },
          },
          args: {
            type: 'string',
            title: 'Arguments',
            description: defaults?.runtimeArgs?.length ? `Default: ${defaults.runtimeArgs.join(' ')}` : '',
            placeholder: defaults?.runtimeArgs?.join(' ') || '--stdio',
          },
        },
      };
    }

    return {
      schemaVersion: 1,
      settings: {
        properties,
        sections: [
          { id: 'runtimes', title: 'Runtimes', properties: ['runtimes'] },
          { id: 'lsp', title: 'Language Servers', properties: serverDefs.map(s => s.id) },
        ],
      },
    };
  }

  // ── State ───────────────────────────────────────────────────

  captureState(): { activeServerIds: string[] } {
    return { activeServerIds: Array.from(this.clients.keys()) };
  }

  restoreState(_state: any): void {
    this.logger?.info('LSP Feature state restored, servers will be started on demand');
  }

  // ── Public API ──────────────────────────────────────────────

  getWorkdir(): string { return this.config.workdir; }

  async hasServer(file: string): Promise<boolean> {
    const extension = path.extname(file) || file;
    for (const server of Object.values(SERVERS)) {
      const serverConfig = this.config.servers?.[server.id];
      if (serverConfig?.disabled) continue;
      if (server.extensions.length && !server.extensions.includes(extension)) continue;
      const root = await server.root(file);
      if (root) return true;
    }
    return false;
  }

  async touchFile(file: string): Promise<void> {
    const clients = await this.getClientsForFile(file);
    await Promise.all(
      clients.map(async (client) => {
        const wait = client.waitForDiagnostics(file);
        await client.notifyOpen(file);
        return wait;
      })
    ).catch((err) => {
      this.logger?.error('failed to touch file', { err, file });
    });
  }

  async executeOnFile<T>(file: string, fn: (client: LspClient) => Promise<T>): Promise<T[]> {
    const clients = await this.getClientsForFile(file);
    return Promise.all(clients.map((client) => fn(client)));
  }

  async executeAll<T>(fn: (client: LspClient) => Promise<T>): Promise<T[]> {
    return Promise.all(Array.from(this.clients.values()).map((client) => fn(client)));
  }

  // ── Internal ────────────────────────────────────────────────

  private async getClientsForFile(file: string): Promise<LspClient[]> {
    const extension = path.extname(file) || file;
    const result: LspClient[] = [];

    for (const server of Object.values(SERVERS)) {
      const serverConfig = this.config.servers?.[server.id];
      if (serverConfig?.disabled) continue;
      if (server.extensions.length && !server.extensions.includes(extension)) continue;

      const root = await server.root(file);
      if (!root) continue;

      const key = root + server.id;
      if (this.broken.has(key)) continue;

      const existing = this.clients.get(key);
      if (existing) { result.push(existing); continue; }

      const inflight = this.spawning.get(key);
      if (inflight) { const c = await inflight; if (c) result.push(c); continue; }

      const task = this.spawnServer(server, root, serverConfig);
      this.spawning.set(key, task);
      task.finally(() => { if (this.spawning.get(key) === task) this.spawning.delete(key); });

      const client = await task;
      if (client) result.push(client);
    }

    return result;
  }

  private async spawnServer(
    server: ServerInfo,
    root: string,
    serverConfig?: LspServerConfig
  ): Promise<LspClient | undefined> {
    const key = root + server.id;
    const spawnConfig = {
      binDir: this.config.binDir,
      workdir: this.config.workdir,
      disableDownload: this.config.disableDownload,
      binary: serverConfig?.binary,
      mode: (serverConfig as any)?.mode,
      runtime: (serverConfig as any)?.runtime,
      package: (serverConfig as any)?.package,
      uvPackage: (serverConfig as any)?.uvPackage,
      args: (serverConfig as any)?.args,
      runtimes: this.config.runtimes,
      env: serverConfig?.env,
      initialization: serverConfig?.initialization,
    };

    let handle;
    try {
      const result = await server.spawn(root, spawnConfig);
      if (!result) {
        this.logger?.error(`LSP server ${server.id} spawn returned undefined`);
        this.broken.add(key);
        return undefined;
      }
      handle = result;
    } catch (err: any) {
      this.logger?.error(`Failed to spawn LSP server ${server.id}`, {
        error: err, errorMessage: err.message, errorStack: err.stack,
      });
      this.broken.add(key);
      return undefined;
    }

    this.logger?.info('spawned lsp server', { serverID: server.id, pid: handle.process.pid });

    handle.process.on('error', (err: Error) => {
      this.logger?.error(`LSP server ${server.id} process error`, { error: err });
      this.broken.add(key);
      this.clients.delete(key);
    });

    const client = new LspClient(server.id, handle, root, this.logger!);
    try {
      await client.initialize();
    } catch (err: any) {
      this.logger?.error(`Failed to initialize LSP client ${server.id}`, {
        error: err, errorMessage: err.message, errorStack: err.stack,
      });
      this.broken.add(key);
      try { handle.process.kill(15); } catch {}
      return undefined;
    }

    const existing = this.clients.get(key);
    if (existing) {
      try { handle.process.kill(15); } catch {}
      return existing;
    }

    this.clients.set(key, client);
    return client;
  }

  private async shutdownAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map((client) => client.shutdown()));
    this.clients.clear();
    this.spawning.clear();
    this.broken.clear();
  }
}
