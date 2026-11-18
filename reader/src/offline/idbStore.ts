/**
 * KvStore (the migration runner's store interface) over IndexedDB. One object
 * store of string keys. The values are plain structured-cloneable objects, and
 * everything private in them is already sealed (see crypto.ts) before it gets here.
 */
import type { KvStore } from '../storage/migrations';

export const DB_NAME = 'mecon-reader-offline';
const STORE = 'kv';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('aborted', 'AbortError'));
  });
}

export async function openIdbStore(name: string = DB_NAME, factory: IDBFactory = indexedDB, keyRange: typeof IDBKeyRange = IDBKeyRange): Promise<KvStore & { close(): void }> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return {
    async get(key) {
      return (await req(db.transaction(STORE, 'readonly').objectStore(STORE).get(key))) as unknown | undefined;
    },
    async put(key, value) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      await txDone(tx);
    },
    async delete(key) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      await txDone(tx);
    },
    async keys(prefix) {
      const range = keyRange.bound(prefix, prefix + '￿');
      return (await req(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys(range))) as string[];
    },
    close: () => db.close(),
  };
}
