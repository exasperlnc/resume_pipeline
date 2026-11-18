import { describe, expect, it } from "vitest";
import { contentHash, htmlToPlainText } from "../src/ingest/text.js";

describe("htmlToPlainText", () => {
  it("decodes entity-encoded HTML before stripping (Greenhouse style)", () => {
    const encoded = "&lt;p&gt;Tools &amp;amp; things&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;";
    expect(htmlToPlainText(encoded)).toBe("Tools & things\n\n * Go");
  });

  it("strips real HTML and keeps entity text that is not markup", () => {
    expect(htmlToPlainText("<p>a &lt; b &amp;&amp; c</p>")).toBe("a < b && c");
  });

  it("drops link hrefs and normalizes nbsp", () => {
    expect(htmlToPlainText('<p>Apply&nbsp;<a href="https://x.example">here</a></p>')).toBe("Apply here");
  });

  it("handles empty input", () => {
    expect(htmlToPlainText("")).toBe("");
  });
});

describe("contentHash", () => {
  it("is stable and sensitive to text", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});
