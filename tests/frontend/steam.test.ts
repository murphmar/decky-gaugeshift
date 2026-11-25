import { describe, expect, it } from "vitest";
import { encodeStringSetting } from "../../src/steam";

const decode = (b64: string) => [...Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))];

describe("encodeStringSetting", () => {
  it("encodes Maximum Game Resolution the way Steam expects", () => {
    // Field 21012, wire type 2 -> tag bytes a2 a1 0a, then length, then the text.
    expect(encodeStringSetting(21012, "Default")).toBe("oqEKB0RlZmF1bHQ="); // captured from a working setup
    expect(decode(encodeStringSetting(21012, "1920x1200"))).toEqual([
      0xa2,
      0xa1,
      0x0a,
      9,
      ...[..."1920x1200"].map((c) => c.charCodeAt(0)),
    ]);
  });

  it("handles long values with a multi-byte length", () => {
    const bytes = decode(encodeStringSetting(21012, "x".repeat(200)));
    expect(bytes.slice(0, 5)).toEqual([0xa2, 0xa1, 0x0a, 0xc8, 0x01]);
    expect(bytes.length).toBe(5 + 200);
  });
});
