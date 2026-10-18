import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ClientSceneResponseBody<T> {
  code: number;
  msg: string;
  data: T;
}

export interface ClientSceneConfig {
  namespace: string;
  scene: string;
  options: Record<string, ClientSceneOption>;
  created_at?: number;
  updated_at?: number;
}

export interface ClientSceneOption {
  id: string;
  type: string;
  /** Option title i18n. */
  contents: Record<string, string>;
  /** Prompt i18n. */
  prompts?: Record<string, string>;
  /** Options shown when no filter applies. */
  items?: ClientSceneItem[];
  /** Which option.type filters this. */
  refer?: string;
  /** Map from other options' itemIds to filtered options. */
  cascades?: Record<string, ClientSceneItem[]>;
  /** Prompt template i18n. */
  templates?: Record<string, string>;
}

export interface ClientSceneItem {
  id: string;
  type: string;
  /** Option title i18n. */
  contents: Record<string, string>;
  /** Option description i18n. */
  descs?: Record<string, string>;
  /** Option label i18n. */
  labels: Record<string, string>;
  /// Event triggered after the conversation completes.
  on_finish?: string | null;
  /** Lucide canonical icon name (kebab-case). */
  img?: string | null;
  /** Compatibility field; unused by the current home/Automations icons. */
  imgs?: {
    cn?: string;
    en?: string;
  };
  share_urls?: Record<string, string>;
  defaults?: Record<string, string[]>;
}

export type ClientScenesResponse = ClientSceneResponseBody<ClientSceneConfig[]>;

export interface IClientScenesService {
  list(): Promise<ClientScenesResponse>;
}

export const IClientScenesService = createServiceDescriptor<IClientScenesService>(
  ServiceChannels.ClientScenes,
);
