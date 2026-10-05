import { LocalSecretVault as SharedLocalSecretVault } from "@ambient/shared/local-secret-vault";

export { isLocalVaultPayload } from "@ambient/shared/local-secret-vault";

export class LocalSecretVault extends SharedLocalSecretVault {
  constructor(keyFilePath: string) {
    super(keyFilePath, "legacy-read");
  }
}
