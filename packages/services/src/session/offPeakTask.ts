import type {
  OffPeakCodingPlanSupport,
  OffPeakTaskCreateResult,
  OffPeakTakeNumberAvailability,
  ZCodeOffPeakTask,
  ZCodeOffPeakTaskCreateParams,
  ModelSelection,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// Off-peak task management service channel (never shared with the automation surface).
// renderer connects via ProxyChannel (same pattern as codingPlanSubscription);
// polling/ticketing/settling are service-internal, never exposed to the renderer.

export interface OffPeakUpdateTaskParams {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  /** undefined = no change; Off-Peak Submission cannot clear to follow-default. */
  modelSelection?: ModelSelection | null;
}

export interface IOffPeakTaskService {
  /** Masked support snapshot of the selected provider/connection; secrets never cross renderer RPC. */
  getCodingPlanSupport(): Promise<OffPeakCodingPlanSupport>;
  /** Live server ticket quota snapshot; gates creation only, POST /ticket stays the final authority. */
  getTakeNumberAvailability(): Promise<OffPeakTakeNumberAvailability>;
  /** Ticket on create (persist only on success); failure returns a stable class, no raw error over RPC. */
  createTask(params: ZCodeOffPeakTaskCreateParams): Promise<OffPeakTaskCreateResult>;
  cancelTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  pauseTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  continueTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  deleteTask(offPeakTaskId: string): Promise<void>;
  /** Hides the local History row only; never deletes task/session/execution fields. */
  deleteHistory(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
  updateTask(
    offPeakTaskId: string,
    params: OffPeakUpdateTaskParams,
  ): Promise<ZCodeOffPeakTask | null>;
  list(): Promise<ZCodeOffPeakTask[]>;
  get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null>;
}

export const IOffPeakTaskService = createServiceDescriptor<IOffPeakTaskService>(
  ServiceChannels.OffPeakTask,
);
