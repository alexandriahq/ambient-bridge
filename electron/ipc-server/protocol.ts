export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type BridgeFrame =
  | BridgeRequestFrame
  | BridgeResponseFrame
  | BridgeStreamFrame
  | BridgeErrorFrame
  | BridgeCancelFrame
  | BridgeBinaryFrame;

export type BridgeRequestFrame = {
  type: "request";
  id: string;
  method: string;
  payload?: JsonValue;
  auth?: BridgeRequestAuth;
  /** W3C trace context. Correlation only; never included in request signing. */
  traceparent?: string;
};

export type BridgeResponseFrame = {
  type: "response";
  id: string;
  payload?: JsonValue;
};

export type BridgeStreamFrame = {
  type: "stream";
  id: string;
  event: "start" | "delta" | "end";
  payload?: JsonValue;
};

export type BridgeErrorFrame = {
  type: "error";
  id: string;
  code: string;
  message: string;
};

export type BridgeCancelFrame = {
  type: "cancel";
  id: string;
  auth?: BridgeRequestAuth;
};

export type BridgeBinaryFrame = {
  type: "binary";
  id: string;
  event: "chunk" | "end";
  seq: number;
  bytes: Buffer;
};

export type BridgeRequestAuth = {
  credentialId: string;
  timestamp: number;
  nonce: string;
  bodyHash: string;
  signature: string;
};

const HEADER_BYTES = 4;
const EMPTY_BUFFER = Buffer.alloc(0);
const BINARY_FRAME_MAGIC = Buffer.from("AMBBIN1\n", "ascii");
const BINARY_HEADER_BYTES = BINARY_FRAME_MAGIC.length + 4;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function encodeFrame(frame: Exclude<BridgeFrame, BridgeBinaryFrame>): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function encodeBinaryFrame(frame: BridgeBinaryFrame): Buffer {
  const binaryHeader = Buffer.from(JSON.stringify({
    event: frame.event,
    id: frame.id,
    seq: frame.seq,
    type: frame.type,
  }), "utf8");
  const bodyHeader = Buffer.allocUnsafe(BINARY_HEADER_BYTES);
  BINARY_FRAME_MAGIC.copy(bodyHeader, 0);
  bodyHeader.writeUInt32BE(binaryHeader.byteLength, BINARY_FRAME_MAGIC.length);
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(bodyHeader.length + binaryHeader.length + frame.bytes.length, 0);
  return Buffer.concat([header, bodyHeader, binaryHeader, frame.bytes]);
}

export class FrameDecoder {
  private buffer = EMPTY_BUFFER;
  private storage = this.buffer;
  private shared = false;

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): BridgeFrame[] {
    const pendingLength = this.buffer.length;
    const length = pendingLength + chunk.length;
    // Grow geometrically: fragmented uploads should copy each byte a bounded
    // number of times. Binary results own their backing buffer, so detach it
    // before the next append can compact or overwrite retained frame bytes.
    const consumedPrefix = this.buffer.byteOffset !== this.storage.byteOffset;
    const releaseExcess = consumedPrefix && this.storage.length > length * 4;
    if (this.shared || releaseExcess || this.storage.length < length) {
      const capacity = this.shared || releaseExcess
        ? length
        : Math.max(length, this.storage.length * 2);
      const storage = Buffer.allocUnsafe(capacity);
      this.buffer.copy(storage);
      this.storage = storage;
    } else if (pendingLength > 0 && consumedPrefix) {
      this.buffer.copy(this.storage);
    }
    chunk.copy(this.storage, pendingLength);
    this.buffer = this.storage.length === length ? this.storage : this.storage.subarray(0, length);
    this.shared = false;
    const frames: BridgeFrame[] = [];

    while (this.buffer.length >= HEADER_BYTES) {
      const frameLength = this.buffer.readUInt32BE(0);
      if (frameLength > this.maxFrameBytes) {
        throw new Error(`IPC frame exceeds ${this.maxFrameBytes} bytes`);
      }

      const totalLength = HEADER_BYTES + frameLength;
      if (this.buffer.length < totalLength) {
        break;
      }

      const body = this.buffer.subarray(HEADER_BYTES, totalLength);
      this.buffer = this.buffer.subarray(totalLength);
      const frame = parseWireFrame(body);
      if (frame.type === "binary") this.shared = true;
      frames.push(frame);
    }

    if (this.buffer.length === 0) {
      this.storage = this.buffer = EMPTY_BUFFER;
      this.shared = false;
    }
    return frames;
  }
}

