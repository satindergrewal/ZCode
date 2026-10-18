import { resolveZCodeRuntimeEnv } from "@zcode/shared";

export type EffectiveNodeEnv = "development" | "production";

export function resolveEffectiveNodeEnv(
  env: Record<string, string | undefined> = process.env,
): EffectiveNodeEnv {
  const runtimeEnv = resolveZCodeRuntimeEnv(env);
  // NODE_ENV is a generic variable used by user shells and the Node ecosystem; it must not decide
  // the ZCode runtime. Only ZCODE_RUNTIME_ENV explicitly injected by app/CLI counts, so NODE_ENV
  // leaked from Bash or a login shell never reaches host/agent runtimes; the test runtime is
  // treated as normal mode without enabling development debug logs.
  return runtimeEnv === "development" ? "development" : "production";
}

export function isEffectiveDevelopmentNodeEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveEffectiveNodeEnv(env) === "development";
}
