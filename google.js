// Google とのやり取り（ブラウザから直接。あいだにサーバーは置かない）
//   - ログイン：Google Identity Services の「通行証（アクセストークン）」。1時間ほどで切れるので、切れたら取り直す
//   - Gmail：core.js の collectSteps の問い合わせに、Gmail API で答える（runGmailStepsAsync）
//   - 保存：本人の Googleドライブ の「アプリ専用の場所」（appDataFolder）にファイルを置く。ドライブの一覧には出ず、ほかのファイルも見えない

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

// ----- ログイン -----

let tokenClient = null;
let token = null, expiresAt = 0;
let waiting = null; // 取り直し中の通行証を待っている人
let hint = '';

/** ログインの準備（Google のログインの部品が読み込まれてから） */
export function initAuth(clientId, loginHint) {
  hint = loginHint || '';
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: resp => {
      const w = waiting; waiting = null;
      if (!w) return;
      if (resp.error) { w.reject(new Error('ログインできませんでした（' + resp.error + '）')); return; }
      // 「Gmail を読む」などのチェックを外して許可されたとき
      const granted = String(resp.scope || '').split(' ');
      const missing = SCOPES.split(' ').filter(s => !granted.includes(s));
      if (missing.length) { w.reject(new Error('Gmail とドライブの両方を許可してください（許可の画面で、チェックを全部入れて「続行」）')); return; }
      token = resp.access_token;
      expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      w.resolve(token);
    },
    error_callback: err => {
      const w = waiting; waiting = null;
      if (w) w.reject(new Error(err && err.type === 'popup_closed' ? 'ログインの画面が閉じられました' : 'ログインの画面を開けませんでした（ポップアップを許可してください）'));
    },
  });
}

export function setLoginHint(email) { hint = email || hint; }
export function hasValidToken() { return !!token && Date.now() < expiresAt - 60000; }

/**
 * 通行証をもらう。切れていたら Google の画面を出す。
 * ボタンを押したその場で呼ぶこと（あとから呼ぶと、ブラウザがポップアップを止める）
 */
export function ensureToken() {
  if (hasValidToken()) return Promise.resolve(token);
  if (!tokenClient) return Promise.reject(new Error('ログインの準備ができていません。少し待ってから、もう一度押してください'));
  if (waiting) return waiting.promise;
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  waiting = { resolve, reject, promise };
  tokenClient.requestAccessToken({ prompt: '', login_hint: hint || undefined });
  return promise;
}

/** ログアウト（このアプリへの許可を取り消す） */
export function signOut() {
  if (token && window.google && window.google.accounts) window.google.accounts.oauth2.revoke(token, () => {});
  token = null; expiresAt = 0;
}

// テストで使う：通行証と fetch を差しかえる
let fetchImpl = (...a) => window.fetch(...a);
export function _setForTest({ fetch, accessToken, limits, retryMs, simpleMax, netRetryMs, adaptive }) {
  if (simpleMax) SIMPLE_MAX = simpleMax;
  if (netRetryMs) NET_RETRY_MS = netRetryMs;
  if (fetch) fetchImpl = fetch;
  if (accessToken) { token = accessToken; expiresAt = Date.now() + 3600e3; }
  PERSIST = false; // テストで覚えた量を、本物のアプリに残さない
  if (limits) { LIMITS = limits.map(l => l.slice()); ADAPTIVE = !!adaptive; lastLimitAt = lastChangeAt = -1e9; }
  if (retryMs) RETRY_MS = retryMs;
  gmailUsed.length = 0;
  pausedUntil = 0;
}

// ----- 問い合わせ -----

const sleep = ms => new Promise(r => setTimeout(r, ms));
const params = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

