// RustMoni Connector — MV3 service worker。
// 负责：配置恢复、WS 连接/指数退避重连、hello 握手、调用路由、上下文菜单、
// 拾取请求关联、一次性上传 token 与截图/资源上传。

import {
  normalizeUrl,
  normalizeEndpoint,
  wsUrl as wsUrlFromEndpoint,
  DEFAULT_UPLOAD_PORT
} from "./lib/urls.js";
import { MSG, CODES, bridgeError, toBridgeError } from "./lib/messages.js";

const SCHEMA = "moni-bridge-v1";
const VERSION = "1.1.0";
const DEFAULT_ENDPOINT = `127.0.0.1:${DEFAULT_UPLOAD_PORT}`;
const ALARM_KEEPALIVE = "moni.keepalive";
const MENU_ID = "moni.collect-image";
const MAX_ELEMENTS = 50;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 5000;

const CAPS = Object.freeze({
  "elements.pick": 1,
  "elements.query": 1,
  "elements.from_context": 1,
  "elements.resolve": 1,
  "capture.visible": 1,
  "cookies.get": 1,
  "assets.fetch": 1,
  // 主动事件主题（仅 Connector 拥有的上游通道）
  "elements.context": 1,
  "elements.picked": 1
});

let socket = null;
let helloPromise = null;
let helloId = "";
let helloSeq = 0;
let helloResolver = null;
let reconnectTimer = null;
let backoff = 1000;
let uploadToken = "";
let uploadEndpoint = "";
let uploadExpiresAt = 0;
let activePick = null;
let pingSeq = 0;
let lastError = "";
let handshaken = false;
// 宿主在 hello 回执里显式声明 events=true 才允许主动推送（兼容旧宿主）。
let eventPushEnabled = false;

/** @type {Map<string, {resolve: Function, timer: number, tabId: number}>} */
const pendingPicks = new Map();

function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function ensureClientId() {
  const stored = await chrome.storage.local.get("clientId");
  if (typeof stored.clientId === "string" && stored.clientId) return stored.clientId;
  const clientId = generateId();
  await chrome.storage.local.set({ clientId });
  return clientId;
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(["endpoint", "token", "wsUrl"]);
  const endpoint = normalizeEndpoint(stored.endpoint) || DEFAULT_ENDPOINT;
  const token = typeof stored.token === "string" ? stored.token : "";
  const wsUrl =
    typeof stored.wsUrl === "string" && /^wss?:\/\//i.test(stored.wsUrl)
      ? stored.wsUrl
      : wsUrlFromEndpoint(endpoint);
  return { endpoint, token, wsUrl };
}

async function setStatus(patch = {}) {
  let config = { endpoint: DEFAULT_ENDPOINT, wsUrl: wsUrlFromEndpoint(DEFAULT_ENDPOINT), token: "" };
  try {
    config = await loadConfig();
  } catch {
    // 存储读取失败时仍要给出可展示状态
  }
  const status = {
    connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
    handshaken,
    reason: "idle",
    endpoint: config.endpoint,
    wsUrl: config.wsUrl,
    hasToken: Boolean(config.token),
    uploadReady: Boolean(uploadToken) && Date.now() < uploadExpiresAt,
    uploadExpiresAt,
    eventPush: eventPushEnabled,
    version: VERSION,
    lastError,
    updatedAt: Date.now(),
    ...patch
  };
  try {
    await chrome.storage.local.set({ status });
  } catch {
    // 状态写盘失败不阻断桥
  }
  try {
    await chrome.runtime.sendMessage({ type: MSG.STATUS_CHANGED, status });
  } catch {
    // 没有弹窗监听是常态
  }
}

function sendFrame(type, id, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(
      JSON.stringify({
        schema: SCHEMA,
        id,
        type,
        ts: Math.floor(Date.now() / 1000),
        payload: payload || {}
      })
    );
    return true;
  } catch (err) {
    console.warn("[moni] send failed", err && err.message);
    return false;
  }
}

/**
 * 主动事件（Connector 专属通道）：单向推送，不需要 id 回执。
 * 只有宿主在 hello 回执里声明 events=true 时才发送，避免旧宿主把未知帧
 * 当成协议错误而断开连接。
 */
