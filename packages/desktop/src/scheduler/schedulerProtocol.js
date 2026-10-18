// Control-message protocol between the scheduler utilityProcess and main. Both ends are
// Electron-side and speak over parentPort.postMessage. Unlike the host<->main CronRun/CronRunResult
// (see @zcode/shared channels + validation), this is the private channel between main and the
// resident cron scheduler process; main translates dispatch requests into CronRun for the host.
export {};
//# sourceMappingURL=schedulerProtocol.js.map