export class ApiError extends Error {
  constructor(status, body, url) { super(apiMessage(status, body, url)); this.status = status; this.body = body; }
}
/** エラーの文：何をしていて（Gmail・ドライブ）、Google が何と言ったか（原因を探すため、英語のままつける） */
function apiMessage(status, body, url) {
  const where = /gmail/.test(url || '') ? 'Gmail' : /drive/.test(url || '') ? 'Googleドライブ' : 'Google';
  let said = '';
  try { const e = JSON.parse(body).error; said = (e.message || '') + (e.errors && e.errors[0] && e.errors[0].reason ? '［' + e.errors[0].reason + '］' : ''); } catch (e) { said = String(body || '').slice(0, 200); }
  const tail = '\n（' + where + '・' + status + '：' + said + '）';
  if (status === 401) return 'ログインの期限が切れました。もう一度ボタンを押してください' + tail;
  if (status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/.test(body)) return 'Google Cloud で、' + (where === 'Gmail' ? 'Gmail API' : 'Google Drive API') + ' を「有効」にしてください（有効にしてから数分かかることがあります）' + tail;
  if (status === 403 && /insufficient|SCOPE/i.test(body)) return where + ' を使う許可がありません。一度ログアウトして、許可の画面でチェックを全部入れて許可してください' + tail;
  if (status === 403) return where + ' に断られました' + tail;
  if (status === 429) return 'Google への問い合わせが多すぎます。しばらくたってから、もう一度お試しください' + tail;
  return where + ' とのやり取りでエラーになりました' + tail;
}

