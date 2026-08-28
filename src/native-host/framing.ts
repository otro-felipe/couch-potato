export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export type NativeMessageFramingErrorCode =
  | "INVALID_JSON"
  | "INVALID_LENGTH"
  | "MESSAGE_TOO_LARGE"
  | "TRUNCATED_MESSAGE"
  | "DECODER_FAILED";

export class NativeMessageFramingError extends Error {
  readonly code: NativeMessageFramingErrorCode;

  constructor(code: NativeMessageFramingErrorCode) {
    super("Native message framing failed");
    this.name = "NativeMessageFramingError";
    this.code = code;
  }
}

const framingFailure = (
  code: NativeMessageFramingErrorCode,
): NativeMessageFramingError => new NativeMessageFramingError(code);

export const encodeNativeMessage = (value: unknown): Buffer => {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw framingFailure("INVALID_JSON");
  }
  if (json === undefined) throw framingFailure("INVALID_JSON");
  const payload = Buffer.from(json, "utf8");
  if (payload.byteLength > MAX_NATIVE_MESSAGE_BYTES)
    throw framingFailure("MESSAGE_TOO_LARGE");
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
};

export class NativeMessageDecoder {
  #buffer = Buffer.alloc(0);
  #expectedLength: number | undefined;
  #failed = false;

  push(chunk: Uint8Array): unknown[] {
    if (this.#failed) throw framingFailure("DECODER_FAILED");
    if (chunk.byteLength > 0)
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);

    const messages: unknown[] = [];
    try {
      while (true) {
        if (this.#expectedLength === undefined) {
          if (this.#buffer.byteLength < 4) break;
          const length = this.#buffer.readUInt32LE(0);
          this.#buffer = this.#buffer.subarray(4);
          if (length === 0) throw framingFailure("INVALID_LENGTH");
          if (length > MAX_NATIVE_MESSAGE_BYTES)
            throw framingFailure("MESSAGE_TOO_LARGE");
          this.#expectedLength = length;
        }

        if (this.#buffer.byteLength < this.#expectedLength) break;
        const payload = this.#buffer.subarray(0, this.#expectedLength);
        this.#buffer = this.#buffer.subarray(this.#expectedLength);
        this.#expectedLength = undefined;
        try {
          messages.push(JSON.parse(payload.toString("utf8")) as unknown);
        } catch {
          throw framingFailure("INVALID_JSON");
        }
      }
    } catch (error) {
      this.#failed = true;
      this.#buffer = Buffer.alloc(0);
      this.#expectedLength = undefined;
      throw error;
    }
    return messages;
  }

  finish(): void {
    if (this.#failed) throw framingFailure("DECODER_FAILED");
    if (this.#buffer.byteLength > 0 || this.#expectedLength !== undefined) {
      this.#failed = true;
      this.#buffer = Buffer.alloc(0);
      this.#expectedLength = undefined;
      throw framingFailure("TRUNCATED_MESSAGE");
    }
  }
}
