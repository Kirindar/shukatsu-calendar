// 端末の中に、前回の表を保存しておく（開いたらすぐ表示する。見るだけならログインしない）。
// 日時（Date）もそのまま入る IndexedDB を使う（localStorage は小さすぎて、読み込み済みメールが入らない）

const DB = 'shukatsu-calendar';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const get = key => run('readonly', s => s.get(key));
export const set = (key, value) => run('readwrite', s => s.put(value, key));
export const del = key => run('readwrite', s => s.delete(key));

// ----- Googleドライブ に置くファイルの中身 -----
// 日時は { $date: ミリ秒 }（「書き出す」で作るファイルと同じ書き方）
const packRows = rows => rows.map(r => r.map(v => (v instanceof Date ? { $date: v.getTime() } : v)));
const unpackRows = rows => (rows || []).map(r => r.map(v => (v && typeof v === 'object' && '$date' in v ? new Date(v.$date) : v)));

/** 表・タスク・締切まとめ・設定など（読み込み済みメールのほか全部） */
export function packData(ss) {
  return JSON.stringify({ app: 'shukatsu-calendar', version: 1, savedAt: new Date().toISOString(),
    sheets: ss.getSheets().filter(s => s.name !== CONFIG.CACHE_SHEET).map(s => ({ name: s.name, rows: packRows(s.data) })) });
}
/** 読み込み済みメール */
export function packMails(ss) {
  const s = ss.getSheetByName(CONFIG.CACHE_SHEET);
  return JSON.stringify({ app: 'shukatsu-calendar', version: 1, rows: s ? packRows(s.data) : [] });
}

/**
 * ドライブから読んだ中身で、表を作り直す。data・mails はどちらかだけでもよい（ないほうは、今の表のものを使う）
 */
export function rebuild(old, dataText, mailsText) {
  const ss = PwaSheets.makeSpreadsheet('local', '');
  const add = (name, rows) => { ss.sheets[name] = PwaSheets.makeSheet(name, rows, { synced: rows.length }); };
  if (dataText) {
    for (const s of JSON.parse(dataText).sheets || []) add(s.name, unpackRows(s.rows));
  } else if (old) {
    for (const s of old.getSheets()) if (s.name !== CONFIG.CACHE_SHEET) ss.sheets[s.name] = s;
  }
  if (mailsText) add(CONFIG.CACHE_SHEET, unpackRows(JSON.parse(mailsText).rows));
  else if (old && old.getSheetByName(CONFIG.CACHE_SHEET)) ss.sheets[CONFIG.CACHE_SHEET] = old.getSheetByName(CONFIG.CACHE_SHEET);
  return ss;
}

/** 読み込み済みメールが、前にドライブに置いたときから変わったか */
export function mailsChanged(ss) {
  const s = ss.getSheetByName(CONFIG.CACHE_SHEET);
  return !!s && (s.full || s.created || s.data.length !== s.synced);
}
/** ドライブに置いたので、変わったしるしを消す */
export function markSaved(ss) {
  for (const s of ss.getSheets()) { s.synced = s.data.length; s.full = false; s.created = false; s.fmt = false; s.renamed = false; }
}

/** メモリの表 → 端末に保存する形（シートの値と、ドライブに置いたかの覚え書き）。extra はログインしたアドレス・ドライブのファイルの id など */
export function toSnapshot(ss, extra) {
  return Object.assign({
    id: ss.id, url: ss.url, savedAt: Date.now(),
    sheets: ss.getSheets().map(s => ({
      name: s.name, data: s.data, sheetId: s.sheetId, synced: s.synced, full: s.full, fmt: s.fmt, created: s.created, renamed: !!s.renamed,
      meta: s.meta, gridRows: s.gridRows, gridCols: s.gridCols, droppable: !!s.droppable,
    })),
  }, extra || {});
}

/** 保存した形 → メモリの表 */
export function fromSnapshot(snap) {
  const ss = PwaSheets.makeSpreadsheet(snap.id, snap.url);
  for (const x of snap.sheets || []) {
    const s = PwaSheets.makeSheet(x.name, x.data, { sheetId: x.sheetId, synced: x.synced, full: x.full, fmt: x.fmt, created: x.created, meta: x.meta });
    s.renamed = x.renamed; s.gridRows = x.gridRows; s.gridCols = x.gridCols; s.droppable = x.droppable;
    ss.sheets[x.name] = s;
  }
  return ss;
}
