import { describe, expect, test } from "bun:test";
import vectors from "./fixtures/aes-256-ecb-vectors.json";
import {
  decryptAes256Ecb,
  encryptAes256Ecb,
  generateKeyBase64,
  sha256Hex,
} from "@abcc/publish-core/crypto";

const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const toBase64 = (value: Uint8Array) => Buffer.from(value).toString("base64");

/**
 * fixtures 由与 src-tauri/src/lib.rs encrypt_aes_256_ecb 相同的 Rust 实现
 * （aes 0.8 + ecb 0.1，Pkcs7）生成，CLI 的输出必须与之逐字节一致。
 */
describe("AES-256-ECB 与 GUI 的 Rust 实现一致", () => {
  for (const testCase of vectors.cases) {
    test(testCase.name, () => {
      const cipher = encryptAes256Ecb(fromBase64(testCase.plain), vectors.key);
      expect(toBase64(cipher)).toBe(testCase.cipher);
    });
  }
});

describe("加密往返", () => {
  test("随机密钥加密后可还原原文", () => {
    const key = generateKeyBase64();
    expect(Buffer.from(key, "base64").length).toBe(32);
    const plain = new Uint8Array(4096).map((_, index) => (index * 13) % 256);
    const cipher = encryptAes256Ecb(plain, key);
    expect(cipher.length % 16).toBe(0);
    expect(cipher.length).toBeGreaterThan(plain.length - 1);
    expect(decryptAes256Ecb(cipher, key)).toEqual(plain);
  });

  test("密钥长度不是 32 字节时拒绝", () => {
    expect(() => encryptAes256Ecb(new Uint8Array(4), Buffer.alloc(16).toString("base64"))).toThrow(
      "32 bytes",
    );
  });

  test("sha256Hex 输出小写十六进制", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
