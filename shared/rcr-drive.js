/* RCR Drive — lets the RCR Dashboard and Invoice Form save to Google Drive when they run as the web app
   (GitHub Pages: …/dashboard/ and …/invoice/). Opened from the computer's files (file://), nothing here is used
   and both apps keep using the folder picked on that computer.

   It makes the Drive folder  My Drive › Documents › RCR  behave like a folder picked with showDirectoryPicker()
   (getDirectoryHandle / getFileHandle / getFile / createWritable / entries / removeEntry), so the apps' existing
   save code works unchanged. Sign-in happens on the web app's home page (index.html), which stores a Google
   access token (valid 1 hour) in localStorage; RCRDrive.signIn() sends the user there and back. */
(function () {
  const API = 'https://www.googleapis.com/drive/v3', UP = 'https://www.googleapis.com/upload/drive/v3';
  const FOLDER = 'application/vnd.google-apps.folder';
  const TK = 'rcr-gtoken', ROOTK = 'rcr-drive-root', USERK = 'rcr-guser';
  const ROOT_PATH = ['Documents', 'RCR'];                 // My Drive › Documents › RCR
  const m = location.pathname.match(/^(.*\/)(dashboard|invoice)\/(index\.html)?$/);
  const hosted = /^https?:$/.test(location.protocol) && !!m;
  const base = m ? m[1] : '/';

  /* ---------- sign-in ---------- */
  function token() {
    try { const t = JSON.parse(localStorage.getItem(TK) || 'null'); return t && t.exp > Date.now() + 60e3 ? t.token : null; } catch { return null; }
  }
  function minutesLeft() { try { const t = JSON.parse(localStorage.getItem(TK) || 'null'); return t ? Math.floor((t.exp - Date.now()) / 6e4) : 0; } catch { return 0; } }
  let leaving = false;
  function signIn(opts) {           // goes to the home page, which asks Google and comes back here; never resolves
    if (!leaving) {
      leaving = true;
      const ret = location.pathname + location.search + location.hash;
      location.href = base + '?signin=1' + (opts && opts.silent ? '&silent=1' : '') + (opts && opts.gmail ? '&gmail=1' : '') + (opts && opts.cal ? '&cal=1' : '') + (opts && opts.cont ? '&cont=1' : '') + '&ret=' + encodeURIComponent(ret);
    }
    return new Promise(() => {});
  }
  function signOut() { [TK, USERK, ROOTK, 'rcr-gmail', 'rcr-gcal', 'rcr-gcal-map', 'rcr-gcont', 'rcr-gscope','rcr-drive-ids'].forEach(k => localStorage.removeItem(k)); try { indexedDB.deleteDatabase('rcr-drive-cache'); } catch { } location.href = base; }
  const user = () => { try { return JSON.parse(localStorage.getItem(USERK) || 'null'); } catch { return null; } };
  const wasSignedIn = () => !!user();

  class AuthError extends Error { constructor(msg) { super(msg || 'Google sign-in has expired'); this.name = 'AuthError'; } }
  const notFound = n => new DOMException(`"${n}" was not found`, 'NotFoundError');
  const mismatch = n => new DOMException(`"${n}" is the wrong kind of item`, 'TypeMismatchError');

  async function api(url, opt) {
    opt = opt || {};
    const t = token(); if (!t) throw new AuthError();
    let r;
    for (let i = 0; i < 3; i++) {                        // retry Google's occasional "rate limit" / server hiccups
      r = await fetch(url, { ...opt, headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + t } });
      if (r.status !== 429 && r.status < 500) break;
      await new Promise(res => setTimeout(res, 600 * (i + 1)));
    }
    if (r.status === 401) { localStorage.removeItem(TK); throw new AuthError(); }
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText;
      try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch { }
      if (r.status === 404) throw new DOMException('Google Drive: ' + msg, 'NotFoundError');
      throw new Error('Google Drive: ' + msg);
    }
    return r;
  }
  const json = (url, opt) => api(url, opt).then(r => r.json());
  const qstr = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const FIELDS = 'id,name,mimeType,modifiedTime,size';
  async function list(parentId, name) {
    let out = [], pageToken = '';
    do {
      const p = new URLSearchParams({ q: `${qstr(parentId)} in parents and trashed=false` + (name != null ? ` and name=${qstr(name)}` : ''),
        fields: `nextPageToken,files(${FIELDS})`, pageSize: '1000', orderBy: 'modifiedTime desc' });
      if (pageToken) p.set('pageToken', pageToken);
      const j = await json(`${API}/files?${p}`);
      out = out.concat(j.files || []); pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  const MIME = { json: 'application/json', csv: 'text/csv', txt: 'text/plain', html: 'text/html', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const mimeOf = n => MIME[(String(n).split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const folderCache = new Map();                          // "parentId/name" → folder metadata (folders rarely change)
  const bodyCache = new Map();                            // file id → { mt, blob } so unchanged files aren't downloaded twice

  /* ---------- speed: remembered between app opens ----------
     IDS (localStorage "rcr-drive-ids"): "parentId/name" → { id, mimeType } for folders and files, so opening the app doesn't have to
     look every folder and file up by name again. A remembered file is checked by its metadata (trashed? still in that folder?)
     before it is read or written; if anything looks off, everything remembered is forgotten and looked up fresh.
     Bodies (IndexedDB "rcr-drive-cache"): file id → { mt, blob }. A file is only downloaded again when Drive says it changed. */
  const IDK = 'rcr-drive-ids';
  let ids = null;
  const idsGet = () => { if (!ids) { try { ids = JSON.parse(localStorage.getItem(IDK) || '{}') || {}; } catch { ids = {}; } } return ids; };
  const idsSave = () => { try { localStorage.setItem(IDK, JSON.stringify(ids || {})); } catch { } };
  const idSet = (parentId, name, f) => { idsGet()[parentId + '/' + name] = { id: f.id, mimeType: f.mimeType }; idsSave(); };
  const idDel = (parentId, name) => { if (idsGet()[parentId + '/' + name]) { delete ids[parentId + '/' + name]; idsSave(); } };
  const checked = new Set();                              // remembered ids confirmed this session
  // something on Drive moved or was deleted: forget all remembered locations AND all "already checked" marks,
  // so every folder is checked again before anything is read from or written into it
  let gen = 0;                                            // bumped by idsForget: folder handles from before must be checked again
  const idsForget = () => { ids = {}; idsSave(); folderCache.clear(); checked.clear(); gen++; };
  const BODY_MAX = 8e6;
  const bodyDB = (() => {
    let p; const db = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('rcr-drive-cache', 1); r.onupgradeneeded = () => r.result.createObjectStore('b'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const tx = (mode, fn) => db().then(d => new Promise((res, rej) => { const t = d.transaction('b', mode), s = t.objectStore('b'), out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }));
    return {
      get: id => tx('readonly', s => s.get(id)).catch(() => null),
      put: (id, v) => tx('readwrite', s => s.put(v, id)).then(trim).catch(() => {}),
      del: id => tx('readwrite', s => s.delete(id)).catch(() => {}),
      clear: () => tx('readwrite', s => s.clear()).catch(() => {}),
    };
    async function trim() {                               // keep the newest ~60 files (photo thumbnails add up)
      const all = await tx('readonly', s => s.getAll()).catch(() => null), keys = await tx('readonly', s => s.getAllKeys()).catch(() => null);
      if (!all || !keys || all.length <= 60) return;
      const order = keys.map((k, i) => [k, all[i].at || 0]).sort((a, b) => a[1] - b[1]);
      await tx('readwrite', s => { for (const [k] of order.slice(0, all.length - 60)) s.delete(k); });
    }
  })();
  // stored as an ArrayBuffer (older iPhone Safari versions were unreliable with Blobs in IndexedDB)
  const keep = (id, mt, blob) => { if (blob && blob.size <= BODY_MAX) blob.arrayBuffer().then(buf => bodyDB.put(id, { mt, buf, type: blob.type, at: Date.now() })).catch(() => {}); };
  const kept = async (id, mt) => { const s = await bodyDB.get(id); return s && s.mt === mt && s.buf ? new Blob([s.buf], { type: s.type || '' }) : null; };

  class DriveFile {
    constructor(id, name, parent, remembered) { this.kind = 'file'; this.id = id; this.name = name; this.parent = parent; this.remembered = !!remembered; }
    async _meta() {                                       // metadata; a remembered id must still be a live file in the same folder
      const meta = await json(`${API}/files/${this.id}?fields=${FIELDS},trashed,parents`).catch(e => { if (e.name === 'NotFoundError' && this.remembered) return null; throw e; });
      if (this.remembered && (!meta || meta.trashed || !(meta.parents || []).includes(this.parent.id))) {
        idsForget(); bodyDB.del(this.id);
        const f = (await this.parent._verify(), (await list(this.parent.id, this.name))[0]);
        if (!f || f.mimeType === FOLDER) { this.id = null; throw notFound(this.name); }
        this.id = f.id; this.remembered = false; idSet(this.parent.id, this.name, f);
        return this._meta();
      }
      checked.add(this.id); this.remembered = false;
      return meta;
    }
    async getFile() {                                     // a File-like object; the content downloads only when read
      if (!this.id) throw notFound(this.name);
      const meta = await this._meta(), id = this.id, name = this.name;
      const load = () => {                                // one download per version, even when asked for twice at once
        const c = bodyCache.get(id); if (c && c.mt === meta.modifiedTime) return c.blob;
        const blob = kept(id, meta.modifiedTime).then(b => b
          || api(`${API}/files/${id}?alt=media`).then(r => r.blob()).then(b => { keep(id, meta.modifiedTime, b); return b; }));
        bodyCache.set(id, { mt: meta.modifiedTime, blob });
        blob.catch(() => { if (bodyCache.get(id) && bodyCache.get(id).blob === blob) bodyCache.delete(id); });
        return blob;
      };
      return { name, type: mimeOf(name), size: +meta.size || 0, lastModified: Date.parse(meta.modifiedTime) || 0,
        text: async () => (await load()).text(), arrayBuffer: async () => (await load()).arrayBuffer(), blob: load };
    }
    async createWritable() {
      const parts = [], self = this;
      return {
        async write(d) { if (d && typeof d === 'object' && d.type === 'write') d = d.data; parts.push(d); },
        async truncate() { },
        async close() { await self._upload(new Blob(parts, { type: mimeOf(self.name) })); },
        async abort() { parts.length = 0; }
      };
    }
    async _upload(blob) {
      if (this.id && this.remembered && !checked.has(this.id)) await this._meta();   // never write into a remembered id without checking it first
      if (!this.id) {                                     // new file: someone else may have just made it; otherwise create it empty
        await this.parent._verify();
        const f = (await list(this.parent.id, this.name))[0];
        this.id = f ? f.id : (await json(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.name, mimeType: mimeOf(this.name), parents: [this.parent.id] }) })).id;
        idSet(this.parent.id, this.name, { id: this.id, mimeType: mimeOf(this.name) }); checked.add(this.id);
      }
      const meta = await json(`${UP}/files/${this.id}?uploadType=media&fields=${FIELDS}`, { method: 'PATCH', headers: { 'Content-Type': mimeOf(this.name) }, body: blob });
      bodyCache.set(this.id, { mt: meta.modifiedTime, blob: Promise.resolve(blob) });
      keep(this.id, meta.modifiedTime, blob);
    }
  }

  class DriveFolder {
    constructor(id, name, remembered) { this.kind = 'directory'; this.id = id; this.name = name; this.remembered = !!remembered; this.gen = gen; }
    async _find(name) { return (await list(this.id, name))[0] || null; }
    // A folder known only from a previous session — or any folder, once something on Drive was found moved or deleted —
    // is checked (once) before anything is looked up or created in it.
    async _verify() {
      if ((!this.remembered && this.gen === gen) || checked.has(this.id)) return;
      const f = await json(`${API}/files/${this.id}?fields=id,mimeType,trashed`).catch(e => { if (e.name === 'NotFoundError') return null; throw e; });
      if (!f || f.trashed || f.mimeType !== FOLDER) { idsForget(); throw new Error('Your Google Drive folders changed since last time — please try again.'); }
      checked.add(this.id);
    }
    async getDirectoryHandle(name, o) {
      const key = this.id + '/' + name; let f = folderCache.get(key);
      if (!f) { const r = idsGet()[key]; if (r && r.mimeType === FOLDER) return new DriveFolder(r.id, name, true); }
      if (!f) {
        await this._verify();
        f = await this._find(name);
        if (f && f.mimeType !== FOLDER) throw mismatch(name);
        if (!f) {
          if (!(o && o.create)) throw notFound(name);
          f = await json(`${API}/files?fields=${FIELDS}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [this.id] }) });
        }
        folderCache.set(key, f); idSet(this.id, name, f); checked.add(f.id);
      }
      return new DriveFolder(f.id, f.name);
    }
    async getFileHandle(name, o) {
      const r = idsGet()[this.id + '/' + name];
      if (r && r.mimeType !== FOLDER) return new DriveFile(r.id, name, this, true);
      await this._verify();
      const f = await this._find(name);
      if (f && f.mimeType === FOLDER) throw mismatch(name);
      if (!f && !(o && o.create)) throw notFound(name);
      if (f) { idSet(this.id, name, f); checked.add(f.id); }
      return new DriveFile(f ? f.id : null, name, this);
    }
    async *entries() {
      await this._verify();
      for (const f of await list(this.id)) {
        if (f.mimeType === FOLDER) { folderCache.set(this.id + '/' + f.name, f); yield [f.name, new DriveFolder(f.id, f.name)]; }
        else yield [f.name, new DriveFile(f.id, f.name, this)];
      }
    }
    async *keys() { for await (const [n] of this.entries()) yield n; }
    async *values() { for await (const [, h] of this.entries()) yield h; }
    [Symbol.asyncIterator]() { return this.entries(); }
    async removeEntry(name) {                             // moves it to the Drive trash (recoverable for 30 days)
      await this._verify();
      const f = await this._find(name); if (!f) return;
      await api(`${API}/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
      folderCache.delete(this.id + '/' + name); idDel(this.id, name); bodyDB.del(f.id);
    }
    async queryPermission() { return token() ? 'granted' : 'prompt'; }
    async requestPermission() { return token() ? 'granted' : signIn({ silent: wasSignedIn() }); }
    async isSameEntry(other) { return !!other && other.id === this.id; }
  }

  // The RCR folder: My Drive › Documents › RCR (remembered after the first time).
  async function root() {
    const saved = localStorage.getItem(ROOTK);
    if (saved) {
      try { const f = await json(`${API}/files/${saved}?fields=id,name,mimeType,trashed`); if (f.mimeType === FOLDER && !f.trashed) { checked.add(f.id); return new DriveFolder(f.id, f.name); } }
      catch (e) { if (e.name === 'AuthError') throw e; }
    }
    idsForget();                                          // the RCR folder itself changed: forget every remembered location
    let id = 'root';
    for (const n of ROOT_PATH) { const f = (await list(id, n)).find(x => x.mimeType === FOLDER); if (!f) { id = null; break; } id = f.id; }
    if (!id) {                                            // not at Documents › RCR: look for a folder named RCR anywhere
      const p = new URLSearchParams({ q: `name='RCR' and mimeType='${FOLDER}' and trashed=false`, fields: 'files(id,name)' });
      const all = (await json(`${API}/files?${p}`)).files || [];
      if (all.length !== 1) throw new Error(all.length ? 'There is more than one folder named RCR in your Google Drive.' : 'No folder named RCR was found in your Google Drive (expected My Drive › Documents › RCR).');
      id = all[0].id;
    }
    localStorage.setItem(ROOTK, id);
    return new DriveFolder(id, 'RCR');
  }

  // Update check: each published build carries <meta name="rcr-build">. When the app is opened or brought back
  // (an iPhone home-screen app has no refresh button), compare with the live copy and offer to reload.
  if (hosted) {
    if (/[?&]fresh=/.test(location.search)) history.replaceState(null, '', location.pathname + location.search.replace(/[?&]fresh=\d+/, '').replace(/^&/, '?') + location.hash);
    const cur = () => (document.querySelector('meta[name="rcr-build"]') || {}).content;
    let shown = false;
    const checkUpdate = async () => {
      if (shown || !cur() || document.visibilityState !== 'visible' || !navigator.onLine) return;
      try {
        const t = await (await fetch(location.pathname + '?update-check=' + Date.now(), { cache: 'no-store' })).text();
        const m = t.match(/<meta name="rcr-build" content="([^"]+)"/);
        if (m && m[1] !== cur()) { shown = true; showUpdate(); }
      } catch { }
    };
    const showUpdate = () => {
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(10px + env(safe-area-inset-top));z-index:90;background:#1d5fd1;color:#fff;border-radius:12px;padding:10px 12px 10px 16px;display:flex;gap:12px;align-items:center;font:600 14px/1.3 Segoe UI,system-ui,-apple-system,Arial,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35);width:max-content;max-width:94vw';
      b.innerHTML = '<span>🔄 A new version of RCR Shop is ready</span><button style="font:inherit;border:0;border-radius:8px;padding:8px 14px;background:#fff;color:#1d5fd1;cursor:pointer">Update now</button>';
      // ?fresh= makes the service worker fetch the new version instead of the saved copy (removed from the address again on load)
      b.querySelector('button').onclick = () => { location.href = location.pathname + '?fresh=' + Date.now() + location.hash; };
      document.body.appendChild(b);
    };
    document.addEventListener('visibilitychange', checkUpdate);
    window.addEventListener('load', () => setTimeout(checkUpdate, 3000));
    setInterval(checkUpdate, 10 * 60e3);
  }

  /* ---------- Gmail (read-only, opt-in): used by the dashboard's "Check Gmail" for Amazon / eBay order emails ---------- */
  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';
  const hasGmail = () => /gmail\.readonly/.test(localStorage.getItem('rcr-gscope') || '');
  async function gmail(path) {
    const t = token(); if (!t) throw new AuthError();
    const r = await fetch(GMAIL + path, { headers: { Authorization: 'Bearer ' + t } });
    if (r.status === 401) { localStorage.removeItem(TK); throw new AuthError(); }
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText; try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch { }
      const e = new Error('Gmail: ' + msg); if (r.status === 403) { e.name = 'GmailDenied'; localStorage.removeItem('rcr-gscope'); } throw e;
    }
    return r.json();
  }

  /* ---------- Google Calendar (opt-in): the dashboard keeps an "RCR Appointments" calendar in step with its appointments.
     Scope calendar.app.created = only calendars this app made; it can't see or change any other calendar. ---------- */
  const CAL = 'https://www.googleapis.com/calendar/v3/';
  const hasCal = () => /calendar\.app\.created/.test(localStorage.getItem('rcr-gscope') || '');
  async function gcal(path, method, body) {        // → JSON (null for 204), or throws; e.status holds Google's HTTP status
    const t = token(); if (!t) throw new AuthError();
    const r = await fetch(CAL + path, { method: method || 'GET', headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { localStorage.removeItem(TK); throw new AuthError(); }
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText; try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch { }
      const e = new Error('Google Calendar: ' + msg); e.status = r.status; if (r.status === 403 && /scope|permission/i.test(msg)) e.name = 'CalDenied'; throw e;
    }
    return r.status === 204 ? null : r.json();
  }

  /* ---------- Google Contacts / People API (opt-in): caller ID — the dashboard keeps an "RCR Customers" contact group in step
     with its customers. The scope can read all contacts, but the dashboard only ever changes or deletes contacts it made
     (they carry its own clientData "rcr" key). ---------- */
  const PEOPLE = 'https://people.googleapis.com/v1/';
  const hasContacts = () => /auth\/contacts(\s|$)/.test(localStorage.getItem('rcr-gscope') || '');
  async function people(path, method, body) {      // → JSON, or throws; e.status holds Google's HTTP status
    const t = token(); if (!t) throw new AuthError();
    let r;
    for (let i = 0; i < 4; i++) {                    // Google asks to slow down now and then: wait and retry
      r = await fetch(PEOPLE + path, { method: method || 'GET', headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (r.status !== 429 && r.status < 500) break;
      await new Promise(res => setTimeout(res, 1500 * (i + 1)));
    }
    if (r.status === 401) { localStorage.removeItem(TK); throw new AuthError(); }
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText; try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch { }
      const e = new Error('Google Contacts: ' + msg); e.status = r.status; if (r.status === 403 && /scope|permission|disabled|not been used/i.test(msg)) e.name = 'ContactsDenied'; throw e;
    }
    return r.status === 204 ? null : r.json();
  }

  window.RCRDrive = { hosted, base, root, signIn, signOut, user, wasSignedIn, signedIn: () => !!token(), minutesLeft, AuthError, hasGmail, gmail, hasCal, gcal, hasContacts, people };
})();
