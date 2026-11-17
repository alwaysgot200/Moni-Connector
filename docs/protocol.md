# moni-bridge-v1 — 浏览器扩展协议

本文描述 RustMoni Connector 与 RustMoni 桌面端之间的协议。宿主与扩展都按本文件
逐字节实现；任何破坏性变更必须同时 bump `schema` 与 `manifest.json` 版本。

## 1. 传输

- WebSocket：`ws://127.0.0.1:<wsPort>/ws`，默认 `wsPort = 38123`。
- 配对/上传 HTTP：`http://127.0.0.1:<uploadPort>/`，默认 `uploadPort = 38124`。
- 两端口都只绑定 `127.0.0.1`；端口占用时桌面端在 `+0…+19` 内递增，配对页显示
  实际端口。
- **token 不放在 URL query**：WS 用首帧 `hello.payload.token`，上传用
  `Authorization: Bearer <upload.token>` 请求头。
- 连接建立后 3 秒内未收到合法 `hello`，宿主断开。

## 2. 帧格式

所有 WS 帧都是单个 JSON 文本信封：

```json
{
  "schema": "moni-bridge-v1",
  "id": "字符串 1..64",
  "type": "hello|call|result|error|progress|event|ping|pong",
  "ts": 1794919933,
  "nonce": "可选",
  "payload": {}
}
```

`ts`（unix 秒）与 `nonce` 可选；`id` 由发起方生成，`result/error/progress` 必须
回填同一 `id`。

### 2.1 hello（扩展 → 宿主）

```json
{
  "schema": "moni-bridge-v1",
  "id": "hello-1",
  "type": "hello",
  "ts": 1794919933,
  "payload": {
    "client_id": "<持久随机 id>",
    "token": "<配对得到的 token>",
    "version": "1.1.0",
    "caps": {
      "elements.pick": 1,
      "elements.query": 1,
      "elements.from_context": 1,
      "elements.resolve": 1,
      "capture.visible": 1,
      "cookies.get": 1,
      "assets.fetch": 1,
      "elements.context": 1,
      "elements.picked": 1
    },
    "user_agent": "<navigator.userAgent>"
  }
}
```

`client_id` 首次运行生成并持久化到 `chrome.storage.local`，随后不变。

### 2.2 hello 回执（宿主 → 扩展）

```json
{
  "schema": "moni-bridge-v1",
  "id": "hello-1",
  "type": "result",
  "payload": {
    "result": {
      "ok": true,
      "app": "browser",
      "events": true,
      "upload": {
        "endpoint": "http://127.0.0.1:38124/v1/upload",
        "token": "<一次性上传 token>",
        "expires_in": 300
      }
    }
  }
}
```

扩展保存 `upload.token` / `upload.endpoint` / 过期时间（`expires_in` 秒，默认
300）。token 过期或上传返回 `401` 时，扩展关闭当前连接并重新 `hello` 换取新
token，然后重试上传一次。

### 2.3 call（宿主 → 扩展）

```json
{
  "schema": "moni-bridge-v1",
  "id": "call-42",
  "type": "call",
  "payload": {
    "method": "elements.pick",
    "params": { "multiple": false, "hint": "选择要识别的图片" },
    "deadline_ms": 20000
  }
}
```

失败回同 `id` 的 `error` 帧。超时由扩展按 `deadline_ms` 自行截断并回
`A501_TIMEOUT`（`elements.pick` 超时同时通知页面结束拾取）。

### 2.4 result（扩展 → 宿主）

```json
{
  "schema": "moni-bridge-v1",
  "id": "call-42",
  "type": "result",
  "payload": { "result": [] }
}
```

### 2.5 error（扩展 → 宿主）

```json
{
  "schema": "moni-bridge-v1",
  "id": "call-42",
  "type": "error",
  "payload": {
    "code": "A406_BROWSER_OFFLINE",
    "message": "browser extension not connected",
    "retryable": false
  }
}
```

扩展禁止吞掉异常回空 `result`；任何失败都必须构造 `{code, message, retryable}`。

### 2.6 ping / pong

- 方向任意；收到 `ping` 必须回同 `id` 的 `pong`。
- 扩展在保活 alarm 中主动发 `ping`，宿主可回 `pong`。

### 2.7 event（扩展 → 宿主，仅 Connector）

