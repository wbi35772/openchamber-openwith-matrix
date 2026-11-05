# 架构说明

OpenWith Matrix 是一个 OpenChamber 扩展（`id: openwith`），由两个运行域组成：

- **面板**：沙箱 iframe，只负责界面与用户交互。
- **服务**：宿主拉起的本地 Node 进程，所有文件、进程、网络和外部命令操作都在这里执行。

两者只通过宿主提供的 `serviceRequest` 通信，面板永远拿不到文件系统或子进程能力。

## 1. 运行拓扑

```text
┌──────────────────────────── OpenChamber host ────────────────────────────┐
│                                                                          │
│  ┌──────────────────────┐        serviceRequest        ┌───────────────┐  │
│  │  panel iframe        │ ───────────────────────────► │  host bridge  │  │
│  │  sandbox="allow-      │                              └───────┬───────┘  │
│  │  scripts"            │                                      │          │
│  │  panel/main.js       │                               Bearer token      │
│  └─────────┬────────────┘                                      │          │
│            │ frame-grant + postMessage                         ▼          │
│  ┌─────────▼────────────┐                             ┌─────────────────┐ │
│  │ guest extensions     │ ◄── guestBridge shim ────── │ service process │ │
│  │ (embedded tabs)      │                             │ 127.0.0.1:PORT  │ │
│  └──────────────────────┘                             └────────┬────────┘ │
│                                                                │          │
└────────────────────────────────────────────────────────────────┼──────────┘
                                                                 │
              ┌──────────────────────────────────────────────────┼──────────────────────────────┐
              │                                                  │                              │
      ~/.config/openchamber/                          child processes                  guest host API
      openwith-matrix.json                            (apps, wsl, docker,               (frame-grant,
      ~/.config/openchamber-openwith/logs/             kubectl, chrome, powershell)      service-request)
```

### 信任边界

| 域 | 能力 | 约束 |
| --- | --- | --- |
| 面板 | DOM、宿主存储、`serviceRequest` | 沙箱 iframe、严格 CSP、无同源存储、不能启动进程 |
| 服务 | 文件、进程、网络、宿主 API | 仅回环监听、Bearer token、2 MB 请求体、`permissions.exec` 白名单 |
| guest | 自己的面板代码 | 只能通过宿主 `frame-grant` 加载，经 shim 访问宿主能力 |
| 网页标签页 | 由服务端浏览器渲染 | 面板只接收帧和转发输入，不直接嵌入任意外部站点 |

## 2. 清单与入口

`package.json` 的 `openchamber` 字段是扩展清单：

```json
{
  "apiVersion": 1,
  "engines": { "openchamber": ">=2.0.0" },
  "contributes": {
    "panel": {
      "id": "openwith",
      "name": "OpenWith Matrix",
      "icon": "icon.svg",
      "entry": "panel/index.html"
    },
    "page": true,
    "service": {
      "entry": "service/main.js",
      "runtime": "host",
      "permissions": { "exec": ["open", "powershell", "wsl", "docker", "kubectl", "..."] }
    }
  }
}
```

- `panel.entry` 指向构建后的 `dist/panel/index.html`。
- `service.entry` 指向构建后的 `dist/service/main.js`（Node ESM）。
- `page: true` 允许同一面板以整页方式打开。
- `permissions.exec` 是服务可以启动的命令白名单；新增外部命令必须同步修改清单。

构建由 `scripts/build.mjs` 完成：清理 `dist/`，复制静态文件，然后用
`@openchamber/sdk` 的 `bundle-guest.ts` 分别打包浏览器 IIFE 与 Node ESM。

## 3. 面板结构

