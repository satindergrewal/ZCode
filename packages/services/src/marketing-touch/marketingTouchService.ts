import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseMarketingTouchResponse, type ApiClient } from "@zcode/shared";
import { readApiJson } from "#src/providers/api/apiJson.js";
import type { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";

const localeSchema = z.enum(["zh-CN", "en-US"]);
// Sequence numbers live for this service process and never reset on component/account/service rebuilds.
let bootRequestSeq = 0;
const reportSchema = z.object({
  locale: localeSchema,
  scope: z.string().uuid(),
  campaignId: z.string().trim().min(1).max(128),
  actionType: z.enum(["confirm", "cancel"]),
});

export function createMarketingTouchService(options: {
  apiClient: ApiClient;
  getToken: () => Promise<string | null | undefined>;
  getDeviceMid: () => string | undefined;
  baseUrl: string;
  appVersion: string;
  onSnapshot?: (snapshot: ReturnType<typeof parseMarketingTouchResponse>) => void;
}): IMarketingTouchService {
  let previousToken: string | undefined;
  let scope = randomUUID();
  async function context(locale: "zh-CN" | "en-US") {
    const token = (await options.getToken())?.trim() || "";
    if (previousToken !== token) {
      previousToken = token;
      scope = randomUUID();
    }
    const device = z.string().uuid().parse(options.getDeviceMid());
    return {
      scope,
      headers: {
        "X-Device-Mid": device,
        "X-Client-Language": localeSchema.parse(locale),
        "X-ZCode-App-Version": options.appVersion,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
  }
  return {
    async query({ locale }) {
      const identity = await context(locale);
      const url = new URL("/api/v1/marketing/touch", options.baseUrl);
      url.searchParams.set("seq", String(bootRequestSeq++));
      const response = await readApiJson<unknown>(options.apiClient, url.href, {
        method: "GET",
        headers: identity.headers,
        timeoutMs: 15_000,
        redirect: "error",
      });
      if ((await context(locale)).scope !== identity.scope)
        throw new Error("marketing_identity_changed");
      const snapshot = parseMarketingTouchResponse(response);
      options.onSnapshot?.(snapshot);
      return { ...snapshot, scope: identity.scope };
    },
    async report(input) {
      const parsed = reportSchema.parse(input);
      const identity = await context(parsed.locale);
      // The account may have switched mid-claim: never report old actions with new credentials, and never leak credentials to the UI.
      if (identity.scope !== parsed.scope) throw new Error("marketing_identity_changed");
      const response = await readApiJson<unknown>(
        options.apiClient,
        new URL("/api/v1/marketing/touch/action", options.baseUrl).href,
        {
          method: "POST",
          headers: { ...identity.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ campaign_id: parsed.campaignId, action_type: parsed.actionType }),
          timeoutMs: 15_000,
          redirect: "error",
        },
      );
      z.object({ code: z.literal(0) }).parse(response);
    },
  };
}
