/** Word facts after AST location; no expansion performed, unknown words never become known options. */
export interface CommandWord {
  value: string;
  dynamic: boolean;
  hasUnquotedGlob: boolean;
  start: number;
  end: number;
}

export function literalPosixWord(text: string, start: number, end: number): CommandWord {
  let value = "";
  let quote = "";
  let dynamic = false;
  let hasUnquotedGlob = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === quote) {
      quote = "";
      continue;
    }
    if (quote !== "'" && c === "\\") {
      const next = text[i + 1];
      if (next === undefined) {
        dynamic = true;
        break;
      }
      if (!quote || ["$", "`", '"', "\\", "\n"].includes(next)) {
        if (next !== "\n") value += next;
        i++;
        continue;
      }
    }
    if (!quote && (c === "'" || c === '"')) {
      quote = c;
      continue;
    }
    if (quote !== "'" && (c === "$" || c === "`")) dynamic = true;
    if (!quote && /[*?[{}~]/.test(c)) dynamic = true;
    if (!quote && /[*?[]/.test(c)) hasUnquotedGlob = true;
    value += c;
  }
  return { value, dynamic: dynamic || Boolean(quote), hasUnquotedGlob, start, end };
}

export function commandBasename(word: CommandWord, windows: boolean): string | undefined {
  if (word.dynamic) return undefined;
  const name = word.value.split(windows ? /[\\/]/ : /\//).at(-1)!;
  return windows ? name.toLowerCase().replace(/\.exe$/, "") : name;
}
