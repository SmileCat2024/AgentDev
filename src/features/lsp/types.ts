/**
 * LSP Feature 类型定义
 */

import type { ChildProcessWithoutNullStreams } from 'child_process';

/**
 * LSP Server handle returned by spawn functions
 */
export interface LspServerHandle {
  process: any;
  initialization?: Record<string, any>;
}

/**
 * Server default metadata
 */
export interface ServerDefaults {
  defaultMode: 'exec' | 'runtime';
  defaultRuntime?: 'nodejs' | 'uv';
  execBinary?: string;
  execArgs?: string[];
  runtimePackage?: string;
  runtimeArgs?: string[];
  /** Package name override for uv runtime (if different from runtimePackage) */
  uvPackage?: string;
}

/**
 * Configuration for a single LSP server
 */
export interface LspServerConfig {
  disabled?: boolean;
  binary?: string;
  /** Launch mode override */
  mode?: 'exec' | 'runtime';
  /** Runtime type, only meaningful when mode='runtime' */
  runtime?: 'nodejs' | 'uv';
  /** npm package name for nodejs runtime (npx <package>) */
  package?: string;
  /** Package name for uv runtime (uv tool run <package>), if different */
  uvPackage?: string;
  /** Additional arguments passed to the server */
  args?: string[];
  command?: string[];
  extensions?: string[];
  env?: Record<string, string>;
  initialization?: Record<string, any>;
}

/**
 * LSP Feature configuration
 */
export interface LspFeatureConfig {
  workdir?: string;
  binDir?: string;
  disableDownload?: boolean;
  /** Shared runtime binary paths */
  runtimes?: {
    nodejs?: string;
    uv?: string;
  };
  servers?: Record<string, LspServerConfig>;
}

/**
 * Server handle returned by spawn functions
 */
export interface ServerHandle {
  process: any;
  initialization?: Record<string, any>;
}

/**
 * Root function type for finding project root
 */
export type RootFunction = (file: string) => Promise<string | undefined>;

/**
 * Server info definition
 */
export interface ServerInfo {
  id: string;
  extensions: string[];
  root: RootFunction;
  defaults: ServerDefaults;
  spawn(root: string, config: ServerSpawnConfig): Promise<ServerHandle | undefined>;
}

/**
 * Server spawn configuration
 */
export interface ServerSpawnConfig {
  binDir: string;
  workdir: string;
  disableDownload?: boolean;
  binary?: string;
  /** Launch mode from per-server config */
  mode?: 'exec' | 'runtime';
  /** Runtime type from per-server config */
  runtime?: 'nodejs' | 'uv';
  /** Package name for npx runtime */
  package?: string;
  /** Package name for uv runtime */
  uvPackage?: string;
  /** Additional args (both modes) */
  args?: string[];
  /** Resolved shared runtime paths */
  runtimes?: {
    nodejs?: string;
    uv?: string;
  };
  env?: Record<string, string>;
  initialization?: Record<string, any>;
}
