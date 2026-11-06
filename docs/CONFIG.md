# 配置参考

OpenWith Matrix 的所有可调项都保存在一个 JSON 文件中。设置界面和资源管理写入的也是
这个文件，手工编辑与界面编辑等价。

## 1. 文件位置

| 平台 | 路径 |
| --- | --- |
| Windows | `%USERPROFILE%\.config\openchamber\openwith-matrix.json` |
| macOS / Linux | `~/.config/openchamber/openwith-matrix.json` |

- 首次启动时，服务读取扩展自带的 `config/default-matrix.json` 作为默认值。
- 用户文件与默认值**深合并**：对象逐层合并，数组整体替换。
- 文件不存在、损坏或字段缺失时，`ConfigStore` 会补齐默认值并重写。
- 写入使用临时文件 + 原子重命名，避免中断导致半截文件。
- 通过界面保存后立即生效；直接编辑文件后需要重载扩展（或重启服务）。

## 2. 顶层结构

```json
{
  "version": 4,
  "settings": {},
  "groups": {},
  "home": {}
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | number | 配置结构版本，当前为 `4` |
| `settings` | object | 全局设置 |
| `groups` | object | 六个资源组的内容 |
| `home` | object | 矩阵主页分页、自定义分组与资源标签 |

## 3. settings

### 3.1 通用

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `theme` | string | `"system"` | 预留字段；界面当前跟随宿主主题 |
| `defaultTabKind` | string | `"matrix-home"` | 预留字段；新标签默认类型 |
| `maxTabs` | number | `40` | 标签页数量上限，超出时回收最久未使用的非置顶标签 |
| `keepAliveTabs` | number | `12` | 保活标签数量 |
| `terminalShell` | string | `"powershell"` | 默认终端：`powershell` / `cmd` / `wsl` / `bash` |
| `terminalTimeoutMs` | number | `60000` | 一次性命令的超时时间（毫秒） |

### 3.2 browser

无头浏览器用于网页标签页与部分云书签预览。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `chromePath` | string | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Chrome 可执行文件 |
| `edgePath` | string | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | Edge 可执行文件 |
| `viewportWidth` | number | `1280` | 渲染宽度 |
| `viewportHeight` | number | `800` | 渲染高度 |
| `jpegQuality` | number | `55` | 帧压缩质量（1–100） |
| `frameIntervalMs` | number | `120` | 帧刷新间隔（毫秒） |

### 3.3 wsl

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `distro` | string | `"Ubuntu-24.04"` | 默认发行版 |
| `defaultUser` | string | `""` | 默认用户；空表示发行版默认用户 |

### 3.4 shardx

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiBase` | string | `"http://127.0.0.1:40325"` | ShardX 本地 API |
| `tokenEnv` | string | `"SHARDX_TOKEN"` | 存放 API token 的环境变量名 |
| `launcherPath` | string | `""` | 启动器路径；为空时「启动浏览器」返回 `launcher-missing` |
| `profileCount` | number | `31` | 预期实例数量，用于统计运行比 |

### 3.5 docker

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `composeFiles` | string[] | `[]` | 默认 Compose 文件；资源组中的 `composeFiles` 会覆盖此处 |
| `defaultProject` | string | `"openwith"` | Compose 项目名 |

### 3.6 k8s

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `defaultContext` | string | `""` | 默认 kube context |
| `defaultNamespace` | string | `"default"` | 默认 namespace |
| `portForwardPool` | number[] | `[18080,18081,18082,18083]` | 可用本地端口池 |

### 3.7 logSources

日志流标签页可订阅的日志源。

