import { describe, expect, test } from "bun:test";
import { readImageSize } from "@abcc/publish-core/images";
import { pngHeader } from "./helpers";

describe("readImageSize", () => {
  test("PNG", () => {
    expect(readImageSize(pngHeader(300, 200))).toEqual({
      width: 300,
      height: 200,
      mime: "image/png",
    });
  });

  test("JPEG：跳过 APP 段读取 SOF0", () => {
    const bytes = new Uint8Array([
      0xff, 0xd8,
      // APP0，长度 16
      0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      // SOF0：长度 17，精度 8，高 0x01e0(480)，宽 0x0280(640)
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(readImageSize(bytes)).toEqual({ width: 640, height: 480, mime: "image/jpeg" });
  });

  test("GIF", () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x01, 0xc8, 0x00]);
    expect(readImageSize(bytes)).toEqual({ width: 300, height: 200, mime: "image/gif" });
  });

  test("WebP VP8X", () => {
    const bytes = new Uint8Array(30);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WEBP"), 8);
    bytes.set(new TextEncoder().encode("VP8X"), 12);
    // 宽 - 1 = 499，高 - 1 = 499（24 位小端）
    bytes.set([0xf3, 0x01, 0x00], 24);
    bytes.set([0xf3, 0x01, 0x00], 27);
    expect(readImageSize(bytes)).toEqual({ width: 500, height: 500, mime: "image/webp" });
  });

  test("无法识别的格式返回 null", () => {
    expect(readImageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
  });
});
