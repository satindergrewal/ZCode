import { z } from "zod";

/**
 * The single source of truth for ZCode agent providers.
 *
 * The ZCodeProvider type and runtime zcodeProviderSchema both derive here,
 * so inline z.enum([...]) copies cannot drift as providers come and go.
 * Depends only on zod (a leaf), importable by validation / zcode-protocol without cycles.
 */
const ZCODE_PROVIDERS = ["glm"] as const;

export const zcodeProviderSchema = z.enum(ZCODE_PROVIDERS);

export type ZCodeProvider = (typeof ZCODE_PROVIDERS)[number];