```json
{
  "id": "service-log",
  "name": "OpenWith service",
  "kind": "file",
  "target": "~/.config/openchamber-openwith/logs/service.log"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一标识 |
| `name` | string | 显示名 |
| `kind` | `file` \| `command` \| `url` | 来源类型 |
| `target` | string | 文件路径、命令或 URL |
| `args` | string[] | `command` 类型的参数 |
| `cwd` | string | `command` 类型的工作目录 |

## 4. groups

六个资源组固定为 `guests`、`win11`、`wsl`、`docker`、`k8s`、`cloud`。
组内数组在保存时**整组替换**，不是逐项合并。

### 4.1 guests

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否在主页显示扩展组 |
| `order` | string[] | `[]` | 扩展显示顺序；未列出的排在后面 |
| `hidden` | string[] | `[]` | 隐藏的扩展 ID |

### 4.2 win11

```json
{
  "apps": [
    { "id": "vscode", "name": "VS Code", "command": "code", "args": [] },
    {
      "id": "my-tool",
      "name": "My Tool",
      "command": "D:\\Tools\\MyTool\\tool.exe",
      "args": ["--project"],
      "icon": "tool"
    }
  ],
  "shardx": [
    { "id": "shardx-01", "name": "ShardX 01", "profileId": "profile-1", "folder": "ShardX" }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `apps[].id` | string | 唯一标识 |
| `apps[].name` | string | 显示名 |
| `apps[].command` | string | PATH 中的命令名或绝对 `.exe` 路径 |
| `apps[].args` | string[] | 启动参数；项目目录会追加在参数之后 |
| `apps[].icon` | string | 可选图标键 |
| `apps[].installed` | boolean | 可选；由检测结果回填 |
| `shardx[].id` | string | 实例 ID |
| `shardx[].name` | string | 实例名 |
| `shardx[].profileId` | string | 可选 ShardX profile |
| `shardx[].folder` | string | 可选工作目录 |

Windows 应用的 `command` 支持任意本机 `.exe`、`.cmd`、`.bat`；在资源管理里点击
「选择 EXE」可直接选取并自动填名称。应用启动时会把当前项目目录追加到参数末尾。

### 4.3 wsl

```json
{
  "distros": [{ "name": "Ubuntu-24.04", "user": "dev", "default": true }],
  "ports": [
    { "id": "wsl-8088", "label": "Open WebUI", "port": 8088, "protocol": "http", "path": "/" },
    { "id": "wsl-6379", "label": "Redis", "port": 6379, "protocol": "tcp" }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `distros[].name` | string | 发行版名称 |
| `distros[].user` | string | 可选默认用户 |
| `distros[].default` | boolean | 是否默认发行版 |
| `ports[].id` | string | 唯一标识 |
| `ports[].label` | string | 显示名 |
| `ports[].port` | number | 端口 |
| `ports[].protocol` | `http` \| `https` \| `tcp` | 协议 |
| `ports[].path` | string | HTTP 路径，默认 `/` |

### 4.4 docker

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否显示 Docker 组 |
| `composeFiles` | string[] | `[]` | 本组 Compose 文件；为空时用 `settings.docker.composeFiles` |
| `containers` | string[] | `[]` | 主页优先展示的容器名 |

### 4.5 k8s

```json
{
  "enabled": true,
  "contexts": [{ "name": "docker-desktop", "namespace": "default" }],
  "portForwards": [
    {
      "id": "grafana",
      "context": "docker-desktop",
      "namespace": "monitoring",
      "pod": "grafana-0",
      "localPort": 18080,
      "remotePort": 3000
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 是否显示 Kubernetes 组 |
| `contexts[].name` | string | kube context |
| `contexts[].namespace` | string | 可选默认 namespace |
| `portForwards[].id` | string | 唯一标识 |
| `portForwards[].context` | string | context |
| `portForwards[].namespace` | string | namespace |
| `portForwards[].pod` | string | pod 名 |
| `portForwards[].localPort` | number | 本地端口 |
| `portForwards[].remotePort` | number | 远端端口 |

### 4.6 cloud

```json
{
  "bookmarks": [
    {
      "id": "repo",
      "name": "仓库搜索",
      "url": "https://github.com/search?q={projectName}",
      "icon": "github",
      "group": "code",
      "openIn": "browser"
    }
  ],
  "webhooks": [
    {
      "id": "notify",
      "name": "通知桥",
      "method": "POST",
      "url": "http://127.0.0.1:27123/webhook",
      "headers": { "Content-Type": "application/json" },
      "body": "{\"path\":\"{path}\"}"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bookmarks[].id` | string | 唯一标识 |
| `bookmarks[].name` | string | 显示名 |
| `bookmarks[].url` | string | 支持变量模板 |
| `bookmarks[].icon` | string | 可选图标键 |
| `bookmarks[].group` | string | 可选分组标签 |
| `bookmarks[].openIn` | `browser` \| `panel` \| `host` | 打开位置 |
| `webhooks[].id` | string | 唯一标识 |
| `webhooks[].name` | string | 显示名 |
| `webhooks[].method` | HTTP 方法 | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` |
| `webhooks[].url` | string | 支持变量模板 |
| `webhooks[].headers` | object | 可选请求头 |
| `webhooks[].body` | string | 可选请求体 |

`openIn` 的含义：

- `browser`：交给系统默认浏览器；
- `panel`：在面板内用网页标签页打开；
- `host`：交给宿主打开（例如 `file:///` 路径）。

## 5. home

```json
{
  "pageSize": 8,
  "groups": [
    {
      "id": "group-dev",
      "name": "开发入口",
      "items": [
        { "id": "item-1", "kind": "guest", "ref": "docker", "label": "Docker" },
        { "id": "item-2", "kind": "app", "ref": "vscode" },
        { "id": "item-3", "kind": "bookmark", "ref": "repo" },
        { "id": "item-4", "kind": "url", "ref": "http://localhost:3000" }
      ]
    }
  ],
  "sections": [
    { "id": "guests", "kind": "guests", "label": "扩展", "view": "list", "visible": true },
    { "id": "win11-apps", "kind": "win11-apps", "label": "应用", "view": "cards", "visible": true },
    {
      "id": "group-dev",
      "kind": "custom-group",
      "label": "开发入口",
      "view": "cards",
      "visible": true,
      "groupId": "group-dev"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `pageSize` | number | 每页条数，最小 3，默认 8 |
| `groups[].id` | string | 分组 ID |
| `groups[].name` | string | 分组名 |
| `groups[].items[].id` | string | 条目 ID |
| `groups[].items[].kind` | `guest` \| `app` \| `bookmark` \| `url` | 条目类型 |
| `groups[].items[].ref` | string | guest/app/bookmark 的 ID，或 URL |
| `groups[].items[].label` | string | 可选显示名 |
| `groups[].items[].icon` | string | 可选图标键 |
| `sections[].id` | string | 标签 ID |
| `sections[].kind` | string | 资源类型，见下表 |
| `sections[].label` | string | 标签显示名，可随时改名 |
| `sections[].view` | `list` \| `cards` \| `compact` | 默认视图样式 |
| `sections[].visible` | boolean | 是否在主页标签栏显示 |
| `sections[].removed` | boolean | 标记已删除；标签栏隐藏，可在主页标签编辑器恢复 |
| `sections[].groupId` | string | `custom-group` 标签对应的分组 ID |

内置标签的 `kind` 固定为 `guests`、`win11-apps`、`shardx`、`wsl-ports`、
`docker-containers`、`k8s-forwards`、`cloud-bookmarks`、`cloud-webhooks`。
内置标签可以改名、排序、隐藏、删除和切换视图；删除时写入 `removed: true`
并保留记录，`ConfigStore.normalize` 不会补回已标记删除的内置标签，因此可以在
主页标签编辑器里恢复。每个自定义分组会自动生成一个 `custom-group` 标签，
其名称跟随分组名；删除该标签同样使用 `removed: true`，分组本身保留。

自定义分组只影响主页展示，不会创建、删除或移动真实资源。

## 6. 变量

云书签、Webhook URL 与请求体支持：

| 变量 | 值 |
| --- | --- |
| `{path}` | 当前项目目录原始路径 |
| `{winPath}` | Windows 反斜杠路径 |
| `{pathUrlEncode}` | URL 编码后的项目路径 |
| `{projectName}` | 项目目录名 |
| `{gitBranch}` | 当前 Git 分支；非仓库为空 |
| `{wslIp}` | WSL 默认发行版 IP |

未识别的占位符原样保留。变量只在执行时展开，不会写回配置。

## 7. 版本与迁移

- `version` 当前为 `4`。`ConfigStore.normalize` 会补齐缺失字段与内置主页标签，因此旧文件通常可直接读取。
- 如果未来修改字段含义或删除字段，会提升 `version` 并在 `changelog.md` 说明迁移方式。
- 降级扩展前先备份配置文件；旧版本可能忽略新字段，但不会删除未知字段。

## 8. 常见问题

**主页没有显示某个应用/书签？**
检查 `groups` 中是否存在，以及 `home.groups` 是否引用了正确的 `ref`。

**「启动浏览器」提示 `launcher-missing`？**
填写 `settings.shardx.launcherPath`，或使用资源管理里的文件选择器。

**网页标签页空白？**
确认 `settings.browser.chromePath` 或 `edgePath` 指向真实可执行文件，并检查服务日志。

**修改配置后没有变化？**
界面保存会立即生效；手工编辑文件需要重载扩展或重启服务。

**配置里出现本机绝对路径，能提交吗？**
不能。用户配置位于仓库之外，不应复制到仓库或文档示例中。
