import { afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

process.env.GIT_CONFIG_COUNT = "2";

// Bugfix: Git Bash 会把 /usr/bin（GNU tar 1.35）注入 PATH 最前，子进程 spawn "tar"
// 解析到 GNU tar 后会把归档参数里的 `C:` 当远程主机（"Cannot connect to C"），
// zcode-server-cli 打包/发布与 native-search 归档类测试因此在 Windows 开发机整批失败。
// 真实 Windows 用户 PATH 中 System32 本就靠前、产品环境一直用 bsdtar；这里恢复同样顺序。
if (process.platform === "win32") {
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  if (existsSync(join(system32, "tar.exe"))) {
    const entries = (process.env.PATH ?? "").split(";");
    const rest = entries.filter((entry) => entry.toLowerCase() !== system32.toLowerCase());
    process.env.PATH = [system32, ...rest].join(";");
  }
}
process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
process.env.GIT_CONFIG_VALUE_0 = "false";
process.env.GIT_CONFIG_KEY_1 = "core.eol";
process.env.GIT_CONFIG_VALUE_1 = "lf";
process.env.ZCODE_TEST_RELEASE_TARGET = process.env.ZCODE_TEST_RELEASE_TARGET ?? "darwin";
process.env.ZCODE_TEST_RELEASE_ARCH = process.env.ZCODE_TEST_RELEASE_ARCH ?? "aarch64";
process.env.ZCODE_TEST_CLIENT_CONFIG_PLATFORM =
  process.env.ZCODE_TEST_CLIENT_CONFIG_PLATFORM ?? "darwin-aarch64";
// Bugfix: 桌面端会把自定义 dataBaseDir 通过环境变量注入到 host/git 子进程。
// 很多服务层单测只通过覆盖 HOME 来隔离临时目录；若保留该变量，路径解析会继续优先命中真实 dataBaseDir，
// 从而导致“终端本地跑通过，但应用内 git push 触发 pre-push 时大量用例误写到同一目录”。
// 这里在测试入口统一清理，保证单测默认只受各自显式设置的 HOME / setDataBaseDir 控制。
delete process.env.ZCODE_DATA_BASE_DIR;

afterEach(() => {
  delete process.env.ZCODE_DATA_BASE_DIR;
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();

  return {
    ...actual,
    homedir: () => {
      const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
      return envHome && envHome.length > 0 ? envHome : actual.homedir();
    },
  };
});

// Bugfix: restore `localStorage` for DOM-based test environments (jsdom) on
// Node >= 23. Node defines a `localStorage` accessor on globalThis that resolves
// to undefined unless --localstorage-file is provided. vitest's getWindowKeys()
// drops window properties that already exist on the Node global unless they are
// in its hardcoded allowlist, which has no `localStorage` entry, so the jsdom
// window's storage never reaches globalThis and tests reading the bare global
// get undefined. Install an in-memory Storage instead; jsdom's own storage is
// in-memory per document too, so observable semantics are equivalent. The
// marker below lets a later file in a reused worker replace a stale shim with
// a fresh instance, keeping per-file isolation.
type MinimalStorageLike = {
  readonly length: number;
  clear: () => void;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
};

type StorageShimHost = typeof globalThis & {
  document?: unknown;
  navigator?: unknown;
  localStorage?: MinimalStorageLike | undefined;
};

const SHIM_MARKER = "__zcodeInMemoryStorageShim";

type ShimMarkedStorage = MinimalStorageLike & { [SHIM_MARKER]?: boolean };

function looksLikeDomEnv(host: StorageShimHost): boolean {
  return "document" in host && "navigator" in host;
}

function installStorageShim(host: StorageShimHost): void {
  const backing = new Map<string, string>();
  const storage: ShimMarkedStorage = {
    [SHIM_MARKER]: true,
    get length() {
      return backing.size;
    },
    clear: () => {
      backing.clear();
    },
    getItem: (key: string) => (backing.has(key) ? (backing.get(key) as string) : null),
    key: (index: number) => Array.from(backing.keys())[index] ?? null,
    removeItem: (key: string) => {
      backing.delete(key);
    },
    setItem: (key: string, value: string) => {
      backing.set(String(key), String(value));
    },
  };
  Object.defineProperty(host, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

const storageHost = globalThis as StorageShimHost;

if (looksLikeDomEnv(storageHost)) {
  const existing = storageHost.localStorage;
  const staleShim = Boolean(existing && (existing as ShimMarkedStorage)[SHIM_MARKER]);
  if (typeof existing === "undefined" || staleShim) {
    installStorageShim(storageHost);
  }
}