function sendEvent(topic, data) {
  if (!eventPushEnabled) return false;
  return sendFrame("event", `event-${generateId().slice(0, 12)}`, {
    topic,
    data: data || {}
  });
}

async function sendHello(config) {
  helloId = `hello-${++helloSeq}`;
  const clientId = await ensureClientId();
  sendFrame("hello", helloId, {
    client_id: clientId,
    token: config.token,
    version: VERSION,
    caps: CAPS,
    user_agent: navigator.userAgent
  });
}

function connect(config) {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return helloPromise || Promise.resolve(null);
  }
  if (!config || !config.token || !config.wsUrl) return Promise.resolve(null);

  let ws;
  try {
    ws = new WebSocket(config.wsUrl);
  } catch (err) {
    lastError = `WebSocket 创建失败：${err && err.message ? err.message : err}`;
    setStatus({ connected: false, reason: "connect_failed" }).catch(() => {});
    scheduleReconnect();
    return Promise.resolve(null);
  }

  socket = ws;
  helloPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      helloResolver = null;
      try {
        ws.close();
      } catch {
        // 忽略关闭异常
      }
      reject(bridgeError(CODES.TIMEOUT, "等待宿主 hello 回执超时"));
    }, HELLO_TIMEOUT_MS);
    helloResolver = {
      resolve(value) {
        clearTimeout(timer);
        helloResolver = null;
        resolve(value);
      },
      reject(err) {
        clearTimeout(timer);
        helloResolver = null;
        reject(err);
      }
    };
  });
  helloPromise.catch(() => {});

  ws.onopen = () => {
    backoff = 1000;
    handshaken = false;
    eventPushEnabled = false;
    setStatus({ connected: true, handshaken: false, reason: "handshake" }).catch(() => {});
    sendHello(config).catch((err) => console.warn("[moni] hello failed", err && err.message));
  };

  ws.onmessage = (event) => {
    handleSocketMessage(event.data).catch((err) =>
      console.warn("[moni] message handling failed", err && err.message)
    );
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      // 关闭失败也交给 onclose
    }
  };

  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    handshaken = false;
    eventPushEnabled = false;
    if (helloResolver) {
      helloResolver.reject(bridgeError(CODES.BROWSER_OFFLINE, "与宿主的连接已断开"));
      helloResolver = null;
    }
    helloPromise = null;
    setStatus({ connected: false, handshaken: false, reason: "closed" }).catch(() => {});
    scheduleReconnect();
  };

  return helloPromise;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const base = Math.min(backoff, 30000);
  const delay = base + Math.floor(Math.random() * 500);
  backoff = Math.min(backoff * 2, 30000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    boot().catch(() => {});
  }, delay);
}

function applyUpload(upload) {
  if (!upload || typeof upload.endpoint !== "string" || typeof upload.token !== "string") return;
  uploadEndpoint = upload.endpoint;
  uploadToken = upload.token;
  const ttl = Number(upload.expires_in);
  uploadExpiresAt = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 300000);
  chrome.storage.local
    .set({ uploadToken, uploadEndpoint, uploadExpiresAt })
    .catch(() => {});
}

async function handleSocketMessage(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    console.warn("[moni] dropped non-JSON frame");
    return;
  }
  if (!frame || frame.schema !== SCHEMA || typeof frame.id !== "string") return;

  switch (frame.type) {
    case "result": {
      if (frame.id !== helloId) break;
      const result = frame.payload && frame.payload.result;
      if (result && result.ok === true) {
        lastError = "";
        handshaken = true;
        eventPushEnabled = result.events === true;
        applyUpload(result.upload);
        setStatus({ connected: true, handshaken: true, reason: "ready" }).catch(() => {});
        if (helloResolver) helloResolver.resolve(result);
      } else {
        lastError = "hello 被宿主拒绝，请重新配对";
        handshaken = false;
        setStatus({ connected: true, handshaken: false, reason: "hello_rejected" }).catch(() => {});
        if (helloResolver) {
          helloResolver.reject(bridgeError(CODES.REAUTH, lastError));
          helloPromise = null;
        }
        if (socket) {
          try {
            socket.close();
          } catch {
            // 忽略关闭异常
          }
        }
      }
      break;
    }
    case "error": {
      if (frame.id !== helloId) break;
      const payload = frame.payload || {};
      lastError = typeof payload.message === "string" ? payload.message : "hello 被宿主拒绝";
      handshaken = false;
      setStatus({ connected: true, handshaken: false, reason: "hello_error" }).catch(() => {});
      if (helloResolver) {
        helloResolver.reject(bridgeError(payload.code || CODES.REAUTH, lastError));
        helloPromise = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          // 忽略关闭异常
        }
      }
      break;
    }
    case "ping":
      sendFrame("pong", frame.id, {});
      break;
    case "pong":
      break;
    case "call":
      await handleCall(frame);
      break;
    default:
      break;
  }
}