```text
panel/
  index.html            外壳与 CSP
  main.ts               启动、宿主通信、标签页工厂、动作实现
  dom.ts                轻量 DOM 构造器（h/button/badge/tooltip/empty/errorText）
  tabManager.ts         标签状态、保活、置顶、排序、分屏、持久化
  guestBridge.ts        注入 guest 的宿主协议 shim
  views/
    matrixHomeView.ts   矩阵主页、六个卡片、分页、自定义分组
    resourceEditorView.ts 资源管理弹窗（11 个分区）
    homeGroupsView.ts   自定义分组编辑弹窗
    configModalView.ts  原始配置编辑弹窗
    logStreamView.ts    日志流面板
  styles.css            全部样式（含窄面板断点）
```

### 3.1 启动流程

1. 读取宿主上下文，确认扩展已启用。
2. 并行拉取 `GET /config` 与 `GET /snapshot`。
3. 从宿主存储 `openwith.tabs.v2` 恢复标签页与分屏状态。
4. 挂载顶栏、标签条、内容区和状态栏；没有标签时打开 `matrix-home`。
5. 订阅服务状态，刷新状态栏版本与服务健康信息。

### 3.2 标签页模型

```ts
type TabKind =
  | 'matrix-home'
  | 'guest-extension'
  | 'web-iframe'
  | 'log-stream'
  | 'terminal-exec';
```

每个标签包含 `id`、`kind`、`title`、`icon`、`payload`、`pinned` 等字段。`TabManager` 负责：

- 新建、关闭、激活、置顶、拖动排序；
- 保活上限与回收；
- 分屏主/副标签与比例（0.2–0.8，默认 0.5）；
- 写入宿主存储，节流后持久化。

标签内容按 `kind` 由 `main.ts` 的工厂函数创建，每个 pane 返回 `{ el, cleanup }`，
关闭或回收时调用 `cleanup` 释放定时器、订阅和事件监听。

### 3.3 五类标签页

| 类型 | 实现 | 说明 |
| --- | --- | --- |
| `matrix-home` | `mountHome` | 资源总览，卡片折叠/分页/编辑入口 |
| `guest-extension` | `frame-grant` + iframe + shim | 在面板内运行其他扩展的 UI |
| `web-iframe` | 服务端 Chrome/Edge CDP | 服务渲染页面，面板显示帧并转发输入 |
| `log-stream` | `GET /logs/subscriptions` 轮询 | 文件/命令/URL 日志，可发送到 AI |
| `terminal-exec` | `POST /terminal/sessions` + 输出轮询 | PowerShell/cmd/WSL/bash 会话 |

### 3.4 guest 嵌入

guest 标签不是普通 iframe。流程是：

1. 面板调用 `POST /guests/:id/frame-grant`，服务向宿主申请一次性授权。
2. 面板用返回的 `/api/guest-files/{grant}/panel/index.html` 作为 iframe 地址。
3. `guestBridge.ts` 在 iframe 内安装宿主协议 shim，把 guest 的存储、请求等调用
   转回父面板，再由父面板走 `serviceRequest`。
4. 授权有时效，过期后重新加载标签页并重新申请。

### 3.5 网页标签页

面板 CSP 不允许任意外部 `iframe`，因此网页标签页由服务端浏览器渲染：

- `POST /browser/sessions` 启动无头 Chrome/Edge（路径来自配置）。
- `GET /browser/sessions/:id/frame` 返回当前帧。
- `POST /browser/sessions/:id/navigate` 导航。
- `POST /browser/sessions/:id/input` 转发鼠标/键盘/滚动。
- `DELETE /browser/sessions/:id` 关闭会话。

面板按 `frameIntervalMs` 拉取帧；不可见标签暂停拉取以节省资源。

## 4. 服务结构

