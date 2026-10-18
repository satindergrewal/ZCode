import type {
  PluginUiSessionScope,
  PluginUiSessionActions,
  PluginUiSessionCommandPort,
} from "@/plugin-ui/contract.js";
import { buildPluginUiImageFileName } from "../domain/pluginUiImageBlocks.js";

/** Session actions translate to ACKs uniformly; state and send config stay with the original session entry. */
export function createPluginUiSessionActions(
  _scope: PluginUiSessionScope,
  port: PluginUiSessionCommandPort,
): PluginUiSessionActions {
  return {
    async sendFollowUp({ prompt, source, images }) {
      // S3: images upload to refs first (paste path); a failed upload sends nothing.
      const attachments = [];
      for (const [index, image] of (images ?? []).entries()) {
        attachments.push(
          await port.uploadAttachment({
            fileName: buildPluginUiImageFileName(
              source.kind === "pluginUi" ? source.pluginId : "gen-ui",
              index,
              image.mimeType,
            ),
            mime: image.mimeType,
            dataBase64: image.dataBase64,
          }),
        );
      }
      const result = await port.sendText(prompt, {
        source,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      // Fix: the normal path ACKs with undefined; never report a sent message as failed.
      if (result === "blocked" || result === "confirmationRequired")
        throw new Error("Session is not ready to accept input");
    },
  };
}
