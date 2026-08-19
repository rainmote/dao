import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "./MarkdownContent";

test("renders assistant Markdown and GFM content", () => {
  const output = renderToStaticMarkup(<MarkdownContent content={[
    "# Result",
    "",
    "- **done**",
    "- [x] tested",
    "",
    "| name | value |",
    "| --- | --- |",
    "| answer | `42` |",
    "",
    "```clojure",
    "(+ 40 2)",
    "```",
  ].join("\n")} />);

  assert.match(output, /<h1>Result<\/h1>/);
  assert.match(output, /<strong>done<\/strong>/);
  assert.match(output, /type="checkbox"/);
  assert.match(output, /<table>/);
  assert.match(output, /class="language-clojure"/);
});

test("does not execute raw HTML and protects links", () => {
  const output = renderToStaticMarkup(<MarkdownContent
    content={'<script>alert("no")</script>\n\n[docs](https://example.com)'} />);

  assert.doesNotMatch(output, /<script>/);
  assert.match(output, /target="_blank"/);
  assert.match(output, /rel="noreferrer noopener"/);
});