```text
service/
  main.ts               HTTP 路由、鉴权、错误封装、进程生命周期
  configStore.ts        默认配置深合并、归一化、原子读写
  terminalController.ts 交互式终端会话与一次性命令
  webProxy.ts           无头浏览器会话、CDP、帧编码
  logController.ts      日志源解析、订阅、滚动缓冲
  guestManager.ts       guest 发现、frame-grant、service-request 代理
  hostLauncher.ts       应用检测与启动（含绝对 exe 路径）
  shardxController.ts   ShardX API 与实例启停
  wslController.ts      WSL 发行版、IP、端口探测
  dockerController.ts   Docker 容器与 compose 操作
  k8sController.ts      kube context、pod、端口转发
  variableEngine.ts     路径/分支/WSL IP 等模板变量
  processUtils.ts       runCapture / runDetached / which / openWithShell
  logger.ts             滚动日志
```

### 4.1 生命周期

- 宿主设置 `OPENCHAMBER_SERVICE_PORT` 与 `OPENCHAMBER_SERVICE_TOKEN` 后启动进程。
- 服务只监听 `127.0.0.1`，所有请求必须带 `Authorization: Bearer <token>`。
- 进程退出时清理终端、浏览器、端口转发和子进程。
- `GET /health` 不要求业务状态，用于宿主与面板判断服务是否就绪。

### 4.2 路由表

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回版本 |
| GET | `/config` | 读取当前配置 |
| PUT | `/config` | 深合并保存配置（数组替换） |
| POST | `/config/reset` | 恢复默认配置 |
| GET | `/snapshot` | 一次性返回配置、guest、应用、WSL、Docker、K8s、ShardX 概览 |
| GET | `/guests` | 已安装 guest 列表 |
| POST | `/guests/:id/frame-grant` | 申请 guest 嵌入授权 |
| POST | `/guests/:id/service-request` | 代理 guest 的服务请求 |
| PUT | `/guests/:id/enabled` | 启用/禁用 guest |
| POST | `/guests/:id/storage` | 读写 guest 存储 |
| GET | `/apps` | 检测本机应用 |
| POST | `/apps/:id/open` | 用指定应用打开项目目录 |
| POST | `/pick-file/start` | 打开 Windows 文件选择器，返回 token |
| GET | `/pick-file/result?token=` | 轮询选择结果（pending/path） |
| POST | `/open` | 按应用名打开绝对路径 |
| GET | `/shardx` | ShardX API 与实例状态 |
| POST | `/shardx/launch` | 启动 ShardX 启动器 |
| POST | `/shardx/:id/start` | 启动实例 |
| POST | `/shardx/:id/stop` | 停止实例 |
| GET | `/wsl` | WSL 发行版、IP、端口 |
| GET | `/docker` | Docker 可用性与容器列表 |
| POST | `/docker/containers/:id/:action` | 容器 start/stop/restart |
| POST | `/docker/compose/:action` | Compose up/down/ps/restart |
| GET | `/k8s` | context、pod、转发状态 |
| POST | `/k8s/forward` | 建立端口转发 |
| DELETE | `/k8s/forward/:id` | 停止端口转发 |
| POST | `/k8s/forward/:id/stop` | 停止端口转发（兼容） |
| POST | `/terminal/exec` | 一次性命令 |
| POST/GET | `/terminal/sessions` | 创建/列出终端会话 |
| GET | `/terminal/sessions/:id/output?since=` | 增量输出 |
| POST | `/terminal/sessions/:id/input` | 写入终端 |
| DELETE | `/terminal/sessions/:id` | 关闭终端 |
| POST/GET | `/browser/sessions` | 创建/列出浏览器会话 |
| GET | `/browser/sessions/:id/frame` | 获取最新帧 |
| POST | `/browser/sessions/:id/navigate` | 导航 |
| POST | `/browser/sessions/:id/input` | 输入事件 |
| DELETE | `/browser/sessions/:id` | 关闭浏览器 |
| GET | `/logs/sources` | 可用日志源 |
| POST/GET | `/logs/subscriptions` | 创建/列出订阅 |
| GET | `/logs/subscriptions/:id/output?since=` | 增量日志 |
| DELETE | `/logs/subscriptions/:id` | 停止订阅 |
| POST | `/variables` | 创建变量上下文 |
| POST | `/variables/expand` | 展开模板 |
| POST | `/webhooks/:id/run` | 执行 Webhook |

