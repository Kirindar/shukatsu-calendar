// ブラウザ版（PWA）の本体。
//   - 開いたら、端末に保存した前回のデータから画面を出す（見るだけならログインしない）
//   - ボタンを押したら：ログイン → ほかの端末で変わっていれば読み直す → core.js の関数を動かす → ドライブに保存 → 端末に保存
//   - 画面は core.js の PAGE_HTML（Apps Script 版と同じ）。中の google.script.run を、ここの call につなぐ
//   - データはメモリの表（sheet.js）で扱い、ドライブの「アプリ専用の場所」に2つのファイルで置く（スプレッドシートは使わない）
//   - 初めての人：読まない就活サイトを選ぶ → 裏でメールを読みながら、使い方の説明（tour.js）。
//     最初の更新は、まず最近1週間だけ読んで画面に出し、そのあと裏で残り（60日前まで）を読む
import * as G from './google.js';
import * as store from './store.js';
import { startTour } from './tour.js';
import { CLIENT_ID } from './config.js';

const SNAP = 'snapshot';
const DATA_FILE = 'data.json.gz';   // 表・タスク・締切まとめ・設定など
const MAIL_FILE = 'mails.json.gz';  // 読み込み済みメール（大きいので、増えたときだけ保存）
// 画面から呼べる core.js の関数（Apps Script 版で google.script.run から呼ぶもの）
const ACTIONS = ['refreshFromWeb', 'resolveReview', 'resolveCandidate', 'resolveDeadline', 'addTask', 'doneTask', 'addCompany',
  'updateCompany', 'deleteCompany', 'setBlocked', 'addBlocked', 'removeBlocked', 'importAll', 'exportAll', 'removeAutoAdded', 'restoreRemoved',
  'hideUndecided', 'unhideUndecided', 'restoreDeadline'];
const READ_ONLY = ['exportAll']; // ログインも保存もいらない
const FIRST_DAYS = 7;               // 最初の更新で、まず読む日数（読めたら画面に出し、残りは裏で読む）
const $ = id => document.getElementById(id);
const ORIGINAL_COLLECT = window.collectMails;

let SS = null; // 今のデータ（メモリの表）
// ログインしたアドレスと、ドライブのファイル（id・最後に保存した日時。ほかの端末で変わったかを見る）・前回の更新にかかった時間
let INFO = { email: '', dataId: '', dataTime: '', mailId: '', mailTime: '', lastTiming: '' };

// core.js を、ブラウザ版の表で動かす
CONFIG.SOURCE_ID = '';                  // 前の版の表から移す機能は使わない
CONFIG.READ_LIMIT_SEC = 900;            // Apps Script のような6分の制限がないので、1回で読み終わるよう長めに（途中で止まると、次の更新で同じ範囲を調べ直すため）
window.getSpreadsheet = () => SS;
const THREADS_KEY = 'THREAD_HISTORY';   // スレッドの id → 前に開いたときの状態（設定に入れて、データと一緒に保存する）

// ----- 順番待ち：メールを読む・保存するなど、データを変える処理は1つずつ（裏で読んでいるあいだに押されたボタンは、終わってから動く） -----
let queue = Promise.resolve();
let queued = 0;
let readingRest = false;                // 最初の更新の残りを裏で読んでいるあいだ
let firstReading = false;               // 最初の更新（最近1週間＋残り）のあいだ。「メールから更新」は押せない
let actionQueue = Promise.resolve();    // そのあいだに押されたボタン（ボタンどうしは1つずつ）
function inOrder(fn) {
  queued++;
  const run = queue.then(fn, fn).finally(() => { queued--; });
  queue = run.catch(() => {});
  return run;
}

// ----- 画面 -----

function showWelcome(message) {
  $('app').hidden = true;
  $('setup').hidden = true;
  $('welcome').hidden = false;
  $('welcome-error').textContent = message || '';
  $('no-client').hidden = !!CLIENT_ID;
  $('start').disabled = !CLIENT_ID;
}

