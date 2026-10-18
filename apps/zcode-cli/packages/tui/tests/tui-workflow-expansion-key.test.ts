import assert from "node:assert/strict";
import test from "node:test";
import type { KeyEvent } from "@mbears/opentui-core";
import { workflowExpansionActionFor } from "../src/app-keyboard-helpers.js";

// `+` / `-` are printable and the composer holds focus by default: these tests pin the three gates behind never eating input
// (no modifier, empty draft, at least one workflow card); loosening any layer breaks typing.

function key(name: string | undefined, overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    ctrl: false,
    meta: false,
    name,
    raw: name ?? "",
    shift: false,
    ...overrides,
  } as KeyEvent;
}

test("bare + with empty draft and cards expands; bare - collapses", () => {
  assert.equal(
    workflowExpansionActionFor({ key: key("+"), draftValue: "", hasCards: true }),
    "expand",
  );
  assert.equal(
    workflowExpansionActionFor({ key: key("-"), draftValue: "", hasCards: true }),
    "collapse",
  );
});

test("falls back to key.raw when key.name is absent", () => {
  assert.equal(
    workflowExpansionActionFor({
      key: key(undefined, { raw: "+" }),
      draftValue: "",
      hasCards: true,
    }),
    "expand",
  );
});

test("modified +/- are never claimed (Ctrl/Meta combos belong elsewhere)", () => {
  assert.equal(
    workflowExpansionActionFor({ key: key("+", { ctrl: true }), draftValue: "", hasCards: true }),
    undefined,
  );
  assert.equal(
    workflowExpansionActionFor({ key: key("-", { meta: true }), draftValue: "", hasCards: true }),
    undefined,
  );
});

test("a non-empty draft keeps +/- as ordinary typed characters", () => {
  // Pasting a diff, typing a flag, writing hyphenated words -- all start with or contain +/-.
  assert.equal(
    workflowExpansionActionFor({ key: key("+"), draftValue: "diff --git", hasCards: true }),
    undefined,
  );
  assert.equal(
    workflowExpansionActionFor({ key: key("-"), draftValue: "ls ", hasCards: true }),
    undefined,
  );
});

test("no workflow cards means +/- still type, even on an empty draft", () => {
  assert.equal(
    workflowExpansionActionFor({ key: key("+"), draftValue: "", hasCards: false }),
    undefined,
  );
  assert.equal(
    workflowExpansionActionFor({ key: key("-"), draftValue: "", hasCards: false }),
    undefined,
  );
});

test("unrelated keys are ignored", () => {
  assert.equal(
    workflowExpansionActionFor({ key: key("a"), draftValue: "", hasCards: true }),
    undefined,
  );
  assert.equal(
    workflowExpansionActionFor({ key: key("enter"), draftValue: "", hasCards: true }),
    undefined,
  );
});
