const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { writeFileSync, appendFileSync, existsSync } = require('fs');
const { ViewerLauncher } = require('./lib/viewer-launcher');

// 文件日志工具（与 viewer-launcher 共享日志文件）
class Logger {
  constructor() {
    this.logFile = path.join(process.env.TEMP || '/tmp', 'agentdev-desktop-debug.log');
    this.initLog();
  }

  initLog() {
    const separator = '='.repeat(60);
    this.write(separator);
    this.write(`[Main] 时间: ${new Date().toISOString()}`);
    this.write(`[Main] Electron: ${process.versions.electron || '未打包'}`);
    this.write(`[Main] Node: ${process.versions.node}`);
    this.write(`[Main] execPath: ${process.execPath}`);
    this.write(`[Main] resourcesPath: ${process.resourcesPath || '未打包'}`);
    this.write(`[Main] __dirname: ${__dirname}`);
    this.write(`[Main] app.isPackaged: ${app.isPackaged}`);
    this.write(`[Main] app.getAppPath(): ${app.getAppPath()}`);
    this.write(separator);
  }

  write(message) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    const line = `[${timestamp}] ${message}\n`;
    try {
      appendFileSync(this.logFile, line, 'utf8');
    } catch (e) {
      // 忽略写入错误
    }
    console.log(message);
  }

  error(message) {
    this.write(`[ERROR] ${message}`);
  }
}

const logger = new Logger();

const DEFAULT_PORT = 2026;
let mainWindow = null;
let viewerLauncher = null;
let isQuitting = false;

logger.write('[Main] main.js 开始执行');

function createWindow() {
  logger.write('[Main] createWindow() 开始');

  Menu.setApplicationMenu(null);

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'agentdev.ico')
    : path.join(__dirname, 'agentdev.ico');

  logger.write(`[Main] icon 路径: ${iconPath}, 存在: ${existsSync(iconPath)}`);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: 'AgentDev Debugger',
    icon: iconPath,
  });

  logger.write(`[Main] BrowserWindow 已创建, id: ${win.id}`);

  // 窗口关闭时触发退出
  win.on('close', async () => {
    logger.write('[Main] 窗口 close 事件触发');
    if (!isQuitting) {
      isQuitting = true;
      await stopViewer();
      app.quit();
    }
  });

  // 先显示加载页面
  const loadingPath = path.join(__dirname, 'loading.html');
  logger.write(`[Main] 加载页面路径: ${loadingPath}`);
  win.loadFile(loadingPath);

  return win;
}

async function startViewer() {
  logger.write('[Main] startViewer() 开始');

  try {
    viewerLauncher = new ViewerLauncher(DEFAULT_PORT);
    const success = await viewerLauncher.start();

    logger.write(`[Main] startViewer 结果: ${success}`);

    if (success && mainWindow) {
      mainWindow.loadURL(`http://localhost:${DEFAULT_PORT}`);
      logger.write('[Main] 调试页面已加载');
    } else if (mainWindow) {
      const errorPath = path.join(__dirname, 'error.html');
      logger.write(`[Main] 加载错误页面: ${errorPath}`);
      mainWindow.loadFile(errorPath);
      logger.error('[Main] ViewerWorker 启动失败');
    }
  } catch (err) {
    logger.error(`[Main] startViewer 异常: ${err.message}`);
    logger.error(`[Main] 堆栈: ${err.stack}`);
  }
}

async function stopViewer() {
  logger.write('[Main] stopViewer() 开始');
  if (viewerLauncher) {
    await viewerLauncher.stop();
    viewerLauncher = null;
  }
  logger.write('[Main] ViewerWorker 已停止');
}

// 应用退出前清理
app.on('before-quit', async (event) => {
  logger.write('[Main] before-quit 事件触发');
  if (!isQuitting) {
    isQuitting = true;
    event.preventDefault();
    await stopViewer();
    app.exit(0);
  }
});

// 所有窗口关闭时（macOS 除外）
app.on('window-all-closed', async () => {
  logger.write('[Main] window-all-closed 事件触发');
  if (!isQuitting) {
    isQuitting = true;
    await stopViewer();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.whenReady().then(async () => {
  logger.write('[Main] app.whenReady() 回调触发');
  mainWindow = createWindow();
  await startViewer();

  app.on('activate', () => {
    logger.write('[Main] activate 事件触发');
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      startViewer();
    }
  });
});

// 异常处理
process.on('uncaughtException', async (err) => {
  logger.error(`[Main] 未捕获异常: ${err.message}`);
  logger.error(`[Main] 堆栈: ${err.stack}`);
  await stopViewer();
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  logger.error(`[Main] 未处理的 Promise 拒绝: ${reason}`);
});
