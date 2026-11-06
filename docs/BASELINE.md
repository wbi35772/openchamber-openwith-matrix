# OpenWith Matrix 2.0 基线

> 本文件定义 OpenWith Matrix 2.0.0 的可交付基线。后续需求以本文件为参照；
> 任何破坏「基线不变量」或配置结构的改动，都必须提升版本号、补充配置迁移说明，
> 并在 `changelog.md` 中记录。

## 1. 基线摘要

| 项目 | 值 |
| --- | --- |
| 产品名 | OpenWith Matrix |
| 扩展 ID | `openwith` |
| 扩展版本 | `2.0.0` |
| 配置版本 | `4`（`CONFIG_VERSION`） |
| 清单 API | `apiVersion: 1` |
| 宿主要求 | OpenChamber `>= 2.0.0`（网页版或桌面版） |
| 主要运行平台 | Windows 11 + WSL2（ShardX / Windows 应用组为 Windows 专属） |
| 基础能力平台 | macOS / Linux 可运行标签页、终端、日志、guest 嵌入与网页标签页 |
| 仓库 | `https://github.com/wbi35772/openchamber-openwith-matrix` |
| 许可证 | Apache-2.0 |
| 基线日期 | 2026-11-05 |
| 基线提交 | 本文件所在的 `main` 分支提交 |

## 2. 交付范围

### 2.1 Tab OS（标签页工作台）

- 五种标签页：`matrix-home`、`guest-extension`、`web-iframe`、`log-stream`、`terminal-exec`。
- 多标签保活（超过上限时按策略回收）、置顶、拖动排序。
- 分屏视图：副标签选择、方向切换、拖动分割线调整比例（0.2–0.8）、双击复位。
- 标签页状态持久化到宿主存储键 `openwith.tabs.v2`。

### 2.2 矩阵主页

- 可配置资源标签栏：默认 8 个内置标签（扩展、应用、ShardX、WSL 端口、容器、端口转发、
  书签、Webhook），点击标签只渲染一个内容区，不再堆叠全部卡片。
- 标签可改名、拖动排序、隐藏；每个标签可独立选择列表、卡片或紧凑视图。
- 分页列表（`home.pageSize`，默认 8）、整行点击打开、悬停详情。
- 自定义分组：扩展、应用、书签和本地端口链接可归类、排序、重命名、删除；每个分组
  自动生成同名标签。
- 标签与视图配置保存在 `home.sections`，随配置文件持久化。
- 动作分层：顶栏只保留工作区动作（分屏、刷新、配置、新标签）；主页头只保留
  “管理”菜单（主页标签、默认资源、自定义分组）；日志与终端从“新标签”菜单打开；
  分屏副标签控件位于顶栏下方的独立分屏条。窄面板下顶栏隐藏品牌名保持单行；
  两个菜单按钮可一键互相切换。

### 2.3 资源管理

- 单一「资源管理」弹窗覆盖默认分组的全部可编辑内容，共 11 个分区：
  扩展、Windows 应用、ShardX 实例、WSL 发行版、WSL 端口、Compose 文件、容器、
  Kube Context、端口转发、云书签、Webhook。
- 扩展分区支持显示/隐藏与排序；Windows 应用支持任意本机 `.exe` 路径。
- 「选择 EXE」通过服务端 `POST /pick-file/start` + 轮询 `GET /pick-file/result` 调起
  Windows 文件选择器，选中后自动回填路径与名称。
- 保存走 `PUT /config`，深合并后立即生效。

### 2.4 本地服务

- 单进程 Node HTTP 服务，仅监听 `127.0.0.1`，每个请求校验宿主下发的 Bearer token。
- 提供配置、快照、guest 桥、应用启动、文件选择、ShardX、WSL、Docker、Kubernetes、
  终端、网页代理、日志、变量、Webhook 等接口（完整列表见 `docs/ARCHITECTURE.md`）。
- 服务日志写入 `~/.config/openchamber-openwith/logs/service.log`（10 MB 滚动，保留 3 份）。

### 2.5 工程化

- `npm run typecheck`、`npm run build`、`npm run test`。
- `dist/` 为完整可安装包，由构建生成，不提交。
- GitHub Actions 在推送到 `main` 时构建并发布滚动 `latest` Release 与 `release` 分支。
- 文档：本基线、架构、配置、开发指南，另有 v1 设计稿存档。

## 3. 基线不变量

以下行为视为兼容性契约，后续版本不得在未升级主版本的情况下破坏：

1. **面板隔离**：`panel/` 运行在沙箱 iframe 中（`allow-scripts`，无 `allow-same-origin`），
   不直接访问文件系统、进程或任意网络；所有特权操作经 `host.serviceRequest` 进入服务。
2. **健康检查**：`GET /health` 必须返回 HTTP 200 与
   `{ "status": "ok", "version": "2.0.0" }`（版本随包版本更新）。
3. **配置位置**：用户配置固定为 `~/.config/openchamber/openwith-matrix.json`，
   写入必须是原子替换；默认配置以深合并方式叠加，数组整体替换。
4. **标签页契约**：`TabKind` 五种取值、存储键 `openwith.tabs.v2`、分屏比例范围
   0.2–0.8 保持不变；新增类型只能追加。
