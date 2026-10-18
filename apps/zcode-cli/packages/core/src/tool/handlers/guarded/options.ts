import type { CommandWord } from "./word.js";

export type OptionArity = "flag" | "value" | "optional";
export type OptionTable = Readonly<Record<string, OptionArity>>;
export interface ParsedOptions {
  flags: string[];
  operands: CommandWord[];
  unsupported: boolean;
}

/**
 * The scan policy must be declared by the caller; there is no default.
 * - ordering: wrapper/leading args stop at the first operand; the target command itself may interleave options and operands.
 * - unknown: a wrapper cannot guess where the real command starts past an unknown option, so abort;
 *   a target's existence rules (rm -rf, --delete, --force) survive one extra unknown word;
 *   continue only marks unsupported, consumes no word, enters no flags, letting the caller converge by match-first.
 */
export interface OptionScanPolicy {
  ordering: "stop-at-operand" | "interspersed";
  unknown: "abort" | "continue";
}

export const WRAPPER_SCAN: OptionScanPolicy = {
  ordering: "stop-at-operand",
  unknown: "abort",
};
export const COMMAND_SCAN: OptionScanPolicy = {
  ordering: "interspersed",
  unknown: "continue",
};

/** Finite option grammar: consume declared-arity values first; unknown options never guess arity. */
export function parseOptions(
  words: CommandWord[],
  table: OptionTable,
  policy: OptionScanPolicy,
): ParsedOptions {
  const result: ParsedOptions = { flags: [], operands: [], unsupported: false };
  let ended = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!ended && !word.dynamic && word.value === "--") {
      ended = true;
      continue;
    }
    if (ended || word.dynamic || !word.value.startsWith("-") || word.value === "-") {
      result.operands.push(word);
      if (policy.ordering === "stop-at-operand") {
        result.operands.push(...words.slice(i + 1));
        break;
      }
      continue;
    }
    const long = word.value.startsWith("--");
    const equals = word.value.indexOf("=");
    const names = long
      ? [equals < 0 ? word.value : word.value.slice(0, equals)]
      : Array.from(word.value.slice(1), (c) => `-${c}`);
    for (let n = 0; n < names.length; n++) {
      const name = names[n]!;
      const arity = table[name];
      const attached = long ? equals >= 0 : n < names.length - 1;
      // Root cause (2026-09-17 review): unknown options used to return immediately, discarding the recognized -r/-f of `rm -rfx`,
      // degrading the whole command to silent YOLO. Abort is reserved for wrapper/leading args.
      if (!arity || (arity === "flag" && long && attached)) {
        result.unsupported = true;
        if (policy.unknown === "abort") return result;
        continue;
      }
      result.flags.push(name);
      if (arity === "value" && !attached) {
        if (!words[++i]) result.unsupported = true;
      }
      if (arity !== "flag") break;
    }
  }
  return result;
}

export function optionTable(flags: string, values = "", optional = ""): OptionTable {
  return Object.fromEntries([
    ...flags
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => [name, "flag"]),
    ...values
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => [name, "value"]),
    ...optional
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => [name, "optional"]),
  ]);
}

export function enabled(flags: string[], yes: string[], no: string[] = []): boolean {
  let result = false;
  for (const flag of flags) {
    if (yes.includes(flag)) result = true;
    if (no.includes(flag)) result = false;
  }
  return result;
}

/** Match-first: with a trusted match return the rule; else any unknown option means unsupported, else supported-no-match. */
export function settleRule(
  rule: string | false,
  parsed: Pick<ParsedOptions, "unsupported">,
): string | false | undefined {
  return rule || (parsed.unsupported ? undefined : false);
}