/** core.js の画面（PAGE_HTML）を出す。中の google.script.run は、親（この画面）の PWA.runner につなぐ */
function showApp() {
  $('welcome').hidden = true;
  $('setup').hidden = true;
  const frame = $('app');
  const data = JSON.stringify(getData()).replace(/</g, '\\u003c');
  const bridge = '<script>window.google = { script: { get run() { return parent.PWA.runner(); } } };</script>';
  // 画面の上に「アカウント」ボタン。裏で読み終わったときに、画面のデータを入れかえる入り口（PWA_SET）
  const extra = '<script>(function () { var h = document.querySelector("header"); if (h) { var b = document.createElement("button"); b.textContent = "アカウント"; b.onclick = function () { parent.PWA.menu(); }; h.insertBefore(b, document.getElementById("status")); }' +
    ' window.PWA_SET = function (d) { DATA = d; render(); }; })();</script>';
  frame.srcdoc = PAGE_HTML.replace('<?!= data ?>', data).replace('<head>', '<head>' + bridge).replace('</body>', extra + '</body>');
  frame.hidden = false;
  return new Promise(resolve => { frame.onload = () => { lockRefresh(); resolve(frame); }; });
}

// 使い方の説明のあいだは、（例）の会社の見本を画面に出す。そのあいだに読み終わった本当のデータは、説明が終わってから出す
let touring = false, pendingData = null;

/** 画面のデータを入れかえる（裏で読み終わったとき） */
function setData(data, force) {
  if (touring && !force) { pendingData = data; return; }
  try { const w = $('app').contentWindow; if (w && w.PWA_SET) w.PWA_SET(data); } catch (e) { /* 画面がなければ、次に開いたときに出る */ }
  lockRefresh();
}

/**
 * 最初の更新のあいだは、画面の「メールから更新」を押せなくする（ほかのボタンは動く）。
 * 画面はボタンの処理が終わるたびに全部のボタンを押せるように戻すので、そのあとにも呼ぶ
 */
function lockRefresh() {
  try {
    const btn = $('app').contentDocument.getElementById('refresh');
    if (!btn) return;
    if (firstReading) {
      if (!btn.dataset.locked) btn.dataset.locked = btn.dataset.label || btn.textContent;
      btn.disabled = true;
      btn.textContent = 'メールを読み込み中…';
      btn.title = '最初のメールを読み終わると押せるようになります';
    } else if (btn.dataset.locked) {
      btn.disabled = false;
      btn.textContent = btn.dataset.locked;
      btn.title = '';
      delete btn.dataset.locked;
    }
  } catch (e) { /* 画面がなければ何もしない */ }
}

/**
 * 使い方の説明で見せる、（例）の会社の画面のデータ。本当のデータとは別の表で作る（保存しない）。
 * ここは途中で待たない（裏でメールを読んでいても、そのあいだに本当の表が入れかわらない）
 */
