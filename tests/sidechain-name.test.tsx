// SidechainName: the description is hidden until hover / tap / keyboard focus.
// (The open/close interaction needs a real browser; this pins the server
// render — closed, accessible, and nothing leaked inline.)
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SidechainName from "../components/SidechainName";

const render = (description: string) =>
  renderToStaticMarkup(
    React.createElement(SidechainName, { name: "Flush", description }),
  );

test("renders the name as a closed, focusable button with no description shown", () => {
  const html = render("Tokens, assets and a DEX on a fast chain over eCash");
  assert.match(html, /^<button type="button" aria-expanded="false"/);
  assert.match(html, />Flush<\/button>$/);
  assert.doesNotMatch(html, /Tokens, assets/, "description only appears when opened");
  assert.doesNotMatch(html, /role="tooltip"/);
});

test("with no description it is plain text, not a button", () => {
  assert.equal(render(""), "<span class=\"\">Flush</span>");
});
