// URL 规范化、仅 http(s) 过滤、本地端口拼接。纯 ES module，可在 Node 直接单测。
// 安全底线：桥只允许 127.0.0.1 / localhost；页面资源只允许 http(s)。

export const DEFAULT_UPLOAD_PORT = 38124;
export const DEFAULT_WS_PORT = 38123;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * 解析为 http/https URL；其它协议（file:、data:、javascript:、ftp: 等）一律返回 null。
 * @param {string} input
 * @param {string} [base]
 * @returns {URL | null}
 */
export function parseHttpUrl(input, base) {
  if (typeof input !== "string" || !input.trim()) return null;
  let url;
  try {
    url = base ? new URL(input.trim(), base) : new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

/**
 * 规范化 http(s) URL；去掉 fragment，保留 query；相对地址按 base 解析。
 * @param {string} input
 * @param {string} [base]
 * @returns {string | null}
 */
export function normalizeUrl(input, base) {
  const url = parseHttpUrl(input, base);
  if (!url) return null;
  url.hash = "";
  return url.href;
}

/**
 * @param {string} input
 * @param {string} [base]
 * @returns {boolean}
 */
export function isHttpUrl(input, base) {
  return parseHttpUrl(input, base) !== null;
}

/**
 * 主机名是否指向本机（去掉 IPv6 方括号并小写）。
 * @param {unknown} host
 * @returns {boolean}
 */
export function isLocalHost(host) {
  if (typeof host !== "string") return false;
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOCAL_HOSTS.has(normalized);
}

function splitHostPort(value) {
  const index = value.lastIndexOf(":");
  if (index < 0) return [value, ""];
  return [value.slice(0, index), value.slice(index + 1)];
}

/**
 * 校验并规范化桥地址为 `host:port`；只接受本机 http（或缺省 scheme）地址。
 * 例：`127.0.0.1` → `127.0.0.1:38124`；`localhost:40000` → 原样；`example.com:38124` → null。
 * @param {string} input
 * @returns {string | null}
 */
export function normalizeEndpoint(input) {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text) return null;

  let host = "";
  let portText = "";

  const schemeMatch = /^(https?):\/\/(\[[^\]]+\]|[^:/?#\s]+)(?::(\d{1,5}))?\/?$/i.exec(text);
  if (schemeMatch) {
    if (schemeMatch[1].toLowerCase() !== "http") return null;
    host = schemeMatch[2];
    portText = schemeMatch[3] || "";
  } else {
    const bareMatch = /^(\[[^\]]+\]|[^:/?#\s]+)(?::(\d{1,5}))?$/.exec(text);
    if (!bareMatch) return null;
    host = bareMatch[1];
    portText = bareMatch[2] || "";
  }

  if (!isLocalHost(host)) return null;
  const port = portText ? Number(portText) : DEFAULT_UPLOAD_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const normalizedHost = host.startsWith("[") ? host.toLowerCase() : host.toLowerCase();
  return `${normalizedHost}:${port}`;
}

/**
 * @param {string} input
 * @returns {boolean}
 */
export function isLocalEndpoint(input) {
  return normalizeEndpoint(input) !== null;
}

/**
 * `host:port` → `http://host:port`。
 * @param {string} endpoint
 * @returns {string | null}
 */
export function httpBase(endpoint) {
  const normalized = normalizeEndpoint(endpoint);
  return normalized ? `http://${normalized}` : null;
}

/**
 * 配对接口地址。
 * @param {string} endpoint
 * @returns {string | null}
 */
export function pairUrl(endpoint) {
  const base = httpBase(endpoint);
  return base ? `${base}/v1/pair` : null;
}

/**
 * 上传接口地址。
 * @param {string} endpoint
 * @returns {string | null}
 */
export function uploadUrl(endpoint) {
  const base = httpBase(endpoint);
  return base ? `${base}/v1/upload` : null;
}

/**
 * 由 HTTP 端点推导 WebSocket 基址：默认上传端口 38124 对应 WS 38123，其它端口原样。
 * @param {string} endpoint
 * @returns {string | null}
 */
export function wsBaseFromEndpoint(endpoint) {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized) return null;
  const [host, portText] = splitHostPort(normalized);
  const port = Number(portText);
  const wsPort = port === DEFAULT_UPLOAD_PORT ? DEFAULT_WS_PORT : port;
  return `ws://${host}:${wsPort}`;
}

/**
 * 完整 WebSocket 地址，默认 `/ws`。
 * @param {string} endpoint
 * @param {string} [path]
 * @returns {string | null}
 */
export function wsUrl(endpoint, path = "/ws") {
  const base = wsBaseFromEndpoint(endpoint);
  if (!base) return null;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