async function handleCall(frame) {
  const payload = frame.payload || {};
  const method = typeof payload.method === "string" ? payload.method : "";
  const params = payload.params && typeof payload.params === "object" ? payload.params : {};
  const rawDeadline = Number(payload.deadline_ms);
  const deadline = Number.isFinite(rawDeadline) && rawDeadline > 0 ? Math.min(rawDeadline, 120000) : 20000;

  try {
    const result = await withDeadline(route(method, params, deadline), deadline, CODES.TIMEOUT);
    sendFrame("result", frame.id, { result: result === undefined ? null : result });
  } catch (err) {
    sendFrame("error", frame.id, toBridgeError(err));
  }
}

function withDeadline(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(bridgeError(code, `调用超过 ${ms}ms 未完成`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function route(method, params, deadline) {
  switch (method) {
    case "elements.from_context":
      return elementFromContext();
    case "elements.pick":
      return pickElements(params, deadline);
    case "elements.query":
      return queryElements(params);
    case "elements.resolve":
      return resolveElements(params);
    case "capture.visible":
      return captureVisible(params);
    case "cookies.get":
      return cookiesGet(params);
    case "assets.fetch":
      return assetsFetch(params);
    default:
      throw bridgeError(CODES.UNSUPPORTED, `unsupported method: ${method || "(missing)"}`);
  }
}

async function activeTab() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    throw bridgeError(CODES.BROWSER_OFFLINE, `查询活动标签页失败：${err && err.message ? err.message : err}`);
  }
  const tab = Array.isArray(tabs) ? tabs[0] : null;
  if (!tab || typeof tab.id !== "number" || tab.id < 0) {
    throw bridgeError(CODES.BROWSER_OFFLINE, "没有可用的活动标签页，请先切换到网页");
  }
  return tab;
}

function injectionError(err) {
  const message = String((err && err.message) || err || "unknown error");
  if (/cannot access|cannot be scripted|missing host permission|extensions gallery/i.test(message)) {
    return bridgeError(
      CODES.BROWSER_OFFLINE,
      `无法访问当前页面（${message}）。请在目标网页点击一次扩展图标后重试。`
    );
  }
  return bridgeError(CODES.BROWSER_OFFLINE, `页面脚本注入失败：${message}`);
}

async function injectScripts(tabId, files, frameId) {
  const target = { tabId };
  if (Number.isInteger(frameId) && frameId >= 0) target.frameIds = [frameId];
  try {
    await chrome.scripting.executeScript({ target, files });
  } catch (err) {
    throw injectionError(err);
  }
}

function normalizeElement(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? normalizeUrl(raw.url) : null;
  if (!url) return null;
  const width = Number(raw.width);
  const height = Number(raw.height);
  return {
    url,
    page_url: typeof raw.page_url === "string" ? raw.page_url : "",
    selector: typeof raw.selector === "string" ? raw.selector : "",
    alt: typeof raw.alt === "string" ? raw.alt : null,
    title: typeof raw.title === "string" ? raw.title : null,
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    outer_html: typeof raw.outer_html === "string" ? raw.outer_html.slice(0, 2000) : null,
    link_url: typeof raw.link_url === "string" ? raw.link_url : null
  };
}

function normalizeElements(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (out.length >= MAX_ELEMENTS) break;
    const element = normalizeElement(raw);
    if (!element || seen.has(element.url)) continue;
    seen.add(element.url);
    out.push(element);
  }
  return out;
}

