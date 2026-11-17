import { createHash } from "node:crypto";
import { MEDIA_LIMITS } from "./collaboration-options.ts";

/**
 * Upload validation and metadata hygiene for contribution photographs.
 *
 * Only JPEG and PNG are accepted. The declared MIME type is ignored: the file
 * signature decides. Metadata segments that commonly carry location, device and
 * authorship details are removed before the bytes are stored, so an approved
 * photograph cannot leak GPS coordinates when it is later exported.
 *
 * Nothing here resizes, re-encodes or otherwise alters pixels.
 */

export class MediaError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MediaError";
    this.status = status;
  }
}

export interface StoredImage {
  mimeType: "image/jpeg" | "image/png";
  bytes: Buffer;
  sha256: string;
}

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8]);
const JPEG_START_OF_SCAN = 0xda;
const JPEG_END_OF_IMAGE = 0xd9;
const JPEG_COMMENT = 0xfe;
/** APP1 carries EXIF/XMP; APP2 is the ICC colour profile and is kept. */
const JPEG_METADATA_MARKERS = new Set([0xe1, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_METADATA_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf"]);

function stripJpegMetadata(input: Buffer): Buffer {
  const output: Buffer[] = [input.subarray(0, 2)];
  let offset = 2;
  while (offset + 1 < input.length) {
    if (input[offset] !== 0xff) {
      throw new MediaError("That image could not be read. Try another file.", 415);
    }
    let marker = input[offset + 1]!;
    let markerStart = offset;
    // Fill bytes are permitted before a marker.
    while (marker === 0xff && offset + 1 < input.length) {
      offset += 1;
      marker = input[offset + 1]!;
      markerStart = offset;
    }
    const afterMarker = markerStart + 2;
    if (marker === JPEG_END_OF_IMAGE) {
      output.push(input.subarray(markerStart));
      return Buffer.concat(output);
    }
    if (marker === JPEG_START_OF_SCAN) {
      // Entropy-coded data follows; copy it verbatim.
      output.push(input.subarray(markerStart));
      return Buffer.concat(output);
    }
    if (afterMarker + 2 > input.length) {
      throw new MediaError("That image is incomplete. Try another file.", 415);
    }
    const length = input.readUInt16BE(afterMarker);
    if (length < 2 || afterMarker + length > input.length) {
      throw new MediaError("That image is incomplete. Try another file.", 415);
    }
    const drop = marker === JPEG_COMMENT || JPEG_METADATA_MARKERS.has(marker);
    if (!drop) output.push(input.subarray(markerStart, afterMarker + length));
    offset = afterMarker + length;
  }
  throw new MediaError("That image is incomplete. Try another file.", 415);
}

function stripPngMetadata(input: Buffer): Buffer {
  const output: Buffer[] = [input.subarray(0, 8)];
  let offset = 8;
  let sawHeader = false;
  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (length > input.length || end > input.length) {
      throw new MediaError("That image is incomplete. Try another file.", 415);
    }
    if (!sawHeader && type !== "IHDR") {
      throw new MediaError("That image could not be read. Try another file.", 415);
    }
    sawHeader = true;
    if (!PNG_METADATA_CHUNKS.has(type)) {
      output.push(input.subarray(offset, end));
    }
    offset = end;
    if (type === "IEND") return Buffer.concat(output);
  }
  throw new MediaError("That image is incomplete. Try another file.", 415);
}

/** Identify and sanitise one uploaded image. Throws `MediaError` on refusal. */
export function prepareImage(bytes: Buffer): StoredImage {
  if (!bytes.length) throw new MediaError("That file is empty.");
  if (bytes.length > MEDIA_LIMITS.fileBytes) {
    throw new MediaError(
      `Each photo must be ${MEDIA_LIMITS.fileBytes / (1024 * 1024)} MB or smaller.`,
      413,
    );
  }
  let prepared: Buffer;
  let mimeType: StoredImage["mimeType"];
  if (bytes.subarray(0, 2).equals(JPEG_SIGNATURE)) {
    prepared = stripJpegMetadata(bytes);
    mimeType = "image/jpeg";
  } else if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    prepared = stripPngMetadata(bytes);
    mimeType = "image/png";
  } else {
    throw new MediaError("Photos must be JPEG or PNG files.", 415);
  }
  return {
    mimeType,
    bytes: prepared,
    sha256: createHash("sha256").update(prepared).digest("hex"),
  };
}

/** Reject a submission before reading its body when the declared size is too big. */
export function assertUploadSize(contentLengthHeader: string | null): void {
  if (!contentLengthHeader) return;
  const declared = Number(contentLengthHeader);
  if (!Number.isFinite(declared) || declared <= 0) return;
  if (declared <= MEDIA_LIMITS.totalBytes + 256 * 1024) return;
  throw new MediaError(
    `Photos must total ${MEDIA_LIMITS.totalBytes / (1024 * 1024)} MB or less.`,
    413,
  );
}

/** Keep the name for the reviewer, not as a path or an executable hint. */
export function safeFilename(value: string | undefined): string {
  const base = String(value ?? "")
    .split(/[\\/]/)
    .pop()
    ?.replace(/[^\w.\- ]+/g, "")
    .trim()
    .slice(0, 120);
  return base || "photo";
}