// Gmail には、1人あたりの上限が2つある：1秒間に 250・1分間に 15,000（問い合わせごとの量：一覧 10・スレッド 10・プロフィール 1）。
// どちらも少し余裕をもたせた量（LIMITS）を超えそうなら、超えないところまで待ってから問い合わせる。
// （前は1分間の上限だけを見ていて、同時に8つ問い合わせると1秒間の上限を超え、上限のエラーで長く待っていた）
let LIMITS = [[1000, 150], [60000, 12000]]; // [何ミリ秒のあいだに, どれだけまで]
// 実際には、説明より少ない量で「1分間の上限」のエラーが出る（1分に2,000も使わないうちに出た）。
// なので、エラーが出たら「そのとき1分間に使っていた量の8割」まで下げ、しばらくエラーが出なければ少しずつ上げる（ADAPTIVE）。
// 覚えた量は端末に保存して、次の更新はその量から始める
let ADAPTIVE = true, PERSIST = true;
const BUDGET_KEY = 'gmailMinuteBudget';
let lastLimitAt = -1e9, lastChangeAt = -1e9; // 最後に上限のエラーで下げた時刻・最後に量を変えた時刻
try { const b = Number(localStorage.getItem(BUDGET_KEY)); if (b >= 200 && b <= 12000) LIMITS[1][1] = b; } catch (e) { /* 覚えていなければ説明どおりの量から */ }
function saveBudget() { if (PERSIST) try { localStorage.setItem(BUDGET_KEY, String(LIMITS[1][1])); } catch (e) { /* 覚えられなくても動く */ } }
/** 上限のエラーが出た：1分間に使ってよい量を、そのとき使っていた量の8割に下げる */
function lowerBudget() {
  if (!ADAPTIVE) return;
  const now = performance.now(), [win, budget] = LIMITS[1];
  if (now - lastLimitAt < win / 30) return; // 同時に問い合わせていて続けて出たエラー（1分なら2秒以内）は、1回と数える（下げすぎないように）
  const used = gmailUsed.filter(x => now - x[0] <= win).reduce((s, x) => s + x[1], 0);
  LIMITS[1][1] = Math.max(Math.ceil(budget / 20), Math.min(budget, Math.round(used * 0.8)));
  lastLimitAt = lastChangeAt = now;
  saveBudget();
}
/** エラーが出ないまま1分たっていて、量いっぱいまで使っているなら、1割ずつ上げる（説明の量 12,000 まで） */
function raiseBudget(now, usedInMinute) {
  if (!ADAPTIVE || now - lastChangeAt < LIMITS[1][0]) return;
  const budget = LIMITS[1][1];
  if (budget >= 12000 || usedInMinute < budget * 0.9) return;
  LIMITS[1][1] = Math.min(12000, Math.ceil(budget * 1.1));
  lastChangeAt = now; // 上げたら、また1分ようすを見る
  saveBudget();
}
// 同時に問い合わせる数。Gmail には「1人が同時にいくつまで」の上限もある（スレッドを本文までまとめて受け取ると1つが長くかかるので、少なめに）
const PARALLEL = 3;
let RETRY_MS = 2000, NET_RETRY_MS = 1000;   // 上限のエラー・つながらなかったときの、最初の待ち時間（やり直すたびに2倍）。テストでは短くする
const gmailUsed = []; // [時刻, 量]（時刻は performance.now。テストで Date を止めても進む）
let pausedUntil = 0;  // 上限のエラーが出たら、しばらくみんな待つ（同時に問い合わせているほかのものも）
let onWait = null;    // 待っているあいだ、画面に知らせる
export function setWaitListener(fn) { onWait = fn; }
function gmailCost(url) {
  if (/\/profile/.test(url)) return 1;
  return 10; // threads の一覧・スレッド（中のメールの本文まで受け取っても10）
}
// 前回の読み取りの数字（どこで時間がかかったかを見るため）：開いたスレッド・開かなかったスレッド・新しく読んだメール・
// 上限で待った時間（同時にいくつ待っていても、時計の上での時間）・上限のエラーの回数と、Gmail が言った理由
export const stats = { opened: 0, skipped: 0, read: 0, waitedMs: 0, limitErrors: 0, limitReason: '', byType: {} };
// 問い合わせの種類ごとの回数と、上限のエラーの回数（どれが「重い」かを見るため）：検索（一覧）・スレッドを開く
const callType = url => (/\/threads\?/.test(url) ? '検索' : /\/threads\//.test(url) ? 'スレッドを開く' : /\/profile/.test(url) ? 'プロフィール' : 'そのほか');
function count(url, key) {
  const t = stats.byType[callType(url)] = stats.byType[callType(url)] || { calls: 0, errors: 0 };
  t[key]++;
}
/** 今、1分間に使ってよいことにしている量（覚えた量） */
export const minuteBudget = () => LIMITS[1][1];
let waiters = 0, waitSince = 0;
async function waitFor(ms) {
  if (!waiters++) waitSince = performance.now();
  try { await sleep(ms); } finally { if (!--waiters) stats.waitedMs += performance.now() - waitSince; }
}
async function reserveGmail(cost) {
  for (;;) {
    const now = performance.now();
    const longest = Math.max(...LIMITS.map(l => l[0]));
    while (gmailUsed.length && now - gmailUsed[0][0] > longest) gmailUsed.shift();
    raiseBudget(now, gmailUsed.filter(x => now - x[0] <= LIMITS[1][0]).reduce((s, x) => s + x[1], 0));
    // 上限のそれぞれについて、あと何ミリ秒待てば入るか
    let wait = Math.max(0, pausedUntil - now);
    for (const [win, budget] of LIMITS) {
      const inWin = gmailUsed.filter(x => now - x[0] <= win);
      let used = inWin.reduce((s, x) => s + x[1], 0);
      let k = 0;
      while (used + cost > budget && k < inWin.length) { used -= inWin[k][1]; wait = Math.max(wait, win - (now - inWin[k][0]) + 5); k++; }
    }
    if (!wait) { gmailUsed.push([now, cost]); return; }
    if (wait > 1500 && onWait) onWait(Math.ceil(wait / 1000));
    await waitFor(wait);
  }
}
const isRateLimit = (status, body) => status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded|Quota exceeded/i.test(body));