async function elementFromContext() {
  const stored = await chrome.storage.session.get("contextElement");
  const element = normalizeElement(stored && stored.contextElement);
  if (!element) throw bridgeError(CODES.NO_ELEMENTS, "还没有右键采集的图片");
  return [element];
}

function clearPick(requestId) {
  const pending = pendingPicks.get(requestId);
  if (pending) clearTimeout(pending.timer);
  pendingPicks.delete(requestId);
  if (activePick === requestId) activePick = null;
}

async function pickElements(params, deadline) {
  if (activePick) throw bridgeError(CODES.BRIDGE_BUSY, "已有拾取请求正在进行中");
  const tab = await activeTab();
  await injectScripts(tab.id, ["lib/dom.js", "content/picker.js"]);

  const requestId = `pick-${generateId().slice(0, 12)}`;
  const multiple = params.multiple === true;
  const hint = typeof params.hint === "string" ? params.hint.slice(0, 200) : "";
  const timeoutMs = Math.max(1500, deadline - 500);

  const picked = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPicks.delete(requestId);
      if (activePick === requestId) activePick = null;
      chrome.tabs.sendMessage(tab.id, { type: MSG.PICK_CANCEL, requestId }).catch(() => {});
      reject(bridgeError(CODES.TIMEOUT, "等待用户拾取元素超时"));
    }, timeoutMs);
    pendingPicks.set(requestId, { resolve, reject, timer, tabId: tab.id });
    activePick = requestId;
  });
  picked.catch(() => {});

  let ack;
  try {
    ack = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.PICK_START,
      requestId,
      params: { multiple, hint }
    });
  } catch (err) {
    clearPick(requestId);
    throw injectionError(err);
  }
  if (!ack || ack.ok !== true) {
    clearPick(requestId);
    throw bridgeError(CODES.ACTION_FAILED, (ack && ack.message) || "拾取器未能启动");
  }
  return picked;
}

async function queryElements(params) {
  const selector = typeof params.selector === "string" ? params.selector.trim() : "";
  if (!selector) throw bridgeError(CODES.UNSUPPORTED, "selector 不能为空");
  const tab = await activeTab();
  await injectScripts(tab.id, ["lib/dom.js", "content/selector.js"]);

  const requestId = `query-${generateId().slice(0, 12)}`;
  const query = {
    selector,
    min_width: Number.isFinite(Number(params.min_width)) ? Number(params.min_width) : 0,
    min_height: Number.isFinite(Number(params.min_height)) ? Number(params.min_height) : 0,
    limit: Math.min(MAX_ELEMENTS, Math.max(1, Number(params.limit) || MAX_ELEMENTS)),
    scroll: params.scroll === true
  };

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.QUERY_START,
      requestId,
      params: query
    });
  } catch (err) {
    throw injectionError(err);
  }
  if (!response || response.ok !== true) {
    throw bridgeError(CODES.UNSUPPORTED, (response && response.message) || "选择器执行失败");
  }
  return normalizeElements(response.elements);
}

async function resolveElements(params) {
  const refs = Array.isArray(params.refs) ? params.refs.slice(0, MAX_ELEMENTS) : [];
  if (!refs.length) return [];
  const tab = await activeTab();
  await injectScripts(tab.id, ["lib/dom.js", "content/selector.js"]);

  const slim = refs.map((ref) => ({
    url: ref && typeof ref.url === "string" ? ref.url : "",
    selector: ref && typeof ref.selector === "string" ? ref.selector : ""
  }));

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.RESOLVE_START,
      refs: slim
    });
  } catch (err) {
    throw injectionError(err);
  }
  if (!response || response.ok !== true) {
    throw bridgeError(CODES.ACTION_FAILED, (response && response.message) || "元素重新解析失败");
  }
  return normalizeElements(response.elements);
}

async function viewportMetrics(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        dpr: window.devicePixelRatio || 1,
        width: window.innerWidth || 0,
        height: window.innerHeight || 0
      })
    });
    const first = Array.isArray(results) ? results[0] : null;
    return first && first.result ? first.result : null;
  } catch {
    return null;
  }
}