function sampleData() {
  const real = SS;
  const ss = PwaSheets.makeSpreadsheet('sample', '');
  useSS(ss);
  try {
    setupSheet();
    const day = (n, h = 23, m = 59) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, m, 0, 0); return d; };
    const row = o => HEADER.map(h => { const k = Object.keys(COL).find(c => COL[c] === h); return o[k] === undefined ? '' : o[k]; });
    const rows = [
      { name: '（例）サンプル商事', kind: '本選考', state: '選考中', step: 'ES', slot: '締切', when: day(2) },
      { name: '（例）テック株式会社', kind: '本選考', state: '選考中', step: '1次面接', slot: '日程', when: day(4, 14, 0) },
      { name: '（例）コンサルティング', kind: '夏期インターン', state: '選考中', step: '2次面接', slot: '日程調整' },
      { name: '（例）メーカー', kind: '本選考', state: '選考中', step: '結果待ち', owned: JSON.stringify({ step: '結果待ち', slot: '', when: null, done: '2次面接', at: day(-5, 10, 0).getTime() }) },
      { name: '（例）不動産', kind: '本選考', state: 'NG' },
    ];
    ss.getSheetByName(CONFIG.SHEET_NAME).getRange(2, 1, rows.length, HEADER.length).setValues(rows.map(row));
    addTask('（例）サンプル商事', '履歴書を書く', day(1, 20, 0).toISOString());
    const dl = sheetWithHeader(ss, CONFIG.DEADLINE_SHEET, DEADLINE_HEADER);
    saveDeadlines(dl, [{ key: 'example-bank|本選考|エントリー', name: '（例）銀行', label: 'エントリー', when: day(6), status: '', subject: '【（例）銀行】本エントリー締切のご案内',
      url: '', sender: 'example.jp', kind: '本選考', alias: '', mailAt: day(-1).getTime(), firstAt: day(-1).getTime(), decidedAt: 0 }]);
    const cand = sheetWithHeader(ss, CONFIG.CANDIDATE_SHEET, CANDIDATE_HEADER);
    // （例）テック株式会社は、メールから自動で表に入れた会社（会社タブに「自動」の印）
    cand.getRange(2, 1, 1, CANDIDATE_HEADER.length).setValues([['example-tech', '（例）テック株式会社', '本選考', 'example.jp', '【（例）テック株式会社】一次面接 日程確定のご連絡', '1次面接', day(4, 14, 0), '', '自動で追加', 1, '', '', day(-2)]]);
    // 予定の記録（過ぎた予定。カレンダーにうすく、結果つきで出る）
    const hist = sheetWithHeader(ss, CONFIG.HISTORY_SHEET, HISTORY_HEADER);
    hist.getRange(2, 1, 2, HISTORY_HEADER.length).setValues([
      ['example-hist-1', day(-6, 15, 0).getTime(), '（例）メーカー', '本選考', '1次面接', '選考', '通過', day(-4, 10, 0).getTime(), ''],
      ['example-hist-2', day(-5, 10, 0).getTime(), '（例）メーカー', '本選考', '2次面接', '選考', '', 0, ''],
    ]);
    const rev = sheetWithHeader(ss, CONFIG.REVIEW_SHEET, REVIEW_HEADER);
    rev.getRange(2, 1, 1, REVIEW_HEADER.length).setValues([['example-review', day(-1, 9, 0), '（例）テック株式会社', '（例）テック株式会社｜本選考', '1次面接', day(5, 10, 0), '',
      'あなたが手で書いた日程（' + (day(4).getMonth() + 1) + '/' + day(4).getDate() + ' 14:00）と、メールの日程がちがう', '', '未確認', '日程']]);
    return getData();
  } finally {
    useSS(real);
  }
}

/** 進み具合：処理中の知らせ（画面の下）と、画面の上の帯（裏で読んでいるとき） */
function hint(text) {
  try { const d = $('app').contentDocument; const el = d && d.getElementById('busy-hint'); if (el) el.textContent = text; } catch (e) { /* 出せなくても動く */ }
  if (!$('progress').hidden) $('progress-text').textContent = text;
}
function progress(text, done) {
  $('progress').hidden = !text;
  $('progress').className = 'progress' + (done ? ' done' : '');
  $('progress-text').textContent = text || '';
  if (done) setTimeout(() => { if ($('progress-text').textContent === text) $('progress').hidden = true; }, 6000);
}

// ----- 保存・ドライブとの行き来 -----

function useSS(ss) { SS = ss; PwaSheets.use(SS); }

async function saveLocal() {
  await store.set(SNAP, store.toSnapshot(SS, INFO));
}

/** ほかの端末で保存されていたら、ドライブのファイルを読み直す（force なら必ず） */
async function syncIn(force) {
  const files = await G.listAppFiles();
  const d = files[DATA_FILE], m = files[MAIL_FILE];
  const needData = d && (force || d.modifiedTime !== INFO.dataTime);
  const needMail = m && (force || m.modifiedTime !== INFO.mailTime);
  if (!needData && !needMail) return;
  if (needMail) hint('ほかの端末で読んだメールを取りこんでいます…');
  const [dataText, mailText] = await Promise.all([needData ? G.downloadText(d.id) : null, needMail ? G.downloadText(m.id) : null]);
  useSS(store.rebuild(SS, dataText, mailText));
  store.markSaved(SS);
  if (d) Object.assign(INFO, { dataId: d.id, dataTime: d.modifiedTime });
  if (m) Object.assign(INFO, { mailId: m.id, mailTime: m.modifiedTime });
}

/**
 * ドライブに保存する（読み込み済みメールは、増えたときだけ）。保存は1つずつ（裏の読み取りとボタンの保存が重なっても、
 * あとから保存するほうが、その時点の新しい中身で保存する）
 */
