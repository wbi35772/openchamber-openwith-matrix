# 开发指南

## 1. 环境要求

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | 20+ | 运行服务、构建脚本 |
| npm | 10+ | 安装依赖、执行脚本 |
| Bun | 1.3.x | `@openchamber/sdk` 的打包器（`bundle-guest.ts`） |
| Git | 2.40+ | 版本管理 |
| OpenChamber | 2.0.0+ | 宿主，用于加载与调试扩展 |

Windows 11 是主要目标平台；WSL2、Docker、kubectl、Chrome/Edge 都是可选依赖。
macOS / Linux 可以开发通用部分，但 ShardX 与 Windows 应用组不会生效。

## 2. 快速开始

```bash
git clone https://github.com/wbi35772/openchamber-openwith-matrix.git
cd openchamber-openwith-matrix
npm install
npm run typecheck
npm run build
```

构建产物在 `dist/`，它是一个完整的扩展包根目录。

安装到宿主：

1. 打开 OpenChamber → 设置 → 扩展；
2. 选择「文件夹 / ZIP / URL」中的**文件夹**，指向本仓库的 `dist/`；
3. 批准 `service` 能力（Allow and enable）；
4. 在侧栏打开 **OpenWith Matrix**。

开发时保持文件夹安装，修改源码后重新 `npm run build`，再重载面板即可。

## 3. 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`，检查 `panel/`、`service/`、`shared/` |
| `npm run build` | 清理 `dist/`，复制静态文件，打包面板与服务 |
| `npm test` | `typecheck` + `build`（当前没有独立单元测试） |
| `make build` / `make typecheck` / `make test` | 等价的 Makefile 包装 |
| `make package` | 生成 `openchamber-openwith-matrix.zip` |

构建脚本依赖 `@openchamber/sdk` 提供的 `scripts/bundle-guest.ts`：

- 面板：浏览器 IIFE，输出 `dist/panel/main.js`；
- 服务：Node ESM，输出 `dist/service/main.js`。

`dist/` 永远不提交；CI 在每次推送到 `main` 时重新构建。

## 4. 目录约定

```text
panel/            浏览器侧代码，禁止直接使用 Node API
  views/          页面级视图，返回 DOM 节点
service/          Node 侧代码，所有特权操作
shared/           面板与服务共享的类型
config/           默认配置（随包发布）
docs/             架构、配置、开发与基线文档
scripts/          构建脚本
demo/             README 截图
```

规则：

- 面板不能 `import` `node:*`，不能直接 `fetch` 任意外部地址；需要网络时走服务。
- 服务不能操作 DOM；返回纯数据，由面板渲染。
- 共享类型只放在 `shared/types.ts`，不要在两侧各写一份。
- 新增外部命令时，同步更新 `package.json` 的 `openchamber.contributes.service.permissions.exec`。
- 代码注释与标识符用英文；面向用户的文案用中文（`changelog.md` 与文档）。

## 5. 常见改动路径

### 新增一个服务接口

1. 在 `shared/types.ts` 定义请求/响应类型（如需要）。
2. 在 `service/main.ts` 增加路由分支，使用现有的 `send` / `HttpError` / `readJson`。
3. 在 `panel/main.ts` 增加 `request<T>()` 包装。
4. 更新 `docs/ARCHITECTURE.md` 的路由表。
5. 写 `changelog.md` 条目，运行 `npm run typecheck && npm run build`。

### 新增一个资源组字段

1. 修改 `shared/types.ts`。
2. 更新 `config/default-matrix.json`。
3. 在 `service/configStore.ts` 的归一化逻辑中补默认值。
4. 更新面板卡片与 `panel/views/resourceEditorView.ts` 的表单。
5. 更新 `docs/CONFIG.md`。

### 新增一个标签页类型

1. 扩展 `TabKind` 与 `TabPayload`。
2. 在 `panel/main.ts` 的 pane 工厂注册创建函数，返回 `{ el, cleanup }`。
3. 确保 `TabManager` 的持久化能读回旧状态。
4. 更新架构文档与 changelog。

## 6. 调试

### 服务健康

```bash
curl -s http://127.0.0.1:PORT/health
```

正常返回：

```json
{ "status": "ok", "version": "2.0.0" }
```

服务端口与 token 由宿主通过环境变量注入，面板通过 `serviceRequest` 访问；手工调试时可
从宿主进程环境或扩展状态中获取。服务只绑定 `127.0.0.1`，不对外网开放。

### 日志

```text
~/.config/openchamber-openwith/logs/service.log
```

- 单文件 10 MB，保留 3 个备份；
- 启动失败、命令失败、HTTP 500 都会写入；
- 也可以在「日志」标签页中订阅。

### 配置

```text
~/.config/openchamber/openwith-matrix.json
```

界面里「配置」打开原始 JSON 编辑器；「资源」打开结构化编辑器。保存后服务会重新归一化
并广播变更。

### 面板

- 面板是沙箱 iframe，DevTools 需要选择对应的 frame 上下文；
- CSP 禁止任意外部 iframe 与内联脚本，调试时不要临时放宽；
- 窄侧栏（约 406 px）是主要使用场景，改样式后务必在窄宽度下检查横向溢出。

### 常见问题

**面板显示“服务未连接”**
检查扩展是否批准了 `service` 能力，以及宿主是否成功启动服务。

**点击应用没有反应**
查看服务日志中的 `spawn` 错误；确认命令存在，Windows `.cmd` 启动器会经 `cmd /c`。

**网页标签页空白**
检查 Chrome/Edge 路径与 `settings.browser` 配置；无头浏览器启动失败会写日志。

**guest 标签页 403**
`frame-grant` 已过期，关闭并重新打开标签页以申请新授权。

## 7. 发布

### 本地发布检查

```bash
npm ci
npm run typecheck
npm run build
```

然后在真实宿主中按 [BASELINE.md](./BASELINE.md) 第 5 节回归。

### CI 发布

`.github/workflows/release.yml`：

- 推送到 `main`：构建 → 生成 `openchamber-openwith-matrix-latest.zip` →
  强制更新孤立 `release` 分支 → 创建/更新 `latest` Release；
- 推送 `vX.Y.Z` 标签：发布同名 Release，同样更新 `release` 分支。

安装方式：

- 下载 Release 中的 zip；
- 或使用 `https://github.com/wbi35772/openchamber-openwith-matrix.git#release`
  （宿主会比较 `package.json` 版本，可原地更新）。

### 版本号

- 不兼容变更：主版本；
- 新能力：次版本；
- 修复：补丁版本。

同时更新 `package.json`、`docs/BASELINE.md` 的版本行，并在 `changelog.md` 记录。

## 8. 提交纪律

- 每次改动都要在 `changelog.md` 顶部加一行：
  `- 新增|优化|修复 YYYY-MM-DD 描述`。
- 类型检查与构建必须通过后再提交。
- 不提交 `dist/`、`node_modules/`、日志、临时文件与本机配置。
- 不提交任何 token、密码、私有路径或用户数据。
- 文档里的行为必须与代码一致；改接口时同步改文档。
