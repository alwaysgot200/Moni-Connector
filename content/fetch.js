// 页面上下文取图并直传本地上传端点。注入到 ISOLATED world，防重复注入。
// 目的：带上页面 Cookie/Referer 绕过防盗链；host 已放开 CORS。
(() => {
  "use strict";

  if (window.__rustMoniFetch) return;
  window.__rustMoniFetch = true;

  function normalizeHttpUrl(input) {
    if (typeof input !== "string" || !input.trim()) return null;
    let url;
    try {
      url = new URL(input.trim(), location.href);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  }

  function fail(code, message) {
    return { ok: false, code, message };
  }

  async function postBlob(blob, mime, upload, clientId) {
    const headers = {
      "Content-Type": mime,
      Authorization: `Bearer ${upload.token}`
    };
    if (clientId) headers["X-Moni-Client-Id"] = clientId;

    let response;
    try {
      response = await fetch(upload.endpoint, {
        method: "POST",
        credentials: "omit",
        headers,
        body: blob
      });
    } catch (err) {
      return fail(
        "A406_BROWSER_OFFLINE",
        `无法连接上传端点：${err && err.message ? err.message : err}`
      );
    }
    if (response.status === 401) {
      return fail("A202_REAUTH_REQUIRED", "上传 token 已过期");
    }
    if (!response.ok) {
      return fail("A500_ACTION_FAILED", `上传失败：HTTP ${response.status}`);
    }
    try {
      const asset = await response.json();
      return { ok: true, asset, mime };
    } catch {
      return fail("A500_ACTION_FAILED", "上传响应不是合法 JSON");
    }
  }

  async function handle(message) {
    const url = normalizeHttpUrl(message.url);
    if (!url) return fail("A302_UNSUPPORTED", "assets.fetch 只接受 http(s) URL");

    const upload = message.upload || {};
    if (typeof upload.endpoint !== "string" || typeof upload.token !== "string") {
      return fail("A202_REAUTH_REQUIRED", "缺少上传端点或 token");
    }

    let response;
    try {
      response = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        referrer: location.href
      });
    } catch (err) {
      return fail(
        "A405_DOWNLOAD_FAILED",
        `页面取图失败：${err && err.message ? err.message : err}`
      );
    }
    if (!response.ok) {
      return fail("A405_DOWNLOAD_FAILED", `资源下载失败：HTTP ${response.status}`);
    }

    let blob;
    try {
      blob = await response.blob();
    } catch (err) {
      return fail("A405_DOWNLOAD_FAILED", `读取资源失败：${err && err.message ? err.message : err}`);
    }
    if (!blob || blob.size === 0) {
      return fail("A405_DOWNLOAD_FAILED", "资源内容为空");
    }
    const mime = blob.type || response.headers.get("content-type") || "application/octet-stream";
    return postBlob(blob, mime, upload, message.clientId);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "moni.fetch.start") return;
    handle(message).then(sendResponse, (err) =>
      sendResponse(
        fail("A500_ACTION_FAILED", err && err.message ? err.message : String(err))
      )
    );
    return true;
  });
})();
