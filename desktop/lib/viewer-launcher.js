const { spawn, execSync } = require('child_process');
const { join } = require('path');
const { writeFileSync, appendFileSync, existsSync } = require('fs');
const http = require('http');

const DEFAULT_PORT = 2026;
const HEALTH_CHECK_INTERVAL = 1000;
const HEALTH_CHECK_TIMEOUT = 30000;

// 文件日志工具
class Logger {
  constructor() {
    this.logFile = join(process.env.TEMP || '/tmp', 'agentdev-desktop-debug.log');
    this.write('='.repeat(60));
    this.write(`[Logger] 日志文件: ${this.logFile}`);
    this.write(`[Logger] 时间: ${new Date().toISOString()}`);
    this.write(`[Logger] Electron: ${process.versions.electron || '未打包'}`);
    this.write(`[Logger] Node: ${process.versions.node}`);
    this.write(`[Logger] execPath: ${process.execPath}`);
    this.write(`[Logger] resourcesPath: ${process.resourcesPath || '未打包'}`);
    this.write(`[Logger] __dirname: ${__dirname}`);
    this.write('='.repeat(60));
  }

  write(message) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    const line = `[${timestamp}] ${message}\n`;
    try {
      appendFileSync(this.logFile, line, 'utf8');
    } catch (e) {
      // 忽略写入错误
    }
    console.log(message); // 同时输出到控制台
  }

  error(message) {
    this.write(`[ERROR] ${message}`);
  }
}

const logger = new Logger();

class ViewerLauncher {
  constructor(port = DEFAULT_PORT) {
    this.port = port;
    this.workerProcess = null;
    this.healthCheckTimer = null;
    logger.write(`[ViewerLauncher] 构造函数，端口: ${port}`);
  }

  /**
   * 获取用于启动 worker 的 Node.js 可执行文件路径
   */
  getNodeExecutablePath() {
    logger.write(`[getNodeExecutablePath] 开始执行`);

    // 开发环境：使用 process.execPath（即 node.exe）
    if (!process.versions.electron) {
      logger.write(`[getNodeExecutablePath] 开发环境，使用 process.execPath: ${process.execPath}`);
      return process.execPath;
    }

    // 打包后：使用 extraResources 中的 node.exe
    if (process.resourcesPath) {
      const nodePath = join(process.resourcesPath, 'node.exe');
      logger.write(`[getNodeExecutablePath] 打包环境，尝试路径: ${nodePath}`);
      logger.write(`[getNodeExecutablePath] 文件存在: ${existsSync(nodePath)}`);
      return nodePath;
    }

    logger.write(`[getNodeExecutablePath] 回退到系统 node`);
    return 'node.exe';
  }

