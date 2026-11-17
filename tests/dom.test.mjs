import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dom = require("../lib/dom.js");

const { bestFromSrcset, cssPath, pickImageUrl, describeElement, collectFromSelector } = dom;

function element(tagName, props = {}) {
  return {
    nodeType: 1,
    tagName,
    previousElementSibling: null,
    nextElementSibling: null,
    parentElement: null,
    ...props
  };
}

function image(props = {}) {
  return element("IMG", {
    tagName: "IMG",
    currentSrc: "",
    src: "",
    alt: "",
    title: "",
    naturalWidth: 0,
    naturalHeight: 0,
    outerHTML: "<img>",
    closest: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    ...props
  });
}

test("bestFromSrcset picks the highest density candidate", () => {
  assert.equal(bestFromSrcset("a.png 1x, b.png 2x"), "b.png");
  assert.equal(bestFromSrcset("a.png 640w, b.png 1280w, c.png 960w"), "b.png");
  assert.equal(bestFromSrcset("only.png"), "only.png");
  assert.equal(bestFromSrcset(""), "");
  assert.equal(bestFromSrcset(undefined), "");
});

test("bestFromSrcset ignores data: candidates", () => {
  assert.equal(bestFromSrcset("data:image/png;base64,AAAA 1x, c.png 2x"), "c.png");
  assert.equal(bestFromSrcset("data:image/png;base64,AAAA 1x"), "");
});

test("cssPath prefers ids and falls back to nth-of-type", () => {
  const docElement = element("HTML");
  const body = element("BODY", { parentElement: docElement });
  const main = element("DIV", { id: "main", parentElement: body });
  const first = element("IMG", { parentElement: main });
  const second = element("IMG", {
    parentElement: main,
    previousElementSibling: first,
    className: "hero"
  });
  first.nextElementSibling = second;

  assert.equal(cssPath(second), "#main > img.hero:nth-of-type(2)");
  assert.equal(cssPath(main), "#main");
  assert.equal(
    cssPath(element("P", { parentElement: body, ownerDocument: { documentElement: docElement } })),
    "body > p"
  );
});

test("pickImageUrl resolves relative background images inside the page", () => {
  const doc = {
    baseURI: "https://example.com/dir/page.html",
    location: { href: "https://example.com/dir/page.html" },
    defaultView: {
      getComputedStyle: () => ({ backgroundImage: 'url("../assets/bg.png")' })
    }
  };
  const div = element("DIV", { ownerDocument: doc, closest: () => null });
  assert.equal(pickImageUrl(div, doc), "https://example.com/assets/bg.png");
});

test("pickImageUrl ignores data: urls", () => {
  const doc = {
    baseURI: "https://example.com/",
    location: { href: "https://example.com/" },
    defaultView: {
      getComputedStyle: () => ({ backgroundImage: 'url("https://cdn.test/bg.png")' })
    }
  };
  const img = image({
    ownerDocument: doc,
    src: "data:image/png;base64,AAAA"
  });
  assert.equal(pickImageUrl(img, doc), null);
});

test("describeElement builds a BrowserElement shape", () => {
  const link = { href: "https://example.com/detail" };
  const doc = {
    baseURI: "https://example.com/gallery",
    location: { href: "https://example.com/gallery" }
  };
  const img = image({
    ownerDocument: doc,
    currentSrc: "https://cdn.test/a.png",
    alt: "cover",
    title: "A",
    naturalWidth: 800,
    naturalHeight: 600,
    closest: (selector) => (selector === "a[href]" ? link : null)
  });

  assert.deepEqual(describeElement(img, doc), {
    url: "https://cdn.test/a.png",
    page_url: "https://example.com/gallery",
    selector: "img",
    alt: "cover",
    title: "A",
    width: 800,
    height: 600,
    outer_html: "<img>",
    link_url: "https://example.com/detail"
  });
});

test("collectFromSelector dedupes and applies minimum sizes", () => {
  const doc = {
    baseURI: "https://example.com/gallery",
    location: { href: "https://example.com/gallery" },
    querySelectorAll: () => [
      image({
        ownerDocument: doc,
        currentSrc: "https://cdn.test/a.png",
        naturalWidth: 800,
        naturalHeight: 600
      }),
      image({
        ownerDocument: doc,
        currentSrc: "https://cdn.test/a.png",
        naturalWidth: 800,
        naturalHeight: 600
      }),
      image({
        ownerDocument: doc,
        currentSrc: "https://cdn.test/small.png",
        naturalWidth: 80,
        naturalHeight: 60
      })
    ]
  };

  const all = collectFromSelector(doc, ".card img", {});
  assert.equal(all.length, 2);
  assert.equal(all[0].url, "https://cdn.test/a.png");

  const big = collectFromSelector(doc, ".card img", { min_width: 400, min_height: 400 });
  assert.equal(big.length, 1);

  const limited = collectFromSelector(doc, ".card img", { limit: 1 });
  assert.equal(limited.length, 1);
  assert.deepEqual(collectFromSelector(doc, "", {}), []);
});
