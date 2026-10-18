import { generateText as aiGenerateText, streamText as aiStreamText } from "ai";
import type {
  ModelProperties,
  ModelRequestAuth,
  ModelTextRequest,
  TraceContext,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { AiSdkResolvedModel } from "./model-execution.js";

export type AiSdkGenerateTextOptions = Parameters<typeof aiGenerateText>[0];
export type AiSdkGenerateTextResult = Awaited<ReturnType<typeof aiGenerateText>>;
export type AiSdkStreamTextOptions = Parameters<typeof aiStreamText>[0];
export type AiSdkStreamTextResult = ReturnType<typeof aiStreamText>;
export type ResolvedAiSdkModel = AiSdkResolvedModel & {
  properties: ModelProperties;
  accountAccess?: ZCodeProviderAccountAccess;
};

export interface AiSdkModelRuntime {
  generateText(options: AiSdkGenerateTextOptions): Promise<AiSdkGenerateTextResult>;
  streamText(options: AiSdkStreamTextOptions): AiSdkStreamTextResult;
}

export interface AiSdkModelTextRequest extends ModelTextRequest {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  // Start Plan account credentials refresh per attempt; adapter-internal retries are real model requests and
  // must offer core/host a refresh chance before each send.
  refreshRuntimeHeadersBeforeAttempt?: (input: {
    accountAccess?: ZCodeProviderAccountAccess;
    attempt: number;
    reason?: "model-request";
    abortSignal?: AbortSignal;
    providerId: string;
    modelId: string;
    traceContext?: TraceContext;
  }) => Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
  // Adapter tests and dev run from source; catch the SSE idle-timeout sequence core recovery forwards.
  streamIdleTimeoutRetryNumber?: number;
  // The same from-source boundary must also catch the compact-only provider stream field,
  // or adapter typecheck loses that runtime-only field before dist refreshes.
  preserveProviderStreamBoundaries?: boolean;
}

export const defaultRuntime: AiSdkModelRuntime = {
  generateText: aiGenerateText,
  streamText: aiStreamText,
};
