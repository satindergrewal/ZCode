import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { ZCodeOffPeakTaskStatus } from "@zcode/shared";
import type { IOffPeakTaskService } from "@zcode/services";
import type { IntlInstance } from "@/i18n/index.js";
import { logger } from "@/logger.js";

// Off-peak task system notifications (notification only; the authoritative path is
// in-app, notification click jumps to the session; visuals pending design).
// Mounted globally (App root, one per window): main's dispatchTaskNotification dedupes by
// (status:taskId) within 3s, so repeated triggers across windows show one notification and
// no leader election is needed. Polling is independent of host sync (no renderer sqlite).

const OFF_PEAK_NOTIFICATION_POLL_MS = 30_000;

/** Off-Peak aggregation notifies terminal states only; permission/elicitation go through the normal session notification path, avoiding duplicates. */
function notifiableStatus(status: ZCodeOffPeakTaskStatus): "completed" | "failed" | null {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return null;
}

export function useOffPeakTaskNotifications(params: {
  offPeakTaskService: IOffPeakTaskService;
  platform: Pick<IPlatformService, "showTaskNotification"> | null | undefined;
  enabled: boolean;
  formatMessage: IntlInstance["formatMessage"];
}): void {
  const { offPeakTaskService, platform, enabled, formatMessage } = params;
  // offPeakTaskId -> last seen status; fire only on the "new -> notifiable" edge, never every poll.
  const seenStatusRef = useRef(new Map<string, ZCodeOffPeakTaskStatus>());

  useEffect(() => {
    if (!enabled || !platform) return;
    let disposed = false;

    const tick = async () => {
      try {
        const tasks = await offPeakTaskService.list();
        if (disposed) return;
        const seen = seenStatusRef.current;
        const alive = new Set<string>();
        for (const task of tasks) {
          alive.add(task.offPeakTaskId);
          const previous = seen.get(task.offPeakTaskId);
          seen.set(task.offPeakTaskId, task.status);
          if (previous === task.status) continue;
          const kind = notifiableStatus(task.status);
          if (!kind) continue;
          // A task whose first sight is already terminal (e.g. backlog at app open) gets no
          // historical notification; notify on real transitions only.
          if (previous === undefined) continue;
          const titleKey =
            kind === "completed" ? "offPeak.notify.completed.title" : "offPeak.notify.failed.title";
          const bodyKey =
            kind === "completed" ? "offPeak.notify.completed.body" : "offPeak.notify.failed.body";
          try {
            platform.showTaskNotification({
              // Click-through uses the run session's taskId (terminal states without a session cannot jump; offPeakTaskId is the fallback).
              taskId: task.sessionId ?? task.conversationId ?? task.offPeakTaskId,
              status: kind === "completed" ? "completed" : "failed",
              title: formatMessage({ id: titleKey }),
              body: formatMessage({ id: bodyKey }, { title: task.title || task.prompt }),
            });
          } catch (error) {
            logger.warn("[off-peak] notification dispatch failed", error);
          }
        }
        // Prune vanished (deleted) tasks so the map cannot grow forever.
        for (const id of seen.keys()) {
          if (!alive.has(id)) seen.delete(id);
        }
      } catch (error) {
        logger.warn("[off-peak] notification poll failed", error);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), OFF_PEAK_NOTIFICATION_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [enabled, platform, offPeakTaskService, formatMessage]);
}
