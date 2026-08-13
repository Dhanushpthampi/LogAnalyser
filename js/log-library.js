const DB_NAME = 'logalizer-log-library';
const STORE_NAME = 'logs';
const LEGACY_DB_NAME = 'marelli-log-library';

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export class LogLibrary {
  async open() {
    if (this.db) return this.db;

    this.db = await this.openDb(DB_NAME);
    const count = await this.count(this.db);
    if (!count) {
      const legacy = await this.tryOpenLegacy();
      if (legacy.count) await this.migrateFrom(legacy.db);
    }

    return this.db;
  }

  openDb(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async tryOpenLegacy() {
    try {
      const db = await this.openDb(LEGACY_DB_NAME);
      const count = await this.count(db);
      return { db, count };
    } catch {
      return { db: null, count: 0 };
    }
  }

  count(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async migrateFrom(legacyDb) {
    const items = await new Promise((resolve, reject) => {
      const tx = legacyDb.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });

    for (const item of items) await this.put(item);
    legacyDb.close();
  }

  run(mode, fn) {
    return this.open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      tx.oncomplete = () => resolve(tx._result);
      tx.onerror = () => reject(tx.error);
      try {
        Promise.resolve(fn(tx.objectStore(STORE_NAME)))
          .then(result => { tx._result = result; })
          .catch(err => { tx.abort(); reject(err); });
      } catch (err) {
        reject(err);
      }
    }));
  }

  request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async list() {
    const items = await this.run('readonly', store => this.request(store.getAll()));
    return (items ?? []).sort((a, b) => b.savedAt - a.savedAt);
  }

  async save(name, blob) {
    const data = blob instanceof Blob
      ? blob
      : new Blob([String(blob ?? '')], { type: 'text/plain' });
    const item = {
      id: newId(),
      name,
      savedAt: Date.now(),
      size: data.size,
      blob: data,
    };
    await this.put(item);
    return item;
  }

  async put(item) {
    await this.run('readwrite', store => { store.put(item); });
    return item;
  }

  async get(id) {
    return this.run('readonly', store => this.request(store.get(id)));
  }

  async update(id, fields) {
    const item = await this.get(id);
    if (!item) return null;
    Object.assign(item, fields, { id });
    await this.put(item);
    return item;
  }

  async rename(id, newName) {
    return this.update(id, { name: newName });
  }

  async remove(id) {
    await this.run('readwrite', store => { store.delete(id); });
  }
}
