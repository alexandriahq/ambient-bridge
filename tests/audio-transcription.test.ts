import { describe, expect, it } from "vitest";
import { audioTranscriptionRequestFromPayload } from "../electron/inference/audio-transcription.js";

describe("Bridge audio transcription request", () => {
  it("builds a multipart request body with file and model fields", async () => {
    const request = audioTranscriptionRequestFromPayload({
      fileName: "sample.wav",
      mediaType: "audio/wav",
      model: "whisper-large-v3-turbo",
      prompt: "Transcribe only clearly audible speech.",
      responseFormat: "json",
      temperature: 0,
    }, Buffer.from("test audio bytes"));

    expect(request.accept).toBe("application/json");
    expect(request.contentType).toBeNull();
    expect(request.body).toBeInstanceOf(FormData);

    const serialized = new Request("https://ambient.local/audio-transcription", {
      body: request.body,
      method: "POST",
    });
    expect(serialized.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);

    const form = await serialized.formData();
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect(file).toMatchObject({ name: "sample.wav", type: "audio/wav" });
    expect(file instanceof File ? await file.text() : "").toBe("test audio bytes");
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("prompt")).toBe("Transcribe only clearly audible speech.");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("temperature")).toBe("0");
  });

  it("forwards the app's verbose_json response format unchanged", async () => {
    // The app asks for verbose_json to get per-segment Whisper confidences;
    // Bridge must pass it through so the executor can preserve it upstream.
    const request = audioTranscriptionRequestFromPayload({
      fileName: "audio.wav",
      mediaType: "audio/wav",
      model: "whisper-large-v3-turbo",
      responseFormat: "verbose_json",
      temperature: 0,
    }, Buffer.from("RIFF audio bytes"));
    const serialized = new Request("https://ambient.local/audio-transcription", {
      body: request.body,
      method: "POST",
    });
    const form = await serialized.formData();
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
  });

  it("forwards the app's language hint and drops anything that is not an ISO 639 code", async () => {
    const form = async (language: unknown) => new Request("https://ambient.local/audio-transcription", {
      body: audioTranscriptionRequestFromPayload({ fileName: "audio.wav", mediaType: "audio/wav", language } as never, Buffer.from("RIFF audio bytes")).body,
      method: "POST",
    }).formData();
    expect((await form("de")).get("language")).toBe("de");
    expect((await form("de-DE")).get("language")).toBeNull();
    expect((await form(undefined)).get("language")).toBeNull();
  });

  it("defaults to the production Whisper transcription model", async () => {
    const request = audioTranscriptionRequestFromPayload({}, Buffer.from("test audio bytes"));
    const serialized = new Request("https://ambient.local/audio-transcription", {
      body: request.body,
      method: "POST",
    });

    const form = await serialized.formData();
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
  });

  it.each([
    ["pooled offset", () => Buffer.from([91, 0, 255, 3, 17, 92]).subarray(1, 5)],
    ["ArrayBuffer offset", () => Buffer.from(new Uint8Array([91, 0, 255, 3, 17, 92]).buffer, 1, 4)],
    ["shared offset", () => {
      const backing = new SharedArrayBuffer(6);
      new Uint8Array(backing).set([91, 0, 255, 3, 17, 92]);
      return Buffer.from(backing, 1, 4);
    }],
    ["maximum upload", () => {
      const bytes = Buffer.alloc(6 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
      return bytes;
    }],
  ] as const)("preserves %s bytes after the caller mutates the source", async (_name, makeAudio) => {
    const audio = makeAudio();
    const expected = Buffer.from(audio);
    const request = audioTranscriptionRequestFromPayload({
      fileName: " offset.wav ", mediaType: "audio/wav", model: "test-model",
    }, audio);
    audio.fill(123);

    const serialized = new Request("https://ambient.local/audio-transcription", {
      body: request.body, method: "POST",
    });
    const form = await serialized.formData();
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error("Multipart file missing");
    expect(file.name).toBe("offset.wav");
    expect(file.type).toBe("audio/wav");
    expect(file.size).toBe(expected.byteLength);
    expect(Buffer.from(await file.arrayBuffer()).equals(expected)).toBe(true);
    expect(form.get("model")).toBe("test-model");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("temperature")).toBe("0");
    expect(form.has("prompt")).toBe(false);
  });

  it("rejects payloads without audio bytes", () => {
    expect(() => audioTranscriptionRequestFromPayload({ model: "whisper-large-v3-turbo" }, Buffer.alloc(0))).toThrow(
      "inference.audioTranscriptions requires audio bytes.",
    );
  });
});
