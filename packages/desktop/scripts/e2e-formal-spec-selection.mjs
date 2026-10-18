export const SSH_FORMAL_SPEC_GLOB =
  "./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts";

const REQUIRED_SSH_E2E_ENV = [
  "ZCODE_E2E_SSH_HOST",
  "ZCODE_E2E_SSH_USERNAME",
  "ZCODE_E2E_SSH_PASSWORD",
];

export function hasRequiredSshE2EEnvironment(env) {
  return REQUIRED_SSH_E2E_ENV.every((name) => env[name]?.trim());
}

export function isSshFormalSpec(spec) {
  return spec
    .replaceAll("\\", "/")
    .includes("/conversation-session/conversation-session-ssh-remote");
}

export function resolveEnvironmentGatedFormalSpecExcludes({ env, targeted }) {
  // Fix: SSH P0 needs a real server; pulling it into the default full run without credentials
  // misrecords missing environment as three product failures. Explicit targeted runs keep the
  // helper's missing-variable fail-closed message.
  return !targeted && !hasRequiredSshE2EEnvironment(env) ? [SSH_FORMAL_SPEC_GLOB] : [];
}
