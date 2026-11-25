/** Offline media blob store (IndexedDB), keyed by project id. */

const DB_NAME = "cuedesigner";
const DB_VERSION = 1;
const STORE = "media";

/** Embed media bytes in `.cueproj.json` when at or under this size. */
export const MEDIA_EMBED_MAX_BYTES = 8 * 1024 * 1024;

export interface StoredMedia {
  projectId: string;
  name: string;
  mimeType: string;
  blob: Blob;
  updatedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () =>
      reject(req.error ?? new Error("Failed to open media IndexedDB"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "projectId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export async function putProjectMedia(
  projectId: string,
  blob: Blob,
  meta: { name: string; mimeType: string },
): Promise<void> {
  const db = await openDb();
  try {
    const record: StoredMedia = {
      projectId,
      name: meta.name,
      mimeType: meta.mimeType,
      blob,
      updatedAt: new Date().toISOString(),
    };
    const tx = db.transaction(STORE, "readwrite");
    await idbReq(tx.objectStore(STORE).put(record));
  } finally {
    db.close();
  }
}

export async function getProjectMedia(
  projectId: string,
): Promise<StoredMedia | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const result = await idbReq(
      tx.objectStore(STORE).get(projectId) as IDBRequest<StoredMedia | undefined>,
    );
    return result ?? null;
  } finally {
    db.close();
  }
}

export async function deleteProjectMedia(projectId: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await idbReq(tx.objectStore(STORE).delete(projectId));
  } finally {
    db.close();
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Expected data URL string"));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to encode media"));
    reader.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  if (!res.ok) throw new Error("Failed to decode media data URL");
  return res.blob();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
