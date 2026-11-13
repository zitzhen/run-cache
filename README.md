# run-cache

`zitzhen/BlockIDE` 的原始 `node_modules` 仓库缓存 MVP1。

## 生成缓存

在 GitHub 打开 **Actions → Cache BlockIDE node_modules → Run workflow**，从 `main` 手动启动。工作流读取 `BlockIDE` 的 `main` 和 `.nvmrc`，依次构建三个平台；每个平台只在内容变化时创建一个独立提交。

```text
BlockIDE/
├── linux-64/
├── win32-x64/
└── darwin-arm64/
    ├── node_modules/
    ├── build/node_modules/
    ├── remote/node_modules/
    ├── extensions/<扩展>/node_modules/
    └── cache.json
```

每个平台目录保留源仓库中所有嵌套 `node_modules` 的相对路径，但排除根目录 `.build`、`out` 和 `src`。缓存包含完整 dependencies 和 devDependencies，不额外包含 Electron 或 Playwright 下载缓存。

`cache.json` 记录源提交、Node.js/npm 版本及 `package-lock.json` 的 SHA-256。平台、Node.js 版本或锁文件哈希不匹配时，不要直接复用该缓存。

## 拉取与恢复

使用 sparse checkout 只拉取需要的平台。例如 Linux x64：

```bash
git clone --filter=blob:none --sparse https://github.com/zitzhen/run-cache.git
git -C run-cache sparse-checkout set BlockIDE/linux-64
```

将 `run-cache/BlockIDE/linux-64/` 内的目录按相对路径覆盖到 `BlockIDE` 源目录，排除元数据文件。若两个仓库克隆为同级目录，可使用：

```bash
rsync -a --exclude='cache.json' run-cache/BlockIDE/linux-64/ BlockIDE/
```

Windows 和 macOS 分别使用 `win32-x64`、`darwin-arm64` 目录。恢复时保留符号链接与可执行权限，无需再次运行 `npm install` 或 `npm ci`。

MVP1 目前仅支持手动生成和手动恢复，尚未修改 `BlockIDE` 的 CI 消费缓存，也不会随源仓库推送自动刷新。
