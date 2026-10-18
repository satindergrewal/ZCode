import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

function readWebIndexHtml(): string {
  return readFileSync(resolve(process.cwd(), "packages/web/index.html"), "utf8");
}

function readWorkspaceFile(path: string): Buffer {
  return readFileSync(resolve(process.cwd(), path));
}

function readWorkspaceFileDataUrl(path: string, mimeType: string): string {
  return `data:${mimeType};base64,${readWorkspaceFile(path).toString("base64")}`;
}

function readCssRule(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`));
  return match?.groups?.body ?? "";
}

function createBootstrapDocument(theme: "zai-dark" | "zai-light"): JSDOM {
  return new JSDOM(readWebIndexHtml(), {
    beforeParse(window) {
      window.localStorage.setItem("zcode-theme", theme);
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({ matches: false }),
      });
    },
    runScripts: "dangerously",
    url: "https://zcode.example/remote",
  });
}

describe("web remote control bootstrap shell", () => {
  it("inlines the same favicon source as the desktop app", () => {
    const html = readWebIndexHtml();
    const document = new JSDOM(html).window.document;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/png"]');

    expect(icon?.href).toBe(readWorkspaceFileDataUrl("public/logo/icons/32x32.png", "image/png"));
    expect(icon?.getAttribute("sizes")).toBe("32x32");
    expect(readWorkspaceFile("packages/web/public/favicon.ico")).toEqual(
      readWorkspaceFile("packages/desktop/build/icon.ico"),
    );
    expect(readWorkspaceFile("public/logo/icons/icon.ico")).toEqual(
      readWorkspaceFile("packages/desktop/build/icon.ico"),
    );
  });

  it("gives the prerendered loading container its own theme background so a transparent body never shows white", () => {
    const html = readWebIndexHtml();
    const loadingRule = readCssRule(html, ".zcode-boot-loading");

    expect(loadingRule).toContain("background: var(--zcode-bootstrap-bg");
    expect(loadingRule).toContain("#0f172a");
  });

  it.each([
    ["zai-dark", "dark", "#161616"],
    ["zai-light", "light", "#f8f8f8"],
  ] as const)(
    "applies %s to the browser theme surface before any app bundle runs",
    (storedTheme, resolvedTheme, expectedColor) => {
      const dom = createBootstrapDocument(storedTheme);
      const { document } = dom.window;

      expect(document.documentElement.getAttribute("data-zcode-browser-theme-surface")).toBe(
        resolvedTheme,
      );
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
        expectedColor,
      );
      expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
        resolvedTheme,
      );

      dom.window.close();
    },
  );

  it("paints a semantic web root background over Electron's transparent one", () => {
    const html = readWebIndexHtml();
    const browserSurfaceRule = readCssRule(html, "html[data-zcode-browser-theme-surface] #root");

    expect(html).toContain("html[data-zcode-browser-theme-surface] body");
    expect(browserSurfaceRule).toContain("background: var(--color-background");
    expect(browserSurfaceRule).toContain("!important");
  });
});
