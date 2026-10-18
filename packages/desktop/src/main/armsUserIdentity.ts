export interface ArmsUserIdentitySyncDeps {
  /** Device-grain id, reported directly as the ARMS user.name. */
  deviceMid: string;
  /** Writes the ARMS user config (by default wraps armsRum.setConfig("user", ...)). */
  setUser: (user: { name: string }) => void;
}

export interface ArmsUserIdentitySync {
  /** Writes deviceMid into the ARMS user.name (deduplicated). */
  refresh: () => void;
}

/**
 * Main-process ARMS RUM identity sync: device_mid is always the user.name.
 *
 * No user.id: the SDK skips and force-rewrites config.user.id to an internal random value on merge,
 * impossible to inject; user.name is not masked. And since setConfig("user", ...) replaces the whole
 * user key (no field merge), pass { name } only -- deliberately no id -- matching the
 * appARMSBootstrap.init user.name shape and avoiding churn.
 */
export function createArmsUserIdentitySync(deps: ArmsUserIdentitySyncDeps): ArmsUserIdentitySync {
  let lastWrittenName: string | null = null;

  function refresh(): void {
    if (deps.deviceMid === lastWrittenName) {
      return;
    }
    lastWrittenName = deps.deviceMid;
    deps.setUser({ name: deps.deviceMid });
  }

  return { refresh };
}
