#!/usr/bin/env node

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distCliDir = join(__dirname, '..', 'dist', 'cli');

const viewerCmd = `@echo off\nnode "%~dp0\\viewer.js" %*\n`;
const serverCmd = `@echo off\nnode "%~dp0\\server.js" %*\n`;

writeFileSync(join(distCliDir, 'viewer.cmd'), viewerCmd, 'utf-8');
writeFileSync(join(distCliDir, 'server.cmd'), serverCmd, 'utf-8');

console.log('Generated .cmd files for Windows bin commands');
