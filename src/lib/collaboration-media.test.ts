import assert from "node:assert/strict";
import { test } from "node:test";
import { assertUploadSize, prepareImage, safeFilename } from "./collaboration-media.ts";
import { MEDIA_LIMITS } from "./collaboration-options.ts";

function segment(marker: number, payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

function jpegWithMetadata(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    segment(0xe1, Buffer.from("Exif\0\0GPSLatitude52.1S", "latin1")),
    segment(0xfe, Buffer.from("private note", "latin1")),
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

function pngWithMetadata(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from("Comment\0GPS 52.1S", "latin1")),
    chunk("eXIf", Buffer.from("Exif\0\0", "latin1")),
    chunk("IDAT", Buffer.from([0x00])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("JPEG metadata segments are removed while the image structure survives", () => {
  const prepared = prepareImage(jpegWithMetadata());
  const text = prepared.bytes.toString("latin1");
  assert.equal(prepared.mimeType, "image/jpeg");
  assert.match(text, /JFIF/);
  assert.doesNotMatch(text, /GPSLatitude/);
  assert.doesNotMatch(text, /private note/);
  assert.equal(prepared.bytes.subarray(0, 2).toString("hex"), "ffd8");
  assert.equal(prepared.bytes.subarray(-2).toString("hex"), "ffd9");
  assert.match(prepared.sha256, /^[a-f0-9]{64}$/);
});

test("PNG text and EXIF chunks are removed without disturbing the image chunks", () => {
  const prepared = prepareImage(pngWithMetadata());
  const text = prepared.bytes.toString("latin1");
  assert.equal(prepared.mimeType, "image/png");
  assert.match(text, /IHDR/);
  assert.match(text, /IDAT/);
  assert.match(text, /IEND/);
  assert.doesNotMatch(text, /GPS 52.1S/);
  assert.equal(prepared.bytes.subarray(12, 16).toString("latin1"), "IHDR");
});

test("the file signature decides the type: renamed or odd files are refused", () => {
  assert.throws(() => prepareImage(Buffer.from("<html></html>")), /JPEG or PNG/);
  assert.throws(() => prepareImage(Buffer.from("GIF89a")), /JPEG or PNG/);
  assert.throws(() => prepareImage(Buffer.alloc(0)), /empty/);
  assert.throws(() => prepareImage(Buffer.from([0xff, 0xd8, 0x00, 0x00])), /could not be read|incomplete/);
});

test("an oversized photograph is refused before storage", () => {
  const oversized = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(MEDIA_LIMITS.fileBytes)]);
  assert.throws(() => prepareImage(oversized), /MB or smaller/);
});

test("the declared upload size is bounded, and an absent header is not a refusal", () => {
  assert.doesNotThrow(() => assertUploadSize(null));
  assert.doesNotThrow(() => assertUploadSize("1000"));
  assert.throws(() => assertUploadSize(String(MEDIA_LIMITS.totalBytes + 1024 * 1024)), /MB or less/);
});

test("stored filenames cannot carry a path", () => {
  assert.equal(safeFilename("../../etc/passwd"), "passwd");
  assert.equal(safeFilename("C:\\photos\\me.jpg"), "me.jpg");
  assert.equal(safeFilename(""), "photo");
  assert.equal(safeFilename("<script>.jpg"), "script.jpg");
});