```json
{
  "schema": "moni-bridge-v1",
  "id": "event-7f3a1c2b9d10",
  "type": "event",
  "ts": 1794919933,
  "payload": {
    "topic": "elements.context",
    "data": { "elements": [] }
  }
}
```

- 单向推送，不需要 `result` 回执；`id` 仅用于日志排查。
- **只有浏览器桥（`app=browser`）允许发送**；宿主对其他桥的 `event` 帧静默丢弃。
- `topic` 必须已在 `hello.caps` 声明，形状与 `namespace.verb` 方法名一致。
- 宿主回执 `events: true` 才发送；旧宿主没有该字段时必须保持静默，避免未知帧
  触发协议错误断开。
- 单条 `data` 序列化后上限 64KB；宿主队列上限 64 条，满后丢弃最旧事件。

| topic | data | 触发时机 |
| --- | --- | --- |
| `elements.context` | `{elements: BrowserElement[]}` | 右键「采集图片到 RustMoni」写入上下文元素后 |
| `elements.picked` | `{request_id, elements, orphan: true}` | 拾取完成但宿主已超时/重连（`orphanPicked` 兜底） |

## 3. 方法清单

### 3.1 `elements.from_context`

- 参数：`{}`
- 返回：`BrowserElement[]`，最近一次右键菜单「采集图片到 RustMoni」的图片。
- 数据来源：`contextMenus.onClicked` 写入 `chrome.storage.session.contextElement`；
  页面可注入时补充描述，否则退回 `srcUrl/pageUrl/linkUrl` 最小信息。
- 1.1.0 起同时推送 `elements.context` 事件（宿主支持时），无需再轮询。
- 无记录时回 `A404_NO_ELEMENTS`。

### 3.2 `elements.pick`

- 参数：`{multiple?: boolean, hint?: string}`。
- 返回：用户点击拾取的 `BrowserElement[]`；`multiple=false` 时点第一个即结束。
- 行为：注入拾取器，绿色 `2px #0FDC78` 高亮框（`pointer-events:none`，
  `z-index:2147483647`），`Esc` 结束；最多 50 个，按 URL 去重。
- 取消返回 `[]`；超时 `A501_TIMEOUT`；已有拾取进行中 `A403_BRIDGE_BUSY`。
- 若拾取完成时宿主已超时/重连（无 pending 请求），1.1.0 起补推
  `elements.picked` 事件并保留 `orphanPicked` 兜底。

### 3.3 `elements.query`

- 参数：`{selector: string, min_width?: number, min_height?: number, limit?: number, scroll?: boolean}`。
- 返回：`BrowserElement[]`，按 URL 去重，`limit` 上限 50。
- `scroll=true` 时逐个 `scrollIntoView` 并等待 120ms，适配懒加载。
- 非法选择器回 `A302_UNSUPPORTED`。

### 3.4 `elements.resolve`

- 参数：`{refs: BrowserElement[]}`。
- 返回：按 `ref.selector` 重新解析的 `BrowserElement[]`，找不到的条目跳过；
  `selector` 为空时尝试按 `url` 匹配页面 `<img>`。

### 3.5 `capture.visible`

- 参数：`{rect?: {x,y,w,h}, dpr?: number}`，`rect` 为 CSS 像素视口坐标。
- 返回：AssetRef `{asset, path, width, height, mime}`，`mime` 固定 `image/png`。
- 流程：`chrome.tabs.captureVisibleTab` → `createImageBitmap` →
  `OffscreenCanvas` 按 `rect × dpr` 裁切 → PNG blob → POST 上传端点。
- 未给 `dpr` 时尝试从页面读取 `devicePixelRatio`，失败按 1 处理。
- 失败：区域无效或超过 32MB → `A503_TOO_LARGE`；截图不可用/无活动页 →
  `A406_BROWSER_OFFLINE`；缺少 `activeTab` 授权 → `A201_DENIED`。

### 3.6 `cookies.get`

- 参数：`{url: string}`，仅 http(s)。
- 返回：`{name, value, domain, path}[]`。
- 未授予可选 `cookies` 权限 → `A201_DENIED`。
- 仍需扩展对该站点有访问权（`activeTab` 或宿主权限），否则 Chrome 可能返回空。

### 3.7 `assets.fetch`

