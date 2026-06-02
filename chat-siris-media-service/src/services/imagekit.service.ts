import ImageKit from "imagekit";
import { randomUUID } from "crypto";
import { MediaAssetModel } from "../models/media-asset.model";

export const VALID_FOLDERS = [
  "Audios",
  "Videos",
  "Pdfs",
  "Zips",
  "Codes",
  "Images",
] as const;

export type MediaFolder = (typeof VALID_FOLDERS)[number];

export type UploadInitBody = {
  fileName: string;
  mimeType: string;
  folder: MediaFolder;
  sizeBytes: number;
};

export type UploadInitResponse = {
  uploadId: string;
  signature: string;
  token: string;
  expire: number;
  folder: string;
  publicKey: string;
};

const VIDEO_MAX_BYTES = 16 * 1024 * 1024;
const OTHER_MAX_BYTES = 25 * 1024 * 1024;

export class FileTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(message: string) {
    super(message);
    this.name = "FileTooLargeError";
  }
}

export class InvalidUploadBodyError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvalidUploadBodyError";
  }
}

export function isVideoMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("video/");
}

export function validateFileSize(mimeType: string, sizeBytes: number): void {
  const max = isVideoMimeType(mimeType) ? VIDEO_MAX_BYTES : OTHER_MAX_BYTES;
  if (sizeBytes > max) {
    throw new FileTooLargeError(
      isVideoMimeType(mimeType)
        ? "Video files must be 16 MB or smaller"
        : "File must be 25 MB or smaller",
    );
  }
}

export function parseUploadInitBody(body: unknown): UploadInitBody {
  if (!body || typeof body !== "object") {
    throw new InvalidUploadBodyError("Request body is required");
  }

  const record = body as Record<string, unknown>;
  const fileName = record.fileName;
  const mimeType = record.mimeType;
  const folder = record.folder;
  const sizeBytes = record.sizeBytes;

  if (typeof fileName !== "string" || fileName.trim().length === 0) {
    throw new InvalidUploadBodyError("fileName is required");
  }
  if (typeof mimeType !== "string" || mimeType.trim().length === 0) {
    throw new InvalidUploadBodyError("mimeType is required");
  }
  if (typeof folder !== "string" || !VALID_FOLDERS.includes(folder as MediaFolder)) {
    throw new InvalidUploadBodyError(
      "folder must be one of Audios, Videos, Pdfs, Zips, Codes, Images",
    );
  }
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new InvalidUploadBodyError("sizeBytes must be a non-negative number");
  }

  return {
    fileName: fileName.trim(),
    mimeType: mimeType.trim(),
    folder: folder as MediaFolder,
    sizeBytes,
  };
}

let imagekitClient: ImageKit | null = null;

/** ImageKit public keys are base64-like and must end with `=`. */
export function normalizeImageKitPublicKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith("public_") && !trimmed.endsWith("=")) {
    return `${trimmed}=`;
  }
  return trimmed;
}

function getImageKit(): ImageKit {
  if (!imagekitClient) {
    const publicKey = normalizeImageKitPublicKey(
      process.env.IMAGEKIT_PUBLIC_KEY ?? "",
    );
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;
    if (!publicKey || !privateKey || !urlEndpoint) {
      throw new Error(
        "IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, and IMAGEKIT_URL_ENDPOINT are required",
      );
    }
    imagekitClient = new ImageKit({ publicKey, privateKey, urlEndpoint });
  }
  return imagekitClient;
}

export function setImageKitClient(client: ImageKit | null): void {
  imagekitClient = client;
}

export async function generateUploadParams(
  userId: string,
  body: UploadInitBody,
): Promise<UploadInitResponse> {
  validateFileSize(body.mimeType, body.sizeBytes);

  const uploadId = randomUUID();
  const token = randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 2400;
  const auth = getImageKit().getAuthenticationParameters(token, expire);

  await MediaAssetModel.create({
    uploadId,
    userId,
    mimeType: body.mimeType,
    folder: body.folder,
    status: "initiated",
    createdAt: new Date(),
  });

  return {
    uploadId,
    signature: auth.signature,
    token: auth.token,
    expire: auth.expire,
    folder: body.folder,
    publicKey: normalizeImageKitPublicKey(process.env.IMAGEKIT_PUBLIC_KEY ?? ""),
  };
}
