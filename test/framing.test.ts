import { describe, expect, it } from "vitest";

import {
  MAX_NATIVE_MESSAGE_BYTES,
  NativeMessageDecoder,
  NativeMessageFramingError,
  encodeNativeMessage,
} from "../src/native-host/framing.js";

describe("Chrome Native Messaging framing", () => {
  it("encodes a JSON value behind a four-byte little-endian length", () => {
    const encoded = encodeNativeMessage({ protocol: "1", id: "one" });

    expect(encoded.readUInt32LE(0)).toBe(encoded.byteLength - 4);
    expect(JSON.parse(encoded.subarray(4).toString("utf8"))).toEqual({ protocol: "1", id: "one" });
  });

  it("decodes fragmented headers and payloads incrementally", () => {
    const frame = encodeNativeMessage({ message: "áéí" });
    const decoder = new NativeMessageDecoder();

    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2, 7))).toEqual([]);
    expect(decoder.push(frame.subarray(7))).toEqual([{ message: "áéí" }]);
    expect(decoder.finish()).toBeUndefined();
  });

  it("decodes several frames from one chunk and accepts empty chunks", () => {
    const frames = Buffer.concat([encodeNativeMessage(null), encodeNativeMessage([1, 2, 3])]);
    const decoder = new NativeMessageDecoder();

    expect(decoder.push(new Uint8Array())).toEqual([]);
    expect(decoder.push(frames)).toEqual([null, [1, 2, 3]]);
    expect(decoder.finish()).toBeUndefined();
  });

  it("rejects values that cannot be encoded as JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => encodeNativeMessage(undefined)).toThrowError(
      expect.objectContaining({ code: "INVALID_JSON" }),
    );
    expect(() => encodeNativeMessage(cyclic)).toThrowError(
      expect.objectContaining({ code: "INVALID_JSON" }),
    );
  });

  it("enforces the one MiB payload limit while encoding", () => {
    expect(() => encodeNativeMessage("x".repeat(MAX_NATIVE_MESSAGE_BYTES))).toThrowError(
      expect.objectContaining({ code: "MESSAGE_TOO_LARGE" }),
    );
  });

  it("rejects zero and oversized declared lengths before reading payloads", () => {
    const zero = Buffer.alloc(4);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1);

    expect(() => new NativeMessageDecoder().push(zero)).toThrowError(
      expect.objectContaining({ code: "INVALID_LENGTH" }),
    );
    expect(() => new NativeMessageDecoder().push(oversized)).toThrowError(
      expect.objectContaining({ code: "MESSAGE_TOO_LARGE" }),
    );
  });

  it("rejects malformed JSON and permanently closes that decoder", () => {
    const invalidPayload = Buffer.from("not-json");
    const frame = Buffer.alloc(4 + invalidPayload.byteLength);
    frame.writeUInt32LE(invalidPayload.byteLength, 0);
    invalidPayload.copy(frame, 4);
    const decoder = new NativeMessageDecoder();

    expect(() => decoder.push(frame)).toThrowError(expect.objectContaining({ code: "INVALID_JSON" }));
    expect(() => decoder.push(encodeNativeMessage(null))).toThrowError(
      expect.objectContaining({ code: "DECODER_FAILED" }),
    );
    expect(() => decoder.finish()).toThrowError(expect.objectContaining({ code: "DECODER_FAILED" }));
  });

  it("rejects a stream that ends during a header or payload", () => {
    const headerDecoder = new NativeMessageDecoder();
    headerDecoder.push(Buffer.from([1, 0]));
    expect(() => headerDecoder.finish()).toThrowError(
      expect.objectContaining({ code: "TRUNCATED_MESSAGE" }),
    );

    const payloadDecoder = new NativeMessageDecoder();
    const frame = encodeNativeMessage({ complete: false });
    payloadDecoder.push(frame.subarray(0, frame.byteLength - 1));
    expect(() => payloadDecoder.finish()).toThrowError(
      expect.objectContaining({ code: "TRUNCATED_MESSAGE" }),
    );
  });

  it("uses fixed safe framing errors without payload reflection", () => {
    const error = new NativeMessageFramingError("INVALID_JSON");

    expect(error.name).toBe("NativeMessageFramingError");
    expect(error.message).toBe("Native message framing failed");
    expect(error.message).not.toContain("payload");
  });
});
