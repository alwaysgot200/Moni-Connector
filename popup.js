import { MSG } from "./lib/messages.js";

const elements = {
  version: document.getElementById("version"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  wsUrl: document.getElementById("wsUrl"),
  endpoint: document.getElementById("endpoint"),
  tokenState: document.getElementById("tokenState"),
  uploadState: document.getElementById("uploadState"),
  pairButton: document.getElementById("pairButton"),
  reconnectButton: document.getElementById("reconnectButton")
};

function setDot(kind) {
  elements.statusDot.className = `dot ${kind}`;
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const date = new Date(ms);
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function render(status) {
  if (!status || status.error) {
    setDot("offline");
    elements.statusText.textContent = "无法获取扩展状态";
    return;
  }
  elements.wsUrl.textContent = status.wsUrl || "—";
  elements.endpoint.textContent = status.endpoint || "—";
  elements.tokenState.textContent = status.hasToken ? "已配置（不回显）" : "未配置";
  elements.uploadState.textContent = status.uploadReady
    ? `有效至 ${formatTime(status.uploadExpiresAt)}`
    : "未获取 / 已过期";

  if (status.connected && status.handshaken) {
    setDot("online");
    elements.statusText.textContent = "已连接 RustMoni";
  } else if (status.hasToken) {
    setDot("pending");
    elements.statusText.textContent = status.lastError || "已配对，等待连接…";
  } else {
    setDot("offline");
    elements.statusText.textContent = "未配对";
  }
}

async function refresh() {
  try {
    const status = await chrome.runtime.sendMessage({ type: MSG.STATUS_GET });
    render(status);
    await renderPermissions();
  } catch (err) {
    render({ error: err && err.message ? err.message : String(err) });
  }
}

async function renderPermissions() {
  for (const input of document.querySelectorAll("input[data-permission]")) {
    const name = input.dataset.permission;
    const granted = await chrome.permissions.contains({ permissions: [name] }).catch(() => false);
    input.checked = Boolean(granted);
  }
}

async function togglePermission(input) {
  const name = input.dataset.permission;
  try {
    if (input.checked) {
      const granted = await chrome.permissions.request({ permissions: [name] });
      if (!granted) input.checked = false;
    } else {
      await chrome.permissions.remove({ permissions: [name] });
    }
  } catch {
    input.checked = !input.checked;
  }
}

elements.version.textContent = `v${chrome.runtime.getManifest().version}`;
elements.pairButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
elements.reconnectButton.addEventListener("click", async () => {
  elements.reconnectButton.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: MSG.RECONNECT });
  } catch {
    // 状态刷新会展示结果
  } finally {
    elements.reconnectButton.disabled = false;
    await refresh();
  }
});

for (const input of document.querySelectorAll("input[data-permission]")) {
  input.addEventListener("change", () => togglePermission(input));
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== MSG.STATUS_CHANGED) return;
  render(message.status);
});

refresh();
setInterval(refresh, 2000);