/** Google に問い合わせる。混んでいる・回数の上限に当たったときは、待ってやり直す。opt.raw なら中身を Blob で返す */
async function api(url, opt = {}) {
  const gmail = /gmail\.googleapis\.com/.test(url);
  for (let attempt = 0; ; attempt++) {
    if (gmail) { await reserveGmail(gmailCost(url)); count(url, 'calls'); }
    const json = opt.body && typeof opt.body === 'string';
    const headers = Object.assign({ Authorization: 'Bearer ' + token }, json ? { 'Content-Type': 'application/json' } : {}, opt.headers || {});
    let res;
    try {
      res = await fetchImpl(url, Object.assign({}, opt, { headers }));
    } catch (e) {
      // つながらなかった（ネットが一瞬切れた・Google が途中で応答をやめた）：少し待ってやり直す
      if (attempt < 4) { await sleep(NET_RETRY_MS * 2 ** attempt); continue; }
      const where = /gmail/.test(url) ? 'Gmail' : /drive|upload/.test(url) ? 'Googleドライブ' : 'Google';
      throw new Error(where + ' につながりませんでした。ネットの接続を確かめて、もう一度押してください（' + e.message + '：' + url.split('?')[0].replace(/^https:\/\/[^/]+/, '') + '）');
    }
    if (opt.response) return res; // 中身ではなく、返事そのもの（大きいファイルの保存で、送り先を知るため）
    if (res.ok) return res.status === 204 ? null : opt.raw ? res.blob() : res.json();
    const body = await res.text();
    // 回数の上限：少し待ってやり直す（2秒・4秒・8秒…。何度もなら、あきらめてエラー）。同時に問い合わせているほかのものも待たせる
    if (isRateLimit(res.status, body) && attempt < 6) {
      const wait = RETRY_MS * 2 ** attempt;
      if (gmail) { lowerBudget(); count(url, 'errors'); }
      pausedUntil = Math.max(pausedUntil, performance.now() + wait);
      if (wait > 1500 && onWait) onWait(Math.ceil(wait / 1000));
      stats.limitErrors++;
      try { const e = JSON.parse(body).error; stats.limitReason = (e.message || '').slice(0, 160); } catch (e) { stats.limitReason = String(body).slice(0, 160); }
      await waitFor(wait);
      continue;
    }
    if (res.status >= 500 && attempt < 4) { await sleep(600 * 2 ** attempt); continue; }
    if (res.status === 401) { token = null; expiresAt = 0; }
    throw new ApiError(res.status, body, url);
  }
}

/** list の一つずつに fn を、同時に n 個まで */
async function pool(list, n, fn) {
  let i = 0;
  const worker = async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
}

// ----- Gmail -----

export async function getProfileEmail() {
  const p = (await api(GMAIL + 'profile?fields=emailAddress')) || {};
  return String(p.emailAddress || '').toLowerCase();
}

/**
 * core.js の collectSteps を、Gmail API で答えながら最後まで進める（Apps Script 版の runGmailSteps のブラウザ版）。
 * cachedIds：保存済みのメールの id（中身を取り直さない）。onProgress(読んだメールの数) で進み具合を知らせる。
 * known：スレッドの id → 前に開いたときのスレッドの状態（historyId）。変わっていないスレッドは、新しいメールがないので開かない。
 *   開いたスレッドの状態は known に書き足す（呼んだ人が保存して、次の更新で渡す）
 */
