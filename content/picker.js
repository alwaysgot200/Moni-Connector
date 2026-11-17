// 元素拾取器。注入到 ISOLATED world，防重复注入；绿色高亮框 + 点击拾取 + Esc 结束。
(() => {
  "use strict";

  if (window.__rustMoniPicker) return;

  const state = {
    active: false,
    multiple: false,
    requestId: "",
    elements: [],
    hint: "",
    box: null,
    hintBox: null,
    savedCursor: ""
  };
  window.__rustMoniPicker = state;

  function describe(target) {
    const helper = window.__moniDom;
    if (!helper || typeof helper.describeElement !== "function") return null;
    return helper.describeElement(target, document);
  }

  function ensureBox() {
    if (state.box && state.box.isConnected) return state.box;
    const box = document.createElement("div");
    box.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "width:0",
      "height:0",
      "pointer-events:none",
      "z-index:2147483647",
      "border:2px solid #0FDC78",
      "background:rgba(15,220,120,.12)",
      "border-radius:2px",
      "box-sizing:border-box",
      "display:none"
    ].join(";");
    document.documentElement.appendChild(box);
    state.box = box;
    return box;
  }

  function ensureHint() {
    if (state.hintBox && state.hintBox.isConnected) return state.hintBox;
    const hint = document.createElement("div");
    hint.style.cssText = [
      "position:fixed",
      "top:12px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "pointer-events:none",
      "background:#0b1220",
      "color:#d7ffe9",
      "border:1px solid #0FDC78",
      "border-radius:4px",
      "padding:6px 10px",
      "font:12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif",
      "box-shadow:0 6px 18px rgba(0,0,0,.35)",
      "max-width:80vw",
      "white-space:nowrap",
      "overflow:hidden",
      "text-overflow:ellipsis"
    ].join(";");
    document.documentElement.appendChild(hint);
    state.hintBox = hint;
    return hint;
  }

  function updateHint(extra) {
    if (!state.hintBox) return;
    const base = state.hint || "点击页面图片进行拾取";
    const count = `已选 ${state.elements.length}/50`;
    state.hintBox.textContent = extra
      ? `${extra} · ${count} · Esc 结束`
      : `${base} · ${count} · Esc 结束`;
  }

  function onMove(event) {
    if (!state.active) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const box = ensureBox();
    if (!target) {
      box.style.display = "none";
      return;
    }
    const rect = target.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = `${Math.round(rect.left)}px`;
    box.style.top = `${Math.round(rect.top)}px`;
    box.style.width = `${Math.round(rect.width)}px`;
    box.style.height = `${Math.round(rect.height)}px`;
  }

  function onClick(event) {
    if (!state.active) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

    const target = document.elementFromPoint(event.clientX, event.clientY);
    const element = target ? describe(target) : null;
    if (!element) {
      updateHint("未识别到图片，继续点击");
      return;
    }
    if (!state.elements.some((item) => item.url === element.url)) {
      state.elements.push(element);
    }
    if (!state.multiple || state.elements.length >= 50) {
      finish(true);
      return;
    }
    updateHint("已拾取");
  }

  function onKey(event) {
    if (!state.active) return;
    if (event.key === "Escape" || event.key === "Esc") {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    }
  }

  function removeListeners() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
  }

  function finish(notify) {
    if (!state.active) return;
    state.active = false;
    removeListeners();
    if (state.box) state.box.style.display = "none";
    if (state.hintBox && state.hintBox.isConnected) state.hintBox.remove();
    state.hintBox = null;
    document.documentElement.style.cursor = state.savedCursor;

    const elements = state.elements.slice(0, 50);
    const requestId = state.requestId;
    state.elements = [];
    state.requestId = "";
    state.multiple = false;
    state.hint = "";

    if (notify && requestId) {
      try {
        chrome.runtime
          .sendMessage({ type: "moni.picked", requestId, elements })
          .catch(() => {});
      } catch {
        // 扩展上下文失效（页面刷新/重载扩展）时忽略
      }
    }
  }

  function start(message) {
    if (state.active) finish(false);
    const params = message.params || {};
    state.active = true;
    state.multiple = params.multiple === true;
    state.requestId = typeof message.requestId === "string" ? message.requestId : "";
    state.elements = [];
    state.hint = typeof params.hint === "string" ? params.hint : "";
    ensureBox();
    ensureHint();
    updateHint("");
    state.savedCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "moni.pick.start") {
      start(message);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "moni.pick.cancel") {
      finish(false);
      sendResponse({ ok: true });
    }
  });
})();
