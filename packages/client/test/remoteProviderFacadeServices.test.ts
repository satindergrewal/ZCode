import { Event, type IChannel, type IChannelClient } from "@zcode/rpc";
import { IModelSelectionService, IProviderSettingsService } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

describe("RemoteServiceAccess Provider Facades", () => {
  it("builds separate proxies for Provider Settings and Model Selection", () => {
    const requestedChannels: string[] = [];
    const channel: IChannel = {
      call: vi.fn(async () => undefined),
      listen: vi.fn(() => Event.None),
    };
    const client: IChannelClient = {
      getChannel: (channelName) => {
        requestedChannels.push(channelName);
        return channel;
      },
    };

    const services = new RemoteServiceAccess(client);

    expect(requestedChannels).toContain(IProviderSettingsService.channelName);
    expect(requestedChannels).toContain(IModelSelectionService.channelName);
    expect(services.providerSettingsService).toBeDefined();
    expect(services.modelSelectionService).toBeDefined();
    expect(Object.keys(services)).not.toContain("providerProvisioningTargetService");
  });
});
