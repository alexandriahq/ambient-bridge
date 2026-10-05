/**
 * Silent mode is the product-wide headless contract for managed deployments:
 * Ambient and Bridge run their services with no user-facing surface — no
 * windows, tray / menu-bar icon, Dock tile, notifications, overlay pill,
 * global shortcuts, or native dialogs. Background mode only skips the initial
 * window; silent mode also refuses every later reveal.
 *
 * `AMBIENT_SILENT=1` is the durable switch (machine/user environment set by
 * the deployment tool) and reaches Bridge through spawn inheritance. The arg
 * only covers the launch that carries it.
 */
export const AMBIENT_SILENT_LAUNCH_ARG = "--ambient-silent";
export const AMBIENT_SILENT_ENV = "AMBIENT_SILENT";

export function isAmbientSilentLaunch(input: {
  readonly argv: readonly string[];
  readonly env?: Record<string, string | undefined>;
}): boolean {
  if (isTruthy(input.env?.[AMBIENT_SILENT_ENV])) return true;
  return input.argv.some((arg) => (arg.split("=", 1)[0]?.trim() ?? "") === AMBIENT_SILENT_LAUNCH_ARG);
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
