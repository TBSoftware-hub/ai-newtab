import { test } from "node:test";
import assert from "node:assert/strict";
import { runOpenRouterBuild, validateOpenRouterModel, OPENROUTER_CHECKPOINT_KEY,
  type BrowserBridge, type KVStore, type OpenRouterCheckpoint, type ModelFetch } from "@homepage/agent-core";
import { validateHomepageCode } from "../apps/extension/lib/transpile";
import { transform } from "sucrase";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const code = `import React from 'react';
export default function PersonalizedHomepage() {
  return <main><h1>Today</h1><a href="https://public.test/story">A real story</a></main>;
}`;
const call = (id: string, name: string, args: unknown) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});
function fixture(responses: unknown[] = [
  [call("history", "getHistory", {})],
  [call("pages", "getPageHtml", { urls: ["https://public.test/"] })],
  [call("read", "readPage", { pageId: "page-1" })],
  [call("submit", "submitHomepage", { code })],
]) {
  const values = new Map<string, unknown>();
  const requests: Array<Record<string, unknown>> = [];
  const scraps: string[][] = [];
  let count = 0;
  const store: KVStore = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    remove: async (key) => { values.delete(key); },
  };
  const bridge: BrowserBridge = {
    getHistory: async () => ({
      sites: [{ domain: "public.test", totalVisits: 2, uniquePages: 1, lastVisitTime: Date.now(),
        averageVisitsPerDay: 1, relevanceScore: 1, titles: ["News"], urls: ["https://public.test/"] }],
      totalSitesSeen: 1,
    }),
    getPageHtml: async ({ urls }) => {
      scraps.push(urls);
      return { pages: urls.map((url) => ({ url, title: "News",
        html: '<a href="https://public.test/story">A real story</a>' })), failed: [] };
    },
  };
  const fetcher: ModelFetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({
      data: [{ id: "test/model", supported_parameters: ["tools"] }],
    });
    requests.push(JSON.parse(String(init?.body)));
    const next = responses[count++];
    if (next instanceof Response) return next;
    if (!next) throw new Error("Fixture ran out of responses");
    return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: next }, finish_reason: "tool_calls" }] });
  };
  const options = { apiKey: "fixture-not-a-real-key", model: "test/model", bridge, store,
    fetch: fetcher, validateCode: validateHomepageCode, blockedSites: [] };
  return { values, requests, scraps, options };
}

test("full tool loop produces a component that transforms and server-renders", async () => {
  const f = fixture();
  const result = await runOpenRouterBuild(f.options);
  assert.equal(result.code, code);
  assert.equal(result.source, "tool-submission");
  assert.equal(f.requests.length, 4);
  assert.ok(f.requests.every((r) => Array.isArray(r.tools)));
  assert.deepEqual(f.requests[0].provider, { require_parameters: true, data_collection: "deny" });
  const transformed = transform(code, { transforms: ["typescript", "imports", "jsx"] }).code;
  const exports: { default?: React.ComponentType } = {};
  new Function("require", "exports", transformed)((name: string) => {
    assert.equal(name, "react");
    return React;
  }, exports);
  assert.ok(exports.default);
  assert.match(renderToStaticMarkup(React.createElement(exports.default)), /A real story/);
  assert.equal((f.values.get(OPENROUTER_CHECKPOINT_KEY) as OpenRouterCheckpoint).code, code);
});

test("catalog rejects missing and non-tool models without sending inference", async () => {
  for (const model of ["bad", "test/missing", "test/plain"]) {
    await assert.rejects(validateOpenRouterModel(model, async () => Response.json({
      data: [{ id: "test/plain", supported_parameters: [] }],
    })));
  }
});

test("blocked and local requests never reach the bridge or upload page bodies", async () => {
  const f = fixture([
    [call("blocked", "getPageHtml", { urls: ["https://bank.test", "http://127.0.0.1/", "file:///secret"] })],
    [],
  ]);
  await assert.rejects(runOpenRouterBuild({ ...f.options, blockedSites: ["bank.test"] }), /without submitting/);
  assert.deepEqual(f.scraps, []);
  const messages = f.requests[1].messages as Array<{ role: string; content: string }>;
  const result = JSON.parse(messages.find((m) => m.role === "tool")!.content);
  assert.equal(result.failed.length, 3);
  assert.equal(f.values.has(OPENROUTER_CHECKPOINT_KEY), false);
});

