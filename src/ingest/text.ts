import { createHash } from "node:crypto";
import { decode } from "he";
import { convert } from "html-to-text";

/**
 * Turn a description into plain text. Greenhouse entity-encodes its HTML
 * ("&lt;p&gt;"), so decode first when the input has no real tags but does
 * have encoded ones, then strip.
 */
export function htmlToPlainText(input: string): string {
  let html = input;
  if (!/<[a-z!/]/i.test(html) && /&lt;[a-z!/]/i.test(html)) html = decode(html);
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "h4", options: { uppercase: false } },
      { selector: "table", format: "dataTable" },
    ],
  });
  return text
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
