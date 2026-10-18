import { updatePreparationResultSchema } from "../contracts.js";
import { requestControl } from "../ipc/controlClient.js";
import { createServiceLogger } from "@zcode/services/node";
import type { ServerLayout } from "./paths.js";
import { prepareOnlineUpdate } from "./updatePreparation.js";

interface UpdateCliIO {
  stdout?: { write(value: string): void };
}

function stdout(io: UpdateCliIO, value: unknown): void {
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function isRunningTaskUpdateGuard(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("Running tasks require --force for update")
  );
}

const log = createServiceLogger("server-update-command");

async function discardPreparedUpdateBestEffort(
  discard: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!discard) return;
  try {
    await discard();
  } catch (error: unknown) {
    // Discarding prepared artifacts is non-critical cleanup; awaiting it directly would let a
    // cleanup failure mask the original running-task guard or control socket error.
    log.warn("failed to discard prepared update after command failure", error);
  }
}

export async function runUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<number>,
): Promise<number> {
  const force = argv.includes("--force");
  let discardPreparedUpdate: (() => Promise<void>) | undefined;
  if (!force) {
    // prepareOnlineUpdate downloads, extracts, and writes the pending release; the old flow only
    // checked running tasks in apply-update after preparation, leaving network/disk side effects
    // even when the guard rejects. Check known running tasks up front and again after preparation;
    // the final apply-update guard still covers the last small race window.
    const result = updatePreparationResultSchema.parse(
      await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
    );
    if (result.status === "blocked") throw new Error("Running tasks require --force for update");
  }
  const preparation = await prepareOnlineUpdate(layout);
  discardPreparedUpdate = "discard" in preparation ? preparation.discard : undefined;
  if (preparation.status === "up-to-date") {
    if (json) stdout(io, preparation);
    else stdout(io, `ZCode Server ${preparation.version} is already up to date`);
    return 0;
  }
  if (!force && discardPreparedUpdate) {
    const discard = discardPreparedUpdate;
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      if (result.status === "blocked") {
        await discardPreparedUpdateBestEffort(discard);
        discardPreparedUpdate = undefined;
        throw new Error("Running tasks require --force for update");
      }
    } catch (error: unknown) {
      if (isRunningTaskUpdateGuard(error)) throw error;
      await discardPreparedUpdateBestEffort(discard);
      discardPreparedUpdate = undefined;
      throw error;
    }
  }
  try {
    const result = await applyUpdate();
    discardPreparedUpdate = undefined;
    return result;
  } catch (error: unknown) {
    if (isRunningTaskUpdateGuard(error)) {
      await discardPreparedUpdateBestEffort(discardPreparedUpdate);
      discardPreparedUpdate = undefined;
    }
    throw error;
  }
}
