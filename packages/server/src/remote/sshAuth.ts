import type { ConnectConfig } from "ssh2";

export const SSH_READY_TIMEOUT_MS = 60_000;
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSH_KEEPALIVE_COUNT_MAX = 3;

interface SSHConnectConfigInput {
  host: string;
  port?: number;
  username: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  password?: string;
  agent?: string;
}

function isMissingPrivateKeyPassphraseMessage(message: string): boolean {
  return /encrypted .*private .*key detected, but no passphrase given/i.test(message);
}

function isInvalidPrivateKeyPassphraseMessage(message: string): boolean {
  return /(bad passphrase|key integrity check failed|unable to authenticate data)/i.test(message);
}

export function buildSSHConnectConfig(input: SSHConnectConfigInput): ConnectConfig {
  const hasPassword = typeof input.password === "string" && input.password.length > 0;

  // With password auth, always sending SSH_AUTH_SOCK makes ssh2 try agent public
  // keys first. Hosts with a small MaxAuthTries exhaust attempts during the
  // pubkey phase, locking out the correct password. Enable the agent only when
  // explicitly passed; password mode defaults to no implicit agent.
  const resolvedAgent = input.agent ?? (hasPassword ? undefined : process.env["SSH_AUTH_SOCK"]);

  return {
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
    password: hasPassword ? input.password : undefined,
    agent: resolvedAgent,
    // ssh2's default readyTimeout is 20s; slow public networks or server flaps
    // misreport as timeouts. Widen the handshake explicitly -- gives real slow
    // links a chance and keeps error normalization aligned with the config.
    readyTimeout: SSH_READY_TIMEOUT_MS,
    // If a project idles behind NAT/firewall or the server drops silently, the
    // stdio channel may not close right away. SSH-level keepalive makes ssh2
    // raise error/close after consecutive misses instead of leaving UI tasks
    // loading forever.
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    // Some SSH servers enable only keyboard-interactive (challenge-response) and
    // disable plain password. tryKeyboard plus the interactive responder lets one
    // password cover those hosts instead of "works in a terminal, fails in app".
    tryKeyboard: hasPassword,
  };
}

export function createKeyboardInteractiveResponder(password?: string) {
  return (
    _name: string,
    _instructions: string,
    _lang: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (responses: string[]) => void,
  ) => {
    if (!password || prompts.length === 0) {
      finish([]);
      return;
    }

    finish(prompts.map(() => password));
  };
}

export function normalizeSSHConnectError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-authentication"
  ) {
    return new Error("SSH authentication failed: check the username, password, or private key configuration");
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-timeout"
  ) {
    return new Error(
      `SSH handshake timed out: no SSH session within ${SSH_READY_TIMEOUT_MS / 1000}s. Check the network, the server's sshd, or terminal SSH config differences`,
    );
  }

  if (error instanceof Error) {
    // ssh2 words private-key failures differently per format (legacy/new OpenSSH,
    // PPK). Matching a single string leaked raw errors for some missing/wrong
    // passphrase cases. Normalize by pattern so the same failure always maps to
    // one product-level hint the user can act on.
    if (isMissingPrivateKeyPassphraseMessage(error.message)) {
      return new Error("SSH private key requires a passphrase: the key is encrypted but no passphrase was provided");
    }
    if (isInvalidPrivateKeyPassphraseMessage(error.message)) {
      return new Error("SSH private key passphrase is incorrect: the key could not be decrypted; check the passphrase");
    }
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error("SSH connection failed");
}