所有成功响应统一为 `{ ok: true, data: ... }`，失败为
`{ ok: false, error, detail }`。HTTP 状态码用于区分参数错误（400）、
不存在（404）、超时（504）与服务内部错误（500）。

### 4.3 配置存储

`ConfigStore` 负责：

- 首次启动读取 `config/default-matrix.json`；
- 读取用户配置并与默认值深合并（数组整体替换）；
- 归一化：补齐缺失分组、`home`、`pageSize`（最小 3，默认 8）、应用/实例字段；
- 写入临时文件后原子重命名，避免半写入；
- 变更后向订阅方广播。

详细字段见 [CONFIG.md](./CONFIG.md)。

### 4.4 进程与命令

`processUtils.ts` 统一封装：

- `runCapture`：收集 stdout/stderr，带超时与退出码；
- `runDetached`：启动后不等待；
- `which` / `where`：跨平台命令探测；
- `openWithShell`：Windows 下通过 shell 打开路径或 URL。

应用启动支持绝对 `.exe` 路径；配置中的应用命令可以是 PATH 名称，也可以是完整路径。
Windows 的 `.cmd` 启动器经 `cmd /c` 执行。

### 4.5 变量与模板

云书签和 Webhook 支持以下占位符：

| 变量 | 含义 |
| --- | --- |
| `{path}` | 当前项目目录原始路径 |
| `{winPath}` | Windows 反斜杠路径 |
| `{pathUrlEncode}` | `encodeURIComponent` 后的路径 |
| `{projectName}` | 项目目录名 |
| `{gitBranch}` | 当前 Git 分支 |
| `{wslIp}` | WSL 默认发行版 IP |

`POST /variables` 生成上下文，`POST /variables/expand` 展开模板。

## 5. 错误处理与日志

- 服务端抛出的 `HttpError` 统一转成 JSON；未知异常记录日志并返回 500。
- 面板用 `notify` 显示成功/失败 toast，错误文本保留服务返回的 `detail`。
- 服务日志：`~/.config/openchamber-openwith/logs/service.log`，单文件 10 MB，
  最多 3 个备份；同时写 stderr。
- 日志流标签页可订阅服务日志、命令输出或 URL，并支持把选中内容发送到 AI 会话。

## 6. 构建与发布

```text
npm run typecheck  -> tsc --noEmit
npm run build      -> scripts/build.mjs -> dist/
npm test           -> typecheck + build
```

`dist/` 是完整包根：`package.json`、`icon.svg`、`panel/`、`service/`、`config/`。
GitHub Actions（`.github/workflows/release.yml`）在 `main` 推送时：

1. `npm ci`、类型检查、构建；
2. 打包 `openchamber-openwith-matrix-latest.zip`；
3. 强制推送 `dist/` 到孤立 `release` 分支（供 git URL 安装）；
4. 创建/更新 `latest` Release 并上传 zip。

推送 `vX.Y.Z` 标签时发布同名版本。详细流程见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 7. 扩展点

- **新增资源类型**：在 `shared/types.ts` 增加配置结构 → 默认配置 → `ConfigStore.normalize`
  → 服务控制器 → 面板卡片与资源编辑器分区。
- **新增标签页类型**：扩展 `TabKind`，在 `main.ts` 工厂注册 pane，保持旧存储可读。
- **新增服务能力**：在 `service/main.ts` 注册路由，更新清单 `permissions.exec`，
  并同步本文路由表。
- **新增变量**：在 `variableEngine.ts` 注册并更新 `docs/CONFIG.md` 的变量表。

## 8. 相关文档

- [基线](./BASELINE.md)
- [配置参考](./CONFIG.md)
- [开发指南](./DEVELOPMENT.md)
- [v1 设计稿存档](./design/v1-open-with-proposal.md)
