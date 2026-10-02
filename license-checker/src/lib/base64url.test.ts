import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "./base64url";
import { BASE64URL_ROUNDTRIP, BASE_FIXTURE } from "./__fixtures__/workerCanonical";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("base64url byte-identical to the worker crypto.ts variant (SL-16)", () => {
  it("encodes a worker fixture string identically (-/_/no-padding)", () => {
    expect(bytesToBase64Url(encoder.encode(BASE64URL_ROUNDTRIP.text))).toBe(BASE64URL_ROUNDTRIP.base64Url);
  });

  it("round-trips the worker fixture back to the original string", () => {
    const bytes = base64UrlToBytes(BASE64URL_ROUNDTRIP.base64Url);
    expect(decoder.decode(bytes)).toBe(BASE64URL_ROUNDTRIP.text);
  });

  it("decodes the worker canonical fixture base64url back to its JSON", () => {
    const bytes = base64UrlToBytes(BASE_FIXTURE.canonicalBase64Url);
    expect(decoder.decode(bytes)).toBe(BASE_FIXTURE.canonicalJson);
  });

  it("round-trips arbitrary bytes with no + / = characters in the output", () => {
    const bytes = new Uint8Array([0, 1, 2, 251, 252, 253, 254, 255]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes));
  });
});
