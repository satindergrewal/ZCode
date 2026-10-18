import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "../src/share/conversationShareRoute.js";
import { resolveConversationShareRouteLocale } from "../src/share/conversationSharePreviewClient.js";

describe("conversation share route", () => {
  it("recognizes share paths without taking over remote routes", () => {
    expect(isConversationSharePath("/cn/share")).toBe(true);
    expect(isConversationSharePath("/cn/share/share-1")).toBe(true);
    expect(isConversationSharePath("/share")).toBe(true);
    expect(isConversationSharePath("/share/share-1")).toBe(true);
    expect(isConversationSharePath("/remote/v4")).toBe(false);
    expect(isConversationSharePath("/sharegate/x")).toBe(false);
  });

  it("no longer rejects bare /share/ on the English site; both prefixes yield the code", () => {
    // /share/<code> used to hit isRejectedConversationSharePath and render not_found,
    // meaning the English share page did not exist.
    expect(resolveConversationShareCodeFromPath("/cn/share/share-1")).toBe("share-1");
    expect(resolveConversationShareCodeFromPath("/share/share-1")).toBe("share-1");
    expect(resolveConversationShareCodeFromPath("/cn/share/share-1/extra")).toBeNull();
    expect(resolveConversationShareCodeFromPath("/share/")).toBeNull();
  });

  it("derives page language from the path prefix", () => {
    expect(resolveConversationShareRouteLocale("/cn/share/share-1")).toBe("zh-CN");
    expect(resolveConversationShareRouteLocale("/share/share-1")).toBe("en-US");
  });

  it("localizes artifact counts with no mixed-language rendering", () => {
    // Root cause: hardcoded English artifact/artifacts with hand-written plurals rendered the zh page as
    // "2026-09-03 11:55 - 1 artifact".
    const source = readFileSync("packages/web/src/share/ConversationShareLandingPage.tsx", "utf8");
    expect(source).toContain("artifactCountOne");
    expect(source).toContain("artifactCountOther");
    expect(source).toContain("{count} 个结果物");
    expect(source).not.toContain("artifact{artifactCount === 1");
  });

  it("routes the English share OAuth callback through the same callback page", () => {
    const mainSource = readFileSync("packages/web/src/main.tsx", "utf8");
    const authSource = readFileSync("packages/web/src/auth/webAuthService.ts", "utf8");
    const stateSource = readFileSync("packages/web/src/auth/oauthStateCodec.ts", "utf8");
    expect(mainSource).toContain('"/share/callback"');
    expect(authSource).toContain('"/share/callback"');
    expect(stateSource).toContain('"/share/callback"');
    expect(stateSource).toContain("const SHARE_PATH_PATTERN");
    expect(stateSource).toContain("cn\\/share|share");
  });

  it("synces share html lang and the document title", () => {
    // index.html pins lang="en"; without syncing, the zh share page misreports language to a11y and translators.
    // document.title was never set, so tabs showed index.html's generic title.
    const source = readFileSync("packages/web/src/main.tsx", "utf8");
    expect(source).toContain("document.documentElement.lang = routeLocale");
    expect(source).toMatch(/document\.title =\s*routeLocale === "zh-CN"/u);
  });

  it("never hardcodes the dev base to /cn/share/ or English routes vanish locally", () => {
    // Root cause: the dev script pinned --base=/cn/share/, so Vite served only that prefix and /share/<code>
    // was rejected outright ("server is configured with a public base URL of /cn/share/").
    const source = readFileSync("scripts/dev-web-share-env.mjs", "utf8");
    expect(source).toContain('"--base=/"');
    expect(source).not.toContain('"--base=/cn/share/"');
  });

  it("keeps the continue-help banner body-width and the download link free of /download", () => {
    const source = readFileSync("packages/web/src/share/ConversationShareLandingPage.tsx", "utf8");
    // Bug one: the banner hung directly off ShareContentRail without ShareContentInset,
    // missing px-4 / @md:px-6 and ran wider than the timestamp and body.
    expect(source).toMatch(/showContinueHelp \? \(\s*(?:\/\/[^\n]*\n\s*)*<ShareContentInset>/u);
    // Bug two: the site home is the download entry; /download is a 404.
    expect(source).toContain('const ZCODE_DOWNLOAD_URL = "https://zcode.z.ai"');
    expect(source).not.toContain("zcode.z.ai/download");
  });
});
