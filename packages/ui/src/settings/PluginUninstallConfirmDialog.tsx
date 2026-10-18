import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// Uninstall is a destructive purge (cache + data dir + config leftovers); every entry shares this confirm,
// one copy and behavior, so Installed and Marketplace never fork.
export function PluginUninstallConfirmDialog({
  open,
  pluginName,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  pluginName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="plugin-store-uninstall-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage(
              { id: "settings.plugins.uninstall.confirmTitle" },
              { name: pluginName },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.plugins.uninstall.confirmDescription" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            type="button"
            size="sm"
            data-testid="plugin-store-uninstall-cancel"
            disabled={pending}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            data-testid="plugin-store-uninstall-confirm"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={(event) => {
              // Prevent Radix's default close-on-action; uninstall is async, the parent collapses on result.
              event.preventDefault();
              onConfirm();
            }}
          >
            {intl.formatMessage({ id: "settings.plugins.uninstall.confirm" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
