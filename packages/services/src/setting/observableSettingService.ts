import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "./setting.js";

interface SettingServiceUpdatedEvent {
  readonly keys: readonly (keyof AppSettings)[];
}

interface ObservableSettingService extends ISettingService {
  onDidUpdate(listener: (event: SettingServiceUpdatedEvent) => void): () => void;
}

/**
 * Adds post-commit notifications to the host settings service without growing the Setting RPC contract.
 * A failed underlying update publishes nothing.
 */
export function createObservableSettingService(base: ISettingService): ObservableSettingService {
  const listeners = new Set<(event: SettingServiceUpdatedEvent) => void>();
  return {
    ...base,
    onDidUpdate(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async update(patch, expectedAccountSettings): Promise<void> {
      if (expectedAccountSettings) await base.update(patch, expectedAccountSettings);
      else await base.update(patch);
      const keys = Object.freeze(Object.keys(patch) as (keyof AppSettings)[]);
      if (keys.length === 0) return;
      const event = Object.freeze({ keys });
      for (const listener of listeners) listener(event);
    },
  };
}