let saving = Promise.resolve();
function syncOut() {
  const run = saving.then(saveNow);
  saving = run.catch(() => {});
  return run;
}
async function saveNow() {
  const jobs = [G.uploadText(DATA_FILE, INFO.dataId, store.packData(SS)).then(f => { INFO.dataId = f.id; INFO.dataTime = f.modifiedTime; })];
  if (store.mailsChanged(SS) || !INFO.mailId) jobs.push(G.uploadText(MAIL_FILE, INFO.mailId, store.packMails(SS)).then(f => { INFO.mailId = f.id; INFO.mailTime = f.modifiedTime; }));
  await Promise.all(jobs);
  store.markSaved(SS);
  await saveLocal();
}

/** 最初の1回：ログインして、ドライブにデータがあれば読み込む（なければ表を作る） */
async function connect() {
  const email = await G.getProfileEmail();
  INFO = { email, dataId: '', dataTime: '', mailId: '', mailTime: '', lastTiming: '' };
  PwaSheets.setUser(email);
  G.setLoginHint(email);
  useSS(PwaSheets.makeSpreadsheet('local', ''));
  await syncIn(true);
  if (!SS.getSheetByName(CONFIG.SHEET_NAME)) setupSheet();
  await syncOut();
}

const isFirstRun = () => !Number(PropertiesService.getUserProperties().getProperty('LAST_RUN') || 0);

// ----- メールを読む -----

/** メールを Gmail から集めておく（core.js の update は、collectMails の代わりにこの結果を使う） */
async function prefetch(full, label) {
  const now = new Date();
  const table = readTable(SS);
  const blocked = readBlocked(SS);
  const cachedIds = new Set(readCache(SS).map.keys());
  const props = PropertiesService.getUserProperties();
  let known = {};
  try { known = JSON.parse(props.getProperty(THREADS_KEY) || '{}'); } catch (e) { known = {}; }
  hint('Gmail を読んでいます' + label + '…');
  const result = await G.runGmailStepsAsync(collectSteps(SS, table.rows, full, now, blocked), cachedIds, n => hint('Gmail を読んでいます' + label + '… 新しいメール ' + n + ' 通'), known);
  // 保存済みのメールがないスレッドは忘れる（古くなって消えたスレッドを、いつまでも覚えておかない）
  const live = new Set([...readCache(SS).map.values()].map(d => d.thread));
  for (const id in known) if (!live.has(id)) delete known[id];
  props.setProperty(THREADS_KEY, JSON.stringify(known));
  return result;
}

/** Gmail に問い合わせず、保存済みのメールだけで表を作り直す（表に会社を足したときなど）。「読み終わった」しるしは付けない */
function cacheOnly(ss, rows, full, now, blocked) {
  return { stopped: true, mails: savedMails(readCache(ss), now, blocked), info: '保存済みのメールだけ' };
}

/** メールを読んで表に反映し、保存する。どこに何秒かかったかを覚える（アカウントのメニューに出す） */
async function readAndSave(full, label) {
  const sec = ms => Math.round(ms / 100) / 10 + '秒';
  const t0 = performance.now();
  const result = await prefetch(full, label);
  const t1 = performance.now();
  const s = Object.assign({}, G.stats);
  window.collectMails = () => result;
  let data;
  try { hint('画面に反映しています…'); data = refreshFromWeb(full); } finally { window.collectMails = ORIGINAL_COLLECT; }
  const t2 = performance.now();
  hint('Googleドライブ に保存しています…');
  await syncOut();
  const t3 = performance.now();
  const line = (label ? label.replace(/[（）]/g, '') + '：' : '') + '全部 ' + sec(t3 - t0) + '（Gmail ' + sec(t1 - t0) + '［上限で待った ' + sec(s.waitedMs) + '・上限のエラー ' + s.limitErrors + '回' +
    '・開いたスレッド ' + s.opened + '・変わっていなくて開かなかったスレッド ' + s.skipped + '・新しいメール ' + s.read + '通・1分間に使う量 ' + G.minuteBudget() + '］・表に反映 ' + sec(t2 - t1) + '・保存 ' + sec(t3 - t2) + '）' +
    // 問い合わせの種類ごと：回数（そのうち上限のエラー）
    '　内訳：' + Object.entries(s.byType).map(([k, v]) => k + ' ' + v.calls + '回（エラー ' + v.errors + '）').join('・') +
    (s.limitReason ? '　Gmail の理由：' + s.limitReason : '');
  // 最初の更新は2回に分けて読むので、両方の時間を出す（最近1週間 → もっと前のメール）
  INFO.lastTiming = label === '（もっと前のメール）' && /^最近1週間/.test(INFO.lastTiming) ? INFO.lastTiming + '\n' + line : line;
  console.log('[就活カレンダー] 更新にかかった時間', INFO.lastTiming);
  await saveLocal();
  return data;
}

