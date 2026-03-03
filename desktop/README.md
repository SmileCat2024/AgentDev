# Desktop Browser - Electron 桌面应用

一个简单的 Electron 桌面程序，自动打开本地 2026 端口的内容。

## 安装依赖

```bash
cd desktop
npm install
```

## 开发运行

```bash
npm start
```

## 构建 Windows 可执行文件

```bash
npm run build-win
```

构建完成后，exe 文件将在 `dist` 目录中生成。

## 构建所有平台

```bash
npm run dist
```

## 配置说明

- 默认打开 URL: `http://localhost:2026`
- 应用名称: DesktopBrowser
- 输出目录: `dist`

## 注意事项

1. 确保在运行应用前，本地 2026 端口上有服务在运行
2. 首次构建可能需要下载 Electron 二进制文件，可能需要一些时间
3. 如果需要修改目标 URL，请编辑 `main.js` 文件中的 `win.loadURL()` 方法

## 目录结构

```
desktop/
├── main.js          # Electron 主进程代码
├── index.html       # 备用页面（正常情况下不会显示）
├── package.json     # 项目配置
└── README.md        # 说明文档
```
