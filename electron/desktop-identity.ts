export interface BridgeDesktopIdentity {
  readonly appId: "com.alexandria.ambient.bridge" | "com.alexandria.ambient.bridge.local";
  readonly appName: "Ambient Bridge" | "Ambient Bridge Local";
}

/**
 * Packaged product metadata is the final authority for desktop identity.
 *
 * Local and standard installers can be built concurrently. Their generated
 * build-config module is shared source, so another build can replace the
 * generated app name between generation and TypeScript compilation. The
 * electron-builder product name is isolated per packaged artifact and cannot
 * participate in that race.
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
  return {
    appId: options.buildAppId,
    appName: options.buildAppName,
  };
}
