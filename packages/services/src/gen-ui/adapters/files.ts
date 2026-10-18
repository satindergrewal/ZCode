import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  GEN_UI_HTML_MAX_BYTES,
  genUiStateTargetSchema,
  type GenUiDocument,
  type GenUiStateTarget,
} from "@zcode/shared/gen-ui";

export function assertGenUiFragment(html: string): void {
  if (Buffer.byteLength(html, "utf8") > GEN_UI_HTML_MAX_BYTES)
    throw new Error("Gen UI file exceeds 5 MB");
  if (/<(?:!doctype\b|\/?(?:html|head|body)(?:\s|>))/iu.test(html))
    throw new Error("Gen UI requires an HTML fragment");
}
export async function readGenUiDocument(
  raw: GenUiStateTarget,
  outputRoot: string,
): Promise<GenUiDocument> {
  const input = genUiStateTargetSchema.parse(raw);
  if (!isAbsolute(outputRoot) || !isAbsolute(input.path) || !isAbsolute(input.workspacePath))
    throw new Error("Invalid executor path");
  const root = resolve(outputRoot),
    file = normalize(input.path);
  const child = relative(root, file);
  // Root cause: forks keep the parent session\x27s HTML paths, so generation-dir grouping must not limit reads for the current session.
  // Read scope comes only from the executing host\x27s fixed output root; widget state keeps the current session identity.
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("Gen UI file is outside the host output directory");
  // Fix rationale: prefix checks after realpath can still admit swapped symlinks; reject links per segment and verify the opened inode.
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Gen UI does not read symbolic links");
  }
  const before = await lstat(current);
  const canonicalFile = await realpath(current);
  const canonicalChild = relative(canonicalRoot, canonicalFile);
  if (
    !canonicalChild ||
    canonicalChild === ".." ||
    canonicalChild.startsWith(`..${sep}`) ||
    isAbsolute(canonicalChild)
  )
    throw new Error("Gen UI file escaped the output directory");
  if (!before.isFile() || before.size > GEN_UI_HTML_MAX_BYTES)
    throw new Error("Gen UI requires a regular file under 5 MB");
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Gen UI file changed while opening");
    const bytes = Buffer.alloc(GEN_UI_HTML_MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    if (used > GEN_UI_HTML_MAX_BYTES) throw new Error("Gen UI file exceeds 5 MB");
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    assertGenUiFragment(html);
    return { path: file, html };
  } finally {
    await handle.close();
  }
}
