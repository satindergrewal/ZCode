import { z } from "zod";

/** Success envelope code shared by BigModel/Z.AI management and PAT issuance; token content validation stays strict. */
export const projectTokenSuccessCodeSchema = z.union([
  z.literal(200),
  z.literal(0),
  z.literal("200"),
  z.literal("0"),
]);