- 参数：`{url: string, page_url?: string}`。
- 返回：AssetRef `{asset, path, width, height, mime}`。
- 流程：内容脚本在页面上下文 `fetch(url, {credentials:"include"})` 取 blob，
  再直接 `POST` 到上传端点（宿主已放开 CORS）；`chrome://` 等不可注入页面或
  页面取图失败时，Service Worker 用 `credentials:"omit"` 直取后上传。
- 上传 `401` 时刷新 hello token 并重试一次；最终失败回
  `A405_DOWNLOAD_FAILED` / `A406_BROWSER_OFFLINE`。

### 3.8 上传请求（扩展 → 宿主 HTTP）

```
POST http://127.0.0.1:<uploadPort>/v1/upload
Authorization: Bearer <upload.token>
Content-Type: <image/png | 资源原始 MIME>
X-Moni-Client-Id: <client_id>

<原始字节>
```

成功 `200` 返回 AssetRef JSON：

```json
{
  "asset": "asset://0123456789abcdef0123456789abcdef",
  "path": "C:\\Users\\me\\AppData\\Local\\RustMoni\\assets\\01\\23...",
  "width": 800,
  "height": 600,
  "mime": "image/png"
}
```

- 单次上传上限 32MB，超出回 `A503_TOO_LARGE`。
- `401` 表示上传 token 失效，扩展重新 hello 后重试。

## 4. 配对接口

```
POST http://127.0.0.1:<uploadPort>/v1/pair
Content-Type: application/json

{"code":"123456","client":"chrome"}
```

成功 `200`：

```json
{
  "token": "<长期 token>",
  "ws": "ws://127.0.0.1:38123/ws",
  "upload": "http://127.0.0.1:38124/v1/upload",
  "protocol": "moni-bridge-v1"
}
```

- `401`：配对码错误/过期（限速，提示稍后再试）。
- 扩展以响应中的 `ws` / `upload` 为准；缺失时才按 `host:port` 推导
  （默认上传 `38124`，WS `38123`）。
- 扩展只接受 `127.0.0.1` / `localhost` 的 http/ws 地址。

## 5. BrowserElement

```json
{
  "url": "https://cdn.example.com/a.png",
  "page_url": "https://example.com/gallery",
  "selector": "#gallery > img:nth-of-type(2)",
  "alt": "cover",
  "title": "",
  "width": 800,
  "height": 600,
  "outer_html": "<img src=\"...\">",
  "link_url": "https://example.com/detail/1"
}
```

- 目标选取：`<img>` 本身 → `closest("img")` → computed `background-image`。
- `data:` / `blob:` / `file:` 等非 http(s) URL 忽略。
- `width/height` 取 `naturalWidth/naturalHeight`，否则取布局尺寸；未知为 `null`。
- `outer_html` 截断到 2000 字符；`alt/title/outer_html/link_url` 可为 `null`。

## 6. 错误码

扩展会发出的错误码（与 `moni-core::action::error::ActionErrorCode` 一致）：

| 码 | 含义 | 典型场景 |
| --- | --- | --- |
| `A101_NO_TEXT` | 无文字 | 当前链路未使用 |
| `A201_DENIED` | 权限被拒 | 未开启 cookies 权限、截图缺少 activeTab |
| `A202_REAUTH_REQUIRED` | 需要重新认证 | 上传 token 过期/配对失效 |
| `A302_UNSUPPORTED` | 不支持 | 未知方法、非法选择器、非 http(s) URL |
| `A403_BRIDGE_BUSY` | 桥忙 | 已有拾取请求进行中 |
| `A404_NO_ELEMENTS` | 无元素 | 尚无右键采集记录 |
| `A405_DOWNLOAD_FAILED` | 下载失败 | 页面取图与 SW 直取均失败 |
| `A406_BROWSER_OFFLINE` | 浏览器离线 | 无活动标签页、页面不可注入、WS 断开 |
| `A500_ACTION_FAILED` | 一般失败 | 截图解码/上传失败 |
| `A501_TIMEOUT` | 超时 | 拾取超时、调用超过 deadline_ms |
| `A502_CANCELLED` | 已取消 | 保留 |
| `A503_TOO_LARGE` | 过大 | 上传超过 32MB、裁剪区域无效 |
| `A504_PAYLOAD_TOO_LARGE` | 载荷过大 | 保留 |

`retryable` 仅作为提示，宿主仍以 `code` 为准；重连/轮询由宿主决定。
