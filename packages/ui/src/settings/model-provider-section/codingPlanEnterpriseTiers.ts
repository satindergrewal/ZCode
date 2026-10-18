import type { EnterpriseCodingPlanProductDisplay } from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";

// 2026-09: the native purchase panel (CodingPlanPurchasePanel) was retired; purchase moved into the embedded
// store webview. This file carries over the enterprise tier/group helpers still used by the settings page (Detail.tsx)
// and login recovery, so live code does not depend on the 6200-line dead panel.

export type PurchaseAudience = "personal" | "team";

export interface EnterpriseCodingPlanProductGroup {
  key: string;
  title: string;
  products: EnterpriseCodingPlanProductDisplay[];
}
