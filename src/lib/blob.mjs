import { get } from '@vercel/blob';

export async function readPrivateBlob(pathname) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('BLOB_STORAGE_NOT_CONFIGURED');
  const result = await get(pathname, { access: 'private' });
  if (!result) return null;
  return {
    blob: result.blob,
    text: await new Response(result.stream).text(),
  };
}

export async function scanPrivateBlob(metadata) {
  const scannerUrl = process.env.MALWARE_SCAN_URL;
  if (!scannerUrl) {
    if (process.env.NODE_ENV === 'production') throw new Error('Malware scanner is not configured');
    return 'skipped';
  }
  const response = await fetch(scannerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.MALWARE_SCAN_TOKEN ? { authorization: `Bearer ${process.env.MALWARE_SCAN_TOKEN}` } : {}),
    },
    body: JSON.stringify(metadata),
  });
  if (!response.ok) throw new Error(`Malware scanner returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.clean !== true) throw new Error('Malware scanner rejected the uploaded file');
  return 'passed';
}
