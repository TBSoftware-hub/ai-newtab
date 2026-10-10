import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildHistoryDigest, slugifyUrl } from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";

describe("buildHistoryDigest", () => {
  const sites = fixtureHistory();

  test("caps the site list at maxResults", () => {
    const digest = buildHistoryDigest(sites, { daysToAnalyze: 14, maxResults: 5 });
    assert.equal(digest.sites.length, 5);
  });

  test("reports what the model is not seeing", () => {
    const digest = buildHistoryDigest(sites, { daysToAnalyze: 14, maxResults: 5 });
    assert.equal(digest.totalSitesSeen, sites.length);
    assert.ok(digest.totalSitesSeen > digest.sites.length);
  });

  test("ranks by relevance score descending", () => {
    const digest = buildHistoryDigest(sites, { daysToAnalyze: 14, maxResults: 10 });
    const scores = digest.sites.map((s) => s.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.equal(digest.sites[0].domain, "news.ycombinator.com");
  });

  test("drops urls[] entirely and caps sampleTitles", () => {
    const fat = [
      {
        domain: "example.com",
        totalVisits: 10,
        uniquePages: 9,
        lastVisitTime: Date.now(),
        averageVisitsPerDay: 1,
        titles: Array.from({ length: 50 }, (_, i) => `title ${i}`),
        urls: Array.from({ length: 50 }, (_, i) => `https://example.com/${i}`),
        relevanceScore: 0.5,
      },
    ];
    const digest = buildHistoryDigest(fat, { daysToAnalyze: 14, maxResults: 10 });
    assert.equal(digest.sites[0].sampleTitles.length, 5);
    assert.ok(!JSON.stringify(digest).includes("example.com/0"));
  });

  test("emits ISO dates, not epoch millis", () => {
    const digest = buildHistoryDigest(sites, { daysToAnalyze: 14, maxResults: 3 });
    for (const site of digest.sites) {
      assert.match(site.lastVisit, /^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test("stays small enough to sit inline in a tool result", () => {
    const digest = buildHistoryDigest(sites, { daysToAnalyze: 14, maxResults: 30 });
    // ~4 chars/token: a few thousand tokens, not millions.
    assert.ok(JSON.stringify(digest).length < 40_000);
  });
});

describe("slugifyUrl", () => {
  test("strips www and non-alphanumerics", () => {
    assert.equal(slugifyUrl("https://www.news.ycombinator.com/news"), "news_ycombinator_com");
  });

  test("survives a malformed url", () => {
    assert.equal(slugifyUrl("not a url"), "not_a_url");
  });

  test("never returns an empty slug", () => {
    assert.equal(slugifyUrl("///"), "page");
  });
});
