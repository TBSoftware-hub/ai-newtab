/// <reference path="../apps/extension/.wxt/types/imports.d.ts" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeApiKey, loadSettings, saveConnection } from "../apps/extension/lib/storage";
import { DEFAULT_MODEL, DEFAULT_OPENROUTER_MODEL } from "@homepage/agent-core";

test("legacy settings remain Anthropic and connection changes preserve other credentials and homepage", async () => {
  const data: Record<string, unknown> = {
    apiKey: "legacy-anthropic-key", model: DEFAULT_MODEL,
    homepageData: { code: "saved homepage", timestamp: "2026-10-10" },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "browser");
  Object.defineProperty(globalThis, "browser", { configurable: true, value: {
    storage: { local: {
      get: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, data[key]])),
      set: async (updates: Record<string, unknown>) => { Object.assign(data, updates); },
    } },
  } });
  try {
    const legacy = await loadSettings();
    assert.equal(legacy.provider, "anthropic");
    assert.equal(activeApiKey(legacy), "legacy-anthropic-key");
    assert.equal(legacy.model, DEFAULT_MODEL);
    assert.equal(legacy.openrouterModel, DEFAULT_OPENROUTER_MODEL);
    await saveConnection({ ...legacy, provider: "openrouter", apiKey: null,
      openrouterApiKey: "fixture-openrouter", openrouterModel: "test/model" });
    const router = await loadSettings();
    assert.equal(activeApiKey(router), "fixture-openrouter");
    assert.equal(router.apiKey, "legacy-anthropic-key");
    await saveConnection({ ...router, provider: "anthropic", apiKey: "updated-key", openrouterApiKey: null });
    assert.equal(data.openrouterApiKey, "fixture-openrouter");
    assert.equal(data.openrouterModel, "test/model");
    assert.deepEqual(data.homepageData, { code: "saved homepage", timestamp: "2026-10-10" });
  } finally {
    if (previous) Object.defineProperty(globalThis, "browser", previous);
    else Reflect.deleteProperty(globalThis, "browser");
  }
});
