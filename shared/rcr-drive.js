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
      location.href = base + '?signin=1' + (opts && opts.silent ? '&silent=1' : '') + '&ret=' + encodeURIComponent(ret);
    }
    return new Promise(() => {});
  }
  function signOut() { localStorage.removeItem(TK); localStorage.removeItem(USERK); localStorage.removeItem(ROOTK); location.href = base; }
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

  class DriveFile {
    constructor(id, name, parent) { this.kind = 'file'; this.id = id; this.name = name; this.parent = parent; }
    async getFile() {                                     // a File-like object; the content downloads only when read
      if (!this.id) throw notFound(this.name);
      const meta = await json(`${API}/files/${this.id}?fields=${FIELDS}`), id = this.id, name = this.name;
      const load = () => {                                // one download per version, even when asked for twice at once
        const c = bodyCache.get(id); if (c && c.mt === meta.modifiedTime) return c.blob;
        const blob = api(`${API}/files/${id}?alt=media`).then(r => r.blob());
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
      if (!this.id) {                                     // new file: someone else may have just made it; otherwise create it empty
        const f = (await list(this.parent.id, this.name))[0];
        this.id = f ? f.id : (await json(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.name, mimeType: mimeOf(this.name), parents: [this.parent.id] }) })).id;
      }
      const meta = await json(`${UP}/files/${this.id}?uploadType=media&fields=${FIELDS}`, { method: 'PATCH', headers: { 'Content-Type': mimeOf(this.name) }, body: blob });
      bodyCache.set(this.id, { mt: meta.modifiedTime, blob: Promise.resolve(blob) });
    }
  }

  class DriveFolder {
    constructor(id, name) { this.kind = 'directory'; this.id = id; this.name = name; }
    async _find(name) { return (await list(this.id, name))[0] || null; }
    async getDirectoryHandle(name, o) {
      const key = this.id + '/' + name; let f = folderCache.get(key);
      if (!f) {
        f = await this._find(name);
        if (f && f.mimeType !== FOLDER) throw mismatch(name);
        if (!f) {
          if (!(o && o.create)) throw notFound(name);
          f = await json(`${API}/files?fields=${FIELDS}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [this.id] }) });
        }
        folderCache.set(key, f);
      }
      return new DriveFolder(f.id, f.name);
    }
    async getFileHandle(name, o) {
      const f = await this._find(name);
      if (f && f.mimeType === FOLDER) throw mismatch(name);
      if (!f && !(o && o.create)) throw notFound(name);
      return new DriveFile(f ? f.id : null, name, this);
    }
    async *entries() {
      for (const f of await list(this.id)) {
        if (f.mimeType === FOLDER) { folderCache.set(this.id + '/' + f.name, f); yield [f.name, new DriveFolder(f.id, f.name)]; }
        else yield [f.name, new DriveFile(f.id, f.name, this)];
      }
    }
    async *keys() { for await (const [n] of this.entries()) yield n; }
    async *values() { for await (const [, h] of this.entries()) yield h; }
    [Symbol.asyncIterator]() { return this.entries(); }
    async removeEntry(name) {                             // moves it to the Drive trash (recoverable for 30 days)
      const f = await this._find(name); if (!f) return;
      await api(`${API}/files/${f.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
      folderCache.delete(this.id + '/' + name);
    }
    async queryPermission() { return token() ? 'granted' : 'prompt'; }
    async requestPermission() { return token() ? 'granted' : signIn({ silent: wasSignedIn() }); }
    async isSameEntry(other) { return !!other && other.id === this.id; }
  }

  // The RCR folder: My Drive › Documents › RCR (remembered after the first time).
  async function root() {
    const saved = localStorage.getItem(ROOTK);
    if (saved) {
      try { const f = await json(`${API}/files/${saved}?fields=id,name,mimeType,trashed`); if (f.mimeType === FOLDER && !f.trashed) return new DriveFolder(f.id, f.name); }
      catch (e) { if (e.name === 'AuthError') throw e; }
    }
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

  window.RCRDrive = { hosted, base, root, signIn, signOut, user, wasSignedIn, signedIn: () => !!token(), minutesLeft, AuthError };
})();
