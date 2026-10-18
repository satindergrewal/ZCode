import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { webContents, type BrowserWindow } from "electron";
import { getGenUiOutputDirectory } from "@zcode/shared/node";

export async function prepareOutputFiles(root: string) {
  // Regression: opening a workspace that contains the app-data dir (like Home) must keep pinned Gen UI output readable.
  const workspacePath = root;
  const outputRoot = join(root, "user-data", "visualizations");
  const directory = getGenUiOutputDirectory(outputRoot, {
    workspacePath,
    workspaceIdentity: "ssh:fixture:/workspace",
    sessionId: "fixture",
  });
  await mkdir(directory, { recursive: true });
  const path = join(directory, "demo.html");
  await copyFile(join(root, "demo.html"), path);
  // Fork keeps the parent session's HTML path; the second session reads the same file, no artifact copy.
  const paths: Record<string, string> = { fixture: path, "second-task": path };
  return { workspacePath, outputRoot, paths };
}

export async function checkInheritedOutput(win: BrowserWindow): Promise<void> {
  const guestId = await win.webContents.executeJavaScript(
    "document.querySelector('[data-testid=gen-ui-anchor] webview').getWebContentsId()",
  );
  const frame = webContents
    .fromId(guestId)!
    .mainFrame.frames.find((value) => value.url.includes("/instance/"))!;
  assert.equal(
    await frame.executeJavaScript("document.querySelector('h1').textContent"),
    "Updated heading",
  );
}
