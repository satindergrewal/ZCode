import { contextBridge } from "electron";
import { installRewardsPageBridge, isTrustedRewardsUrl } from "@zcode/shared";

// Ordinary pages and third-party navigation must not inherit the invite page's bridge; only host-approved dev mode allows localhost.
if (
  isTrustedRewardsUrl(window.location.href, {
    dev: process.argv.includes("--zcode-rewards-dev"),
    e2e: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
  })
) {
  contextBridge.executeInMainWorld({ func: installRewardsPageBridge, args: [] });
}
