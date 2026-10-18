import { afterEach, describe, expect, it } from "vitest";
import {
  buildSSHConnectConfig,
  createKeyboardInteractiveResponder,
  normalizeSSHConnectError,
} from "../src/remote/sshAuth.js";

const originalAuthSock = process.env["SSH_AUTH_SOCK"];

afterEach(() => {
  if (originalAuthSock == null) {
    delete process.env["SSH_AUTH_SOCK"];
    return;
  }
  process.env["SSH_AUTH_SOCK"] = originalAuthSock;
});

describe("sshAuth", () => {
  it("disables the implicit agent by default and enables keyboard-interactive for password auth", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      password: "secret",
    });

    expect(config.agent).toBeUndefined();
    expect(config.tryKeyboard).toBe(true);
    expect(config.password).toBe("secret");
  });

  it("keeps the implicit agent when no password is set", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
    });

    expect(config.agent).toBe("/tmp/test.sock");
    expect(config.tryKeyboard).toBe(false);
  });

  it("lets an explicit agent override the default policy", () => {
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      password: "secret",
      agent: "/tmp/custom.sock",
    });

    expect(config.agent).toBe("/tmp/custom.sock");
  });

  it("sets readyTimeout and keepalive explicitly so silent disconnects never hang", () => {
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
    });

    expect(config.readyTimeout).toBe(60_000);
    expect(config.keepaliveInterval).toBe(15_000);
    expect(config.keepaliveCountMax).toBe(3);
  });

  it("uses the key passphrase only for decryption, never to flip the password-auth branch", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      privateKey: "test-private-key",
      passphrase: "key-secret",
    });

    expect(config.passphrase).toBe("key-secret");
    expect(config.agent).toBe("/tmp/test.sock");
    expect(config.tryKeyboard).toBe(false);
    expect(config.password).toBeUndefined();
  });

  it("answers every keyboard-interactive prompt with the same password", () => {
    const responder = createKeyboardInteractiveResponder("secret");
    let responses: string[] = [];
    responder(
      "",
      "",
      "",
      [
        { prompt: "Password:", echo: false },
        { prompt: "OTP:", echo: false },
      ],
      (nextResponses) => {
        responses = nextResponses;
      },
    );

    expect(responses).toEqual(["secret", "secret"]);
  });

  it("maps client-authentication errors to a readable message", () => {
    const error = normalizeSSHConnectError({ level: "client-authentication" });
    expect(error.message).toContain("SSH authentication failed");
  });

  it("labels client-timeout errors as an SSH handshake timeout", () => {
    const error = normalizeSSHConnectError({ level: "client-timeout" });
    expect(error.message).toBe(
      "SSH handshake timed out: no SSH session within 60s. Check the network, the server's sshd, or terminal SSH config differences",
    );
  });

  it("normalizes missing-passphrase error variants into one readable message", () => {
    const expectedMessage =
      "SSH private key requires a passphrase: the key is encrypted but no passphrase was provided";
    const cases = [
      "Encrypted private OpenSSH key detected, but no passphrase given",
      "Encrypted OpenSSH private key detected, but no passphrase given",
      "Encrypted PPK private key detected, but no passphrase given",
    ];

    for (const message of cases) {
      expect(normalizeSSHConnectError(new Error(message)).message).toBe(expectedMessage);
    }
  });

  it("maps key passphrase errors to a readable message", () => {
    const expectedMessage =
      "SSH private key passphrase is incorrect: the key could not be decrypted; check the passphrase";
    const cases = [
      "OpenSSH key integrity check failed -- bad passphrase?",
      "PPK private key integrity check failed -- bad passphrase?",
    ];

    for (const message of cases) {
      expect(normalizeSSHConnectError(new Error(message)).message).toBe(expectedMessage);
    }
  });
});