/**
 * 最初の更新：まず最近1週間だけ読んで反映・保存し（onFirst に画面のデータを渡す）、そのあと残り（60日前まで）を読む。
 * 2回目は、1回目に開いたスレッドを開かないので、読むのは古いほうだけ。
 * 残りは順番待ちに並べて { rest }（終わったら画面のデータ）で返す（ここで待つと、順番待ちの中で自分を待って止まるため）
 */
async function firstRead(onFirst) {
  const keep = { DAYS: CONFIG.DAYS, CANDIDATE_DAYS: CONFIG.CANDIDATE_DAYS };
  let data;
  firstReading = true;
  lockRefresh();
  Object.assign(CONFIG, { DAYS: FIRST_DAYS, CANDIDATE_DAYS: FIRST_DAYS });
  try { data = await readAndSave(true, '（最近1週間）'); } catch (e) { firstReading = false; lockRefresh(); throw e; } finally { Object.assign(CONFIG, keep); }
  onFirst(data);
  // 残りを読んでいるあいだ（数分かかる）も、「メールから更新」のほかのボタンはすぐ動くようにする（readingRest）
  readingRest = true;
  const rest = inOrder(() => readAndSave(true, '（もっと前のメール）'));
  rest.finally(() => { readingRest = false; firstReading = false; lockRefresh(); });
  return { rest };
}

/** 最初の更新の残りが終わったら、画面に出して知らせる */
function whenRestDone(rest) {
  progress('最近1週間のメールを画面に出しました。もっと前のメールも読んでいます…');
  rest.then(d => { setData(d); progress('メールを読み終わりました', true); })
    .catch(e => progress('もっと前のメールを読めませんでした：' + e.message + '（「メールから更新」でやり直せます）'));
}

/** 裏で最初の更新をする（使い方の説明を見ているあいだなど）。進み具合は画面の上の帯に出す */
function firstReadInBackground() {
  progress('メールを読んでいます（最近1週間）…');
  return inOrder(() => firstRead(setData)).then(r => whenRestDone(r.rest))
    .catch(e => progress('メールを読めませんでした：' + e.message + '（右上の「メールから更新」でやり直せます）'));
}

// ----- core.js の関数を呼ぶ（画面の google.script.run から） -----

/**
 * 画面のボタンから呼ばれる。fn は core.js の関数の名前（refreshFromWeb・resolveDeadline など）。
 * ログインの画面は、ボタンを押したその場で出す必要があるので、最初に ensureToken を呼ぶ
 */
function call(fn, args) {
  if (!ACTIONS.includes(fn)) return Promise.reject(new Error('わからない操作です: ' + fn));
  // 説明のあいだの画面は（例）の見本なので、ボタンは動かさない
  if (touring) return Promise.reject(new Error('使い方の説明のあいだは、ボタンは動きません（見本の画面です）。説明が終わってから押してください'));
  if (READ_ONLY.includes(fn)) return new Promise(resolve => resolve(window[fn](...args)));
  if (firstReading && fn === 'refreshFromWeb') return Promise.reject(new Error('最初のメールを読み込んでいます。読み終わってから押してください'));
  const tokenReady = CLIENT_ID ? G.ensureToken() : Promise.reject(new Error('設定がまだです（config.js にクライアント ID を入れてください）'));
  // 最初の更新の残り（もっと前のメール）を裏で読んでいるあいだは、ボタンは待たせずにすぐ動かす。
  // 同じ表（SS）を直すので、読み終わったときの反映にも、ここで直したことが入る。ほかの端末からの読み直しはしない（読み取り中の表を入れかえないため）
  if (readingRest && fn !== 'refreshFromWeb') {
    const run = actionQueue.then(async () => {
      await tokenReady;
      window.collectMails = cacheOnly;
      let data;
      try { data = window[fn](...args); } finally { window.collectMails = ORIGINAL_COLLECT; }
      hint('Googleドライブ に保存しています…');
      await syncOut();
      return data;
    });
    actionQueue = run.catch(() => {});
    return run;
  }
  if (queued) hint('前の処理（メールの読み取りなど）が終わるのを待っています…');
  return inOrder(async () => {
    await tokenReady;
    if (!INFO.email) { INFO.email = await G.getProfileEmail(); PwaSheets.setUser(INFO.email); }
    await syncIn(false);
    if (fn === 'refreshFromWeb') {
      // 初めての更新は、最近1週間を読んだら画面に出し、残りは裏で読む
      if (isFirstRun()) {
        let first;
        const r = await firstRead(d => { first = d; });
        whenRestDone(r.rest);
        return first;
      }
      return readAndSave(!!args[0], '');
    }
    window.collectMails = cacheOnly;
    let data;
    try { data = window[fn](...args); } finally { window.collectMails = ORIGINAL_COLLECT; }
    hint('Googleドライブ に保存しています…');
    await syncOut();
    return data;
  });
}

