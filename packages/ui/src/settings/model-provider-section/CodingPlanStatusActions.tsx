import { CodingPlanEntryButton } from "@/settings/CodingPlanEntryButton.js";
import type { CodingPlanBillingDiscountConfig } from "@zcode/shared";
import { ArrowLeftIcon, Loader2Icon, RocketIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  CodingPlanBillingDiscountBadgePill,
  CodingPlanBillingDiscountInfoDialog,
} from "@/CodingPlanBillingDiscount.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanLoginOptions } from "./codingPlanPricingCards.js";

export function CodingPlanStatusActions({
  providerName,
  isDisconnected,
  isUnavailable,
  isPurchased,
  loginLoading,
  loginButtonId,
  loginVisible,
  canDisconnectProvider,
  disconnectLoading,
  onLogin,
  onDisconnect,
}: {
  providerName: string;
  isDisconnected: boolean;
  isUnavailable: boolean;
  isPurchased: boolean;
  loginLoading?: boolean;
  loginButtonId: string;
  loginVisible: boolean;
  canDisconnectProvider: boolean;
  disconnectLoading?: boolean;
  onLogin?: (options?: CodingPlanLoginOptions) => void;
  onDisconnect?: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex shrink-0 flex-wrap justify-start gap-2">
      {loginVisible && (isDisconnected || isUnavailable) && onLogin ? (
        <Button type="button" size="lg" onClick={() => onLogin()} disabled={loginLoading}>
          {loginLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({ id: loginButtonId }, { provider: providerName })}
        </Button>
      ) : null}
      {canDisconnectProvider && onDisconnect && !isPurchased ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disconnectLoading}
          onClick={onDisconnect}
        >
          {disconnectLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({
            id: "settings.modelProvider.codingPlan.disconnect",
          })}
        </Button>
      ) : null}
    </div>
  );
}

export function CodingPlanUpgradeAction({
  loginLoading,
  upgradePlansVisible,
  actionLabelId = "settings.modelProvider.codingPlan.upgrade",
  billingDiscountActive,
  billingDiscountConfig,
  onUpgradePlansVisibleChange,
}: {
  loginLoading?: boolean;
  upgradePlansVisible: boolean;
  actionLabelId?: string;
  billingDiscountActive?: boolean;
  billingDiscountConfig?: CodingPlanBillingDiscountConfig;
  onUpgradePlansVisibleChange: (visible: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const billingDiscountButtonActive = billingDiscountActive === true && !upgradePlansVisible;

  const upgradeButton = (
    <CodingPlanEntryButton
      bypassGate={upgradePlansVisible}
      type="button"
      size="lg"
      className={cn(
        billingDiscountButtonActive &&
          "button-gradient dark:bg-[#484A58] text-white hover:bg-transparent hover:opacity-90 dark:hover:bg-[#484A58] pr-[5px] rounded-full",
      )}
      onClick={() => {
        // Purchase/upgrade must open the panel first; OAuth recovery is handled by the panel after the user
        // picks plan/cycle, so Upgrade never jumps straight to login and hides the purchase flow.
        onUpgradePlansVisibleChange(!upgradePlansVisible);
      }}
      disabled={loginLoading}
    >
      {loginLoading ? (
        // Upgrade may trigger an OAuth business-token refresh first.
        // While waiting there is only disabled, no spinner; it reads as a dead click.
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : upgradePlansVisible ? (
        <ArrowLeftIcon className="size-3.5" />
      ) : (
        <RocketIcon className="size-3.5" />
      )}
      {intl.formatMessage({
        id: upgradePlansVisible ? "settings.modelProvider.codingPlan.cancelUpgrade" : actionLabelId,
      })}
      {billingDiscountButtonActive ? (
        <CodingPlanBillingDiscountBadgePill
          config={billingDiscountConfig}
          iconVisible={false}
          variant="surface"
        />
      ) : null}
    </CodingPlanEntryButton>
  );

  if (!billingDiscountButtonActive) {
    return upgradeButton;
  }

  return (
    <div className="inline-flex shrink-0 items-center gap-1">
      {upgradeButton}
      <CodingPlanBillingDiscountInfoDialog config={billingDiscountConfig} />
    </div>
  );
}
