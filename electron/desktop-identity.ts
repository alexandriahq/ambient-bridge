export interface BridgeDesktopIdentity {
  readonly appId:
    | "com.alexandria.ambient.bridge"
    | "com.alexandria.ambient.bridge.local"
    | "com.alexandria.ambient.bridge.dev";
  readonly appName: "Ambient Bridge" | "Ambient Bridge Local" | "Ambient Bridge Dev";
}

/**
 * Packaged product metadata is the final authority for desktop identity.
 *
 * Local and standard installers can be built concurrently. Their generated
 * build-config module is shared source, so another build can replace the
 * generated app name between generation and TypeScript compilation. The
 * electron-builder product name is isolated per packaged artifact and cannot
 * participate in that race.
 *
 * Unpackaged source runs must never claim the bare production AppUserModelID:
 * the process is still electron.exe, and sharing production AUMID registers
 * Start Menu as "Electron" (#520). Use `.dev` for source, `.local` for the
 * packaged Local QA installer, and the bare id only for prod/experimental.
 */
export function resolveBridgeDesktopIdentity(options: {
  readonly buildAppId: BridgeDesktopIdentity["appId"];
  readonly buildAppName: BridgeDesktopIdentity["appName"];
  readonly packaged: boolean;
  readonly packagedAppName: string;
}): BridgeDesktopIdentity {
  if (options.packaged) {
    if (options.packagedAppName === "Ambient Bridge Local") {
      return {
        appId: "com.alexandria.ambient.bridge.local",
        appName: "Ambient Bridge Local",
      };
    }
    if (options.packagedAppName === "Ambient Bridge") {
      return {
        appId: "com.alexandria.ambient.bridge",
        appName: "Ambient Bridge",
      };
    }
  }

  if (
    options.buildAppId === "com.alexandria.ambient.bridge.local"
    || options.buildAppName === "Ambient Bridge Local"
  ) {
    return {
      appId: "com.alexandria.ambient.bridge.local",
      appName: "Ambient Bridge Local",
    };
  }

  if (!options.packaged) {
    return {
      appId: "com.alexandria.ambient.bridge.dev",
      appName: "Ambient Bridge Dev",
    };
  }

  return {
    appId: options.buildAppId,
    appName: options.buildAppName,
  };
}
