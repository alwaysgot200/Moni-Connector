# RustMoni Connector

RustMoni 桌面应用的浏览器动作桥（Chrome / Edge，Manifest V3）。扩展只连接本机
`127.0.0.1`，通过 `moni-bridge-v1` WebSocket 协议接收桌面端调用，完成元素拾取、
选择器批量采集、可见区截图与资源取回上传。

无构建步骤、无 npm 依赖、无远程代码；所有逻辑都是仓库内的静态 JS/HTML。

## 目录

```
manifest.json        MV3 清单（无图标文件，弹窗内联 SVG）
background.js        Service Worker：连接、路由、重连、contextMenus、上传 token
lib/urls.js          URL/端点规范化（可在 Node 单测）
lib/messages.js      消息类型与错误构造
lib/dom.js           页面内纯函数（pickImageUrl/srcset/cssPath/批量采集）
content/picker.js    元素拾取器（绿色高亮、Esc 结束、最多 50 个）
content/selector.js  选择器批量采集 / 重新解析 / 右键元素描述
content/fetch.js     页面上下文取图并直传本地上传端点
popup.html/js        连接状态、桥端口、可选权限开关
options.html/js      配对表单（host:port + 6 位配对码）、保存、连接测试
docs/protocol.md     帧格式、方法清单、错误码
tests/*.test.mjs     node:test 单测
```

## 侧载安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本目录 `Moni-Connector`。
4. 建议固定扩展图标到工具栏。

要求 Chrome/Edge 116+（Service Worker 的 WebSocket 保活与 `chrome.storage.session`）。

## 配对

1. 启动 RustMoni 桌面端，打开浏览器桥，界面会显示 6 位配对码与实际端口
   （默认上传/配对端口 `38124`，WebSocket 端口 `38123`）。
2. 右键扩展图标 →「选项」，或从弹窗点击「打开配对设置」。
3. 填写 `host:port`（默认 `127.0.0.1:38124`）与 6 位配对码，点击「配对并连接」。
4. 配对成功后扩展会保存长期 token，并立即发起 WebSocket 连接；
   之后每次 Service Worker 唤醒都会从 `chrome.storage.local` 恢复配置并重连。
5. 「连接测试」会当前配置建立一次握手并返回结果。

> 桌面端重启后 token 不变；若桌面端重新配对/轮换了 token，需要在扩展里重新配对。

## 页面访问（activeTab）

清单只申请 `http://127.0.0.1/*` / `http://localhost/*`（含对应 `ws://`）作为宿主权限，这是安全边界的一部分：扩展默认
**不能**读取任意网页。使用拾取、批量采集、截图、页面取图之前，请先在目标网页
上点击一次扩展图标（或打开弹窗），Chrome 会为该标签页授予临时 `activeTab`
权限，直到页面导航。

- `chrome://`、`edge://`、扩展商店等受保护页面无法注入或截图。
- 截图依赖 `chrome.tabs.captureVisibleTab`，同样受 `activeTab` 约束。

## 支持的方法

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `elements.from_context` | `{}` | `BrowserElement[]`（最近一次右键图片） |
| `elements.pick` | `{multiple?: boolean, hint?: string}` | `BrowserElement[]`（用户点选，Esc 结束，最多 50） |
| `elements.query` | `{selector, min_width?, min_height?, limit?, scroll?}` | `BrowserElement[]` |
| `elements.resolve` | `{refs: BrowserElement[]}` | 重新解析后的 `BrowserElement[]` |
| `capture.visible` | `{rect?: {x,y,w,h}, dpr?: number}` | `{asset, path, width, height, mime}` |
| `cookies.get` | `{url}` | `{name, value, domain, path}[]` |
| `assets.fetch` | `{url, page_url?}` | `{asset, path, width, height, mime}` |

`BrowserElement`：`{url, page_url, selector, alt, title, width, height, outer_html, link_url}`。
目标选取规则：`<img>` 本身 → `closest("img")` → computed `background-image`；
`data:` URL 忽略。`selector` 为简洁稳定的 CSS path（id 优先，其次 class/tag +
`nth-of-type`）。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `contextMenus` | 「采集图片到 RustMoni」右键菜单 |
| `activeTab` | 用户点击扩展图标后临时访问当前页（注入/截图） |
| `scripting` | 注入 `lib/dom.js` 与 `content/*.js` |
| `storage` | 保存端点、token、状态；`storage.session` 保存右键上下文与拾取兜底 |
| `alarms` | 约 0.4 分钟的保活/重连检查（Service Worker 会休眠） |
| `cookies`（可选） | 仅 `cookies.get` 使用，弹窗内手动开启 |
| `downloads`（可选） | 预留给桌面端下载增强，当前未主动使用 |
| `tabs`（可选） | 预留给标签页信息增强，当前仅用无需额外权限的标签页 id |

`cookies.get` 还要求扩展对该 URL 所属站点有访问权（`activeTab` 或宿主权限），
否则 Chrome 会返回空列表或拒绝；这是浏览器权限模型的限制。

## 安全说明

- 只连接 `127.0.0.1` / `localhost`；选项页拒绝任何外部主机与 `https` 桥地址。
- WebSocket 长期 token 只放在首帧 `hello.payload.token`，**不拼进 URL**；
  一次性上传 token 按协议 §8.7 放在 `POST /v1/upload?token=…`，同时附带 `Authorization: Bearer`。
- token 只保存在 `chrome.storage.local`，弹窗/选项页只显示「已配置」，不回显。
- 上传内容超过 32MB 直接拒绝；`asset://` 由桌面端生成，扩展不接触本地路径。
- 内容脚本只在用户点击扩展图标授予 `activeTab` 后注入，不申请 `<all_urls>`。
- 不使用 `eval`、远程脚本或内联脚本，符合 MV3 CSP。

## 已知限制

- `assets.fetch` 优先在页面上下文 `fetch(..., {credentials:"include"})` 后直传
  `127.0.0.1`；若图片站点 CORS 或 Chrome 私有网络访问（PNA）拦截，会退回
  Service Worker `credentials:"omit"` 下载后上传，仍失败则返回
  `A405_DOWNLOAD_FAILED`。
- Service Worker 休眠会丢失内存态；端点、token、上传 token 均从 storage 恢复，
  拾取请求若在休眠期间完成会存入 `chrome.storage.session` 的 `orphanPicked`，
  桌面端可直接重新发起拾取。
- 端口被占用时桌面端会在 `+0…+19` 内递增；以配对页显示的实际端口为准，配对
  响应里的 `ws` / `upload` 地址优先于本地推导值。

## 测试

```bash
node --test tests/urls.test.mjs tests/dom.test.mjs
```

`lib/dom.js` 用 CommonJS/浏览器双模式导出，测试通过普通对象 stub 元素验证
srcset 选择、CSS path 与批量采集纯逻辑。

## 许可

MIT，见 `LICENSE`。
