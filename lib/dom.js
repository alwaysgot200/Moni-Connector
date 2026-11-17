// 页面内共享纯函数。经典脚本（挂 window.__moniDom）供 executeScript 注入；
// 同时兼容 Node require 做单测（无 DOM 依赖的纯逻辑 stubbing 即可）。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.__moniDom = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createMoniDom() {
  "use strict";

  const DATA_URL = /^data:/i;
  const ALLOWED_IMAGE_SCHEME = /^https?:/i;
  const UNSAFE_SCHEME = /^(?:blob|file|javascript|about|chrome|edge):/i;

  function tagOf(el) {
    return el && typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  }

  function pageUrlOf(doc) {
    if (!doc) return "";
    if (doc.location && typeof doc.location.href === "string") return doc.location.href;
    if (typeof doc.URL === "string") return doc.URL;
    if (typeof doc.baseURI === "string") return doc.baseURI;
    return "";
  }

  function baseUrlOf(doc, el) {
    if (doc && typeof doc.baseURI === "string" && doc.baseURI) return doc.baseURI;
    if (el && el.ownerDocument && typeof el.ownerDocument.baseURI === "string") {
      return el.ownerDocument.baseURI;
    }
    return pageUrlOf(doc);
  }

  function resolveUrl(raw, base) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    const value = raw.trim();
    if (DATA_URL.test(value) || UNSAFE_SCHEME.test(value)) return null;
    let resolved;
    try {
      resolved = base ? new URL(value, base) : new URL(value);
    } catch {
      return null;
    }
    if (!ALLOWED_IMAGE_SCHEME.test(resolved.protocol)) return null;
    return resolved.href;
  }

  function styleOf(el) {
    if (!el || !el.ownerDocument) return null;
    const win = el.ownerDocument.defaultView;
    if (win && typeof win.getComputedStyle === "function") {
      try {
        return win.getComputedStyle(el);
      } catch {
        return null;
      }
    }
    return null;
  }

  function backgroundUrlOf(el) {
    const style = styleOf(el);
    if (!style || typeof style.backgroundImage !== "string") return null;
    const value = style.backgroundImage;
    if (!value || value === "none") return null;
    const match = /url\((['"]?)(.*?)\1\)/i.exec(value);
    return match && match[2] ? match[2] : null;
  }

  /**
   * 解析 srcset，取最大宽度/像素密度候选。纯字符串逻辑，便于单测。
   * @param {string} srcset
   * @returns {string}
   */
  function bestFromSrcset(srcset) {
    if (typeof srcset !== "string" || !srcset.trim()) return "";
    const candidates = [];
    for (const part of srcset.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const pieces = trimmed.split(/\s+/);
      const url = pieces[0];
      if (!url || DATA_URL.test(url)) continue;
      // srcset 里的 data: 候选会因逗号被切碎，丢弃没有 URL 特征的碎片。
      if (!/[\/.:]/.test(url)) continue;
      const descriptor = pieces[1] || "";
      let weight = 1;
      const widthMatch = /^(\d+(?:\.\d+)?)w$/i.exec(descriptor);
      const densityMatch = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor);
      if (widthMatch) weight = Number(widthMatch[1]);
      else if (densityMatch) weight = Number(densityMatch[1]);
      candidates.push({ url, weight });
    }
    if (!candidates.length) return "";
    candidates.sort((a, b) => b.weight - a.weight);
    return candidates[0].url;
  }

  function srcOfImage(img) {
    if (!img) return "";
    if (typeof img.currentSrc === "string" && img.currentSrc) return img.currentSrc;
    if (typeof img.src === "string" && img.src) return img.src;
    if (typeof img.getAttribute === "function") {
      const raw = img.getAttribute("src");
      if (raw) return raw;
      const srcset = img.getAttribute("srcset");
      if (srcset) {
        const best = bestFromSrcset(srcset);
        if (best) return best;
      }
    }
    if (img.dataset) {
      if (typeof img.dataset.src === "string" && img.dataset.src) return img.dataset.src;
      if (typeof img.dataset.original === "string" && img.dataset.original) return img.dataset.original;
      if (typeof img.dataset.lazySrc === "string" && img.dataset.lazySrc) return img.dataset.lazySrc;
    }
    return "";
  }

  /**
   * 目标选取：<img> 本身 → closest("img") → computed background-image。
   * data: 与非法协议忽略。
   * @param {Element | null} el
   * @param {Document} [doc]
   * @returns {string | null}
   */
  function pickImageUrl(el, doc) {
    if (!el) return null;
    const documentRef = doc || el.ownerDocument || null;
    let img = null;
    if (tagOf(el) === "IMG") {
      img = el;
    } else if (typeof el.closest === "function") {
      img = el.closest("img");
    }

    const base = baseUrlOf(documentRef, img || el);
    if (img) {
      const raw = srcOfImage(img);
      // 有 src 但不可用（data:/blob: 等）时直接忽略该元素，不再退化到背景图。
      if (raw) return resolveUrl(raw, base);
    }
    const background = backgroundUrlOf(img || el);
    if (!background) return null;
    return resolveUrl(background, base);
  }

  function escapeIdent(value) {
    const text = String(value);
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
      return globalThis.CSS.escape(text);
    }
    return text.replace(/([^A-Za-z0-9_-])/g, "\\$1");
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    const parts = [];
    let node = el;
    const docElement = el.ownerDocument ? el.ownerDocument.documentElement : null;
    while (node && node.nodeType === 1 && node !== docElement) {
      if (typeof node.id === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(node.id)) {
        parts.unshift(`#${escapeIdent(node.id)}`);
        break;
      }
      const tag = tagOf(node).toLowerCase();
      let index = 1;
      let total = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (tagOf(sibling) === tagOf(node)) {
          index += 1;
          total += 1;
        }
      }
      for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (tagOf(sibling) === tagOf(node)) total += 1;
      }
      const classNames = typeof node.className === "string" ? node.className.trim().split(/\s+/) : [];
      const firstClass = classNames.find((name) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name));
      if (total > 1) {
        const classPart = firstClass ? `.${escapeIdent(firstClass)}` : "";
        parts.unshift(`${tag}${classPart}:nth-of-type(${index})`);
      } else {
        parts.unshift(tag);
      }
      if (tag === "html") break;
      node = node.parentElement;
      if (parts.length >= 8) break;
    }
    return parts.join(" > ");
  }

  function rectOf(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    try {
      return el.getBoundingClientRect();
    } catch {
      return null;
    }
  }

  /**
   * 把命中的元素描述为 BrowserElement。
   * @param {Element | null} el
   * @param {Document} [doc]
   * @returns {object | null}
   */
  function describeElement(el, doc) {
    if (!el) return null;
    const documentRef = doc || el.ownerDocument || null;
    const img = tagOf(el) === "IMG" ? el : typeof el.closest === "function" ? el.closest("img") : null;
    const url = pickImageUrl(el, documentRef);
    if (!url) return null;

    const target = img || el;
    const rect = rectOf(target);
    const link = typeof target.closest === "function" ? target.closest("a[href]") : null;

    let width = null;
    let height = null;
    if (img) {
      if (Number.isFinite(img.naturalWidth) && img.naturalWidth > 0) width = img.naturalWidth;
      if (Number.isFinite(img.naturalHeight) && img.naturalHeight > 0) height = img.naturalHeight;
    }
    if (width === null && rect && Number.isFinite(rect.width) && rect.width > 0) {
      width = Math.round(rect.width);
    }
    if (height === null && rect && Number.isFinite(rect.height) && rect.height > 0) {
      height = Math.round(rect.height);
    }

    let outerHtml = null;
    if (typeof target.outerHTML === "string") {
      outerHtml = target.outerHTML.slice(0, 2000);
    }

    return {
      url,
      page_url: pageUrlOf(documentRef),
      selector: cssPath(target),
      alt: img && typeof img.alt === "string" ? img.alt : null,
      title: img && typeof img.title === "string" ? img.title : null,
      width,
      height,
      outer_html: outerHtml,
      link_url: link && typeof link.href === "string" ? link.href : null
    };
  }

  function pickTarget(el, doc) {
    if (tagOf(el) === "IMG") return el;
    if (typeof el.querySelector === "function") {
      const inner = el.querySelector("img");
      if (inner) return inner;
    }
    return el;
  }

  /**
   * 按 CSS 选择器批量采集，去重并按最小尺寸过滤。
   * @param {Document} documentRef
   * @param {string} selector
   * @param {{min_width?: number, min_height?: number, limit?: number}} [opts]
   * @returns {object[]}
   */
  function collectFromSelector(documentRef, selector, opts = {}) {
    const out = [];
    if (!documentRef || typeof selector !== "string" || !selector.trim()) return out;
    let nodes;
    try {
      nodes = documentRef.querySelectorAll(selector);
    } catch {
      return out;
    }
    const minWidth = Number.isFinite(opts.min_width) ? opts.min_width : 0;
    const minHeight = Number.isFinite(opts.min_height) ? opts.min_height : 0;
    const limit = Number.isFinite(opts.limit) ? Math.min(50, Math.max(1, opts.limit)) : 50;
    const seen = new Set();
    for (const node of nodes) {
      if (out.length >= limit) break;
      const element = describeElement(pickTarget(node, documentRef), documentRef);
      if (!element || seen.has(element.url)) continue;
      if (minWidth > 0 && (!element.width || element.width < minWidth)) continue;
      if (minHeight > 0 && (!element.height || element.height < minHeight)) continue;
      seen.add(element.url);
      out.push(element);
    }
    return out;
  }

  return {
    bestFromSrcset,
    cssPath,
    pickImageUrl,
    describeElement,
    collectFromSelector
  };
});
