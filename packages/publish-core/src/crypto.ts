/**
 * 包体加密：与 GUI 相同的 AES-256-ECB + PKCS7。
 *
 * GUI 在 app/logic/publish/encryption.ts 里生成 32 字节随机密钥，交给 Tauri 命令
 * encrypt_aes_256_ecb（src-tauri/src/lib.rs，aes + ecb crate，Pkcs7 填充）加密，
 * 再对密文算 SHA-256。CLI 拿不到 Tauri，这里用 node:crypto 做同一个标准算法；
 * 输出与 Rust 实现逐字节一致由 tests/cli/crypto.test.ts 的固定向量保证。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const AES_KEY_BYTES = 32;

export function generateKeyBase64(): string {
    return randomBytes(AES_KEY_BYTES).toString("base64");
}

function decodeKey(keyBase64: string): Buffer {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== AES_KEY_BYTES) {
        throw new Error("AES-256 key must be exactly 32 bytes");
    }
    return key;
}

export function encryptAes256Ecb(data: Uint8Array, keyBase64: string): Uint8Array {
    // ECB 无 IV；node:crypto 默认开启 PKCS7 填充，与 Rust 的 Pkcs7 一致。
    const cipher = createCipheriv("aes-256-ecb", decodeKey(keyBase64), null);
    return new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
}

export function decryptAes256Ecb(data: Uint8Array, keyBase64: string): Uint8Array {
    const decipher = createDecipheriv("aes-256-ecb", decodeKey(keyBase64), null);
    return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
}

export function sha256Hex(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}