5. **服务安全**：仅绑定回环地址、必须校验 `Authorization: Bearer <token>`、
   请求体上限 2 MB；服务只能执行清单 `permissions.exec` 声明的命令。
6. **清单入口**：`package.json` 中 `openchamber.contributes.panel.entry` 为
   `panel/index.html`，`service.entry` 为 `service/main.js`，构建产物路径必须一致。
7. **CSP 约束**：面板不直接嵌入任意外部网页；网页标签页由服务端无头 Chrome/Edge
   通过 CDP 渲染后回传帧。
8. **变更纪律**：每次变更同步更新 `changelog.md`；`dist/` 不提交；文档中的行为描述
   必须与代码一致。

## 4. 运行模型

```text
OpenChamber host
  ├─ panel iframe (sandboxed)          ui only
  │    └─ serviceRequest ─────────────┐
  ├─ service (Node, 127.0.0.1:PORT) ◄─┘  Bearer token
  │    ├─ config store  ~/.config/openchamber/openwith-matrix.json
  │    ├─ child processes (apps, wsl, docker, kubectl, powershell, chrome)
  │    └─ guest host API (frame-grant, service-request)
  └─ storage (tabs, layout)
```

详细模块划分与数据流见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 5. 基线验证记录

以下检查在 2026-11-05 的实机宿主（`http://127.0.0.1:53253`，约 406 px 侧栏）上完成；
基线整理后会重新执行类型检查与构建。

| 检查项 | 方法 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过 |
| 构建 | `npm run build` | 通过，生成 `dist/` |
| 宿主加载 | 安装 `dist/` 后重载宿主 | 导航入口出现，面板正常渲染 |
| 健康检查 | `GET /health` | `{status:"ok",version:"2.0.0"}` |
| 五类标签页 | 逐个打开 | 主页、guest、网页、日志、终端均正常 |
| 分屏 | 拖动分割线、双击复位、切换方向 | 比例持久化，布局正确 |
| 保活/置顶/排序 | 切换标签、拖动、置顶 | 状态符合预期 |
| guest 嵌入 | frame-grant + shim | 第三方扩展可在标签页内运行 |
| 网页标签页 | 服务端 CDP | 页面渲染与输入转发正常 |
| 日志流 | 文件与命令源 | 订阅、输出、发送到 AI 正常 |
| 终端 | PowerShell 会话 | 命令执行与输出正常 |
| 资源管理 | 11 个分区逐项打开 | 均可编辑，350 px 宽度无横向溢出 |
| 主页标签 | 改名、拖动排序、隐藏/删除与恢复、切换三种视图 | 点击标签切换内容区，保存后刷新仍生效；删除的内置标签可恢复 |
| 选择 EXE | 真实文件对话框选择 `notepad.exe` | 路径与名称回填，无报错 |
| 保存回环 | 临时新增/删除 Webhook | 配置写入后可读回，删除后无残留 |
| 窄面板 | 376 px 侧栏 | 顶栏保持单行，标签栏、面板与表单自动换行，无横向溢出 |

> 当前仓库没有独立单元测试；`npm test` 等价于类型检查 + 构建。功能回归依赖本表
> 与 `docs/DEVELOPMENT.md` 的手工清单。

## 6. 已知限制

- **Windows 优先**：ShardX、Windows 应用、WSL2 资源组依赖 Windows 环境；macOS/Linux
  仅保证通用标签页、终端、日志与 guest 能力。
- **ShardX 启动器需配置**：默认配置的 `settings.shardx.launcherPath` 为空，需在
  配置或资源管理中填写本机启动器路径，否则「启动浏览器」返回 `launcher-missing`。
- **外部工具可选**：Docker、kubectl、Chrome/Edge 未安装时，对应分组显示不可用；
  网页标签页需要可用的 Chromium 内核浏览器路径。
- **guest frame-grant 有时效**：授权后需在有效期内加载 guest iframe，过期需重新授权。
- **服务需人工批准**：未批准 `service` 能力时，面板只能展示静态界面。
- **不支持 VS Code 与移动端**：扩展仅在 OpenChamber 宿主中加载。
- **无自动化端到端测试**：发布前需按验证清单在真实宿主中回归。
- **配置含本机路径**：配置文件不随仓库同步，跨机器使用需重新填写路径。

## 7. 变更管理

1. 功能或修复合并前，先在 `changelog.md` 顶部追加一行
   `- 新增|优化|修复 YYYY-MM-DD 描述`。
2. 修改配置结构时提升 `CONFIG_VERSION`，并在 `docs/CONFIG.md` 记录迁移方式；
   `ConfigStore.normalize` 必须能读入旧文件。
3. 修改服务接口时同步更新 `docs/ARCHITECTURE.md` 的路由表；删除路由视为破坏性变更。
4. 版本号遵循 SemVer：不兼容的契约变化提升主版本，新增能力提升次版本，修复提升补丁版本。
5. 发布前执行：`npm run typecheck` → `npm run build` → 安装 `dist/` → 按第 5 节回归
   → 提交 → 打 `vX.Y.Z` 标签（可选）→ 等待 Release 工作流完成。

## 8. 相关文档

- [架构说明](./ARCHITECTURE.md)
- [配置参考](./CONFIG.md)
- [开发指南](./DEVELOPMENT.md)
- [v1 设计稿存档](./design/v1-open-with-proposal.md)
- [变更记录](../changelog.md)