/** 画面の中の google.script.run の代わり（withSuccessHandler・withFailureHandler・関数の呼び出し） */
function runner() {
  const h = { ok: () => {}, ng: () => {} };
  const r = new Proxy({}, {
    get(t, k) {
      if (k === 'withSuccessHandler') return f => { h.ok = f; return r; };
      if (k === 'withFailureHandler') return f => { h.ng = f; return r; };
      return (...args) => {
        call(String(k), args).then(d => h.ok(d), e => h.ng(e instanceof Error ? e : new Error(String(e))))
          .finally(lockRefresh); // 画面がボタンを全部押せるように戻したあとで、もう一度押せなくする
      };
    },
  });
  return r;
}

// ----- はじめの設定（読まない就活サイト）→ 使い方の説明 -----

function showSetup() {
  $('welcome').hidden = true;
  $('app').hidden = true;
  $('setup').hidden = false;
  const box = $('setup-list'); box.replaceChildren();
  for (const b of getData().blockList || []) {
    const lb = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = b.on; cb.dataset.sender = b.sender; cb.dataset.was = b.on ? '1' : '';
    const name = document.createElement('span'); name.textContent = b.memo || b.sender;
    const dom = document.createElement('small'); dom.textContent = b.sender;
    lb.append(cb, name, dom);
    box.append(lb);
  }
}

/** はじめの設定を終える：選んだサイトを反映 → 画面を出す → 裏でメールを読み始める → 使い方の説明 */
async function finishSetup() {
  for (const cb of $('setup-list').querySelectorAll('input')) {
    if (cb.checked !== !!cb.dataset.was) setBlocked(cb.dataset.sender, cb.checked);
  }
  const frame = await showApp();
  firstReadInBackground();
  tour(frame);
}

/** 使い方の説明：そのあいだは（例）の会社で見せ、終わったら本当のデータに戻す */
function tour(frame) {
  touring = true;
  pendingData = null;
  setData(sampleData(), true);
  startTour(frame || $('app'), () => {
    touring = false;
    setData(pendingData || getData(), true);
    pendingData = null;
    // 説明でいろいろなタブを開いたので、終わったら「タスク」に戻す
    try { const t = $('app').contentDocument.querySelector('[data-pane="todo"]'); if (t) t.click(); window.scrollTo(0, 0); $('app').contentWindow.scrollTo(0, 0); } catch (e) { /* 戻せなくても動く */ }
    try { localStorage.setItem('tourDone', '1'); } catch (e) { /* 覚えられなくても動く */ }
  });
}

$('setup-next').onclick = () => { $('setup-next').disabled = true; finishSetup().finally(() => { $('setup-next').disabled = false; }); };
// 前のデータ（Apps Script 版で書き出したファイル）を読み込んでから始める
$('setup-import').onclick = () => $('setup-file').click();
$('setup-file').onchange = () => {
  const f = $('setup-file').files[0];
  $('setup-file').value = '';
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      importAll(String(reader.result));
      $('setup-import-done').textContent = f.name + ' を読み込みました。';
      showSetup();
    } catch (e) { $('setup-import-done').textContent = '読み込めませんでした：' + e.message; }
  };
  reader.readAsText(f);
};

