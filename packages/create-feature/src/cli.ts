#!/usr/bin/env node
/**
 * @agentdev/create-feature CLI
 *
 * 创建新的 AgentDev Feature 包
 *
 * 使用方式：
 *   create-agentdev-feature my-feature
 *   npm init agentdev-feature my-feature
 *   npx @agentdev/create-feature my-feature
 */

import { createFeature } from './create.js';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: create-agentdev-feature <feature-name>');
  console.error('Example: create-agentdev-feature my-feature');
  process.exit(1);
}

const featureName = args[0];

createFeature(featureName).catch((error) => {
  console.error(`Error creating feature: ${error.message}`);
  process.exit(1);
});
