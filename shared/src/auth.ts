/**
 * Auth contracts shared between the Ambient app and Bridge renderers.
 *
 * Both apps render the same account state: Bridge owns the WorkOS session
 * (single writer) and pushes this shape to its own renderer over Electron IPC
 * and to the Ambient app over the paired Unix-socket IPC. Neither renderer
 * ever sees tokens — only this display state plus command callbacks.
 */

export type SharedAuthOrganization = {
  readonly id: string;
  readonly name: string;
};

export type SharedSignedInAccount = {
  readonly kind: "signed_in";
  readonly email: string | null;
  readonly name?: string | null;
  readonly profilePictureUrl?: string | null;
  readonly organizationId?: string | null;
  readonly organizationName?: string | null;
  readonly organizations?: readonly SharedAuthOrganization[];
};

export type SharedAuthAccount =
  | { readonly kind: "signed_out" }
  | { readonly kind: "login_pending" }
  | SharedSignedInAccount;

export function accountDisplayName(account: SharedSignedInAccount): string {
  const name = account.name?.trim();
  if (name) return name;
  const email = account.email?.trim();
  if (email) return email;
  return "Signed in";
}

export function accountInitials(account: SharedSignedInAccount): string {
  const source = account.name?.trim() || account.email?.trim() || "";
  if (!source) return "•";
  const words = source.split(/[\s._@-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? words[1]?.[0] ?? "" : "";
  const initials = `${first}${second}`.toUpperCase();
  return initials || "•";
}
