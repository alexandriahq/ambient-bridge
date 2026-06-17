export type EncryptedInferencePayload = {
  body: string;
  headers: Record<string, string>;
};

export type TinfoilEncryptionAdapter = {
  encryptJson(payload: unknown): Promise<EncryptedInferencePayload>;
};

export class PassthroughEncryptionAdapter implements TinfoilEncryptionAdapter {
  async encryptJson(payload: unknown): Promise<EncryptedInferencePayload> {
    return {
      body: JSON.stringify(payload),
      headers: {
        "X-Ambient-Encryption": "fixture-passthrough",
      },
    };
  }
}
