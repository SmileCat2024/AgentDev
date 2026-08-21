/**
 * LSP Client - 通过 JSON-RPC 与 LSP 服务器通信
 */

import { EventEmitter } from 'events';
import path from 'path';
import { readFile } from 'fs/promises';
import { pathToFileURL, fileURLToPath } from 'url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js';
import type { Diagnostic } from 'vscode-languageserver-types';
import { LANGUAGE_EXTENSIONS } from './servers.js';
import type { LspServerHandle } from './types.js';

const DIAGNOSTICS_DEBOUNCE_MS = 150;
const INIT_TIMEOUT_MS = 45000;
const DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * LSP Client - 处理与 LSP 服务器的 JSON-RPC 通信
 */
export class LspClient extends EventEmitter {
  private connection: any;
  private diagnostics: Map<string, Diagnostic[]> = new Map();
  private files: Record<string, number> = {};

  constructor(
    private serverID: string,
    private handle: LspServerHandle,
    private root: string,
    private logger: { info: (msg: string, data?: any) => void; error: (msg: string, data?: any) => void }
  ) {
    super();
    this.connection = createMessageConnection(
      new StreamMessageReader(handle.process.stdout),
      new StreamMessageWriter(handle.process.stdin)
    );
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.connection.onNotification('textDocument/publishDiagnostics', (params: any) => {
      const filePath = normalizePath(fileURLToPath(params.uri));
      this.logger.info('diagnostics received', {
        path: filePath,
        count: params.diagnostics.length,
      });
      this.diagnostics.set(filePath, params.diagnostics);
      this.emit('diagnostics', { path: filePath, serverID: this.serverID });
    });

    this.connection.onRequest('window/workDoneProgress/create', () => null);
    this.connection.onRequest('workspace/configuration', async () => [
      this.handle.initialization ?? {},
    ]);
    this.connection.onRequest('client/registerCapability', async () => {});
    this.connection.onRequest('client/unregisterCapability', async () => {});
    this.connection.onRequest('workspace/workspaceFolders', async () => [
      { name: 'workspace', uri: pathToFileURL(this.root).href },
    ]);
  }

