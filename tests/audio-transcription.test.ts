import { describe, expect, it } from "vitest";
import { audioTranscriptionRequestFromPayload } from "../electron/inference/audio-transcription.js";

describe("Bridge audio transcription request", () => {
  it("builds a multipart request body with file and model fields", async () => {
    const request = audioTranscriptionRequestFromPayload({
      fileName: "sample.wav",
      mediaType: "audio/wav",
      model: "voxtral-small-24b",
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
    expect(form.get("model")).toBe("voxtral-small-24b");
    expect(form.get("prompt")).toBe("Transcribe only clearly audible speech.");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("temperature")).toBe("0");
  });

  it("rejects payloads without audio bytes", () => {
    expect(() => audioTranscriptionRequestFromPayload({ model: "voxtral-small-24b" }, Buffer.alloc(0))).toThrow(
      "inference.audioTranscriptions requires audio bytes.",
    );
  });
});
