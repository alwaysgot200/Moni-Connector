import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_UPLOAD_PORT,
  DEFAULT_WS_PORT,
  normalizeUrl,
  normalizeEndpoint,
  isHttpUrl,
  isLocalEndpoint,
  isLocalHost,
  pairUrl,
  uploadUrl,
  wsBaseFromEndpoint,
  wsUrl
} from "../lib/urls.js";

test("normalizeUrl keeps only http(s) and drops fragments", () => {
  assert.equal(
    normalizeUrl("HTTP://Example.COM:80/a/../b?x=1#frag"),
    "http://example.com/b?x=1"
  );
  assert.equal(
    normalizeUrl("/img/a.png", "https://example.com/dir/page.html"),
    "https://example.com/img/a.png"
  );
  assert.equal(
    normalizeUrl("https://example.com:443/p.png#top"),
    "https://example.com/p.png"
  );
});

test("normalizeUrl rejects non-http schemes", () => {
  assert.equal(normalizeUrl("file:///C:/x.png"), null);
  assert.equal(normalizeUrl("data:image/png;base64,AAAA"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("ftp://127.0.0.1/x.png"), null);
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("isHttpUrl only accepts http(s)", () => {
  assert.equal(isHttpUrl("https://example.com/a.png"), true);
  assert.equal(isHttpUrl("http://127.0.0.1/a.png"), true);
  assert.equal(isHttpUrl("file:///tmp/a.png"), false);
});

test("normalizeEndpoint fills the default upload port and only allows loopback", () => {
  assert.equal(normalizeEndpoint("127.0.0.1"), `127.0.0.1:${DEFAULT_UPLOAD_PORT}`);
  assert.equal(normalizeEndpoint(" localhost "), `localhost:${DEFAULT_UPLOAD_PORT}`);
  assert.equal(normalizeEndpoint("localhost:40000"), "localhost:40000");
  assert.equal(normalizeEndpoint("http://127.0.0.1:38124"), "127.0.0.1:38124");
  assert.equal(normalizeEndpoint("http://localhost:40000/"), "localhost:40000");
  assert.equal(normalizeEndpoint("[::1]:38124"), "[::1]:38124");
});

test("normalizeEndpoint rejects external hosts, https and malformed ports", () => {
  assert.equal(normalizeEndpoint("example.com:38124"), null);
  assert.equal(normalizeEndpoint("https://example.com:38124"), null);
  assert.equal(normalizeEndpoint("https://127.0.0.1:38124"), null);
  assert.equal(normalizeEndpoint("ftp://127.0.0.1:38124"), null);
  assert.equal(normalizeEndpoint("127.0.0.1:0"), null);
  assert.equal(normalizeEndpoint("127.0.0.1:70000"), null);
  assert.equal(normalizeEndpoint("127.0.0.1:38124/path"), null);
  assert.equal(normalizeEndpoint("127.0.0.1?x=1"), null);
  assert.equal(normalizeEndpoint(""), null);
  assert.equal(normalizeEndpoint(undefined), null);
});

test("isLocalEndpoint and isLocalHost keep the bridge on loopback", () => {
  assert.equal(isLocalEndpoint("127.0.0.1:38124"), true);
  assert.equal(isLocalEndpoint("http://localhost:38125"), true);
  assert.equal(isLocalEndpoint("https://example.com"), false);
  assert.equal(isLocalEndpoint("10.0.0.2:38124"), false);
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("[::1]"), true);
  assert.equal(isLocalHost("192.168.1.10"), false);
});

test("pair, upload and ws urls are derived from the endpoint", () => {
  assert.equal(pairUrl("127.0.0.1"), `http://127.0.0.1:${DEFAULT_UPLOAD_PORT}/v1/pair`);
  assert.equal(uploadUrl("localhost:40000"), "http://localhost:40000/v1/upload");
  assert.equal(
    wsBaseFromEndpoint("127.0.0.1"),
    `ws://127.0.0.1:${DEFAULT_WS_PORT}`
  );
  assert.equal(wsBaseFromEndpoint("127.0.0.1:38125"), "ws://127.0.0.1:38125");
  assert.equal(wsUrl("127.0.0.1"), `ws://127.0.0.1:${DEFAULT_WS_PORT}/ws`);
  assert.equal(wsUrl("127.0.0.1:38125", "socket"), "ws://127.0.0.1:38125/socket");
  assert.equal(pairUrl("example.com"), null);
  assert.equal(uploadUrl("file:///tmp"), null);
});
