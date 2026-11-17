import {
  DEFAULT_UPLOAD_PORT,
  normalizeEndpoint,
  pairUrl,
  uploadUrl,
  wsUrl,
  isLocalHost
} from "./lib/urls.js";
import { MSG } from "./lib/messages.js";

const endpointInput = document.getElementById("endpointInput");
const codeInput = document.getElementById("codeInput");
const pairButton = document.getElementById("pairButton");
const saveButton = document.getElementById("saveButton");
const testButton = document.getElementById("testButton");
const notice = document.getElementById("notice");
const endpointState = document.getElementById("endpointState");
const wsState = document.getElementById("wsState");
const uploadState = document.getElementById("uploadState");
const tokenState = document.getElementById("tokenState");

function showNotice(text, kind) {
  notice.textContent = text;
  notice.className = `notice show ${kind === "ok" ? "ok" : "error"}`;
}

function safeWs(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return "";
    if (!isLocalHost(url.hostname)) return "";
    return url.href;
  } catch {
    return "";
  }
}

function safeHttp(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return "";
    if (!isLocalHost(url.hostname)) return "";
    return url.href;
  } catch {
    return "";
  }
}

async function load() {
  const stored = await chrome.storage.local.get([
    "endpoint",
    "token",
    "wsUrl",
    "uploadUrl"
  ]);
  const endpoint = normalizeEndpoint(stored.endpoint) || `127.0.0.1:${DEFAULT_UPLOAD_PORT}`;
  if (document.activeElement !== endpointInput) endpointInput.value = endpoint;

  endpointState.textContent = endpoint;
  const derivedWs = wsUrl(endpoint);
  wsState.textContent = safeWs(stored.wsUrl) || derivedWs || "—";
  uploadState.textContent = safeHttp(stored.uploadUrl) || uploadUrl(endpoint) || "—";
  tokenState.textContent = stored.token ? "已配置（不回显）" : "未配置";
}

async function saveEndpoint(announce = true) {
  const endpoint = normalizeEndpoint(endpointInput.value);
  if (!endpoint) {
    throw new Error("地址必须形如 127.0.0.1:38124，且只允许本机（127.0.0.1 / localhost）");
  }
  const stored = await chrome.storage.local.get(["endpoint"]);
  const patch = { endpoint };
  if (stored.endpoint !== endpoint) {
    Object.assign(patch, {
      token: "",
      wsUrl: "",
      uploadUrl: "",
      uploadToken: "",
      uploadExpiresAt: 0
    });
  }
  await chrome.storage.local.set(patch);
  await load();
  if (announce) {
    showNotice(
      stored.endpoint !== endpoint
        ? "地址已保存；地址变更后需要重新配对。"
        : "地址已保存。",
      "ok"
    );
  }
  return endpoint;
}

async function reconnect() {
  try {
    await chrome.runtime.sendMessage({ type: MSG.RECONNECT });
  } catch {
    // 状态由连接测试展示
  }
}

async function pair() {
  pairButton.disabled = true;
  try {
    const endpoint = normalizeEndpoint(endpointInput.value);
    if (!endpoint) throw new Error("请填写合法的本机地址，如 127.0.0.1:38124");
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) throw new Error("配对码必须是 6 位数字");

    const target = pairUrl(endpoint);
    if (!target) throw new Error("配对地址无效");

    let response;
    try {
      response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, client: "chrome" })
      });
    } catch (err) {
      throw new Error(`无法连接配对服务：${err && err.message ? err.message : err}`);
    }

    if (response.status === 401) {
      throw new Error("配对码错误或已过期；连续失败会被限速，请稍后再试");
    }
    if (!response.ok) {
      throw new Error(`配对失败：HTTP ${response.status}`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("配对响应不是合法 JSON");
    }
    if (!data || typeof data.token !== "string" || !data.token) {
      throw new Error("配对响应缺少 token");
    }
    if (typeof data.protocol === "string" && data.protocol !== "moni-bridge-v1") {
      throw new Error(`协议版本不匹配：${data.protocol}`);
    }

    const ws = safeWs(data.ws) || wsUrl(endpoint);
    const upload = safeHttp(data.upload) || uploadUrl(endpoint);
    if (!ws || !upload) throw new Error("配对响应中的服务地址不是本机地址");

    await chrome.storage.local.set({
      endpoint,
      token: data.token,
      wsUrl: ws,
      uploadUrl: upload,
      pairedAt: Date.now(),
      uploadToken: "",
      uploadExpiresAt: 0
    });
    codeInput.value = "";
    await load();
    await reconnect();
    showNotice(`配对成功，正在连接 ${ws}`, "ok");
  } catch (err) {
    showNotice(err && err.message ? err.message : String(err), "error");
  } finally {
    pairButton.disabled = false;
  }
}

async function test() {
  testButton.disabled = true;
  try {
    await saveEndpoint(false);
    const result = await chrome.runtime.sendMessage({ type: MSG.TEST });
    if (result && result.ok) {
      showNotice(`连接正常：${result.wsUrl || ""}`, "ok");
    } else {
      showNotice((result && result.message) || "连接失败：RustMoni 未运行或未配对", "error");
    }
  } catch (err) {
    showNotice(err && err.message ? err.message : String(err), "error");
  } finally {
    testButton.disabled = false;
  }
}

pairButton.addEventListener("click", pair);
saveButton.addEventListener("click", () => {
  saveEndpoint(true).catch((err) => showNotice(err.message, "error"));
});
testButton.addEventListener("click", test);
codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
});

load().catch((err) => showNotice(err.message, "error"));
