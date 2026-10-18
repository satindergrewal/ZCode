import { app } from "electron";
import { getAppConfigDir } from "@zcode/services/node";

export type ElectronAppPathName = "appData" | "userData";

export function isElectronAppPackaged(): boolean {
  return (app as unknown as { isPackaged?: boolean } | undefined)?.isPackaged === true;
}

export function getElectronAppPath(name: ElectronAppPathName): string {
  const electronApp = app as unknown as
    | { getPath?: (pathName: ElectronAppPathName) => string }
    | undefined;
  if (electronApp?.getPath) {
    return electronApp.getPath(name);
  }

  // Some main-process unit tests mock only the Electron API the subject imports directly;
  // transitively importing desktopRuntimeEnv may then lack app. Real desktop runs use app.getPath;
  // Node-only tests fall back to the config dir so import-time constants never break unrelated tests.
  return getAppConfigDir();
}
