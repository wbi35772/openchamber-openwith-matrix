/**
 * Shared contract for the OpenWith Matrix panel and its host service.
 *
 * The panel is a sandboxed iframe: it cannot start processes, read arbitrary
 * files or open sockets. The service runs as a normal Node process under the
 * OpenChamber host, so every privileged action is described here once and
 * performed there. Keeping this file dependency-free also keeps it usable from
 * the Phase 2 panel bundle without pulling Node code into the browser.
 */

export const MATRIX_VERSION = '2.0.0';
export const CONFIG_VERSION = 4;
export const CONFIG_FILE_NAME = 'openwith-matrix.json';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type MatrixPlatform = 'windows' | 'macos' | 'linux';
export type TabKind = 'matrix-home' | 'guest-extension' | 'web-iframe' | 'log-stream' | 'terminal-exec';
export type TerminalShell = 'powershell' | 'cmd' | 'wsl' | 'bash';

// ---------------------------------------------------------------------------
// Persisted configuration
// ---------------------------------------------------------------------------

export interface MatrixConfig {
  version: number;
  settings: MatrixSettings;
  groups: MatrixGroups;
  home: HomeConfig;
}

export interface HomeConfig {
  pageSize: number;
  groups: HomeGroup[];
  sections: HomeSectionConfig[];
}

export type HomeSectionKind =
  | 'guests'
  | 'win11-apps'
  | 'shardx'
  | 'wsl-ports'
  | 'docker-containers'
  | 'k8s-forwards'
  | 'cloud-bookmarks'
  | 'cloud-webhooks'
  | 'custom-group';

export type HomeViewMode = 'list' | 'cards' | 'compact';

export interface HomeSectionConfig {
  id: string;
  kind: HomeSectionKind;
  label: string;
  view: HomeViewMode;
  visible: boolean;
  removed?: boolean;
  groupId?: string;
}

/**
 * Built-in home tabs. The shipped JSON repeats these values, but normalize uses
 * this list to restore any tab a user config is missing.
 */
export const DEFAULT_HOME_SECTIONS: HomeSectionConfig[] = [
  { id: 'guests', kind: 'guests', label: '扩展', view: 'list', visible: true },
  { id: 'win11-apps', kind: 'win11-apps', label: '应用', view: 'cards', visible: true },
  { id: 'shardx', kind: 'shardx', label: 'ShardX', view: 'list', visible: true },
  { id: 'wsl-ports', kind: 'wsl-ports', label: 'WSL 端口', view: 'list', visible: true },
  {
    id: 'docker-containers',
    kind: 'docker-containers',
    label: '容器',
    view: 'list',
    visible: true,
  },
  { id: 'k8s-forwards', kind: 'k8s-forwards', label: '端口转发', view: 'list', visible: true },
  {
    id: 'cloud-bookmarks',
    kind: 'cloud-bookmarks',
    label: '书签',
    view: 'cards',
    visible: true,
  },
  { id: 'cloud-webhooks', kind: 'cloud-webhooks', label: 'Webhook', view: 'list', visible: true },
];

export interface HomeGroup {
  id: string;
  name: string;
  items: HomeItem[];
}

export type HomeItemKind = 'guest' | 'app' | 'bookmark' | 'url';

export interface HomeItem {
  id: string;
  kind: HomeItemKind;
  ref: string;
  label?: string;
  icon?: string;
}

export interface MatrixSettings {
  theme: 'system' | 'dark' | 'light';
  defaultTabKind: TabKind;
  maxTabs: number;
  keepAliveTabs: number;
  terminalShell: TerminalShell;
  terminalTimeoutMs: number;
  browser: BrowserSettings;
  wsl: WslSettings;
  shardx: ShardxSettings;
  docker: DockerSettings;
  k8s: K8sSettings;
  logSources: LogSourceConfig[];
}

export interface BrowserSettings {
  chromePath: string;
  edgePath: string;
  viewportWidth: number;
  viewportHeight: number;
  jpegQuality: number;
  frameIntervalMs: number;
}

export interface WslSettings {
  distro: string;
  defaultUser: string;
}

export interface ShardxSettings {
  apiBase: string;
  tokenEnv: string;
  launcherPath: string;
  profileCount: number;
}

