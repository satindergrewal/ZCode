import {
  zcodeProtocolMethods,
  zcodePluginsReferenceCatalogResultSchema,
  type ZCodePluginsReferenceCatalogParams,
} from "@zcode/shared";
import type { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";

/** Legacy protocol validates strictly; new fields use a separate call, only -32601 proves absence. */
export async function requestPluginReferenceCatalog(
  client: Pick<ZCodeProtocolClient, "request">,
  params: ZCodePluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      zcodeProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      zcodePluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      zcodeProtocolMethods.pluginsReferenceCatalog,
      params,
      zcodePluginsReferenceCatalogResultSchema,
    );
  }
}