function cropRegion(bitmap, rect, dpr) {
  if (!rect) return { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w);
  const h = Number(rect.h);
  if (![x, y, w, h].every((value) => Number.isFinite(value)) || w <= 0 || h <= 0) {
    throw bridgeError(CODES.TOO_LARGE, "截图区域参数无效");
  }
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const sx = Math.max(0, Math.round(x * scale));
  const sy = Math.max(0, Math.round(y * scale));
  const sw = Math.min(bitmap.width - sx, Math.round(w * scale));
  const sh = Math.min(bitmap.height - sy, Math.round(h * scale));
  if (sw <= 0 || sh <= 0) {
    throw bridgeError(CODES.TOO_LARGE, "截图区域超出可视范围");
  }
  return { x: sx, y: sy, width: sw, height: sh };
}

function captureError(err) {
  const message = String((err && err.message) || err || "unknown error");
  if (/permission|activeTab|not be captured|chrome:\/\//i.test(message)) {
    return bridgeError(
      CODES.BROWSER_OFFLINE,
      `截图不可用（${message}）。请在目标网页点击一次扩展图标后重试。`
    );
  }
  return bridgeError(CODES.BROWSER_OFFLINE, `截图失败：${message}`);
}

async function captureVisible(params) {
  const tab = await activeTab();
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    throw captureError(err);
  }
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    throw bridgeError(CODES.BROWSER_OFFLINE, "截图返回为空");
  }

  let bitmap;
  try {
    const sourceBlob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(sourceBlob);
  } catch (err) {
    throw bridgeError(CODES.ACTION_FAILED, `截图解码失败：${err && err.message ? err.message : err}`);
  }

  const rect = params && params.rect && typeof params.rect === "object" ? params.rect : null;
  let dpr = Number(params && params.dpr);
  if (!Number.isFinite(dpr) || dpr <= 0) {
    if (rect) {
      const metrics = await viewportMetrics(tab.id);
      dpr = metrics && Number(metrics.dpr) > 0 ? Number(metrics.dpr) : 1;
    } else {
      dpr = 1;
    }
  }

  try {
    const crop = cropRegion(bitmap, rect, dpr);
    const canvas = new OffscreenCanvas(crop.width, crop.height);
    const context = canvas.getContext("2d");
    if (!context) throw bridgeError(CODES.ACTION_FAILED, "无法创建离屏画布");
    context.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height
    );
    const blob = await canvas.convertToBlob({ type: "image/png" });
    if (!blob || blob.size > MAX_UPLOAD_BYTES) {
      throw bridgeError(CODES.TOO_LARGE, "截图超过 32MB 上传上限");
    }
    const asset = await uploadBlob(blob, "image/png");
    return {
      asset: asset.asset,
      path: asset.path,
      width: crop.width,
      height: crop.height,
      mime: "image/png"
    };
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

async function cookiesGet(params) {
  const granted = await chrome.permissions
    .contains({ permissions: ["cookies"] })
    .catch(() => false);
  if (!granted) {
    throw bridgeError(
      CODES.DENIED,
      "缺少 cookies 权限。请在扩展弹窗中开启 cookies 权限后重试。"
    );
  }
  const url = normalizeUrl(params && params.url);
  if (!url) throw bridgeError(CODES.UNSUPPORTED, "cookies.get 只接受 http(s) URL");
  let cookies;
  try {
    cookies = await chrome.cookies.getAll({ url });
  } catch (err) {
    throw bridgeError(CODES.DENIED, `读取 cookies 失败：${err && err.message ? err.message : err}`);
  }
  return (Array.isArray(cookies) ? cookies : []).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path
  }));
}

function normalizeAsset(value, fallbackMime) {
  if (!value || typeof value !== "object") {
    throw bridgeError(CODES.ACTION_FAILED, "上传响应缺少工件字段");
  }
  const asset = typeof value.asset === "string" ? value.asset.toLowerCase() : "";
  if (!/^asset:\/\/[0-9a-f]{32}$/.test(asset)) {
    throw bridgeError(CODES.ACTION_FAILED, "上传响应中的 asset 不合法");
  }
  const width = Number(value.width);
  const height = Number(value.height);
  return {
    asset,
    path: typeof value.path === "string" ? value.path : "",
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    mime: typeof value.mime === "string" && value.mime ? value.mime : fallbackMime || "application/octet-stream"
  };
}