export interface DockerSettings {
  composeFiles: string[];
  defaultProject: string;
}

export interface K8sSettings {
  defaultContext: string;
  defaultNamespace: string;
  portForwardPool: number[];
}

export interface MatrixGroups {
  guests: GuestGroup;
  win11: Win11Group;
  wsl: WslGroup;
  docker: DockerGroup;
  k8s: K8sGroup;
  cloud: CloudGroup;
}

export interface GuestGroup {
  enabled: boolean;
  order: string[];
  hidden: string[];
}

export interface Win11Group {
  apps: Win11App[];
  shardx: ShardxInstanceConfig[];
}

export interface Win11App {
  id: string;
  name: string;
  command: string;
  args: string[];
  icon?: string;
  installed?: boolean;
}

export interface ShardxInstanceConfig {
  id: string;
  name: string;
  profileId?: string;
  folder?: string;
}

export interface WslGroup {
  distros: WslDistroConfig[];
  ports: WslPortConfig[];
}

export interface WslDistroConfig {
  name: string;
  user?: string;
  default?: boolean;
}

export interface WslPortConfig {
  id: string;
  label: string;
  port: number;
  protocol: 'http' | 'https' | 'tcp';
  path?: string;
}

export interface DockerGroup {
  enabled: boolean;
  composeFiles: string[];
  containers: string[];
}

export interface K8sGroup {
  enabled: boolean;
  contexts: K8sContextConfig[];
  portForwards: K8sPortForwardConfig[];
}

export interface K8sContextConfig {
  name: string;
  namespace?: string;
}

export interface K8sPortForwardConfig {
  id: string;
  context: string;
  namespace: string;
  pod: string;
  localPort: number;
  remotePort: number;
}

export interface CloudGroup {
  bookmarks: CloudBookmark[];
  webhooks: WebhookConfig[];
}

export interface CloudBookmark {
  id: string;
  name: string;
  url: string;
  icon?: string;
  group?: string;
  openIn: 'browser' | 'panel' | 'host';
}

