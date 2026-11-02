// ブラウザ版（PWA）で core.js（Apps Script 版の Code.gs と同じもの）を動かすための、Google のサービスの代わり。
//   - SpreadsheetApp：表はブラウザのメモリに持つ（スプレッドシートは使わない。ドライブにはファイルで置く：main.js）
//   - PropertiesService：表の中の「（ツール用）設定」シートに入れる（データと一緒に保存され、パソコンとスマホで共有される）
//   - Session・Logger：ログインした人のアドレスと、ログ
// Gmail は非同期なので、ここでは扱わない（google.js の runGmailStepsAsync が core.js の collectSteps に答える）
(function () {
  'use strict';

  const SETTINGS_SHEET = '（ツール用）設定';

  /**
   * シート1枚。data は 2次元の配列（1行目が見出し）。
   * 書き戻しのために覚えておくこと：
   *   synced … 前に Googleドライブ と合わせたときの行数（これより下に足しただけなら、足した行だけ書く）
   *   full   … synced より上を書き換えた・消した（全部書き直す）
   *   fmt    … 見出しの固定・列を隠す・選択肢などを変えた
   */
  function makeSheet(name, data, opt) {
    opt = opt || {};
    const s = {
      name, data: (data || []).map(r => r.slice()), maxRows: opt.maxRows || 1000,
      sheetId: opt.sheetId == null ? null : opt.sheetId, synced: opt.synced || 0, full: !!opt.full, fmt: !!opt.fmt, created: !!opt.created,
      meta: opt.meta || { frozen: 0, hidden: false, hiddenCols: {}, widths: {}, rules: {} },
    };
    const width = () => Math.max(1, ...s.data.map(r => r.length));
    const cell = (r, c) => (s.data[r - 1] || [])[c - 1];
    const touch = r => { if (r <= s.synced) s.full = true; };
    const put = (r, c, v) => {
      if (typeof v === 'string' && v.startsWith("'")) v = v.slice(1); // 「'」で始まる文字は、そのまま文字として入れる（Googleの表と同じ）
      if (v === undefined || v === null) v = '';
      touch(r);
      s.data[r - 1] = s.data[r - 1] || [];
      s.data[r - 1][c - 1] = v;
    };
    // 下の空の行は持たない（getLastRow を Googleの表と同じにする）
    const trim = () => { while (s.data.length && !(s.data[s.data.length - 1] || []).some(v => v !== '' && v !== undefined)) s.data.pop(); };
    const range = (r, c, nr = 1, nc = 1) => {
      const rg = {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) { const v = cell(r + i, c + j); row.push(v === undefined ? '' : v); }
            out.push(row);
          }
          return out;
        },
        getValue() { const v = cell(r, c); return v === undefined ? '' : v; },
        setValues(v) {
          if (v.length !== nr || v.some(row => row.length !== nc)) throw new Error('setValues の大きさが範囲と合いません（' + s.name + '）');
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) put(r + i, c + j, v[i][j]);
          trim();
          return rg;
        },
        setValue(v) { put(r, c, v); trim(); return rg; },
        clearContent() {
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (s.data[r - 1 + i] && s.data[r - 1 + i][c - 1 + j] !== undefined) { touch(r + i); s.data[r - 1 + i][c - 1 + j] = ''; }
          trim();
          return rg;
        },
        // 選択肢（列ごとに覚える）・チェックボックス
        setDataValidation(rule) {
          for (let j = 0; j < nc; j++) s.meta.rules[c + j] = { row: r, rows: nr, list: rule && rule.list ? rule.list.slice() : null, strict: !!(rule && rule.strict) };
          s.fmt = true;
          return rg;
        },
        insertCheckboxes() {
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) { const v = cell(r + i, c + j); if (v === undefined || v === '') put(r + i, c + j, false); }
          for (let j = 0; j < nc; j++) s.meta.rules[c + j] = { row: r, rows: nr, checkbox: true };
          s.fmt = true;
          trim();
          return rg;
        },
        setFontWeight() { return rg; }, setBackground() { return rg; }, setNumberFormat() { return rg; },
      };
      return rg;
    };
    Object.assign(s, {
      getName: () => s.name,
      setName(n) { s.name = n; s.renamed = true; return s; },
      getRange: (a, b, c, d) => range(a, b, c, d),
      getDataRange: () => range(1, 1, Math.max(1, s.data.length), width()),
      getLastRow: () => s.data.length,
      getLastColumn: () => (s.data.length ? width() : 0),
      getMaxRows: () => Math.max(s.maxRows, s.data.length),
      clearContents() { if (s.data.length) { s.data = []; s.full = true; } return s; },
      deleteRow(r) { if (r <= s.data.length) { s.data.splice(r - 1, 1); s.full = true; trim(); } return s; },
      setFrozenRows(n) { s.meta.frozen = n; s.fmt = true; return s; },
      hideColumns(c, k) { for (let i = 0; i < (k || 1); i++) s.meta.hiddenCols[c + i] = true; s.fmt = true; return s; },
      hideSheet() { s.meta.hidden = true; s.fmt = true; return s; },
      setColumnWidth(c, px) { s.meta.widths[c] = px; s.fmt = true; return s; },
      setConditionalFormatRules() { return s; }, // 色分けはブラウザ版では書き戻さない
    });
    // Apps Script 版のテスト（mock.js）と同じ名前で、列ごとの選択肢を見られるように
    Object.defineProperty(s, 'dv', { get: () => s.meta.rules });
    return s;
  }

  /** スプレッドシート（Googleドライブ の表1つ）。sheets は 名前 → シート（並びは入れた順） */
  function makeSpreadsheet(id, url) {
    const ss = {
      id: id || 'local', url: url || '', sheets: {},
      getId: () => ss.id,
      getUrl: () => ss.url,
      getSheets: () => Object.values(ss.sheets).filter(x => x),
      getSheetByName: n => Object.values(ss.sheets).find(x => x && x.name === n) || null,
      insertSheet(n, index) {
        const sh = makeSheet(n, [], { created: true, full: true });
        if (index === 0) {
          const rest = ss.sheets;
          ss.sheets = { [n]: sh };
          for (const k in rest) if (k !== n) ss.sheets[k] = rest[k];
        } else {
          ss.sheets[n] = sh;
        }
        return sh;
      },
    };
    return ss;
  }

  // ----- core.js が使う Google のサービスの代わり -----

  let CURRENT = null; // 今使っているスプレッドシート
  let USER_EMAIL = '';

  const rule = {};
  ['whenFormulaSatisfied', 'setFontColor', 'setBackground', 'setRanges'].forEach(k => { rule[k] = () => rule; });
  rule.build = () => ({});

  window.SpreadsheetApp = {
    getActiveSpreadsheet: () => CURRENT,
    openById: id => (CURRENT && id === CURRENT.id ? CURRENT : null),
    create: () => CURRENT,
    newConditionalFormatRule: () => rule,
    newDataValidation: () => {
      const b = { list: null, strict: true, requireValueInList(l) { b.list = l; return b; }, setAllowInvalid(a) { b.strict = !a; return b; },
        build: () => ({ list: b.list, strict: b.strict }) };
      return b;
    },
  };

  /** 設定は「（ツール用）設定」シートの A列（キー）・B列（値）。なければ作って隠す */
  function settingsSheet() {
    let sh = CURRENT.getSheetByName(SETTINGS_SHEET);
    if (!sh) {
      sh = CURRENT.insertSheet(SETTINGS_SHEET);
      sh.getRange(1, 1, 1, 2).setValues([['キー', '値']]);
      sh.hideSheet();
    }
    return sh;
  }
  window.PropertiesService = {
    getUserProperties: () => ({
      getProperty(k) {
        if (!CURRENT) return null;
        const row = settingsSheet().getDataRange().getValues().slice(1).find(r => r[0] === k);
        return row ? String(row[1]) : null;
      },
      setProperty(k, v) {
        const sh = settingsSheet();
        const rows = sh.getDataRange().getValues();
        const i = rows.findIndex((r, n) => n > 0 && r[0] === k);
        if (i > 0) { if (String(rows[i][1]) !== String(v)) sh.getRange(i + 1, 2).setValue(String(v)); } else sh.getRange(rows.length + 1, 1, 1, 2).setValues([[k, String(v)]]);
      },
    }),
  };
  window.Session = { getEffectiveUser: () => ({ getEmail: () => USER_EMAIL }) };
  window.Logger = { log: m => console.log('[就活カレンダー]', m) };
  window.HtmlService = { createTemplate() { throw new Error('ブラウザ版では使いません'); } };
  window.GmailApp = {
    search() { throw new Error('ブラウザ版では GmailApp は使えません（runGmailStepsAsync を使う）'); },
    getMessagesForThreads() { throw new Error('ブラウザ版では GmailApp は使えません'); },
  };

  window.PwaSheets = {
    SETTINGS_SHEET, makeSheet, makeSpreadsheet,
    // テストで、ほかのまねに入れかえたあと元に戻すため
    services: { SpreadsheetApp: window.SpreadsheetApp, PropertiesService: window.PropertiesService, Session: window.Session, Logger: window.Logger },
    use(ss) { CURRENT = ss; },
    current: () => CURRENT,
    setUser(email) { USER_EMAIL = email || ''; },
    user: () => USER_EMAIL,
  };
})();
