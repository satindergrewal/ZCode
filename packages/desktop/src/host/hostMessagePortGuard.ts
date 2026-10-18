import { hostIncomingMessageSchema } from "@zcode/shared";

export interface CloseableTransferredPort {
  close(): void;
}

export interface HostIncomingMessageEventLike {
  data: unknown;
  ports: readonly CloseableTransferredPort[];
}

function closeTransferredPort(port: CloseableTransferredPort | undefined): void {
  try {
    port?.close();
  } catch {
    // Rejection cleanup is best effort; a close error must not mask the original schema/initialization error.
  }
}

/** On schema-invalid, a transferred port is adopted by no ChannelServer and must be closed in place. */
export function parseHostIncomingMessageEvent(
  event: HostIncomingMessageEventLike,
): ReturnType<typeof hostIncomingMessageSchema.safeParse> {
  // After a clean pnpm install, zod lives in @zcode/shared's private node_modules; if the exported function relies
  // on inferred return types, the .d.ts references a non-portable private ZodSafeParseResult path.
  const result = hostIncomingMessageSchema.safeParse(event.data);
  if (!result.success) {
    for (const port of event.ports) closeTransferredPort(port);
  }
  return result;
}

/** Reject and close when AttachServicePort arrives before activeServices is ready, so remote RPCs never pend forever. */
export function rejectUnavailableAttachedServicePort(
  port: CloseableTransferredPort,
  servicesReady: boolean,
): boolean {
  if (servicesReady) return false;
  closeTransferredPort(port);
  return true;
}
