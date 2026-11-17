// 扩展内部消息类型与桥错误辅助。纯 ES module，供 background / popup / options 共用。
// 内容脚本经 executeScript 注入，不能用 module，故其消息名在 content/*.js 内以字符串重复。

export const MSG = Object.freeze({
  PICK_START: "moni.pick.start",
  PICK_CANCEL: "moni.pick.cancel",
  PICKED: "moni.picked",
  QUERY_START: "moni.query.start",
  RESOLVE_START: "moni.resolve.start",
  CONTEXT_DESCRIBE: "moni.context.describe",
  FETCH_START: "moni.fetch.start",
  STATUS_GET: "moni.status.get",
  STATUS_CHANGED: "moni.status.changed",
  RECONNECT: "moni.reconnect",
  TEST: "moni.test"
});

// 与 moni-core::action::error 的 ActionErrorCode 保持一致；扩展只发其中一部分。
export const CODES = Object.freeze({
  NO_TEXT: "A101_NO_TEXT",
  DENIED: "A201_DENIED",
  REAUTH: "A202_REAUTH_REQUIRED",
  UNSUPPORTED: "A302_UNSUPPORTED",
  BRIDGE_BUSY: "A403_BRIDGE_BUSY",
  NO_ELEMENTS: "A404_NO_ELEMENTS",
  DOWNLOAD_FAILED: "A405_DOWNLOAD_FAILED",
  BROWSER_OFFLINE: "A406_BROWSER_OFFLINE",
  ACTION_FAILED: "A500_ACTION_FAILED",
  TIMEOUT: "A501_TIMEOUT",
  CANCELLED: "A502_CANCELLED",
  TOO_LARGE: "A503_TOO_LARGE",
  PAYLOAD_TOO_LARGE: "A504_PAYLOAD_TOO_LARGE"
});

/**
 * 构造可回填 error 帧的结构化错误。
 * @param {string} code
 * @param {string} message
 * @param {boolean} [retryable]
 * @returns {{code: string, message: string, retryable: boolean}}
 */
export function bridgeError(code, message, retryable = false) {
  return {
    code: typeof code === "string" && code ? code : CODES.ACTION_FAILED,
    message: typeof message === "string" && message ? message : "unknown error",
    retryable: retryable === true
  };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBridgeError(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.code === "string" &&
      typeof value.message === "string"
  );
}

/**
 * 把任意异常收敛为 {code, message, retryable}，避免异常被吞掉后回空 result。
 * @param {unknown} err
 * @param {string} [fallbackCode]
 */
export function toBridgeError(err, fallbackCode = CODES.ACTION_FAILED) {
  if (isBridgeError(err)) {
    return bridgeError(err.code, err.message, err.retryable === true);
  }
  if (err instanceof Error) {
    return bridgeError(fallbackCode, err.message || String(err));
  }
  if (typeof err === "string" && err) {
    return bridgeError(fallbackCode, err);
  }
  return bridgeError(fallbackCode, "unknown error");
}
