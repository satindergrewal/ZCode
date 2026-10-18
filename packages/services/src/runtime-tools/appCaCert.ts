import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import { getAppConfigDir } from "../paths.js";

// Self-signed CA for the app runtime (distinct from the debug packet-capture proxy CA, which is
// debug-only). Generated on first app start: agent subprocesses trust the public cert via
// NODE_EXTRA_CA_CERTS and the egress proxy uses the key for TLS re-signing. Existing files are
// reused as-is so the cert fingerprint stays stable and trusted.

const APP_CA_CERT_FILE = "zcode-network-ca.pem";
const APP_CA_KEY_FILE = "zcode-network-ca.key";
const CA_VALIDITY_YEARS = 10;
const CA_KEY_BITS = 2048;

interface AppCaCertPaths {
  certPath: string;
  keyPath: string;
}

function getAppCaCertPaths(): AppCaCertPaths {
  const certDir = join(getAppConfigDir(), "certs");
  return {
    certPath: join(certDir, APP_CA_CERT_FILE),
    keyPath: join(certDir, APP_CA_KEY_FILE),
  };
}

/**
 * Ensure the app self-signed CA exists, generating it when missing. Returns the cert (public key) path.
 * Idempotent: returns immediately when both cert and key exist, without regenerating.
 */
export function ensureAppCaCert(): string {
  const { certPath, keyPath } = getAppCaCertPaths();
  if (existsSync(certPath) && existsSync(keyPath)) {
    return certPath;
  }

  const { certPem, keyPem } = generateSelfSignedCa();
  mkdirSync(join(getAppConfigDir(), "certs"), { recursive: true });
  // The key holds secret material: tighten permissions to 0600; the public cert stays readable.
  writeFileSync(certPath, certPem, { mode: 0o644 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  return certPath;
}

function generateSelfSignedCa(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(CA_KEY_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // Cryptographic random serial number; clear the top bit so it never parses as negative.
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  cert.serialNumber = serial.toString("hex");

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + CA_VALIDITY_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: "commonName", value: "ZCode Network CA" },
    { name: "organizationName", value: "ZCode" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed: issuer == subject
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", critical: true, keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