// ----- アカウントのメニュー -----

function menu() {
  $('menu-email').textContent = INFO.email || '（まだログインしていません）';
  $('menu-timing').textContent = INFO.lastTiming ? '前回の更新にかかった時間：' + INFO.lastTiming : '';
  $('menu').hidden = false;
}
$('menu-close').onclick = () => { $('menu').hidden = true; };
$('menu-tour').onclick = () => { $('menu').hidden = true; tour(); };
$('menu-signout').onclick = async () => {
  if (!confirm('この端末からログアウトして、この端末に保存したデータを消しますか？（Googleドライブ のデータは消えません。もう一度ログインすれば戻ります）')) return;
  G.signOut();
  await store.del(SNAP);
  SS = null; INFO = { email: '', dataId: '', dataTime: '', mailId: '', mailTime: '', lastTiming: '' };
  $('menu').hidden = true;
  showWelcome();
};

// データを全部消す（検証用：最初の更新を、まっさらな状態から試すため）。もとに戻せないので2回確かめる
$('menu-wipe').onclick = () => {
  if (!confirm('Googleドライブ に保存したデータ（会社一覧・タスク・締切まとめ・読み込み済みメールなど）と、この端末の保存を、全部消しますか？\n\nもとに戻せません。残したいときは、先に「設定」→「書き出す」でファイルに保存してください。')) return;
  if (!confirm('本当に消しますか？')) return;
  const tokenReady = CLIENT_ID ? G.ensureToken() : Promise.reject(new Error('設定がまだです')); // ボタンを押したその場で
  const btn = $('menu-wipe');
  btn.disabled = true;
  btn.textContent = '消しています…';
  inOrder(() => tokenReady.then(() => G.deleteAppFiles())).then(async n => {
    await store.del(SNAP);
    SS = null; INFO = { email: INFO.email, dataId: '', dataTime: '', mailId: '', mailTime: '', lastTiming: '' };
    $('menu').hidden = true;
    progress('');
    showWelcome();
    $('welcome-error').textContent = 'データを消しました（ドライブのファイル ' + n + ' 個）。「Googleでログインして始める」で、まっさらな状態から始められます。';
  }).catch(e => alert('消せませんでした：' + e.message)).finally(() => { btn.disabled = false; btn.textContent = 'データを全部消す（ドライブの分も）'; });
};

// ----- はじめる -----

$('start').onclick = () => {
  const tokenReady = G.ensureToken(); // ボタンを押したその場で
  $('start').disabled = true;
  $('welcome-error').textContent = '';
  $('welcome-busy').hidden = false;
  tokenReady.then(connect)
    // まだ一度もメールを読んでいなければ、はじめの設定から。読んだことがあれば（ほかの端末で使っていた）すぐ画面へ
    .then(() => (isFirstRun() ? showSetup() : showApp()))
    .catch(e => showWelcome(e.message))
    .finally(() => { $('welcome-busy').hidden = true; $('start').disabled = !CLIENT_ID; });
};

window.PWA = { runner, menu, call };
// Gmail の1分間の上限に近くて待っているとき
G.setWaitListener(sec => hint('Gmail の1分間に読める量の上限に近いので、' + sec + '秒ほど待ってから続きを読みます…（初めての更新は時間がかかります）'));

/** Google のログインの部品が読み込まれるのを待つ */
function whenGis() {
  return new Promise(resolve => {
    const check = () => (window.google && window.google.accounts && window.google.accounts.oauth2 ? resolve() : setTimeout(check, 100));
    check();
  });
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  let snap = null;
  try { snap = await store.get(SNAP); } catch (e) { snap = null; }
  if (snap && snap.sheets) {
    useSS(store.fromSnapshot(snap));
    INFO = { email: snap.email || '', dataId: snap.dataId || '', dataTime: snap.dataTime || '', mailId: snap.mailId || '', mailTime: snap.mailTime || '', lastTiming: snap.lastTiming || '' };
    PwaSheets.setUser(INFO.email);
    showApp();
  } else {
    showWelcome();
  }
  if (CLIENT_ID) whenGis().then(() => G.initAuth(CLIENT_ID, INFO.email));
}

boot();