export async function runGmailStepsAsync(steps, cachedIds, onProgress, known) {
  known = known || {};
  Object.assign(stats, { opened: 0, skipped: 0, read: 0, waitedMs: 0, limitErrors: 0, limitReason: '', byType: {} });
  const pages = new Map();  // 検索の言葉 → 見つかったスレッド（ページをめくって足していく）
  const threads = new Map(); // スレッドの id → { last（いちばん新しいメールの日時）, ids（下書きを除くメールの id。まだ開いていなければ null）, history }
  let read = 0;
  /** スレッドを開いて、メールの id と日時を見る（中身はまだ取らない） */
  // スレッドは、中のメールの本文までまとめて受け取る（Gmail の量はスレッド1つで10。メールを1通ずつ取ると、1通ごとに5かかる）
  const open = async t => {
    const th = (await api(GMAIL + 'threads/' + t.id + '?' + params({ format: 'full', fields: 'id,historyId,messages(id,internalDate,labelIds,payload)' }))) || {};
    const msgs = (th.messages || []).filter(m => !(m.labelIds || []).includes('DRAFT'));
    const fresh = msgs.filter(m => !cachedIds.has(m.id));
    read += fresh.length;
    stats.opened++;
    stats.read += fresh.length;
    if (fresh.length && onProgress) onProgress(read);
    threads.set(t.id, { last: Math.max(0, ...msgs.map(m => Number(m.internalDate) || 0)), ids: msgs.map(m => m.id), history: th.historyId || t.historyId,
      full: new Map(fresh.map(m => [m.id, toMessage(m)])) });
  };
  let step = steps.next();
  while (!step.done) {
    const q = step.value;
    let answer;
    if (q.search != null) {
      const list = await searchThreads(pages, q.search, q.start + q.max);
      const slice = list.slice(q.start, q.start + q.max);
      // 前に開いたときから変わっていないスレッドは開かない（新しいメールがないので、collectSteps は飛ばす）
      for (const t of slice) if (!threads.has(t.id) && t.historyId && known[t.id] === t.historyId) { threads.set(t.id, { last: 0, ids: null, history: t.historyId }); stats.skipped++; }
      await pool(slice.filter(t => !threads.has(t.id)), PARALLEL, open);
      answer = slice.map(t => ({ getId: () => t.id, getLastMessageDate: () => new Date(threads.get(t.id).last) }));
    } else {
      // 変わっていないのに開くことになったスレッド（保存したメールが消えていたときなど）は、ここで開く
      await pool(q.threads.filter(t => !threads.get(t.getId()).ids).map(t => ({ id: t.getId(), historyId: threads.get(t.getId()).history })), PARALLEL, open);
      // 保存していないメールは、開いたときに受け取った中身を返す（保存済みのものは id だけ返す。collectSteps は id を見て飛ばす）
      answer = q.threads.map(t => { const th = threads.get(t.getId()); return th.ids.map(id => th.full.get(id) || { getId: () => id }); });
    }
    step = steps.next(answer);
  }
  // スレッドの状態を覚える。ただし途中で止まったときは、新しいメールがなかったスレッドだけ
  // （新しいメールを保存しきれなかったスレッドを「変わっていない」と覚えると、次から読まれなくなるため）
  const finished = !(step.value && step.value.stopped);
  for (const [id, t] of threads) {
    if (t.history && (finished || !t.ids || t.ids.every(x => cachedIds.has(x)))) known[id] = t.history;
  }
  return step.value;
}

async function searchThreads(pages, q, need) {
  let p = pages.get(q);
  if (!p) { p = { list: [], token: undefined, done: false }; pages.set(q, p); }
  while (!p.done && p.list.length < need) {
    // 見つからなかったときなど、Gmail が中身のない返事（204）をすることがあるので、空の結果として扱う
    const r = (await api(GMAIL + 'threads?' + params({ q, maxResults: 100, pageToken: p.token, fields: 'threads(id,historyId),nextPageToken' }))) || {};
    p.list.push(...(r.threads || []));
    p.token = r.nextPageToken;
    if (!p.token) p.done = true;
  }
  return p.list;
}

/** Gmail API のメール（format=full）を、Apps Script の GmailMessage と同じ形に */
export function toMessage(m) {
  const head = name => (((m.payload || {}).headers || []).find(h => h.name.toLowerCase() === name) || {}).value || '';
  const body = plainBody(m.payload || {});
  return {
    getId: () => m.id, getDate: () => new Date(Number(m.internalDate)), getFrom: () => head('from'), getSubject: () => head('subject'), getPlainBody: () => body,
  };
}

