# AI Homepage

**A new tab that reads the internet for you.**

AI Homepage replaces Edge's or Chrome's new-tab page with one that's written for you. An
agent looks at what you've actually been browsing, opens the pages you follow
(signed in as you), and writes a fresh homepage from what it finds there. It
rebuilds itself in the background, so each new tab is up to date.

![An example homepage in a morning-newspaper style](docs/preview.png)
<sub>Illustration. Your homepage is built from your own browsing, so its stories will be different.</sub>

A morning newspaper is just one look. You can describe any look and the next build
follows it: a quiet one-column digest, a dense dashboard, a green-on-black
terminal, a zine.

> **Privacy, up front.** To build your homepage, the extension sends a summary of
> your browsing history (top domains, visit counts, a few page titles) and the
> cleaned-up HTML of selected pages to your chosen AI provider, using your own API key.
> Those pages are loaded in your signed-in browser, so they can include private
> content. With OpenRouter, content passes through OpenRouter to an inference provider;
> temporary build checkpoints are stored locally and cleared on completion, cancellation,
> or a handled error. Anthropic sessions and uploaded pages are cleaned up when builds end.
> Your API keys stay in the extension's local storage. More detail in
> [ARCHITECTURE.md](./ARCHITECTURE.md#privacy).

---

## Install

You need Microsoft Edge or Chrome (or another Chromium browser), [Node.js](https://nodejs.org) 20+,
and an [OpenRouter API key](https://openrouter.ai/settings/keys) or
[Anthropic API key](https://console.anthropic.com). No local server or companion app is needed.

```bash
git clone https://github.com/ThariqS/ai-newtab.git
cd ai-newtab
npx pnpm@10.11.1 install
npx pnpm@10.11.1 build
```

(If you already have [pnpm](https://pnpm.io), plain `pnpm install && pnpm build` works too.)

Then load it into Edge:

1. Go to `edge://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `apps\extension\.output\chrome-mv3`.

If Edge asks whether to keep the changed new-tab page, keep/enable the extension.
The `chrome-mv3` folder name is WXT's Chromium build target; the same build works in Edge.
For Chrome, use `chrome://extensions` instead.

## Your first homepage

1. Open a new tab, select **OpenRouter** or **Anthropic**, and paste that provider's API key.
   For OpenRouter, choose a suggested model or enter a custom model ID.
2. Click **Build today's homepage**.
3. Watch it work. The progress view walks through each step: preparing the
   agent, reading your history, opening pages in your browser, analyzing them,
   and writing your homepage.

The first build takes a few minutes. You can close the tab while it runs, since
the build lives in the extension's background worker and appears in any new tab
you open.

## Make it yours

Click **⚙️ Settings** on the new tab.

**Instructions.** Anything you write here goes into every build and takes priority
over the agent's own defaults. This box sets both the content and the look:

| You write | You get |
| --- | --- |
| *"A morning newspaper. Serif type, a big masthead, a lead story, a column of briefs."* | A broadsheet front page |
| *"One calm column. No images. Five things worth reading, with one line on why."* | A quiet reading list |
| *"Dense dashboard: GitHub PRs and issues first, then Hacker News, then everything else."* | A work cockpit |
| *"Green-on-black terminal, monospace, like a 1980s BBS."* | Exactly that |
| *"Skip sports and politics. Always show the weather and my next three calendar events."* | Your rules, every day |

Click **Save & rebuild** to apply them right away.

**Sites the agent never reads.** Enter one host per line; subdomains are included,
and `*.example.com` is supported. The editable defaults include common webmail,
sign-in and document hosts. **Save & rebuild** saves the list and applies it to
history summaries and URLs requested through `getPageHtml`. A page that redirects
onto a blocked host is dropped before its content is uploaded. Local-network
addresses (localhost, private IPs, `.local` and `.internal` hosts) are always blocked.

**AI provider.** In Settings, select the provider, enter its key, and click
**Save connection**. This applies to the next build. Both providers' keys are
kept separately, existing Anthropic settings are preserved, and providers never
switch automatically after an error. Use a spending-limited personal key.

**OpenRouter model.** The suggestions are GPT-4.1, Claude Sonnet 4, and Gemini 2.5 Flash.
You can enter a custom model ID such as `openai/gpt-4.1`. Availability and tool-calling
support are checked against OpenRouter's catalog on save and before each unfinished build.
Suggestions were catalog-verified, not quality-benchmarked with paid live builds.
Model availability, account access, and pricing can change.

OpenRouter builds have a cumulative eight-page request budget, 30 model turns,
bounded page reads, and context/output limits. A build that reaches a limit
reports an error rather than silently switching models. OpenRouter narration
appears after each model turn, not token by token.

**Anthropic model.** Choose which Claude model writes your page:

- **Claude Sonnet 5.5** (default): the best balance of quality and cost.
- **Claude Haiku 5.5**: the fastest and cheapest.
- **Claude Opus 5.5**: the most careful editor, and the most expensive.

The new model takes effect from your next build.

**Rebuild automatically.** On by default. Once your homepage is older than the
interval you pick (6, 12, 24 or 48 hours), the extension rebuilds it quietly in the
background. It only starts after you've built once by hand, and it won't retry a
failed build until the next interval, so it never loops.

**↻ Rebuild** in the top-right corner rebuilds right away.

## Good to know

- **Cost.** Anthropic builds use a managed agent session; OpenRouter builds make
  multiple inference requests, all billed to the selected provider's API key. What it
  costs depends on the model and on how much it reads. For Anthropic, Haiku is the cheapest
  choice, and you can turn off automatic rebuilds to build only when you ask.
- **What it can see.** It ranks the sites in your history and opens up to 8 of
  them per build. It skips search engines, webmail, banking and logged-out
  marketing pages. Anything it can't open is reported, not hidden.
- **Links are real.** Every link on the page comes from a page the agent actually
  read. It's told never to invent a URL.
- **Interrupted builds.** If the browser closes mid-build, the worker resumes on wake;
  the new tab can also offer **Resume interrupted build**. OpenRouter resumes with
  the original model and provider from its local checkpoint. Interrupted model
  requests may be billed again. Interrupted browser tools are reported as failed
  rather than replayed; reserved page budget stays consumed.
- **Updating.** After pulling new code, run `npx pnpm@10.11.1 build` again, then
  click the reload icon on the extension in `edge://extensions` or `chrome://extensions`.

## How it works

1. **`getHistory`**: the agent gets a ranked summary of your most-visited domains.
2. **`getPageHtml`**: it picks up to 8 pages, which the extension opens in a
   background window, cleans up, and mounts into the agent's sandbox as files.
3. **`grep` / `read`**: the agent pulls headlines, posts and links out of those
   files inside its sandbox.
4. **`write`**: it writes one React component, which the new tab renders.

For Anthropic, the extension's background worker drives a
[Claude Managed Agents](https://docs.claude.com) session directly, with no server
in between. The two custom tools run in the extension because they need
`chrome.history` and `chrome.tabs`. Everything else happens in the agent's
sandbox, where shell access is off: scraped pages are untrusted input.

For OpenRouter, the worker owns the agent loop. Pages stay in a restricted local
page store; `searchPage` and `readPage` return bounded excerpts to the model.
`submitHomepage` delivers the component, which is syntax/contract checked before
saving. There is no remote filesystem or shell. Browser access and blocked-site
rules are still enforced locally, not entrusted to the model.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the event flow, the layout, and
the gotchas worth knowing.

## Development

```
packages/agent-core   the agent loop: host-agnostic, no chrome.* or node:*
apps/extension        the MV3 extension (WXT + React)
harness               Bun scripts that run agent-core outside Chrome, and test the built extension
```

```bash
pnpm dev                 # WXT with hot reload
pnpm typecheck           # all packages
pnpm test                # all unit tests under Node (no API calls)
pnpm test:openrouter     # only OpenRouter tool-loop and output checks
pnpm extension:test      # isolated headless Edge on Windows, Chrome on macOS; fixture AI/scraping

cp .env.example .env     # add ANTHROPIC_API_KEY, then:
pnpm agent:run           # a full build against the real API, with fixture history
pnpm agent:verify        # check the output actually renders
```

`extension:test` accepts `BROWSER_PATH` (or the legacy `CHROME_PATH`) for another
Edge/Chrome executable and `SCREENSHOT_DIR` for desktop/mobile screenshots. It
uses a temporary profile and a dynamically allocated debugging port; it does not
read your normal browser profile or make live model requests. The `agent:*`
commands still require Bun and an Anthropic key.

GitHub Copilot is not a provider in this version. Its SDK needs a separate CLI
runtime/companion process; Microsoft Copilot's Edge sidebar is not used.

## Status

Early and experimental. It's a tool you run yourself with your own key. Don't
publish it to a store as-is: anyone with access to the browser profile can read
the stored API key.

## License

MIT