  async initialize(): Promise<void> {
    this.connection.listen();
    this.logger.info('sending initialize');

    await withTimeout(
      this.connection.sendRequest('initialize', {
        rootUri: pathToFileURL(this.root).href,
        processId: this.handle.process.pid,
        workspaceFolders: [{ name: 'workspace', uri: pathToFileURL(this.root).href }],
        initializationOptions: { ...this.handle.initialization },
        capabilities: {
          window: { workDoneProgress: true },
          workspace: {
            configuration: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
          textDocument: {
            synchronization: { didOpen: true, didChange: true },
            publishDiagnostics: { versionSupport: true },
          },
        },
      }),
      INIT_TIMEOUT_MS
    );

    await this.connection.sendNotification('initialized', {});

    if (this.handle.initialization) {
      await this.connection.sendNotification('workspace/didChangeConfiguration', {
        settings: this.handle.initialization,
      });
    }

    this.logger.info('initialized');
  }

  get serverId(): string {
    return this.serverID;
  }

  get clientRoot(): string {
    return this.root;
  }

  getDiagnostics(): Map<string, Diagnostic[]> {
    return this.diagnostics;
  }

  async notifyOpen(filePath: string): Promise<void> {
    filePath = path.isAbsolute(filePath) ? filePath : path.resolve(this.root, filePath);
    const text = await readFile(filePath, 'utf-8');
    const extension = path.extname(filePath);
    const languageId = LANGUAGE_EXTENSIONS[extension] ?? 'plaintext';
    const version = this.files[filePath];

    if (version !== undefined) {
      await this.connection.sendNotification('workspace/didChangeWatchedFiles', {
        changes: [{ uri: pathToFileURL(filePath).href, type: 2 }],
      });
      const next = version + 1;
      this.files[filePath] = next;
      await this.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri: pathToFileURL(filePath).href, version: next },
        contentChanges: [{ text }],
      });
    } else {
      await this.connection.sendNotification('workspace/didChangeWatchedFiles', {
        changes: [{ uri: pathToFileURL(filePath).href, type: 1 }],
      });
      this.diagnostics.delete(filePath);
      await this.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: pathToFileURL(filePath).href,
          languageId,
          version: 0,
          text,
        },
      });
      this.files[filePath] = 0;
    }
  }

  async waitForDiagnostics(filePath: string): Promise<void> {
    const normalizedPath = normalizePath(
      path.isAbsolute(filePath) ? filePath : path.resolve(this.root, filePath)
    );

    return withTimeout(
      new Promise<void>((resolve) => {
        let debounceTimer: NodeJS.Timeout;
        const handler = (data: { path: string; serverID: string }) => {
          if (data.path === normalizedPath && data.serverID === this.serverID) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              this.off('diagnostics', handler);
              resolve();
            }, DIAGNOSTICS_DEBOUNCE_MS);
          }
        };
        this.on('diagnostics', handler);
      }),
      DIAGNOSTICS_WAIT_TIMEOUT_MS
    ).catch(() => {});
  }

  // LSP request methods
  async definition(filePath: string, line: number, character: number): Promise<unknown> {
    return this.connection
      .sendRequest('textDocument/definition', {
        textDocument: { uri: pathToFileURL(filePath).href },
        position: { line, character },
      })
      .catch(() => null);
  }

  async references(filePath: string, line: number, character: number): Promise<unknown> {
    return this.connection
      .sendRequest('textDocument/references', {
        textDocument: { uri: pathToFileURL(filePath).href },
        position: { line, character },
        context: { includeDeclaration: true },
      })
      .catch(() => []);
  }

  async hover(filePath: string, line: number, character: number): Promise<unknown> {
    return this.connection
      .sendRequest('textDocument/hover', {
        textDocument: { uri: pathToFileURL(filePath).href },
        position: { line, character },
      })
      .catch(() => null);
  }

  async documentSymbol(uri: string): Promise<unknown> {
    return this.connection
      .sendRequest('textDocument/documentSymbol', { textDocument: { uri } })
      .catch(() => []);
  }

  async workspaceSymbol(query: string): Promise<unknown> {
    return this.connection.sendRequest('workspace/symbol', { query }).catch(() => []);
  }

  async implementation(filePath: string, line: number, character: number): Promise<unknown> {
    return this.connection
      .sendRequest('textDocument/implementation', {
        textDocument: { uri: pathToFileURL(filePath).href },
        position: { line, character },
      })
      .catch(() => null);
  }

  async prepareCallHierarchy(filePath: string, line: number, character: number): Promise<unknown> {
    return this.connection
      .sendRequest('textDocument/prepareCallHierarchy', {
        textDocument: { uri: pathToFileURL(filePath).href },
        position: { line, character },
      })
      .catch(() => []);
  }

  async incomingCalls(filePath: string, line: number, character: number): Promise<unknown> {
    return this.connection
      .sendRequest('callHierarchy/incomingCalls', {
        item: {
          uri: pathToFileURL(filePath).href,
          range: {
            start: { line, character },
            end: { line, character },
          },
        },
      })
      .catch(() => []);
  }

  async outgoingCalls(filePath: string, line: number, character: number): Promise<unknown> {
    return this.connection
      .sendRequest('callHierarchy/outgoingCalls', {
        item: {
          uri: pathToFileURL(filePath).href,
          range: {
            start: { line, character },
            end: { line, character },
          },
        },
      })
      .catch(() => []);
  }

  async shutdown(): Promise<void> {
    try {
      await this.connection.sendRequest('shutdown');
      await this.connection.sendNotification('exit');
    } catch (error) {
      this.logger.error('Error during LSP shutdown', { error });
    }
    this.connection.dispose();
  }
}
