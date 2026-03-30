#!/usr/bin/env node

/**
 * Copy feature skill files (SKILL.md) from src to dist
 * Mirrors the pattern used for .render.ts → .render.js template compilation:
 *   tsup handles .render.ts compilation
 *   this script handles .md skill files
 *
 * Source: src/features/{featureName}/skills/**
 * Target: dist/features/{featureName}/skills/**
 */

import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcFeaturesDir = join(rootDir, 'src', 'features');
const distFeaturesDir = join(rootDir, 'dist', 'features');

function copyDir(src, dest) {
  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      console.log(`  ${relative(rootDir, srcPath)} -> ${relative(rootDir, destPath)}`);
    }
  }
}

let count = 0;

if (!existsSync(srcFeaturesDir)) {
  console.log('No src/features directory found, skipping.');
  process.exit(0);
}

const features = readdirSync(srcFeaturesDir, { withFileTypes: true });

for (const feature of features) {
  if (!feature.isDirectory()) continue;

  const skillsDir = join(srcFeaturesDir, feature.name, 'skills');
  if (!existsSync(skillsDir)) continue;

  const distSkillsDir = join(distFeaturesDir, feature.name, 'skills');
  console.log(`Feature "${feature.name}": copying skills/`);
  copyDir(skillsDir, distSkillsDir);
  count++;
}

console.log(`\nCopied skills for ${count} feature(s).`);
