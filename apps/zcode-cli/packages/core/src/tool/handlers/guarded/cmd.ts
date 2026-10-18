import type { CommandWord } from "./word.js";

const CMD_DELETE_BUILTIN = /^(?:rd|rmdir|del|erase)$/i;

/** CMD's finite surface: double quotes and carets; single quotes are plain chars. Complex blocks/variable expansion unparsed. */
export function analyzeCmdCommand(source: string): {
  commands: CommandWord[][];
  unsupported: boolean;
} {
  const commands: CommandWord[][] = [];
  let words: CommandWord[] = [];
  let value = "";
  let start = -1;
  let quote = false;
  let dynamic = false;
  let hasUnquotedGlob = false;
  let skipTarget = false;
  let unsupported = false;
  let invalidSegment = false;
  let blockDepth = 0;
  const flushWord = (end: number) => {
    if (start < 0) return;
    if (!skipTarget) words.push({ value, dynamic, hasUnquotedGlob, start, end });
    skipTarget = false;
    value = "";
    start = -1;
    dynamic = false;
    hasUnquotedGlob = false;
  };
  const flushCommand = (end: number) => {
    flushWord(end);
    if (
      !invalidSegment &&
      blockDepth === 0 &&
      words.length &&
      !/^(?:rem|::)$/i.test(words[0]!.value)
    )
      commands.push(words);
    words = [];
    invalidSegment = blockDepth > 0;
  };
  const splitDeleteSwitch = (index: number) => {
    // CMD built-in deletes allow rd/s/q and target/s/q; carets are stripped by CMD first, quoted paths stay whole words.
    // Only these four built-ins split; never split other commands' paths or redirect targets on switches.
    if (!skipTarget && CMD_DELETE_BUILTIN.test(words[0]?.value ?? value)) {
      flushWord(index);
      start = index;
    }
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (!quote && c === "^") {
      if (start < 0) start = i;
      if (source[i + 1] === undefined || /[\r\n]/.test(source[i + 1]!)) {
        unsupported = true;
        invalidSegment = true;
      } else {
        if (source[i + 1] === "/") splitDeleteSwitch(i);
        value += source[++i];
      }
      continue;
    }
    if (c === '"') {
      if (start < 0) start = i;
      quote = !quote;
      continue;
    }
    if (!quote && /[ \t]/.test(c)) {
      flushWord(i);
      continue;
    }
    if (!quote && /[&|\r\n]/.test(c)) {
      flushCommand(i);
      if (source[i + 1] === c) i++;
      continue;
    }
    if (!quote && /[<>]/.test(c)) {
      // fd redirects like 2>&1 are neither command separators nor argv.
      if (start >= 0 && /^\d+$/.test(value)) {
        value = "";
        start = -1;
      }
      flushWord(i);
      if (source[i + 1] === c) i++;
      if (source[i + 1] === "&" && /[\d-]/.test(source[i + 2] ?? "")) {
        i += 2;
      } else skipTarget = true;
      continue;
    }
    if (!quote && /[()]/.test(c)) {
      unsupported = true;
      invalidSegment = true;
      blockDepth = c === "(" ? blockDepth + 1 : Math.max(0, blockDepth - 1);
    }
    if (!quote && c === "/") splitDeleteSwitch(i);
    if (start < 0) start = i;
    if (c === "%" || c === "!") dynamic = true;
    if (!quote && /[*?[]/.test(c)) hasUnquotedGlob = true;
    value += c;
    // The redirect target rem is a filename; only a REM in command position can absorb trailing comment text.
    if (!quote && !skipTarget && words.length === 0 && /^(?:rem\s|::)/i.test(source.slice(start))) {
      const newline = source.indexOf("\n", i);
      value = "";
      start = -1;
      i = newline < 0 ? source.length : newline;
    }
  }
  // Root cause (2026-09-17 review): skipTarget stayed true while the target word had not flushed, judging commands like `git reset --hard 2>nul`
  // that end on a redirect target as "missing target". Only a redirect operator followed by no target word is missing;
  // while a target word accumulates (start >= 0), flushCommand below discards it as a redirect target as usual.
  if (quote || (skipTarget && start < 0)) {
    unsupported = true;
    invalidSegment = true;
  }
  flushCommand(source.length);
  return { commands, unsupported };
}
