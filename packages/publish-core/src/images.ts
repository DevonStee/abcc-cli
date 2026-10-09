/**
 * 从文件头读取图片尺寸（PNG / JPEG / WebP / GIF）。
 *
 * GUI 用浏览器解码图片拿宽高；CLI 不引入图像库，只解析文件头，
 * 结果交给 app/logic/publish/pre-publish-checks.ts 做同一套规格判定。
 */
export interface ImageSize {
    width: number;
    height: number;
    mime: string;
}

function readUint16BE(bytes: Uint8Array, offset: number) {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes: Uint8Array, offset: number) {
    return (
        ((bytes[offset] << 24) >>> 0) +
        (bytes[offset + 1] << 16) +
        (bytes[offset + 2] << 8) +
        bytes[offset + 3]
    );
}

function readUint16LE(bytes: Uint8Array, offset: number) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number) {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readPng(bytes: Uint8Array): ImageSize | null {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || !signature.every((b, i) => bytes[i] === b)) return null;
    if (ascii(bytes, 12, 4) !== "IHDR") return null;
    return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20), mime: "image/png" };
}

function readJpeg(bytes: Uint8Array): ImageSize | null {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
        }
        const marker = bytes[offset + 1];
        // 填充字节与无长度的标记
        if (marker === 0xff) {
            offset += 1;
            continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
            continue;
        }
        const length = readUint16BE(bytes, offset + 2);
        // SOF0..SOF15，排除 DHT(C4)、JPG(C8)、DAC(CC)
        const isSof =
            marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
            return {
                height: readUint16BE(bytes, offset + 5),
                width: readUint16BE(bytes, offset + 7),
                mime: "image/jpeg",
            };
        }
        offset += 2 + length;
    }
    return null;
}

function readWebp(bytes: Uint8Array): ImageSize | null {
    if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
        return null;
    }
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8X") {
        return {
            width: readUint24LE(bytes, 24) + 1,
            height: readUint24LE(bytes, 27) + 1,
            mime: "image/webp",
        };
    }
    if (chunk === "VP8 ") {
        return {
            width: readUint16LE(bytes, 26) & 0x3fff,
            height: readUint16LE(bytes, 28) & 0x3fff,
            mime: "image/webp",
        };
    }
    if (chunk === "VP8L") {
        const b0 = bytes[21];
        const b1 = bytes[22];
        const b2 = bytes[23];
        const b3 = bytes[24];
        return {
            width: 1 + (((b1 & 0x3f) << 8) | b0),
            height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
            mime: "image/webp",
        };
    }
    return null;
}

function readGif(bytes: Uint8Array): ImageSize | null {
    if (bytes.length < 10) return null;
    const header = ascii(bytes, 0, 6);
    if (header !== "GIF87a" && header !== "GIF89a") return null;
    return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8), mime: "image/gif" };
}

export function readImageSize(bytes: Uint8Array): ImageSize | null {
    return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes) ?? readGif(bytes);
}
