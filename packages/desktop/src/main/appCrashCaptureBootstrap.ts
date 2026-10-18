import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// Must run before appARMSBootstrap: desktopEarlyDataBaseDirBootstrap inject dataBaseDir, then configure crash dumps.
// remoteCrashReporterEnabled=true means ARMS owns remote crash reporting; the local-only crashReporter stays off.
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, true);
