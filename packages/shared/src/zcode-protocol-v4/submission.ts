import { z } from "zod";

/** Agent modes the Composer may submit explicitly; auto is internal runtime state and never enters a user Submission. */
export const submissionModeSchema = z.enum(["build", "edit", "plan", "yolo", "guarded"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
