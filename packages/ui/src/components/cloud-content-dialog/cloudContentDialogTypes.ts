import type { CloudContentPayload } from "@zcode/shared";

type WireHero = CloudContentPayload["dialog"]["hero"];
export type CloudImageHero = Extract<WireHero, { type: "image" }>;
export type CloudVideoHero = Extract<WireHero, { type: "video" }>;
export type CloudLottieHero = Extract<WireHero, { type: "lottie" }>;
type WireBundleHero = Extract<WireHero, { type: "interactive_bundle" }>;
/** Only the host sets resolvedUrl; app-bundled trusted assets never masquerade as a cloud ZIP. */
export type CloudInteractiveBundleHero = Omit<WireBundleHero, "bundle"> &
  (
    | { bundle: WireBundleHero["bundle"]; resolvedUrl?: string }
    | { bundle?: never; resolvedUrl: string }
  );

export type CloudDialogHero =
  | CloudImageHero
  | CloudVideoHero
  | CloudLottieHero
  | CloudInteractiveBundleHero;

export type CloudFormattedText = CloudContentPayload["dialog"]["description"];
export type CloudDialogButton = CloudContentPayload["dialog"]["buttons"][number] & {
  formattedLabel?: CloudFormattedText;
};
export type CloudContentAction = CloudContentPayload["actions"][string];
export type CloudContentDialogPayload = Omit<CloudContentPayload, "dialog"> & {
  dialog: Omit<CloudContentPayload["dialog"], "hero" | "buttons"> & {
    hero: CloudDialogHero | null;
    formattedTitle?: CloudFormattedText;
    buttons: CloudDialogButton[];
  };
};

export interface CloudHeroHostInitMessage {
  channel: "zcode-cloud-hero-v1";
  type: "init";
  instanceId: string;
  theme: "light" | "dark";
  locale: string;
  reducedMotion: boolean;
  data: Record<string, unknown>;
}

export type CloudHeroHostMessage =
  | CloudHeroHostInitMessage
  | {
      channel: "zcode-cloud-hero-v1";
      type: "hover";
      instanceId: string;
      hovered: boolean;
    }
  | {
      channel: "zcode-cloud-hero-v1";
      type: "theme";
      instanceId: string;
      theme: "light" | "dark";
    }
  | {
      channel: "zcode-cloud-hero-v1";
      type: "visibility";
      instanceId: string;
      visible: boolean;
    }
  | {
      channel: "zcode-cloud-hero-v1";
      type: "destroy";
      instanceId: string;
    };

export type CloudHeroResourceMessage =
  | {
      channel: "zcode-cloud-hero-v1";
      type: "ready";
      instanceId: string;
    }
  | {
      channel: "zcode-cloud-hero-v1";
      type: "action";
      instanceId: string;
      id: string;
    }
  | {
      channel: "zcode-cloud-hero-v1";
      type: "resize";
      instanceId: string;
      height: number;
    }
  | {
      channel: "zcode-cloud-hero-v1";
      type: "error";
      instanceId: string;
      code: string;
    };
