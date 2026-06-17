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
  const body = Buffer.concat([bodyHeader, binaryHeader, frame.bytes]);
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): BridgeFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
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
      frames.push(parseWireFrame(body));
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
  return parsed as Exclude<BridgeFrame, BridgeBinaryFrame>;
}