  async start() {
    logger.write('[ViewerLauncher] start() 开始执行');

    if (this.workerProcess) {
      logger.write('[ViewerLauncher] ViewerWorker 已在运行');
      return true;
    }

    const workerPath = this.getWorkerPath();
    const projectRoot = this.getProjectRoot();
    const nodePath = this.getNodeExecutablePath();

    logger.write(`=== 启动参数 ===`);
    logger.write(`Node 路径: ${nodePath}`);
    logger.write(`Worker 路径: ${workerPath}`);
    logger.write(`工作目录: ${projectRoot}`);
    logger.write(`端口: ${this.port}`);
    logger.write(`================`);

    // 检查文件是否存在
    if (!existsSync(workerPath)) {
      logger.error(`文件不存在: ${workerPath}`);
      return false;
    }

    if (!existsSync(nodePath)) {
      logger.error(`Node.js 不存在: ${nodePath}`);
      logger.error(`请确保 Node.js 已安装或已正确打包`);
      return false;
    }

    const env = {
      ...process.env,
      AGENTDEV_OPEN_BROWSER: 'false',
      AGENTDEV_PORT: String(this.port),
    };

    logger.write('[ViewerLauncher] 准备 spawn 进程...');

    try {
      this.workerProcess = spawn(nodePath, [workerPath], {
        env,
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      logger.write(`[ViewerLauncher] 进程已创建, PID: ${this.workerProcess.pid}`);
    } catch (err) {
      logger.error(`创建进程失败: ${err.message}`);
      return false;
    }

    // 输出日志
    this.workerProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      logger.write(`[ViewerWorker STDOUT] ${msg}`);
    });

    this.workerProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      logger.error(`[ViewerWorker STDERR] ${msg}`);
    });

    // 监听退出事件
    this.workerProcess.on('exit', (code, signal) => {
      logger.write(`[ViewerLauncher] 进程退出: code=${code}, signal=${signal}`);
      this.workerProcess = null;
      this.clearHealthCheck();
    });

    this.workerProcess.on('error', (err) => {
      logger.error(`[ViewerLauncher] 进程错误: ${err.message}`);
      this.workerProcess = null;
      this.clearHealthCheck();
    });

    logger.write('[ViewerLauncher] 开始等待服务就绪...');

    // 等待服务就绪
    return await this.waitForReady();
  }

  async waitForReady() {
    logger.write('[ViewerLauncher] waitForReady() 开始');
    const startTime = Date.now();
    let checkCount = 0;

    return new Promise((resolve) => {
      this.healthCheckTimer = setInterval(async () => {
        checkCount++;
        const isReady = await this.checkHealth();

        logger.write(`[ViewerLauncher] 健康检查 #${checkCount}: ${isReady ? '成功' : '失败'}`);

        if (isReady) {
          this.clearHealthCheck();
          logger.write(`[ViewerLauncher] ViewerWorker 已就绪: http://localhost:${this.port}`);
          resolve(true);
        } else if (Date.now() - startTime > HEALTH_CHECK_TIMEOUT) {
          this.clearHealthCheck();
          logger.error(`启动超时 (已检查 ${checkCount} 次)`);
          if (this.workerProcess && !this.workerProcess.killed) {
            logger.write(`进程状态: PID=${this.workerProcess.pid}, killed=${this.workerProcess.killed}`);
          }
          this.killProcess();
          resolve(false);
        }
      }, HEALTH_CHECK_INTERVAL);
    });
  }

  async checkHealth() {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${this.port}/api/agents`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  async stop() {
    logger.write('[ViewerLauncher] stop() 开始');
    this.clearHealthCheck();
    this.killProcess();
    await new Promise(resolve => setTimeout(resolve, 500));
    logger.write('[ViewerLauncher] ViewerWorker 已停止');
  }

  clearHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  killProcess() {
    if (!this.workerProcess) return;

    const pid = this.workerProcess.pid;
    logger.write(`[ViewerLauncher] 终止进程 PID: ${pid}`);

    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        logger.write(`[ViewerLauncher] taskkill 执行成功`);
      } catch (e) {
        logger.write(`[ViewerLauncher] taskkill 失败: ${e.message}`);
      }
    } else {
      try {
        this.workerProcess.kill('SIGTERM');
      } catch (e) {
        // 忽略
      }
    }

    this.workerProcess = null;
  }

  getWorkerPath() {
    logger.write('[ViewerLauncher] getWorkerPath() 开始');

    const path = require('path');

    // 开发环境：desktop/lib/../.../dist/cli/viewer.js
    const devPath = path.join(__dirname, '../../dist/cli/viewer.js');
    logger.write(`[ViewerLauncher] 开发路径检查: ${devPath}, 存在: ${existsSync(devPath)}`);

    if (existsSync(devPath)) {
      logger.write(`[ViewerLauncher] 使用开发环境路径: ${devPath}`);
      return devPath;
    }

    // 打包后：尝试多个可能的路径
    const candidates = [
      path.join(__dirname, '../cli/viewer.js'),
      path.join(__dirname, '../dist/cli/viewer.js'),
      process.resourcesPath && path.join(process.resourcesPath, 'app/cli/viewer.js'),
      process.resourcesPath && path.join(process.resourcesPath, 'app/dist/cli/viewer.js'),
    ].filter(Boolean);

    logger.write(`[ViewerLauncher] 候选路径数量: ${candidates.length}`);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const exists = existsSync(candidate);
      logger.write(`[ViewerLauncher] 候选 #${i}: ${candidate}, 存在: ${exists}`);
      if (exists) {
        logger.write(`[ViewerLauncher] 使用打包环境路径: ${candidate}`);
        return candidate;
      }
    }

    const errorMsg = `找不到 viewer.js，尝试了: ${candidates.join(', ')}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  getProjectRoot() {
    logger.write('[ViewerLauncher] getProjectRoot() 开始');

    const path = require('path');
    const devRoot = path.join(__dirname, '../..');

    if (existsSync(path.join(devRoot, 'dist/cli/viewer.js'))) {
      logger.write(`[ViewerLauncher] 使用开发环境根目录: ${devRoot}`);
      return devRoot;
    }

    const cwd = process.cwd();
    logger.write(`[ViewerLauncher] 使用 process.cwd(): ${cwd}`);
    return cwd;
  }
}

module.exports = { ViewerLauncher };
