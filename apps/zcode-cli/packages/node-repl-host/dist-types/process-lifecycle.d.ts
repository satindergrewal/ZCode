/**
 * NodeReplSession catches sync REPL cell errors, but fire-and-forget async errors (e.g. an unawaited
 * tab.* call rejected on turn interrupt) would, under Node's default policy, take down the whole server
 * process -- and with the child gone, in-session Browser Use is lost. Downgrade async errors to stderr logs:
 * runtime state preserved, protocol stdout untouched.
 *
 * After the parent exits, writing stderr raises EPIPE. The old handler wrote the EPIPE stack back to the same
 * stderr, looping EPIPE -> uncaughtException -> stderr.write -> EPIPE. A closed output pipe means the MCP client
 * is unreachable: go straight to shutdown instead of writing more diagnostics.
 */
export declare function installNodeReplProcessGuards(input: {
  onOutputClosed: (error: Error) => void;
  process: Pick<NodeJS.Process, "on">;
  writeStderr: (text: string) => void;
}): void;
export declare function installNodeReplShutdownTriggers(input: {
  process: Pick<NodeJS.Process, "once">;
  shutdown: () => void;
  stdin: Pick<NodeJS.ReadStream, "once">;
}): void;
export declare function isDirectMcpEntrypoint(
  importMetaUrl: string,
  argvPath: string | undefined,
): Promise<boolean>;
//# sourceMappingURL=process-lifecycle.d.ts.map
