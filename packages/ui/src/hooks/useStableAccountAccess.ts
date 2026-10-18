import { useRef } from "react";
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "@zcode/shared";

type StableAccountAccess = ZCodeProviderAccountAccess | ZCodeAccountAccess;

/** Schema parsing rebuilds the same Account Access as a new object; hook deps must be stable per configuration value. */
export function useStableAccountAccess(
  accountAccess: StableAccountAccess | null | undefined,
): StableAccountAccess | undefined {
  const normalized = accountAccess ?? undefined;
  const key = JSON.stringify(accountAccess ?? null);
  const stable = useRef({ key, value: normalized });
  if (stable.current.key !== key) {
    stable.current = { key, value: normalized };
  }
  return stable.current.value;
}
