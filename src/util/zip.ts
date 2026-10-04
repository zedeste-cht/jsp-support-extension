/**
 * Lazy zip/jar reader: reads only the central directory to list entries, and
 * inflates single entries on demand. Never loads the whole archive in memory.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';

export interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}

export class ZipFile {
    private constructor(readonly path: string, readonly entries: Map<string, ZipEntry>) { }

    static async open(zipPath: string): Promise<ZipFile> {
        const fh = await fs.promises.open(zipPath, 'r');
        try {
            const { size } = await fh.stat();
            const tailLen = Math.min(size, 65557 + 20);
            const tail = Buffer.alloc(tailLen);
            await fh.read(tail, 0, tailLen, size - tailLen);

            let eocd = -1;
            for (let i = tailLen - 22; i >= 0; i--) {
                if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
            }
            if (eocd < 0) { throw new Error(`Not a zip file: ${zipPath}`); }

            let count = tail.readUInt16LE(eocd + 10);
            let cdSize = tail.readUInt32LE(eocd + 12);
            let cdOffset = tail.readUInt32LE(eocd + 16);

            // Zip64
            if (cdOffset === 0xffffffff || count === 0xffff) {
                const loc = eocd - 20;
                if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
                    const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
                    const z64 = Buffer.alloc(56);
                    await fh.read(z64, 0, 56, z64Offset);
                    if (z64.readUInt32LE(0) === 0x06064b50) {
                        count = Number(z64.readBigUInt64LE(32));
                        cdSize = Number(z64.readBigUInt64LE(40));
                        cdOffset = Number(z64.readBigUInt64LE(48));
                    }
                }
            }

            const cd = Buffer.alloc(cdSize);
            await fh.read(cd, 0, cdSize, cdOffset);
            const entries = new Map<string, ZipEntry>();
            let p = 0;
            for (let n = 0; n < count && p + 46 <= cd.length; n++) {
                if (cd.readUInt32LE(p) !== 0x02014b50) { break; }
                const method = cd.readUInt16LE(p + 10);
                let compressedSize = cd.readUInt32LE(p + 20);
                let uncompressedSize = cd.readUInt32LE(p + 24);
                const nameLen = cd.readUInt16LE(p + 28);
                const extraLen = cd.readUInt16LE(p + 30);
                const commentLen = cd.readUInt16LE(p + 32);
                let localHeaderOffset = cd.readUInt32LE(p + 42);
                const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

                if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
                    let e = p + 46 + nameLen;
                    const extraEnd = e + extraLen;
                    while (e + 4 <= extraEnd) {
                        const id = cd.readUInt16LE(e);
                        const len = cd.readUInt16LE(e + 2);
                        if (id === 0x0001) {
                            let q = e + 4;
                            if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
                            if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
                            if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(cd.readBigUInt64LE(q)); }
                            break;
                        }
                        e += 4 + len;
                    }
                }
                if (!name.endsWith('/')) {
                    entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
                }
                p += 46 + nameLen + extraLen + commentLen;
            }
            return new ZipFile(zipPath, entries);
        } finally {
            await fh.close();
        }
    }

    async read(entryName: string): Promise<Buffer | null> {
        const e = this.entries.get(entryName);
        if (!e) { return null; }
        const fh = await fs.promises.open(this.path, 'r');
        try {
            const header = Buffer.alloc(30);
            await fh.read(header, 0, 30, e.localHeaderOffset);
            if (header.readUInt32LE(0) !== 0x04034b50) { throw new Error(`Bad local header for ${entryName}`); }
            const nameLen = header.readUInt16LE(26);
            const extraLen = header.readUInt16LE(28);
            const data = Buffer.alloc(e.compressedSize);
            await fh.read(data, 0, e.compressedSize, e.localHeaderOffset + 30 + nameLen + extraLen);
            if (e.method === 0) { return data; }
            if (e.method === 8) { return zlib.inflateRawSync(data); }
            throw new Error(`Unsupported zip method ${e.method} for ${entryName}`);
        } finally {
            await fh.close();
        }
    }

    async readText(entryName: string): Promise<string | null> {
        const buf = await this.read(entryName);
        return buf ? buf.toString('utf8') : null;
    }
}
