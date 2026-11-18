import { get, head } from "@vercel/blob";

export const PRIVATE_BLOB_ACCESS = "private" as const;

export function requireBlobStorage() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_STORAGE_NOT_CONFIGURED");
  return process.env.BLOB_READ_WRITE_TOKEN;
}

export async function headPrivateBlob(pathname: string) {
  const token = requireBlobStorage();
  return head(pathname, { token });
}

export async function readPrivateBlob(pathname: string) {
  requireBlobStorage();
  const result = await get(pathname, { access: PRIVATE_BLOB_ACCESS });
  if (!result) return null;
  return {
    blob: result.blob,
    text: await new Response(result.stream).text(),
  };
}
