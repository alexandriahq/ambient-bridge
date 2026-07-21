import type { JsonValue } from "../ipc-server/protocol.js";

export type AudioTranscriptionRequestOverrides = {
  readonly accept: "application/json";
  readonly body: FormData;
  readonly contentType: null;
};

export type AudioUploadMetadata = {
  readonly expectedByteLength: number;
  readonly expectedSha256: string;
};

const MAX_AUDIO_UPLOAD_BYTES = 6 * 1024 * 1024;

export function audioUploadMetadataFromPayload(value: JsonValue | undefined): AudioUploadMetadata {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
  const expectedByteLength = typeof payload.audioByteLength === "number" && Number.isSafeInteger(payload.audioByteLength)
    ? payload.audioByteLength
    : 0;
  const expectedSha256 = typeof payload.audioSha256 === "string" ? payload.audioSha256 : "";
  if (expectedByteLength <= 0 || expectedByteLength > MAX_AUDIO_UPLOAD_BYTES) {
    throw new Error(`inference.audioTranscriptions audioByteLength must be between 1 and ${MAX_AUDIO_UPLOAD_BYTES}.`);
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("inference.audioTranscriptions requires audioSha256.");
  }
  return { expectedByteLength, expectedSha256 };
}

export function audioTranscriptionRequestFromPayload(
  value: JsonValue | undefined,
  audio: Buffer,
): AudioTranscriptionRequestOverrides {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
  if (audio.byteLength === 0) {
    throw new Error("inference.audioTranscriptions requires audio bytes.");
  }

  const mediaType = mediaTypeValue(typeof payload.mediaType === "string" ? payload.mediaType : null);
  const fileName = fileNameValue(typeof payload.fileName === "string" ? payload.fileName : null);
  const model = typeof payload.model === "string" && payload.model ? payload.model : "whisper-large-v3-turbo";
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  const temperature = typeof payload.temperature === "number" ? String(payload.temperature) : "0";
  const responseFormat = typeof payload.responseFormat === "string" && payload.responseFormat ? payload.responseFormat : "json";
  const body = new FormData();
  body.set("model", model);
  if (prompt) body.set("prompt", prompt);
  body.set("response_format", responseFormat);
  body.set("temperature", temperature);
  body.set("file", new Blob([blobPartFromBuffer(audio)], { type: mediaType }), fileName);

  return {
    accept: "application/json",
    body,
    contentType: null,
  };
}

function blobPartFromBuffer(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}

function fileNameValue(value: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "audio.wav";
}

function mediaTypeValue(value: string | null): string {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9][A-Za-z0-9+.-]*\/[A-Za-z0-9][A-Za-z0-9+.-]*$/.test(trimmed)
    ? trimmed
    : "audio/wav";
}