/** 本文：text/plain があればそれ、なければ text/html を文字にしたもの（Apps Script の getPlainBody と同じ考え） */
export function plainBody(payload) {
  const parts = [];
  const walk = p => {
    if (!p) return;
    const isFile = p.filename && p.filename.length;
    if (!isFile && p.body && p.body.data && /^text\/(plain|html)/i.test(p.mimeType || '')) parts.push(p);
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const plain = parts.find(p => /^text\/plain/i.test(p.mimeType));
  if (plain) return decodePart(plain);
  const html = parts.find(p => /^text\/html/i.test(p.mimeType));
  return html ? htmlToText(decodePart(html)) : '';
}

/** 本文の中身（base64url）を文字に。文字コードは Content-Type の charset（iso-2022-jp・shift_jis なども） */
export function decodePart(p) {
  const ct = (((p.headers || []).find(h => h.name.toLowerCase() === 'content-type') || {}).value) || p.mimeType || '';
  const charset = ((ct.match(/charset="?([^";\s]+)"?/i) || [])[1] || 'utf-8').toLowerCase();
  const b64 = p.body.data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try { return new TextDecoder(charset).decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
}

/** HTML のメールを文字だけに（改行は残す） */
export function htmlToText(html) {
  const marked = String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n');
  const doc = new DOMParser().parseFromString(marked, 'text/html');
  return (doc.body ? doc.body.textContent : '').replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ----- Googleドライブ の「アプリ専用の場所」 -----
// ファイルは2つ：data.json.gz（表・タスク・締切まとめなど。毎回保存）と mails.json.gz（読み込み済みメール。増えたときだけ保存）

/** アプリ専用の場所にあるファイル：名前 → { id, modifiedTime } */
export async function listAppFiles() {
  const r = (await api(DRIVE + '?' + params({ spaces: 'appDataFolder', fields: 'files(id,name,modifiedTime)', pageSize: 100 }))) || {};
  const out = {};
  for (const f of r.files || []) if (!out[f.name] || f.modifiedTime > out[f.name].modifiedTime) out[f.name] = { id: f.id, modifiedTime: f.modifiedTime };
  return out;
}

/** 文字を gzip で小さくする・もとに戻す（読み込み済みメールは本文が多いので、5分の1くらいになる） */
export async function gzip(text) {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
export async function gunzip(blob) {
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

/** アプリ専用の場所のファイルを全部消す（もとに戻せない）。返り値は消した数 */
export async function deleteAppFiles() {
  const r = (await api(DRIVE + '?' + params({ spaces: 'appDataFolder', fields: 'files(id)', pageSize: 100 }))) || {};
  for (const f of r.files || []) await api(DRIVE + '/' + f.id, { method: 'DELETE' });
  return (r.files || []).length;
}

export async function downloadText(id) {
  return gunzip(await api(DRIVE + '/' + id + '?alt=media', { raw: true }));
}

// 1回で送れるのは 5MB まで（Google の決まり）。それより大きいファイルは「大きいファイル用」（resumable）で送る
let SIMPLE_MAX = 4.5 * 1024 * 1024;

/** ファイルを保存する（id がなければ作る）。返り値は { id, modifiedTime } */
export async function uploadText(name, id, text) {
  const body = await gzip(text);
  if (body.size > SIMPLE_MAX) return uploadLarge(name, id, body);
  if (id) {
    return api(UPLOAD + '/' + id + '?' + params({ uploadType: 'media', fields: 'id,modifiedTime' }), { method: 'PATCH', body, headers: { 'Content-Type': 'application/gzip' } });
  }
  const boundary = 'shukatsu' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
  const multipart = new Blob([
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n',
    '--' + boundary + '\r\nContent-Type: application/gzip\r\n\r\n', body, '\r\n--' + boundary + '--',
  ]);
  return api(UPLOAD + '?' + params({ uploadType: 'multipart', fields: 'id,modifiedTime' }), { method: 'POST', body: multipart, headers: { 'Content-Type': 'multipart/related; boundary=' + boundary } });
}

/** 大きいファイル：まず「これから送る」と伝えて送り先をもらい、そこへ中身を送る */
async function uploadLarge(name, id, body) {
  const url = (id ? UPLOAD + '/' + id : UPLOAD) + '?' + params({ uploadType: 'resumable', fields: 'id,modifiedTime' });
  const res = await api(url, {
    method: id ? 'PATCH' : 'POST', body: JSON.stringify(id ? {} : { name, parents: ['appDataFolder'] }), response: true,
    headers: { 'X-Upload-Content-Type': 'application/gzip', 'X-Upload-Content-Length': String(body.size) },
  });
  if (!res.ok) throw new ApiError(res.status, await res.text(), url);
  const target = res.headers.get('Location');
  if (!target) throw new Error('大きいファイルを保存できませんでした（Google から送り先が返ってきませんでした）');
  return api(target, { method: 'PUT', body, headers: { 'Content-Type': 'application/gzip' } });
}
