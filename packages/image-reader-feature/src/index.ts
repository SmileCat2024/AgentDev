/**
 * ImageReaderFeature - 图片读取能力
 *
 * 提供 read_image 工具，让 Agent 能主动读取本地图片文件，
 * 并将图片直接注入到对话上下文中（而非用文字描述）。
 *
 * 未来可扩展：read_pdf（将 PDF 页面渲染为图片后注入）等。
 */

import { fileURLToPath } from 'url';
import type { AgentFeature, Tool, PackageInfo, FeatureManifestDefinition } from '@agentdev/core';
import { getPackageInfoFromSource } from '@agentdev/core';
import { createReadImageTool } from './tools.js';

export interface ImageReaderFeatureConfig {
  /** 工作目录（用于解析相对路径） */
  workspaceDir?: string;
  /** 受管图片快照目录；默认 ~/.agentdev/images */
  storageDir?: string;
}

export class ImageReaderFeature implements AgentFeature {
  readonly name = 'image-reader';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = '提供图片读取工具（read_image），让 Agent 能主动读取本地图片并注入到上下文中。';

  private readonly config: ImageReaderFeatureConfig;
  private _packageInfo: PackageInfo | null = null;

  constructor(config: ImageReaderFeatureConfig = {}) {
    this.config = config;
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  getTemplateNames(): string[] {
    return [];
  }

  getTools(): Tool[] {
    return [createReadImageTool(this.config)];
  }

  getFeatureManifest(): FeatureManifestDefinition {
    return {
      schemaVersion: 1 as const,
      settings: {
        properties: {},
      },
    };
  }
}

export { createReadImageTool } from './tools.js';
