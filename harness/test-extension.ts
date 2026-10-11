/**
 * Loads the built extension into a real (headless) Chrome and verifies the half
 * of the system the Bun harness can't reach:
 *
 *   1. the MV3 service worker registers,
 *   2. the new-tab override renders (the API-key screen on a fresh profile),
 *   3. the worker answers `subscribe` on the build port with a snapshot,
 *   4. `startBuild` with no API key fails cleanly with an error message,
 *   5. `chrome.history` is readable, so the `history` permission is real.
 *
 * No API calls are made. Chrome 136+ ignores `--load-extension`, so the
 * extension is loaded over CDP's Extensions domain instead.
 *
 * Run: pnpm build && pnpm extension:test
 * Set CHROME_PATH if Chrome isn't at the default macOS location.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.BROWSER_PATH ?? process.env.CHROME_PATH ??
  (process.platform === "win32"
    ? join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")
    : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "extension", ".output", "chrome-mv3");
let PORT = 0;

if (!existsSync(join(EXT, "manifest.json"))) {
  console.error(`No build at ${EXT}. Run: pnpm build`);
  process.exit(1);
}
if (!existsSync(CHROME)) throw new Error("Browser not found. Set BROWSER_PATH to your Edge or Chrome executable.");

const profile = mkdtempSync(join(tmpdir(), "hp-ext-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label: string, pass: boolean, extra?: string) => {
  console.log(`${pass ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!pass) failures++;
};

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-extension-debugging", // required for the CDP Extensions domain
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function getJson(path: string) {
  return (await fetch(`http://127.0.0.1:${PORT}${path}`)).json() as Promise<any>;
}

/** Minimal CDP client over a target's websocket. */
async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiters = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && waiters.has(msg.id)) {
      waiters.get(msg.id)!(msg);
      waiters.delete(msg.id);
    }
  };
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((res) => {
      const n = ++id;
      waiters.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return {
    send,
    close: () => ws.close(),
    async evaluate<T>(expression: string): Promise<T> {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      const ex = r.result?.exceptionDetails;
      if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
      return r.result?.result?.value as T;
    },
  };
}

try {
  for (let i = 0; i < 80; i++) {
    const portFile = join(profile, "DevToolsActivePort");
    if (existsSync(portFile)) {
      PORT = Number(readFileSync(portFile, "utf8").split("\n")[0]);
      break;
    }
    await sleep(250);
  }
  let version: any;
  for (let i = 0; i < 80; i++) {
    try {
      version = await getJson("/json/version");
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error("Chrome devtools endpoint never came up");
  console.log(`   ${version.Browser}\n`);

  // ---- load the unpacked extension ----------------------------------------
  const browser = await cdp(version.webSocketDebuggerUrl);
  const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const extId: string | undefined = loaded.result?.id;
  if (!extId) throw new Error(`loadUnpacked failed: ${JSON.stringify(loaded)}`);
  console.log(`   extension id: ${extId}\n`);

  // ---- 1. service worker ---------------------------------------------------
  let sw: any;
  for (let i = 0; i < 40 && !sw; i++) {
    const targets: any[] = await getJson("/json/list");
    sw = targets.find((t) => t.type === "service_worker" && t.url.includes(extId));
    if (!sw) await sleep(250);
  }
  check("MV3 service worker registered", Boolean(sw), sw?.url.split("/").pop());

  // ---- 2. new-tab override renders ----------------------------------------
  const targets: any[] = await getJson("/json/list");
  const blank = targets.find((t) => t.type === "page");
  if (!blank) throw new Error("no page target to navigate");

  const page = await cdp(blank.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  const nav = await page.send("Page.navigate", { url: "chrome://newtab/" });
  if (nav.result?.errorText) throw new Error(`navigate failed: ${nav.result.errorText}`);

  let href = "";
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      href = await page.evaluate<string>("location.href");
      const ready = await page.evaluate<string>("document.readyState");
      if (href.startsWith("chrome-extension://") && ready === "complete") break;
    } catch {
      /* navigation in flight */
    }
  }
  check("new-tab override loads", href.startsWith("chrome-extension://"), href);

  await sleep(2500); // let React mount
  const bodyText = await page.evaluate<string>("document.body.innerText");
  check(
    "renders the API-key setup screen",
    /Connect your AI provider/i.test(bodyText),
    bodyText.split("\n").filter(Boolean)[0]?.slice(0, 50),
  );
  const screenshot = async (name: string, width: number, height: number) => {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    if (process.env.SCREENSHOT_DIR) {
      mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(process.env.SCREENSHOT_DIR, `${name}.png`), Buffer.from(shot.result.data, "base64"));
    }
    check(`${name} fits viewport`, await page.evaluate<boolean>(`(() => {
      const dialog = document.querySelector("[role=dialog]");
      return document.documentElement.scrollWidth <= innerWidth && (!dialog || dialog.scrollWidth <= dialog.clientWidth);
    })()`));
  };
  await screenshot("setup-desktop", 1200, 800);
  await screenshot("setup-mobile", 390, 844);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });

  // Open a build port, send one message, and collect replies for a moment.
  const talkMany = (messages: object[], waitMs: number) =>
    page.evaluate<string>(`
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "homepage-agent" });
        const replies = [];
        port.onMessage.addListener((m) => replies.push(m));
        for (const message of ${JSON.stringify(messages)}) port.postMessage(message);
        setTimeout(() => { port.disconnect(); resolve(JSON.stringify(replies)); }, ${waitMs});
      })
    `).then((raw) => JSON.parse(raw) as any[]);
  const talk = (msg: object, waitMs: number) => talkMany([msg], waitMs);

  // ---- 3. subscribe → snapshot ---------------------------------------------
  const subscribed = await talk({ kind: "subscribe" }, 1500);
  const snapshot = subscribed.find((m) => m.kind === "snapshot");
  check(
    "worker answers subscribe with a build snapshot",
    Boolean(snapshot) && snapshot.state.running === false,
    JSON.stringify(subscribed[0])?.slice(0, 80),
  );

  // ---- 4. startBuild without a key fails cleanly ----------------------------
  const started = await talk({ kind: "startBuild" }, 3000);
  const error = started.find((m) => m.kind === "error");
  check("startBuild with no API key reports an error", /API key/i.test(error?.message ?? ""), error?.message);

  // ---- 5. chrome.history is readable ---------------------------------------
  const domains = await page.evaluate<string[]>(`
    (async () => {
      const seed = [
        "https://news.ycombinator.com/",
        "https://news.ycombinator.com/item?id=1",
        "https://lobste.rs/",
        "https://arstechnica.com/",
      ];
      for (const url of seed) await chrome.history.addUrl({ url });
      await new Promise((r) => setTimeout(r, 500));
      const items = await chrome.history.search({ text: "", startTime: 0, maxResults: 100 });
      return [...new Set(items.map((i) => new URL(i.url).hostname))];
    })()
  `);
  check(
    "chrome.history is readable (seeded domains returned)",
    domains.includes("news.ycombinator.com"),
    domains.join(", "),
  );

  if (!sw) throw new Error("No service worker available for provider tests.");
  const worker = await cdp(sw.webSocketDebuggerUrl);
  // Model traffic and scraping browser APIs are fixtures. Real history, storage,
  // worker orchestration and the page/worker protocol still run end to end.
  await worker.evaluate(`
    (() => {
      const originalFetch = globalThis.fetch;
      let turn = 0;
      const calls = [
        { name: "getHistory", arguments: "{}" },
        { name: "getPageHtml", arguments: JSON.stringify({ urls: ["https://public.test/"], loadDelayMs: 0 }) },
        { name: "readPage", arguments: JSON.stringify({ pageId: "page-1" }) },
        { name: "submitHomepage", arguments: JSON.stringify({ code: "import React from 'react'; export default function PersonalizedHomepage() { return <main><h1>Fixture homepage</h1><a href='https://public.test/story'>Story</a></main>; }" }) },
      ];
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test/model", supported_parameters: ["tools"] }] });
        if (String(url).endsWith("/chat/completions")) {
          const fn = calls[turn++];
          if (!fn) throw new Error("Unexpected extra fixture inference");
          return Response.json({ choices: [{ message: { content: null, tool_calls: [{
            id: "fixture-" + turn, type: "function", function: fn
          }] }, finish_reason: "tool_calls" }] });
        }
        return originalFetch(url, init);
      };
      chrome.windows.create = async () => ({ id: 900001 });
      chrome.windows.remove = async () => {};
      chrome.tabs.create = async () => ({ id: 900002 });
      chrome.tabs.remove = async () => {};
      chrome.tabs.onUpdated.addListener = (listener) => { setTimeout(() => listener(900002, { status: "complete" }), 10); };
      chrome.tabs.onUpdated.removeListener = () => {};
      chrome.scripting.executeScript = async () => [{ result: { url: "https://public.test/", title: "Fixture", html: "<a href='https://public.test/story'>Story</a>" } }];
      return true;
    })()
  `);
  await page.evaluate(`
    (() => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => String(url).endsWith("/models")
        ? Promise.resolve(Response.json({ data: [{ id: "test/model", supported_parameters: ["tools"] }] }))
        : originalFetch(url, init);
      const select = document.querySelector("select");
      select.value = "openrouter";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()
  `);
  await sleep(200);
  await page.evaluate(`
    (() => {
      const setInput = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      setInput(document.querySelector("input[type=password]"), "sk-or-fixture-not-a-real-key");
      setInput(document.querySelector("input[list]"), "test/model");
    })()
  `);
  await sleep(100);
  await page.evaluate("document.querySelector('button[type=submit]').click()");
  await sleep(500);
  const connection = await page.evaluate<Record<string, unknown>>("chrome.storage.local.get(['provider', 'openrouterModel'])");
  check("OpenRouter onboarding saves provider and custom model", connection.provider === "openrouter" && connection.openrouterModel === "test/model");
  const built = await talkMany([{ kind: "startBuild" }, { kind: "startBuild" }], 3000);
  const done = built.filter((m) => m.kind === "done");
  check("concurrent startBuild requests share one OpenRouter build", done.length === 1 && !built.some((m) => m.kind === "error"), built.find((m) => m.kind === "error")?.message);
  const saved = await page.evaluate<Record<string, any>>("chrome.storage.local.get(['homepageData', 'openrouterBuild'])");
  check("homepage persists and temporary checkpoint is cleared", /Fixture homepage/.test(saved.homepageData?.code ?? "") && saved.openrouterBuild === undefined);
  await page.evaluate(`Array.from(document.querySelectorAll("button")).find(b => b.title === "Settings" || b.textContent.includes("Settings")).click()`);
  await sleep(200);
  await screenshot("settings-desktop", 1200, 800);
  await screenshot("settings-mobile", 390, 844);
  check("settings focus is inside the dialog", await page.evaluate<boolean>("document.querySelector('[role=dialog]').contains(document.activeElement)"));
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`
    (() => {
      const select = document.querySelector("form select");
      select.value = "anthropic";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()
  `);
  await sleep(100);
  await page.evaluate(`
    (() => {
      const input = document.querySelector("form input[type=password]");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "sk-ant-fixture-not-a-real-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await sleep(100);
  await page.evaluate("document.querySelector('form button[type=submit]').click()");
  await sleep(300);
  const switched = await page.evaluate<Record<string, unknown>>("chrome.storage.local.get(['provider', 'apiKey', 'openrouterApiKey', 'homepageData'])");
  check("provider switch preserves both keys and saved homepage", switched.provider === "anthropic" && Boolean(switched.apiKey) && Boolean(switched.openrouterApiKey) && Boolean(switched.homepageData));
  await page.evaluate("document.querySelector('[role=dialog] textarea').focus()");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(100);
  check("Escape closes settings", await page.evaluate<boolean>("!document.querySelector('[role=dialog]')"));
  worker.close();

  page.close();
  browser.close();
} catch (err) {
  console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
  failures++;
} finally {
  chrome.kill("SIGKILL");
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}

console.log(
  `\n${failures === 0 ? "\x1b[32mEXTENSION VERIFIED\x1b[0m" : `\x1b[31m${failures} check(s) failed\x1b[0m`}`,
);
process.exit(failures === 0 ? 0 : 1);