test("drops blocked redirect content before it reaches model context or checkpoint pages", async () => {
  const f = fixture([[call("pages", "getPageHtml", { urls: ["https://public.test/"] })], []]);
  f.options.bridge.getPageHtml = async () => ({ pages: [{
    url: "https://public.test/", finalUrl: "https://bank.test/", title: "Secret", html: "PRIVATE_BODY",
  }], failed: [] });
  await assert.rejects(runOpenRouterBuild({ ...f.options, blockedSites: ["bank.test"] }));
  assert.ok(!JSON.stringify(f.requests).includes("PRIVATE_BODY"));
  assert.ok(!JSON.stringify(f.requests).includes("Secret"));
});

test("enforces cumulative eight-page budget even across multiple calls", async () => {
  const f = fixture([
    [call("first", "getPageHtml", { urls: Array(8).fill("https://public.test/") })],
    [call("second", "getPageHtml", { urls: ["https://public.test/again"] })], [],
  ]);
  await assert.rejects(runOpenRouterBuild(f.options));
  assert.equal(f.scraps.length, 1);
  assert.match(JSON.stringify(f.requests[2]), /Eight-page build budget exceeded/);
});

test("malformed tool arguments, unknown tools and invalid output get explicit tool errors", async () => {
  const f = fixture([
    [call("history", "getHistory", { daysToAnalyze: 999 }), call("unknown", "bash", { command: "no" })],
    [call("submit", "submitHomepage", { code: "invalid" })], [],
  ]);
  await assert.rejects(runOpenRouterBuild(f.options));
  assert.match(JSON.stringify(f.requests[1]), /between 1 and 90/);
  assert.match(JSON.stringify(f.requests[1]), /Unknown tool: bash/);
  assert.match(JSON.stringify(f.requests[2]), /at least one allowed page/);
});

test("read/search output is bounded and reports truncated pages", async () => {
  const f = fixture([
    [call("pages", "getPageHtml", { urls: ["https://public.test/"] })],
    [call("read", "readPage", { pageId: "page-1", length: 16000 }),
      call("search", "searchPage", { pageId: "page-1", query: "story" })], [],
  ]);
  f.options.bridge.getPageHtml = async () => ({ pages: [{
    url: "https://public.test/", title: "News", html: "story ".repeat(30_000),
  }], failed: [] });
  await assert.rejects(runOpenRouterBuild(f.options));
  const results = (f.requests[2].messages as Array<{ role: string; content: string }>)
    .filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  assert.equal(results[0].pages[0].truncated, true);
  assert.equal(results[1].text.length, 16000);
  assert.equal(results[2].matches.length, 10);
});

test("resume reuses completed results and does not replay an interrupted scrape", async () => {
  const f = fixture([[]]);
  const checkpoint: OpenRouterCheckpoint = {
    version: 1, id: "resume", model: "test/model",
    messages: [{ role: "assistant", content: null, tool_calls: [
      { ...call("interrupted", "getPageHtml", { urls: ["https://public.test/"] }), type: "function" },
    ] }],
    pages: {}, attempted: ["interrupted"], pageCount: 1, historyRead: true, turns: 1,
  };
  f.values.set(OPENROUTER_CHECKPOINT_KEY, checkpoint);
  await assert.rejects(runOpenRouterBuild({ ...f.options, resume: true, model: "test/changed" }));
  assert.deepEqual(f.scraps, []);
  assert.equal(f.requests[0].model, "test/model");
  assert.match(JSON.stringify(f.requests[0]), /interrupted by worker restart/);
});

