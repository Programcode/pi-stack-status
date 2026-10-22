import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import worker, { BUCKETS, HISTORY_LENGTH, SITES, escape, summarize } from "../src/index.js";

function memoryKV(initial) {
  const store = new Map(initial ?? []);
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function stateFor(overrides = {}) {
  const sites = {};
  for (const site of SITES) {
    const history = overrides[site.url]?.history ?? Array(HISTORY_LENGTH).fill(1);
    const last = overrides[site.url]?.last ?? { ok: true, code: 200, ms: 40, at: Date.now() };
    sites[site.url] = { history, last };
  }
  return { checkedAt: Date.now(), sites };
}

async function read(response) {
  return { status: response.status, headers: response.headers, text: await response.text() };
}

test("escapes HTML in text and attributes", () => {
  assert.equal(escape(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("summarizes a full day, a partial bucket, and a short history", () => {
  const allUp = summarize(stateFor());
  assert.equal(allUp.length, SITES.length);
  assert.equal(allUp[0].uptime, 100);
  assert.equal(allUp[0].bars.length, BUCKETS);
  assert.ok(allUp[0].bars.every((bar) => bar === "up"));

  const mixed = Array(HISTORY_LENGTH - 6).fill(1).concat([1, 1, 1, 0, 0, 0]);
  const partial = summarize(stateFor({ [SITES[0].url]: { history: mixed, last: { ok: false, code: 502, ms: 12, at: 1 } } }))[0];
  assert.equal(partial.bars.at(-1), "partial");
  assert.deepEqual(partial.bars.slice(0, -1), Array(BUCKETS - 1).fill("up"));
  assert.equal(partial.ok, false);

  const fresh = summarize(stateFor({ [SITES[1].url]: { history: [0], last: { ok: false, code: 0, ms: 10, at: 1 } } }))[1];
  assert.equal(fresh.bars.filter((bar) => bar === "none").length, BUCKETS - 1);
  assert.equal(fresh.bars.at(-1), "down");
  assert.equal(fresh.uptime, 0);

  const [empty] = summarize({ sites: {} });
  assert.equal(empty.uptime, null);
  assert.equal(empty.ok, null);
  assert.ok(empty.bars.every((bar) => bar === "none"));
});

test("renders the page and the JSON API from stored history", async () => {
  const env = { STATE: memoryKV([["state", JSON.stringify(stateFor())]]) };
  const page = await read(await worker.fetch(new Request("https://status.pi-stack.org/"), env));
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.text, /Everything is running/);
  assert.match(page.text, /DebateLab/);
  assert.equal(page.text.match(/<span class="up"><\/span>/g).length, SITES.length * BUCKETS);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(page.headers.get("access-control-allow-origin"), null);

  const downState = stateFor({
    [SITES[2].url]: { history: Array(HISTORY_LENGTH).fill(0), last: { ok: false, code: 503, ms: 80, at: Date.now() } },
  });
  const downEnv = { STATE: memoryKV([["state", JSON.stringify(downState)]]) };
  const downPage = await read(await worker.fetch(new Request("https://status.pi-stack.org/"), downEnv));
  assert.match(downPage.text, /Athel is down/);
  assert.match(downPage.text, /HTTP 503/);

  const api = await worker.fetch(new Request("https://status.pi-stack.org/api/status"), env);
  assert.equal(api.status, 200);
  assert.equal(api.headers.get("access-control-allow-origin"), "*");
  const body = await api.json();
  assert.equal(body.sites.length, SITES.length);
  assert.equal(body.sites[0].bars, undefined);
  assert.equal(body.sites[0].uptime, 100);
  assert.equal(typeof body.checkedAt, "number");
});

test("unknown paths and methods do not probe the sites", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("no");
  };
  try {
    const env = { STATE: memoryKV() };
    const missing = await worker.fetch(new Request("https://status.pi-stack.org/favicon.ico"), env);
    assert.equal(missing.status, 404);
    const posted = await worker.fetch(new Request("https://status.pi-stack.org/", { method: "POST" }), env);
    assert.equal(posted.status, 405);
    assert.match(posted.headers.get("allow"), /GET, HEAD/);
    assert.equal(calls, 0);
    assert.equal(env.STATE.store.size, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("an empty store checks every site once and counts redirects as up", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), redirect: init?.redirect, ua: init?.headers?.["user-agent"] });
    if (String(url).includes("athel")) return new Response("nope", { status: 500 });
    if (String(url).includes("notes")) throw new TypeError("connect failed");
    if (String(url).includes("proto")) return new Response(null, { status: 307 });
    return new Response("ok", { status: 200 });
  };
  try {
    const env = { STATE: memoryKV() };
    const response = await worker.fetch(new Request("https://status.pi-stack.org/"), env);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(calls.length, SITES.length);
    assert.ok(calls.every((call) => call.redirect === "manual"));
    assert.match(calls[0].ua, /PiStackStatus\/1\.0/);
    assert.match(html, /2 sites are down/);
    assert.match(html, /Athel/);
    assert.match(html, /YubiNotes/);
    const stored = JSON.parse(env.STATE.store.get("state"));
    assert.equal(stored.sites["https://proto.pi-stack.org/"].last.ok, true);
    assert.equal(stored.sites["https://proto.pi-stack.org/"].last.code, 307);
    assert.equal(stored.sites["https://athel.pi-stack.org/"].history.at(-1), 0);
    assert.equal(stored.sites["https://notes.pi-stack.org/"].last.error, "TypeError");
  } finally {
    globalThis.fetch = original;
  }
});

test("a missing store or a failed read does not throw a stack to the client", async () => {
  const missing = await worker.fetch(new Request("https://status.pi-stack.org/"), {});
  assert.equal(missing.status, 500);
  assert.match(await missing.text(), /not configured/);

  const broken = {
    STATE: {
      async get() {
        throw new Error("kv down");
      },
      async put() {},
    },
  };
  const failed = await worker.fetch(new Request("https://status.pi-stack.org/api/status"), broken);
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /kv down/);
});

test("the cron records a check and logs a structured failure", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("ok", { status: 200 });
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const env = { STATE: memoryKV() };
    let background;
    await worker.scheduled(null, env, { waitUntil(job) { background = job; } });
    await background;
    const stored = JSON.parse(env.STATE.store.get("state"));
    assert.equal(Object.keys(stored.sites).length, SITES.length);

    calls = 0;
    await assert.rejects(worker.scheduled(null, {}, { waitUntil() {} }), /STATE binding is not configured/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
  }
  assert.match(errors.join("\n"), /scheduled_check_failed/);
  assert.doesNotMatch(errors.join("\n"), /https?:\/\//);
});

test("wrangler config does not commit a Cloudflare account id", () => {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(raw, /"account_id"/);
});
