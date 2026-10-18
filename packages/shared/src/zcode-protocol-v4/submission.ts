import { z } from "zod";

/** Agent modes the composer may submit explicitly; auto is Runtime-internal state, never a user Submission. */
export const submissionModeSchema = z.enum(["build", "edit", "plan", "yolo"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