test("completed output survives a restart without inference", async () => {
  const f = fixture();
  await runOpenRouterBuild(f.options);
  f.requests.length = 0;
  const resumed = await runOpenRouterBuild({ ...f.options, resume: true });
  assert.equal(resumed.code, code);
  assert.equal(f.requests.length, 0);
});

test("cancellation and API failures remove temporary private data", async () => {
  const cancelled = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runOpenRouterBuild({ ...cancelled.options, signal: controller.signal }));
  assert.equal(cancelled.values.has(OPENROUTER_CHECKPOINT_KEY), false);
  for (const status of [401, 402, 429, 500]) {
    const f = fixture([new Response("sensitive upstream body", { status })]);
    await assert.rejects(runOpenRouterBuild(f.options), new RegExp(`HTTP ${status}`));
    assert.equal(f.values.has(OPENROUTER_CHECKPOINT_KEY), false);
  }
});

test("rejects invalid TSX, missing component contracts and non-React imports", () => {
  for (const invalid of [
    "not TSX", code.replace("<main>", "<main><"), code.replace("PersonalizedHomepage", "Wrong"),
    code.replace("'react'", "'other'"), "import x from 'other';\n" + code,
    code + "\nimport('other');",
  ]) assert.throws(() => validateHomepageCode(invalid));
});

test("turn and context budgets fail explicitly before further model calls", async () => {
  const turns = fixture(Array.from({ length: 30 }, (_, i) => [call(`call-${i}`, "unknown", {})]));
  await assert.rejects(runOpenRouterBuild(turns.options), /30 model turns/);
  assert.equal(turns.requests.length, 30);
  const context = fixture();
  await assert.rejects(runOpenRouterBuild({ ...context.options, userSystemPrompt: "x".repeat(240_000) }), /context budget/);
  assert.equal(context.requests.length, 0);
});

test("malformed responses, duplicate IDs and truncated output stop rather than looping", async () => {
  for (const body of [
    { choices: [] },
    { choices: [{ message: { content: 42 } }] },
    { choices: [{ message: { content: null, tool_calls: [] }, finish_reason: "length" }] },
    { choices: [{ message: { content: null, tool_calls: [call("same", "unknown", {}), call("same", "unknown", {})] } }] },
    { error: { message: "PRIVATE_UPSTREAM_TEXT" } },
  ]) {
    const f = fixture([Response.json(body)]);
    await assert.rejects(runOpenRouterBuild(f.options), (error: Error) => !error.message.includes("PRIVATE_UPSTREAM_TEXT"));
    assert.equal(f.requests.length, 1);
    assert.equal(f.values.has(OPENROUTER_CHECKPOINT_KEY), false);
  }
});

test("block-list edits apply after scraping and before each cached-page read", async () => {
  let blocked: string[] = [];
  const f = fixture([[call("pages", "getPageHtml", { urls: ["https://public.test/"] })], []]);
  f.options.bridge.getPageHtml = async () => {
    blocked = ["public.test"];
    return { pages: [{ url: "https://public.test/", title: "PRIVATE_TITLE", html: "PRIVATE_BODY" }], failed: [] };
  };
  await assert.rejects(runOpenRouterBuild({ ...f.options, blockedSites: async () => blocked }));
  assert.ok(!JSON.stringify(f.requests).includes("PRIVATE_BODY"));
  assert.ok(!JSON.stringify(f.requests).includes("PRIVATE_TITLE"));
});

test("cancellation during scraping prevents another inference and clears cached pages", async () => {
  const f = fixture([[call("pages", "getPageHtml", { urls: ["https://public.test/"] })]]);
  const controller = new AbortController();
  f.options.bridge.getPageHtml = async () => {
    controller.abort();
    return { pages: [{ url: "https://public.test/", title: "Private", html: "PRIVATE_BODY" }], failed: [] };
  };
  await assert.rejects(runOpenRouterBuild({ ...f.options, signal: controller.signal }));
  assert.equal(f.requests.length, 1);
  assert.equal(f.values.has(OPENROUTER_CHECKPOINT_KEY), false);
  assert.ok(!JSON.stringify(f.requests).includes("PRIVATE_BODY"));
});
