// Product image storage.
//
// Files go into this project's Google Cloud Storage bucket and are served from
// a public URL. The bucket name comes from GCS_BUCKET; on Cloud Run the
// ambient service account provides the credentials.
//
// Both the billing app (JWT-authenticated staff) and the Laxorashopping
// website (API-key authenticated) upload through here, so a photo added in
// either place lands in the same bucket and is served the same way.

import multer from "multer";
import { Storage } from "@google-cloud/storage";
import { badRequest } from "../utils/errors";
import type { Request, Response, NextFunction } from "express";

export const gcsBucket = process.env.GCS_BUCKET || "";
const gcs = new Storage();

const MAX_UPLOAD_MB = 15;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }, // phone photos are often 8-12 MB
});

// Runs multer for a single file and converts its errors (e.g. file-too-large)
// into clear 400s. Without this a too-large upload falls through to the generic
// 500 "Internal server error", which reads as "upload just failed".
export function uploadSingle(field: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.single(field)(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE")
          return next(
            badRequest(
              `This file is too large. Please upload a file under ${MAX_UPLOAD_MB} MB (try a smaller photo or a PDF).`
            )
          );
        return next(badRequest(err.message));
      }
      if (err) return next(err);
      next();
    });
  };
}

export type UploadedFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

// Stores one uploaded file and returns its public URL. `folder` keeps the
// website's own imagery (categories, banners) out of the product folder.
export async function saveUpload(
  file: UploadedFile | undefined,
  businessId: string,
  folder = "product-images"
): Promise<string> {
  // What the caller sent is checked first. Reporting "storage is not
  // configured" to someone who actually attached a .txt sends them chasing a
  // server problem that is not theirs.
  if (!file) throw badRequest("No file received");
  if (!file.mimetype.startsWith("image/") && file.mimetype !== "application/pdf")
    throw badRequest("Only image or PDF files can be uploaded");
  if (!gcsBucket)
    throw badRequest(
      "Image storage is not configured on the server (GCS_BUCKET is not set). Please contact support."
    );

  const ext = (file.originalname.split(".").pop() || "jpg")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 5);
  const objectName = `${folder}/${businessId}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.${ext}`;

  const blob = gcs.bucket(gcsBucket).file(objectName);
  await blob.save(file.buffer, {
    contentType: file.mimetype,
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000" },
  });

  return `https://storage.googleapis.com/${gcsBucket}/${objectName}`;
}
