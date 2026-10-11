import { buildHistoryDigest } from "./history-digest";
import { buildKickoffMessage, HOMEPAGE_SYSTEM_PROMPT, OUTPUT_PATH } from "./prompt";
import { DEFAULTS, GET_HISTORY_SCHEMA, GET_PAGE_HTML_SCHEMA } from "./schemas";
import { DEFAULT_BLOCKED_SITES, isAllowedUrl, isBlocked, normalizeBlockList } from "./site-filter";
import type { BrowserBridge, HomepageBuildResult, KVStore, RunCallbacks } from "./types";

export type HomepageProvider = "anthropic" | "openrouter";
export type ModelFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
export const OPENROUTER_CHECKPOINT_KEY = "openrouterBuild";
export const OPENROUTER_MODEL_CHOICES = [
  { id: "openai/gpt-4.1", label: "GPT-4.1" },
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
] as const;
export const DEFAULT_OPENROUTER_MODEL = OPENROUTER_MODEL_CHOICES[0].id;
const API_ROOT = "https://openrouter.ai/api/v1";
const MAX_TURNS = 30;
const MAX_PAGES = 8;
const MAX_PAGE_CHARS = 100_000;
const MAX_READ_CHARS = 16_000;
const MAX_CONTEXT_CHARS = 240_000;
const MAX_CODE_CHARS = 100_000;

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface Page {
  url: string;
  html: string;
  title: string;
}
export interface OpenRouterCheckpoint {
  version: 1;
  id: string;
  model: string;
  messages: Message[];
  pages: Record<string, Page>;
  attempted: string[];
  pageCount: number;
  historyRead: boolean;
  turns: number;
  code?: string;
}
export interface OpenRouterRunOptions {
  apiKey: string;
  model: string;
  bridge: BrowserBridge;
  store: KVStore;
  userSystemPrompt?: string;
  blockedSites?: string[] | (() => Promise<string[]>);
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  resume?: boolean;
  now?: Date;
  fetch?: ModelFetch;
  validateCode: (code: string) => void;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer between ${min} and ${max}`);
  }
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected non-empty text");
  return value;
}
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}
const TOOLS = [
  tool("getHistory", "Read the ranked browsing history once.", GET_HISTORY_SCHEMA.properties, []),
  tool("getPageHtml", "Load up to eight pages per build in the signed-in browser. Returns page IDs for searchPage/readPage.", GET_PAGE_HTML_SCHEMA.properties, ["urls"]),
  tool("searchPage", "Find literal text in a stored page. Returns bounded excerpts and offsets, not regex results.", {
    pageId: { type: "string" }, query: { type: "string", maxLength: 200 },
  }, ["pageId", "query"]),
  tool("readPage", "Read a bounded range from a stored page.", {
    pageId: { type: "string" }, offset: { type: "integer", minimum: 0 },
    length: { type: "integer", minimum: 1, maximum: MAX_READ_CHARS },
  }, ["pageId"]),
  tool("submitHomepage", "Submit the complete React TSX component, not a code fence. Ends the build.", {
    code: { type: "string", maxLength: MAX_CODE_CHARS },
  }, ["code"]),
];
const SYSTEM = `${HOMEPAGE_SYSTEM_PROMPT}

Runtime override: there is NO remote sandbox or filesystem. getPageHtml returns
page IDs instead of mount paths. Use searchPage (literal search) and readPage
(offset/length) to inspect those pages. Submit your complete component through
submitHomepage, NOT write or a prose reply. No other tools exist.
The eight-page budget is shared across all tool calls in this build.
Large pages are truncated locally and explicitly marked. Do not claim to have read omitted content.`;

async function request(fetcher: ModelFetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetcher(url, { ...init, signal: AbortSignal.any([
    ...(init.signal ? [init.signal] : []), AbortSignal.timeout(120_000),
  ]) });
  if (!response.ok) {
    // Never include upstream bodies: they may echo private prompts or credentials.
    throw new Error(`OpenRouter HTTP ${response.status}. ${
      response.status === 401 ? "Check your API key." :
      response.status === 402 ? "Add credits or check your key spending limit." :
      response.status === 429 ? "Rate limited; retry later." : "Check model availability and retry."
    }`);
  }
  const body: unknown = await response.json();
  const data = object(body);
  if (data.error) throw new Error("OpenRouter returned an API error. Check your model and account.");
  return body;
}

export async function validateOpenRouterModel(model: string, fetcher: ModelFetch = fetch, signal?: AbortSignal) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/-]+$/.test(model)) {
    throw new Error("Enter an OpenRouter model ID such as openai/gpt-4.1.");
  }
  const body = object(await request(fetcher, `${API_ROOT}/models`, { signal }));
  if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalog.");
  const found = body.data.map(object).find((m) => m.id === model);
  if (!found) throw new Error(`OpenRouter model "${model}" is not available.`);
  if (!Array.isArray(found.supported_parameters) || !found.supported_parameters.includes("tools")) {
    throw new Error(`OpenRouter model "${model}" does not support tool calling.`);
  }
}

function assistantMessage(raw: unknown): Message {
  const data = object(raw);
  if (data.content !== null && data.content !== undefined && typeof data.content !== "string") {
    throw new Error("OpenRouter returned invalid message content.");
  }
  const calls = data.tool_calls;
  if (calls !== undefined && (!Array.isArray(calls) || calls.length > 16)) {
    throw new Error("OpenRouter returned invalid tool calls.");
  }
  return {
    role: "assistant", content: typeof data.content === "string" ? data.content : null,
    tool_calls: calls === undefined ? undefined : (calls as unknown[]).map((rawCall) => {
      const c = object(rawCall);
      const f = object(c.function);
      if (c.type !== "function") throw new Error("Unsupported OpenRouter tool call type.");
      return { id: text(c.id), type: "function", function: { name: text(f.name), arguments: text(f.arguments) } };
    }),
  };
}

export async function runOpenRouterBuild(opts: OpenRouterRunOptions): Promise<HomepageBuildResult> {
  const fetcher = opts.fetch ?? fetch;
  const emit = opts.callbacks;
  const persist = (state: OpenRouterCheckpoint) => opts.store.set(OPENROUTER_CHECKPOINT_KEY, state);
  try {
    emit?.onPhase?.("setup");
    const saved = opts.resume ? await opts.store.get<OpenRouterCheckpoint>(OPENROUTER_CHECKPOINT_KEY) : undefined;
    if (opts.resume && !saved) throw new Error("No OpenRouter build is available to resume.");
    if (saved && saved.version !== 1) throw new Error("This OpenRouter checkpoint is incompatible. Start a new build.");
    const state: OpenRouterCheckpoint = saved ?? {
      version: 1, id: crypto.randomUUID(), model: opts.model,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: buildKickoffMessage({
        now: opts.now ?? new Date(), userSystemPrompt: opts.userSystemPrompt,
      }).replaceAll(OUTPUT_PATH, "submitHomepage") }],
      pages: {}, attempted: [], pageCount: 0, historyRead: false, turns: 0,
    };
    const blockList = async () => normalizeBlockList(
      (typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites) ?? DEFAULT_BLOCKED_SITES,
    );
    const execute = async (call: ToolCall): Promise<unknown> => {
      const args = object(JSON.parse(call.function.arguments));
      const blocked = await blockList();
      switch (call.function.name) {
        case "getHistory": {
          if (state.historyRead) throw new Error("History has already been read.");
          const daysToAnalyze = integer(args.daysToAnalyze, DEFAULTS.daysToAnalyze, 1, 90);
          const maxResults = integer(args.maxResults, DEFAULTS.maxResults, 1, 50);
          state.historyRead = true;
          await persist(state);
          emit?.onPhase?.("history");
          const raw = await opts.bridge.getHistory({ daysToAnalyze, maxResults });
          const sites = raw.sites.filter((s) => !isBlocked(s.domain, blocked));
          return buildHistoryDigest(sites, {
            daysToAnalyze, maxResults, totalSitesSeen: raw.totalSitesSeen - (raw.sites.length - sites.length),
          });
        }
        case "getPageHtml": {
          if (!Array.isArray(args.urls) || !args.urls.length || args.urls.length > MAX_PAGES) {
            throw new Error("Request between one and eight URLs.");
          }
          const urls = args.urls.map(text);
          const delay = integer(args.loadDelayMs, DEFAULTS.loadDelayMs, 0, 30_000);
          if (state.pageCount + urls.length > MAX_PAGES) throw new Error("Eight-page build budget exceeded.");
          state.pageCount += urls.length;
          await persist(state);
          const failed: Array<{ url: string; reason: string }> = [];
          const allowed = urls.filter((url) => {
            if (isAllowedUrl(url, blocked)) return true;
            failed.push({ url, reason: "blocked by the user's settings" });
            return false;
          });
          emit?.onPhase?.("scraping", `${allowed.length} pages`);
          const report = allowed.length ? await opts.bridge.getPageHtml({ urls: allowed, loadDelayMs: delay }) : { pages: [], failed: [] };
          opts.signal?.throwIfAborted();
          failed.push(...report.failed);
          const refs = [];
          // Recheck settings after the potentially slow scrape.
          const currentBlocked = await blockList();
          for (const page of report.pages) {
            if (!allowed.includes(page.url) || !isAllowedUrl(page.url, currentBlocked) ||
              (page.finalUrl && !isAllowedUrl(page.finalUrl, currentBlocked))) {
              failed.push({ url: page.url, reason: "blocked by the user's settings" });
              continue;
            }
            const pageId = `page-${Object.keys(state.pages).length + 1}`;
            state.pages[pageId] = { url: page.finalUrl ?? page.url, title: page.title, html: page.html.slice(0, MAX_PAGE_CHARS) };
            refs.push({ pageId, url: page.finalUrl ?? page.url, title: page.title,
              chars: state.pages[pageId].html.length, truncated: page.html.length > MAX_PAGE_CHARS });
          }
          return { pages: refs, failed };
        }
        case "searchPage":
        case "readPage": {
          const page = state.pages[text(args.pageId)];
          if (!page) throw new Error("Unknown page ID.");
          if (!isAllowedUrl(page.url, blocked)) throw new Error("Page is now blocked by the user's settings.");
          emit?.onPhase?.("analyzing", call.function.name);
          if (call.function.name === "readPage") {
            const offset = integer(args.offset, 0, 0, page.html.length);
            const length = integer(args.length, 8000, 1, MAX_READ_CHARS);
            return { offset, text: page.html.slice(offset, offset + length), totalChars: page.html.length };
          }
          const query = text(args.query);
          if (query.length > 200) throw new Error("Search query is too long.");
          const matches = [];
          const html = page.html.toLowerCase();
          let offset = html.indexOf(query.toLowerCase());
          while (offset !== -1 && matches.length < 10) {
            matches.push({ offset, text: page.html.slice(Math.max(0, offset - 150), offset + 500) });
            offset = html.indexOf(query.toLowerCase(), offset + query.length);
          }
          return { matches, capped: matches.length === 10 };
        }
        case "submitHomepage": {
          if (!state.historyRead || !Object.keys(state.pages).length) {
            throw new Error("Read history and at least one allowed page before submitting.");
          }
          const code = text(args.code).trim();
          if (code.length > MAX_CODE_CHARS) throw new Error("Homepage exceeds the output size limit.");
          opts.validateCode(code);
          emit?.onPhase?.("writing");
          state.code = code;
          return { accepted: true };
        }
        default: throw new Error(`Unknown tool: ${call.function.name}`);
      }
    };
    if (!state.code) await validateOpenRouterModel(state.model, fetcher, opts.signal);
    await persist(state);
    for (;;) {
      opts.signal?.throwIfAborted();
      if (state.code) {
        opts.validateCode(state.code);
        emit?.onPhase?.("done");
        // The host clears this after saving the homepage, so a worker kill cannot lose the output.
        return { code: state.code, sessionId: state.id, source: "tool-submission" };
      }
      const pending = state.messages.at(-1)?.role === "assistant"
        ? state.messages.at(-1)?.tool_calls
        : [...state.messages].reverse().find((m) => m.role === "assistant")?.tool_calls;
      const answered = new Set(state.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
      for (const call of pending ?? []) {
        opts.signal?.throwIfAborted();
        if (answered.has(call.id)) continue;
        let result: unknown;
        if (state.attempted.includes(call.id)) {
          result = { error: "Tool interrupted by worker restart. Its budget was consumed; do not repeat blocked requests." };
        } else {
          state.attempted.push(call.id);
          await persist(state);
          try {
            result = await execute(call);
          } catch (error) {
            opts.signal?.throwIfAborted();
            const reason = error instanceof Error ? error.message : String(error);
            emit?.onLog?.(`tool ${call.function.name} failed: ${reason}`);
            result = { error: reason };
          }
        }
        state.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        await persist(state);
        if (state.code) break;
      }
      if (state.code) continue;
      opts.signal?.throwIfAborted();
      if (state.turns >= MAX_TURNS) throw new Error("OpenRouter build exceeded 30 model turns.");
      const payload = JSON.stringify({
        model: state.model, messages: state.messages, tools: TOOLS,
        max_tokens: 16_000, stream: false, provider: { require_parameters: true, data_collection: "deny" },
      });
      if (payload.length > MAX_CONTEXT_CHARS) throw new Error("OpenRouter build exceeded the context budget.");
      state.turns++;
      await persist(state);
      emit?.onPhase?.("thinking");
      const response = object(await request(fetcher, `${API_ROOT}/chat/completions`, {
        method: "POST", signal: opts.signal,
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" }, body: payload,
      }));
      if (!Array.isArray(response.choices) || !response.choices.length) throw new Error("OpenRouter returned no choices.");
      const choice = object(response.choices[0]);
      if (choice.finish_reason === "length") throw new Error("OpenRouter output was truncated. Choose a model with a larger output allowance.");
      const message = assistantMessage(choice.message);
      if (!message.tool_calls?.length) throw new Error("The model ended without submitting a homepage. Retry or choose another tool-capable model.");
      const previousIds = new Set(state.messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []));
      for (const call of message.tool_calls) {
        if (previousIds.has(call.id)) throw new Error("OpenRouter returned a duplicate tool call ID.");
        previousIds.add(call.id);
      }
      if (message.content) emit?.onText?.(message.content);
      state.messages.push(message);
      await persist(state);
    }
  } catch (error) {
    emit?.onPhase?.("cleanup");
    await opts.store.remove(OPENROUTER_CHECKPOINT_KEY);
    throw error;
  }
}