export interface WebhookConfig {
  id: string;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface LogSourceConfig {
  id: string;
  name: string;
  kind: 'file' | 'command' | 'url';
  target: string;
  args?: string[];
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Variable expansion
// ---------------------------------------------------------------------------

export interface VariableContext {
  path: string;
  winPath: string;
  pathUrlEncode: string;
  projectName: string;
  gitBranch: string;
  wslIp: string;
  host: string;
  port: string;
  date: string;
  now: string;
  env: Record<string, string>;
}

export interface VariableInput {
  path?: string;
  winPath?: string;
  gitBranch?: string;
  wslIp?: string;
  host?: string;
  port?: string | number;
  env?: Record<string, string | undefined>;
}

export interface WebhookResult {
  ok: boolean;
  status: number;
  url: string;
  body: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Live snapshots
// ---------------------------------------------------------------------------

export interface GuestServiceInfo {
  runtime?: string;
  granted?: boolean;
  permissions?: {
    exec?: string[];
    sockets?: string[];
  };
}

export interface GuestSummary {
  id: string;
  name: string;
  icon?: string;
  enabled: boolean;
  version?: string;
  source?: string;
  path?: string;
  entry?: string;
  pageEntry?: string;
  capabilities?: {
    requested?: string[];
    granted?: string[];
  };
  service?: GuestServiceInfo;
  storageId?: string;
}

export interface GuestFrameGrant {
  grant: string;
  expiresAt: number;
  url: string;
}

export interface GuestServiceRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface GuestServiceResult {
  status: number;
  body: string;
}

export interface AppSummary {
  id: string;
  name: string;
  command: string;
  installed: boolean;
  icon?: string;
}

export interface ShardxProfile {
  profile_id: string;
  name?: string;
  folder?: string;
  notes?: string;
  color?: string;
  proxy?: string;
  [key: string]: unknown;
}

export interface ShardxCdp {
  http_url?: string;
  web_socket_debugger_url?: string;
  [key: string]: unknown;
}

export interface ShardxRunning {
  profile_id: string;
  pid?: number;
  cdp?: ShardxCdp | null;
  [key: string]: unknown;
}

export interface ShardxInstance {
  id: string;
  index: number;
  name: string;
  profileId: string | null;
  running: boolean;
  cdpUrl?: string;
  folder?: string;
}

export interface ShardxSnapshot {
  online: boolean;
  apiBase: string;
  profiles: ShardxProfile[];
  running: ShardxRunning[];
  instances: ShardxInstance[];
  expected: number;
  error?: string;
}

export interface WslDistro {
  name: string;
  state: string;
  version: string;
  default: boolean;
}

export interface WslPortStatus {
  id: string;
  label: string;
  port: number;
  protocol: 'http' | 'https' | 'tcp';
  open: boolean;
  latencyMs?: number;
  url?: string;
  error?: string;
}

export interface WslSnapshot {
  available: boolean;
  distros: WslDistro[];
  ip?: string;
  ports: WslPortStatus[];
  error?: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt?: string;
}

export interface DockerSnapshot {
  available: boolean;
  version?: string;
  containers: DockerContainer[];
  error?: string;
}

export interface K8sContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace: string;
  current: boolean;
}

export interface K8sPod {
  name: string;
  namespace: string;
  context: string;
  status: string;
  ready: string;
  restarts: string;
  age: string;
}

export interface PortForwardStatus {
  id: string;
  context: string;
  namespace: string;
  pod: string;
  localPort: number;
  remotePort: number;
  running: boolean;
  pid?: number;
  error?: string;
}

export interface K8sSnapshot {
  available: boolean;
  contexts: K8sContextInfo[];
  pods: K8sPod[];
  forwards: PortForwardStatus[];
  error?: string;
}

export interface TerminalExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface TerminalSessionInfo {
  id: string;
  shell: TerminalShell;
  cwd: string;
  distro?: string;
  alive: boolean;
  createdAt: number;
}

export interface TerminalChunk {
  seq: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  at: number;
}

export interface TerminalOutput {
  chunks: TerminalChunk[];
  nextSeq: number;
  truncated: boolean;
  alive: boolean;
}

export interface BrowserSessionInfo {
  id: string;
  url: string;
  title: string;
  width: number;
  height: number;
  alive: boolean;
  createdAt: number;
  frameSeq: number;
}

export interface BrowserFrame {
  seq: number;
  mime: 'image/jpeg';
  data: string;
  width: number;
  height: number;
  at: number;
}

export type BrowserInput =
  | {
      type: 'mouse';
      action: 'move' | 'down' | 'up' | 'click' | 'wheel';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
    }
  | {
      type: 'key';
      action: 'down' | 'up' | 'press';
      key: string;
      code?: string;
      text?: string;
      modifiers?: number;
    }
  | { type: 'text'; text: string };

export interface LogChunk {
  seq: number;
  sourceId: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  at: number;
}

export interface LogSubscriptionInfo {
  id: string;
  sourceId: string;
  name: string;
  kind: 'file' | 'command' | 'url';
  target: string;
  alive: boolean;
  createdAt: number;
  error?: string;
}

export interface LogSourceInfo {
  id: string;
  name: string;
  kind: 'file' | 'command' | 'url';
  target: string;
  available: boolean;
  error?: string;
}

export interface LogOutput {
  chunks: LogChunk[];
  nextSeq: number;
  truncated: boolean;
  alive: boolean;
  error?: string;
}

export interface MatrixHealth {
  status: 'ok';
  version: string;
  pid: number;
  uptimeMs: number;
}

export interface MatrixSnapshot {
  health: MatrixHealth;
  config: MatrixConfig;
  guests: GuestSummary[];
  apps: AppSummary[];
  shardx: ShardxSnapshot;
  wsl: WslSnapshot;
  docker: DockerSnapshot;
  k8s: K8sSnapshot;
  errors: string[];
}

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: string;
  detail?: string;
}

export type ApiResult<T> = ApiOk<T> | ApiError;

// ---------------------------------------------------------------------------
// Panel-side tab model (shared so Phase 2 can persist it verbatim)
// ---------------------------------------------------------------------------

export interface WorkspaceTab {
  id: string;
  kind: TabKind;
  title: string;
  icon?: string;
  pinned: boolean;
  keepAlive: boolean;
  createdAt: number;
  payload: Record<string, JsonValue>;
}

export interface SplitLayout {
  enabled: boolean;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  secondaryTabId: string | null;
}
