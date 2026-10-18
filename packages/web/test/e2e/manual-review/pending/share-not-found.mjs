// SHARE-NF01: start pnpm dev:web-share:mock first, then run this file; dev fixtures only.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const baseUrl = process.env.SHARE_E2E_BASE_URL || "http://localhost:5173";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const locale of ["cn/share", "share"]) {
    for (const width of [320, 1280]) {
      for (const theme of ["zai-light", "zai-dark"]) {
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        await context.addInitScript((value) => localStorage.setItem("zcode-theme", value), theme);
        const page = await context.newPage();
        const chinese = locale === "cn/share";
        const home = page.getByRole("link", {
          name: chinese ? "回到首页" : "Back to home",
          exact: true,
        });
        await page.goto(`${baseUrl}/${locale}/mock-not-found`);
        await page
          .getByRole("heading", {
            name: chinese ? "登录后查看分享" : "Sign in to view this share",
            exact: true,
          })
          .waitFor();
        assert.equal(await home.count(), 0);
        await page.locator('[data-share-login-provider="zai"]').click();
        await page
          .getByRole("heading", {
            name: chinese ? "找不到分享内容" : "Share not found",
            exact: true,
          })
          .waitFor();
        await page
          .getByText(
            chinese
              ? "Z.ai 与 BigModel 的账号数据不互通。"
              : "Z.ai and BigModel do not share account data.",
            { exact: false },
          )
          .waitFor();
        await home.waitFor();
        assert.equal(await home.getAttribute("href"), "https://zcode.z.ai");
        assert.equal(await home.getAttribute("target"), null);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        const retry = page.getByRole("button", {
          name: chinese ? "重试" : "Try again",
          exact: true,
        });
        // After clearing the mock auth the retry must land back on the login page, proving the button re-reads the token and re-requests.
        await page.evaluate(() => sessionStorage.removeItem("zcode:share:mock-auth"));
        await retry.click();
        await page.locator('[data-share-login-provider="bigmodel"]').waitFor();
        await page.locator('[data-share-login-provider="bigmodel"]').click();
        await home.waitFor();
        await page.route("https://zcode.z.ai/**", (route) =>
          route.fulfill({ contentType: "text/html", body: "<h1>Home</h1>" }),
        );
        await home.click();
        await page.waitForURL("https://zcode.z.ai/");
        assert.equal(context.pages().length, 1);
        await page.goto(`${baseUrl}/${locale}/mock-expired`);
        await page
          .getByRole("heading", { name: chinese ? "分享已过期" : "Share expired", exact: true })
          .waitFor();
        assert.equal(await home.count(), 0);
        await context.close();
        console.log(`PASS SHARE-NF01 ${locale} ${width} ${theme}`);
      }
    }
  }
} finally {
  await browser.close();
}