async function refreshSession() {
  const config = await loadConfig();
  if (!config.token) throw bridgeError(CODES.REAUTH, "尚未配对：请先在扩展选项页完成配对");
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  backoff = 1000;
  if (socket) {
    const old = socket;
    socket = null;
    handshaken = false;
    try {
      old.close();
    } catch {
      // 忽略关闭异常
    }
  }
  try {
    await connect(config);
  } catch (err) {
    console.warn("[moni] refresh session failed", err && err.message);
  }
}

async function ensureUploadSession() {
  if (uploadToken && uploadEndpoint && Date.now() < uploadExpiresAt - 5000) {
    return uploadToken;
  }
  const stored = await chrome.storage.local.get([
    "uploadToken",
    "uploadEndpoint",
    "uploadExpiresAt"
  ]);
  if (
    typeof stored.uploadToken === "string" &&
    stored.uploadToken &&
    typeof stored.uploadEndpoint === "string" &&
    stored.uploadEndpoint &&
    Number(stored.uploadExpiresAt) > Date.now() + 5000
  ) {
    uploadToken = stored.uploadToken;
    uploadEndpoint = stored.uploadEndpoint;
    uploadExpiresAt = Number(stored.uploadExpiresAt);
    return uploadToken;
  }
  await refreshSession();
  return uploadToken;
}

async function tryUpload(blob, mime) {
  const token = await ensureUploadSession();
  if (!token || !uploadEndpoint) {
    throw bridgeError(CODES.REAUTH, "缺少上传 token：请重新配对");
  }
  // 宿主按 `?token=` 取一次性上传 token（协议 §8.7）；Authorization 头保留给带 Bearer 校验的宿主。
  let target;
  try {
    target = new URL(uploadEndpoint);
  } catch {
    throw bridgeError(CODES.ACTION_FAILED, "上传端点地址无效");
  }
  target.searchParams.set("token", token);
  let response;
  try {
    response = await fetch(target.toString(), {
      method: "POST",
      headers: {
        "Content-Type": mime || "application/octet-stream",
        Authorization: `Bearer ${token}`,
        "X-Moni-Client-Id": await ensureClientId()
      },
      body: blob
    });
  } catch (err) {
    throw bridgeError(
      CODES.BROWSER_OFFLINE,
      `无法连接上传端点：${err && err.message ? err.message : err}`
    );
  }
  if (response.status === 401) return null;
  if (!response.ok) {
    throw bridgeError(CODES.ACTION_FAILED, `上传失败：HTTP ${response.status}`);
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw bridgeError(CODES.ACTION_FAILED, "上传响应不是合法 JSON");
  }
  return normalizeAsset(json, mime);
}

async function uploadBlob(blob, mime) {
  if (!blob || blob.size === 0) throw bridgeError(CODES.ACTION_FAILED, "上传内容为空");
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw bridgeError(CODES.TOO_LARGE, "图片超过 32MB 上传上限");
  }
  const first = await tryUpload(blob, mime);
  if (first) return first;

  uploadToken = "";
  uploadExpiresAt = 0;
  await chrome.storage.local.set({ uploadToken: "", uploadExpiresAt: 0 }).catch(() => {});
  await refreshSession();
  const second = await tryUpload(blob, mime);
  if (!second) throw bridgeError(CODES.REAUTH, "上传 token 已失效，请重新配对");
  return second;
}

async function pageFetchUpload(payload, requestId) {
  const tab = await activeTab();
  await injectScripts(tab.id, ["lib/dom.js", "content/fetch.js"]);
  return chrome.tabs.sendMessage(tab.id, {
    type: MSG.FETCH_START,
    requestId,
    url: payload.url,
    pageUrl: payload.pageUrl,
    clientId: payload.clientId,
    upload: payload.upload
  });
}