function parseWireFrame(body: Buffer): BridgeFrame {
  if (body.subarray(0, BINARY_FRAME_MAGIC.length).equals(BINARY_FRAME_MAGIC)) {
    return parseBinaryFrame(body);
  }
  return parseFrame(body);
}

function parseBinaryFrame(body: Buffer): BridgeBinaryFrame {
  if (body.byteLength < BINARY_HEADER_BYTES) {
    throw new Error("Invalid binary IPC frame");
  }
  const headerLength = body.readUInt32BE(BINARY_FRAME_MAGIC.length);
  const headerStart = BINARY_HEADER_BYTES;
  const headerEnd = headerStart + headerLength;
  if (headerLength <= 0 || headerEnd > body.byteLength) {
    throw new Error("Invalid binary IPC frame header");
  }
  const parsed = JSON.parse(body.subarray(headerStart, headerEnd).toString("utf8")) as BridgeBinaryFrame;
  if (
    !parsed
    || typeof parsed !== "object"
    || parsed.type !== "binary"
    || typeof parsed.id !== "string"
    || (parsed.event !== "chunk" && parsed.event !== "end")
    || typeof parsed.seq !== "number"
    || !Number.isSafeInteger(parsed.seq)
    || parsed.seq < 0
  ) {
    throw new Error("Invalid binary IPC frame header");
  }
  return {
    bytes: body.subarray(headerEnd),
    event: parsed.event,
    id: parsed.id,
    seq: parsed.seq,
    type: "binary",
  };
}

function parseFrame(body: Buffer): Exclude<BridgeFrame, BridgeBinaryFrame> {
  const parsed = JSON.parse(body.toString("utf8")) as BridgeFrame;
  if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
    throw new Error("Invalid IPC frame");
  }
  if (parsed.type === "binary") {
    throw new Error("Binary IPC frames must use binary framing");
  }
  if (!isValidFrame(parsed)) {
    throw new Error("Invalid IPC frame");
  }
  return parsed;
}

function isValidFrame(frame: BridgeFrame): frame is Exclude<BridgeFrame, BridgeBinaryFrame> {
  switch (frame.type) {
    case "request":
      return typeof frame.id === "string"
        && frame.id.length > 0
        && typeof frame.method === "string"
        && frame.method.length > 0
        && optionalJsonValue(frame.payload)
        && optionalAuth(frame.auth)
        && optionalTraceparent(frame.traceparent);
    case "response":
      return typeof frame.id === "string"
        && frame.id.length > 0
        && optionalJsonValue(frame.payload);
    case "stream":
      return typeof frame.id === "string"
        && frame.id.length > 0
        && (frame.event === "start" || frame.event === "delta" || frame.event === "end")
        && optionalJsonValue(frame.payload);
    case "error":
      return typeof frame.id === "string"
        && frame.id.length > 0
        && typeof frame.code === "string"
        && frame.code.length > 0
        && typeof frame.message === "string";
    case "cancel":
      return typeof frame.id === "string"
        && frame.id.length > 0
        && optionalAuth(frame.auth);
    case "binary":
      return false;
    default:
      return false;
  }
}

function optionalTraceparent(value: string | undefined): boolean {
  return value === undefined || (
    /^00-[a-f0-9]{32}-[a-f0-9]{16}-(00|01)$/.test(value)
    && !/^00-0{32}-/.test(value)
    && !/-0{16}-(00|01)$/.test(value)
  );
}

function optionalAuth(auth: BridgeRequestAuth | undefined): boolean {
  return auth === undefined || (
    typeof auth === "object"
    && auth !== null
    && typeof auth.credentialId === "string"
    && typeof auth.timestamp === "number"
    && Number.isFinite(auth.timestamp)
    && typeof auth.nonce === "string"
    && typeof auth.bodyHash === "string"
    && typeof auth.signature === "string"
  );
}

function optionalJsonValue(value: JsonValue | undefined): boolean {
  return value === undefined || isJsonValue(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth > 64) return false;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
}
