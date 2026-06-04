import type { Highlight, StoredDocument } from "./types";

const DB_NAME = "pdf-annotation";
const DB_VERSION = 1;
const DOC_STORE = "documents";
const META_STORE = "metadata";

type Metadata = {
  key: string;
  value: string;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(DOC_STORE)) {
        db.createObjectStore(DOC_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });

  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

export async function saveDocument(document: StoredDocument) {
  const db = await openDb();
  const transaction = db.transaction([DOC_STORE, META_STORE], "readwrite");
  transaction.objectStore(DOC_STORE).put(document);
  transaction.objectStore(META_STORE).put({ key: "lastDocumentId", value: document.id } satisfies Metadata);

  await new Promise<void>((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}

export async function getDocument(id: string) {
  const db = await openDb();
  return promisify<StoredDocument | undefined>(
    db.transaction(DOC_STORE, "readonly").objectStore(DOC_STORE).get(id),
  );
}

export async function getLastDocument() {
  const db = await openDb();
  const meta = await promisify<Metadata | undefined>(
    db.transaction(META_STORE, "readonly").objectStore(META_STORE).get("lastDocumentId"),
  );

  if (!meta?.value) {
    return undefined;
  }

  return getDocument(meta.value);
}

export async function updateHighlights(documentId: string, highlights: Highlight[]) {
  const document = await getDocument(documentId);

  if (!document) {
    return;
  }

  await saveDocument({
    ...document,
    highlights,
    updatedAt: new Date().toISOString(),
  });
}
