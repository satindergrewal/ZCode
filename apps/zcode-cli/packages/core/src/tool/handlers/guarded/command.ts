import type { ExecutionShellSelection } from "@zcode/contracts";
import { analyzeBashCommand } from "../bash-command-parser.js";
import { analyzeCmdCommand } from "./cmd.js";
import { matchGit, type RuleMatch } from "./git.js";
import { matchFindDelete } from "./find.js";
import { matchCmdDelete, matchRobocopyDelete } from "./windows-delete.js";
import { COMMAND_SCAN, enabled, optionTable, parseOptions, settleRule } from "./options.js";
import { unwrapCommand } from "./wrappers.js";
import { commandBasename, type CommandWord } from "./word.js";

export type DangerousCommandResult =
  | { status: "matched"; ruleId: string; start: number; end: number }
  | { status: "notMatched" | "unsupported" };

const RM = optionTable(
  "-r -R --recursive -f --force -i -I --one-file-system --preserve-root --no-preserve-root -v --verbose -d --dir --help --version",
  "",
  "--interactive",
);
const RSYNC_DELETE = [
  "--delete",
  "--del",
  "--delete-before",
  "--delete-during",
  "--delete-delay",
  "--delete-after",
  "--delete-excluded",
];
const RSYNC = optionTable(
  `-a -r -v -q -z -h -P -p -t -g -o -D -l -H -A -X -u -c -n --dry-run --archive --recursive --verbose --quiet --compress --progress --partial --checksum --update --numeric-ids --ignore-errors --force --help --version ${RSYNC_DELETE.join(" ")}`,
  "-e --rsh -f --filter --include --exclude --include-from --exclude-from --files-from --rsync-path --log-file --out-format --backup-dir --suffix --chmod --chown --max-delete --timeout --bwlimit --compare-dest --copy-dest --link-dest",
);
const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "cmd",
  "powershell",
  "pwsh",
  "eval",
  "source",
  ".",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
]);
const MAX_LENGTH = 10_000;

export function matchDangerousCommand(
  command: string,
  dialect: ExecutionShellSelection["dialect"],
): DangerousCommandResult {
  if (command.length > MAX_LENGTH || dialect === "legacy-shell") return { status: "unsupported" };
  const windows = dialect === "cmd" || dialect === "git-bash";
  let commands: CommandWord[][];
  let unsupported: boolean;
  if (dialect === "cmd") {
    ({ commands, unsupported } = analyzeCmdCommand(command));
  } else {
    const analysis = analyzeBashCommand(command);
    // A parse failure has no reliable span; partial unsupported nodes never discard the other independent commands.
    if (analysis.hasParseErrors) return { status: "unsupported" };
    commands = analysis.commands.map((c) => c.words);
    unsupported = analysis.hasUnsupportedSyntax;
  }
  for (const invocation of commands) {
    const words = unwrapCommand(invocation, windows);
    if (!words?.[0]) {
      unsupported = true;
      continue;
    }
    const name = commandBasename(words[0], windows);
    const result = name ? matchInvocation(name, words.slice(1), dialect) : undefined;
    if (result)
      return {
        status: "matched",
        ruleId: `safety.bash.${result}`,
        start: words[0].start,
        end: words.at(-1)!.end,
      };
    if (result === undefined || words.some((word) => word.dynamic)) unsupported = true;
  }
  return { status: unsupported ? "unsupported" : "notMatched" };
}

function matchInvocation(
  name: string,
  args: CommandWord[],
  dialect: ExecutionShellSelection["dialect"],
): RuleMatch {
  if (name === "git") return matchGit(args);
  if (INTERPRETERS.has(name)) return undefined;
  if (dialect === "cmd" && ["rd", "rmdir", "del", "erase"].includes(name))
    return matchCmdDelete(name, args);
  if (dialect !== "cmd" && name === "find") return matchFindDelete(args);
  if ((dialect === "cmd" || dialect === "git-bash") && name === "robocopy")
    return matchRobocopyDelete(args, dialect);
  if (name === "rm") {
    const parsed = parseOptions(args, RM, COMMAND_SCAN);
    // BSD rm stops parsing options after the first target; the existence scan would swallow later real filenames like --help.
    // Target counting follows that semantics; dangerous options keep GNU's interleaved scan, with no platform probing.
    const targets = parseOptions(args, RM, { ordering: "stop-at-operand", unknown: "continue" });
    // recursive or syntactic batch suffices; never expand targets, never cancel known danger evidence via help/interactive flags.
    return settleRule(
      (enabled(parsed.flags, ["-r", "-R", "--recursive"]) ||
        targets.operands.length >= 2 ||
        targets.operands.some((word) => word.hasUnquotedGlob)) &&
        "remove-critical-path",
      parsed,
    );
  }
  if (["dd", "mount", "umount", "mkfs"].includes(name) || /^mkfs\.[a-zA-Z0-9_-]+$/.test(name)) {
    // Exempt only standalone, unambiguous query forms; a --help inside -o/option values is not an exit option.
    if (args.length === 1 && !args[0]!.dynamic && ["--help", "--version"].includes(args[0]!.value))
      return false;
    return !(name === "mount" && args.length === 0) && "system-storage";
  }
  if (name === "rsync") {
    const parsed = parseOptions(args, RSYNC, COMMAND_SCAN);
    return settleRule(
      !parsed.flags.some((f) => ["-n", "--dry-run", "--help", "--version"].includes(f)) &&
        parsed.flags.some((f) => RSYNC_DELETE.includes(f)) &&
        "rsync-delete",
      parsed,
    );
  }
  return false;
}
