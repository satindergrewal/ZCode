import { z } from "zod";

const sharedContextImportV2StateSchema = z
  .object({
    contextId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    shareUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === "https:" || url.protocol === "http:") &&
            url.search === "" &&
            url.hash === "" &&
            /^\/cn\/share\/[^/]+$/u.test(url.pathname)
          );
        } catch {
          return false;
        }
      }, "shareUrl must use the canonical /cn/share/<code> path"),
    status: z.enum(["pending", "reserved", "attached", "discarded"]),
  })
  .strict();
// shareUrl is hard-bound to /cn/share/<code>. A future domain change, or taking the English /share/<code> as
// canonical, would fail persisted provenance validation of existing sessions (local persistence, not wire, hence outside
// the "responses are lenient" discipline). Whenever the canonical URL shape changes, add a legacy branch accepting the old
// shape first--per legacySharedContextImportStateSchema's precedent.

const legacySharedContextImportStateSchema = z.object({ title: z.string().trim().min(1) }).strict();

export const sharedContextImportStateSchema = z.union([
  sharedContextImportV2StateSchema,
  legacySharedContextImportStateSchema,
]);

export type SharedContextImportState = z.infer<typeof sharedContextImportStateSchema>;
