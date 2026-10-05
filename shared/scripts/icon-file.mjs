import { readFileSync, writeFileSync } from "node:fs";

export function writeIco(outputPath, entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  const images = [];
  let imageOffset = header.length + directory.length;

  entries.forEach(({ size, filePath }, index) => {
    const data = readFileSync(filePath);
    const offset = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, offset);
    directory.writeUInt8(size >= 256 ? 0 : size, offset + 1);
    directory.writeUInt8(0, offset + 2);
    directory.writeUInt8(0, offset + 3);
    directory.writeUInt16LE(1, offset + 4);
    directory.writeUInt16LE(32, offset + 6);
    directory.writeUInt32LE(data.length, offset + 8);
    directory.writeUInt32LE(imageOffset, offset + 12);
    images.push(data);
    imageOffset += data.length;
  });

  writeFileSync(outputPath, Buffer.concat([header, directory, ...images]));
}