async function assetsFetch(params) {
  const url = normalizeUrl(params && params.url);
  if (!url) throw bridgeError(CODES.UNSUPPORTED, "assets.fetch 只接受 http(s) URL");

  const clientId = await ensureClientId();
  let lastMessage = "";
  let upload = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await ensureUploadSession();
    if (!token || !uploadEndpoint) {
      throw bridgeError(CODES.REAUTH, "缺少上传 token：请重新配对");
    }
    upload = { endpoint: uploadEndpoint, token };

    try {
      const response = await pageFetchUpload(
        { url, pageUrl: typeof params.page_url === "string" ? params.page_url : "", clientId, upload },
        `fetch-${generateId().slice(0, 12)}`
      );
      if (response && response.ok === true && response.asset) {
        return normalizeAsset(response.asset, response.mime);
      }
      lastMessage = (response && response.message) || "页面上下文取图失败";
      if (response && response.code === CODES.REAUTH && attempt === 0) {
        await refreshSession();
        continue;
      }
    } catch (err) {
      lastMessage = err && err.message ? err.message : String(err);
    }
    break;
  }

  // 内容脚本不可用（chrome:// 等）或页面 fetch 被 CORS 拦截时，退回 SW 直取。
  let response;
  try {
    response = await fetch(url, { credentials: "omit", redirect: "follow" });
  } catch (err) {
    throw bridgeError(
      CODES.DOWNLOAD_FAILED,
      `资源下载失败：${lastMessage || (err && err.message) || "network error"}`
    );
  }
  if (!response.ok) {
    throw bridgeError(CODES.DOWNLOAD_FAILED, `资源下载失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const mime = blob.type || response.headers.get("content-type") || "application/octet-stream";
  return uploadBlob(blob, mime);
}

async function testConnection() {
  const config = await loadConfig();
  if (!config.token) {
    return { ok: false, message: "尚未配对：请先填写配对码并完成配对" };
  }
  if (socket && socket.readyState === WebSocket.OPEN && handshaken) {
    return { ok: true, connected: true, endpoint: config.endpoint, wsUrl: config.wsUrl };
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  backoff = 1000;
  if (socket) {
    const old = socket;
    socket = null;
    handshaken = false;
    try {
      old.close();
    } catch {
      // 忽略
    }
  }
  const hello = await connect(config);
  if (!hello) return { ok: false, message: "无法建立连接，请确认 RustMoni 正在运行" };
  return { ok: true, connected: true, endpoint: config.endpoint, wsUrl: config.wsUrl };
}

async function getStatus() {
  const config = await loadConfig();
  const permissions = {};
  for (const name of ["cookies", "downloads", "tabs"]) {
    permissions[name] = await chrome.permissions.contains({ permissions: [name] }).catch(() => false);
  }
  return {
    connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
    handshaken: Boolean(socket && socket.readyState === WebSocket.OPEN && handshaken),
    reason: socket ? "connected" : "offline",
    endpoint: config.endpoint,
    wsUrl: config.wsUrl,
    hasToken: Boolean(config.token),
    uploadReady: Boolean(uploadToken) && Date.now() < uploadExpiresAt,
    uploadExpiresAt,
    eventPush: eventPushEnabled,
    version: VERSION,
    lastError,
    permissions
  };
}

async function boot() {
  await ensureClientId();
  const stored = await chrome.storage.local.get([
    "uploadToken",
    "uploadEndpoint",
    "uploadExpiresAt"
  ]);
  if (
    typeof stored.uploadToken === "string" &&
    typeof stored.uploadEndpoint === "string" &&
    Number(stored.uploadExpiresAt) > Date.now() + 5000
  ) {
    uploadToken = stored.uploadToken;
    uploadEndpoint = stored.uploadEndpoint;
    uploadExpiresAt = Number(stored.uploadExpiresAt);
  }
  const config = await loadConfig();
  if (!config.token) {
    await setStatus({ connected: false, handshaken: false, reason: "unpaired" });
    return null;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return helloPromise;
  }
  try {
    return await connect(config);
  } catch (err) {
    console.warn("[moni] hello failed", err && err.message);
    return null;
  }
}

function setupMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create(
        { id: MENU_ID, title: "采集图片到 RustMoni", contexts: ["image"] },
        () => {
          void chrome.runtime.lastError;
        }
      );
    });
  } catch (err) {
    console.warn("[moni] context menu setup failed", err && err.message);
  }
}

async function recordContextElement(info, tab) {
  if (!info || typeof info.srcUrl !== "string" || !tab || typeof tab.id !== "number") return;
  const pageUrl = info.pageUrl || tab.url || "";
  const fallback = {
    url: info.srcUrl,
    page_url: pageUrl,
    selector: "",
    alt: null,
    title: null,
    width: null,
    height: null,
    outer_html: null,
    link_url: typeof info.linkUrl === "string" ? info.linkUrl : null
  };

  const fallbackElement = normalizeElement(fallback);
  if (fallbackElement) {
    // 先落最小信息，页面注入/描述较慢时宿主也能立刻读到。
    await chrome.storage.session.set({ contextElement: fallbackElement, contextAt: Date.now() });
  }

  let described = null;
  try {
    await injectScripts(tab.id, ["lib/dom.js", "content/selector.js"], info.frameId);
    const message = {
      type: MSG.CONTEXT_DESCRIBE,
      url: info.srcUrl,
      pageUrl
    };
    const options = Number.isInteger(info.frameId) ? { frameId: info.frameId } : undefined;
    const response = await chrome.tabs.sendMessage(tab.id, message, options);
    if (response && response.ok === true) described = response.element;
  } catch {
    // 页面不可注入（chrome:// 等）时退回 contextMenus 提供的最小信息
  }

  const element = normalizeElement(described) || normalizeElement(fallback);
  if (!element) return;
  await chrome.storage.session.set({ contextElement: element, contextAt: Date.now() });
  // 宿主已明确支持事件通道时立即推送，Moni 无需轮询即可知道用户刚采集了图片。
  sendEvent("elements.context", { elements: [element] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info || info.menuItemId !== MENU_ID) return;
  recordContextElement(info, tab).catch((err) =>
    console.warn("[moni] context capture failed", err && err.message)
  );
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case MSG.PICKED: {
      const requestId = typeof message.requestId === "string" ? message.requestId : "";
      const elements = normalizeElements(message.elements);
      const pending = pendingPicks.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingPicks.delete(requestId);
        if (activePick === requestId) activePick = null;
        pending.resolve(elements);
      } else {
        chrome.storage.session
          .set({ orphanPicked: { requestId, elements, at: Date.now() } })
          .catch(() => {});
        // 宿主可能已超时/重连；补推一条事件让它恢复这次拾取结果。
        sendEvent("elements.picked", {
          request_id: requestId,
          elements,
          orphan: true
        });
      }
      sendResponse({ ok: true });
      return;
    }
    case MSG.STATUS_GET:
      getStatus().then(sendResponse, (err) =>
        sendResponse({ error: err && err.message ? err.message : String(err) })
      );
      return true;
    case MSG.RECONNECT:
      boot().then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, message: err && err.message ? err.message : String(err) })
      );
      return true;
    case MSG.TEST:
      testConnection().then(sendResponse, (err) =>
        sendResponse({ ok: false, message: err && err.message ? err.message : String(err) })
      );
      return true;
    default:
      return;
  }
});

function ensureAlarm() {
  try {
    chrome.alarms.get(ALARM_KEEPALIVE).then(
      (alarm) => {
        if (!alarm) {
          chrome.alarms
            .create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 })
            .catch(() => chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.5 }).catch(() => {}));
        }
      },
      () => {
        chrome.alarms
          .create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 })
          .catch(() => chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.5 }).catch(() => {}));
      }
    );
  } catch (err) {
    console.warn("[moni] alarm setup failed", err && err.message);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_KEEPALIVE) return;
  boot().catch(() => {});
  if (socket && socket.readyState === WebSocket.OPEN) {
    sendFrame("ping", `ping-${++pingSeq}`, {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  setupMenus();
  ensureAlarm();
  boot().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  setupMenus();
  ensureAlarm();
  boot().catch(() => {});
});

setupMenus();
ensureAlarm();
boot().catch(() => {});
