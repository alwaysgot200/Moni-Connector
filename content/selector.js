// 批量选择器 / 重新解析 / 右键上下文描述。注入到 ISOLATED world，防重复注入。
(() => {
  "use strict";

  if (window.__rustMoniSelector) return;
  window.__rustMoniSelector = true;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function dom() {
    return window.__moniDom || null;
  }

  function pickTarget(element) {
    if (!element || element.tagName === "IMG") return element;
    if (typeof element.querySelector === "function") {
      const inner = element.querySelector("img");
      if (inner) return inner;
    }
    return element;
  }

  function describeOne(element, helper) {
    if (!element) return null;
    const target = pickTarget(element);
    let described = helper.describeElement(target, document);
    if (!described && target !== element) {
      described = helper.describeElement(element, document);
    }
    return described;
  }

  function findImageByUrl(url) {
    if (typeof url !== "string" || !url) return null;
    const images = document.images || document.querySelectorAll("img");
    for (const image of images) {
      const current = image.currentSrc || image.src || "";
      if (current === url) return image;
    }
    return null;
  }

  function validateSelector(selector) {
    if (typeof selector !== "string" || !selector.trim()) {
      throw new Error("selector 不能为空");
    }
    document.querySelectorAll(selector);
  }

  async function handleQuery(message) {
    const helper = dom();
    if (!helper) throw new Error("DOM helper unavailable");
    const params = message.params || {};
    validateSelector(params.selector);

    if (params.scroll !== true) {
      return { ok: true, elements: helper.collectFromSelector(document, params.selector, params) };
    }

    const nodes = Array.from(document.querySelectorAll(params.selector));
    const limit = Math.min(50, Math.max(1, Number(params.limit) || 50));
    const minWidth = Number(params.min_width) || 0;
    const minHeight = Number(params.min_height) || 0;
    const out = [];
    const seen = new Set();

    for (const node of nodes.slice(0, limit * 4)) {
      if (out.length >= limit) break;
      if (typeof node.scrollIntoView === "function") {
        node.scrollIntoView({ block: "center", inline: "nearest" });
      }
      await sleep(120);
      const element = describeOne(node, helper);
      if (!element || seen.has(element.url)) continue;
      if (minWidth > 0 && (!element.width || element.width < minWidth)) continue;
      if (minHeight > 0 && (!element.height || element.height < minHeight)) continue;
      seen.add(element.url);
      out.push(element);
    }
    return { ok: true, elements: out };
  }

  function handleResolve(message) {
    const helper = dom();
    if (!helper) return { ok: false, code: "A500_ACTION_FAILED", message: "DOM helper unavailable" };
    const refs = Array.isArray(message.refs) ? message.refs.slice(0, 50) : [];
    const out = [];
    for (const ref of refs) {
      let element = null;
      if (ref && typeof ref.selector === "string" && ref.selector) {
        try {
          element = document.querySelector(ref.selector);
        } catch {
          element = null;
        }
      }
      if (!element && ref && typeof ref.url === "string") {
        element = findImageByUrl(ref.url);
      }
      if (!element) continue;
      const described = describeOne(element, helper);
      if (described) out.push(described);
    }
    return { ok: true, elements: out };
  }

  function handleContext(message) {
    const helper = dom();
    if (!helper) return { ok: false, code: "A500_ACTION_FAILED", message: "DOM helper unavailable" };
    const image = findImageByUrl(message.url);
    if (!image) return { ok: true, element: null };
    return { ok: true, element: helper.describeElement(image, document) };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "moni.query.start":
        handleQuery(message).then(sendResponse, (err) =>
          sendResponse({
            ok: false,
            code: "A302_UNSUPPORTED",
            message: err && err.message ? err.message : String(err)
          })
        );
        return true;
      case "moni.resolve.start":
        sendResponse(handleResolve(message));
        return;
      case "moni.context.describe":
        sendResponse(handleContext(message));
        return;
      default:
        return;
    }
  });
})();
