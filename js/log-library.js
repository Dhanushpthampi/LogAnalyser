const DB_NAME = 'marelli-log-library';
const STORE_NAME = 'logs';

export class LogLibrary {
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve,reject) => {
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>request.result.createObjectStore(STORE_NAME,{keyPath:'id'});
      request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
    });
    return this.db;
  }
  async list() { const db=await this.open(); return this.request(db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll()).then(items=>items.sort((a,b)=>b.savedAt-a.savedAt)); }
  async save(name, blob) { const db=await this.open(); const item={id:crypto.randomUUID(),name,savedAt:Date.now(),size:blob.size,blob}; await this.request(db.transaction(STORE_NAME,'readwrite').objectStore(STORE_NAME).put(item)); return item; }
  async get(id) { const db=await this.open(); return this.request(db.transaction(STORE_NAME).objectStore(STORE_NAME).get(id)); }
  async rename(id, newName) { const db=await this.open(); const item=await this.get(id); if(!item) return; item.name=newName; await this.request(db.transaction(STORE_NAME,'readwrite').objectStore(STORE_NAME).put(item)); return item; }
  async remove(id) { const db=await this.open(); return this.request(db.transaction(STORE_NAME,'readwrite').objectStore(STORE_NAME).delete(id)); }
  request(request) { return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}); }
}

