// 使い方の説明（チュートリアル）：アプリの画面の上で、説明する場所だけ明るくして、吹き出しで説明する。「次へ」で進む。
// タブの説明では、そのタブを自動で開いて、下に出る一覧もいっしょに見せる（open）。まわりは暗い幕でおおい、押せないようにする
// 画面（core.js の PAGE_HTML）は iframe の中なので、その中の場所を探して、外側（この画面）に幕と吹き出しを重ねる

// 今出ているタブの一覧
const PANE = '.side .pane:not([hidden])';
// タブの説明：そのタブを開いて、タブと一覧をいっしょに明るくする
const tab = (pane, text) => ({ sel: '[data-pane="' + pane + '"]', area: PANE, open: '[data-pane="' + pane + '"]', text });

const STEPS = [
  { sel: '#grid', text: 'カレンダーです。タスク（赤）・予定（青）・一覧にない会社の締切（点線）が、日付ごとに出ます。' },
  // 予定のある日を開いて、その日の一覧を見せる
  { sel: '#day-list', open: doc => { const c = doc.querySelector('.day:not(.out) .chip'); return c && c.closest('.day'); },
    text: '日付を押すと、その日の締切・予定がここに出ます。行を押すと、会社・日時・メールへのリンクなど、くわしいことが出ます。' },
  tab('todo', '「タスク」：期限までに自分がやること（ESの提出・面接の予約・書類の提出など）。期限が近い順に並びます。「済」を押すと消えます。'),
  tab('dls', '「締切まとめ」：まだ受けていない会社（マイページに登録しただけの会社など）から届いた締切です。会社を押すと、締切ごとに「提出済み」「非表示」を選べます。'),
  tab('plans', '「予定」：面接・GD・面談など、その日時に参加するもの。'),
  tab('undecided', '「日程未定」：次の選考は決まったけれど、日にちがまだのもの。自分で日程を返す必要があるもの（要調整）は、画面の上の赤い帯でもお知らせします。気にしなくていい会社は「非表示」で隠せます（下の「非表示にした会社」から戻せます）。'),
  tab('waiting', '「結果待ち」：面接やESのあと、結果を待っているもの。何日たったかも出ます（2週間をすぎると黄色、3週間で赤）。'),
  tab('reviews', '「確認待ち」：メールの内容が、あなたが手で直した内容とちがうときなど、ツールが自信をもって書けないものです。「反映」か「却下」を選んでください。'),
  tab('companies', '「会社」：メールから見つけた会社が全部出ます。日程が決まった・通過したなど、選考が始まった会社は、メールから自動で入ります（「自動」の印）。関係ない会社が入ったら、行を押して「非表示」。上のボタンで選考中・内定などにしぼりこみ、会社名でさがせます。行を押して「編集」で、状況（NG・内定など）やメモを直せます。'),
  tab('stats', '「数字」：選考中・内定・NGの社数、今どの段階の会社が多いか、通過率が見られます。「画面の上にも出す」で、いつも上に出しておけます。'),
  { sel: '#add-co-open', text: 'マイページでしか連絡が来ない会社は、ここから自分で足せます。' },
  { sel: '#settings-open', text: '読まない送信元（就活サイトの宣伝など）、非表示にしたもの（戻せます）、データの書き出し・読み込みはここ。' },
  { sel: '#refresh', text: '新しいメールを読むときは、ここを押します。2回目からは、新しく届いたメールだけを読むので速く終わります。' },
];

let state = null;

/** 説明を始める。frame は画面の iframe。終わったら onEnd */
export function startTour(frame, onEnd) {
  stopTour();
  const root = document.createElement('div');
  root.className = 'tour';
  root.innerHTML = '<div class="shade" data-s="t"></div><div class="shade" data-s="l"></div><div class="shade" data-s="r"></div><div class="shade" data-s="b"></div>' +
    '<div class="ring"></div><div class="bubble" role="dialog" aria-live="polite"><div class="count"></div><div class="text"></div>' +
    '<div class="sample">説明のあいだは「（例）」の会社の見本で見せています。終わると、あなたのメールから読んだ内容に切りかわります。</div>' +
    '<div class="buttons"><button class="skip">説明をとばす</button><button class="next primary">次へ</button></div></div>';
  document.body.append(root);
  state = { frame, root, i: -1, onEnd };
  root.querySelector('.skip').onclick = () => end();
  root.querySelector('.next').onclick = () => go(state.i + 1);
  const win = frame.contentWindow;
  state.place = () => place();
  window.addEventListener('resize', state.place);
  win.addEventListener('resize', state.place);
  win.addEventListener('scroll', state.place, true);
  go(0);
}

export function stopTour() {
  if (!state) return;
  window.removeEventListener('resize', state.place);
  try { state.frame.contentWindow.removeEventListener('resize', state.place); state.frame.contentWindow.removeEventListener('scroll', state.place, true); } catch (e) { /* 画面が変わっていても止める */ }
  state.root.remove();
  state = null;
}

function end() {
  const cb = state && state.onEnd;
  stopTour();
  if (cb) cb();
}

function target() {
  const step = STEPS[state.i];
  return step && state.frame.contentDocument && state.frame.contentDocument.querySelector(step.sel);
}

function go(i) {
  if (!state) return;
  if (i >= STEPS.length) { end(); return; }
  state.i = i;
  const step = STEPS[i];
  const doc = state.frame.contentDocument;
  // 説明する場所を開く（タブを開く・予定のある日を選ぶ）
  const opener = typeof step.open === 'function' ? step.open(doc) : step.open && doc.querySelector(step.open);
  if (opener) opener.click();
  const el = target();
  if (!el) { go(i + 1); return; } // 画面にない場所はとばす
  // いっしょに見せる一覧があるときは、タブを画面の上のほうに（下に一覧が見えるように）
  el.scrollIntoView({ block: step.area ? 'start' : 'center', inline: 'center' });
  showArea(step);
  state.root.querySelector('.count').textContent = (i + 1) + ' / ' + STEPS.length;
  state.root.querySelector('.text').textContent = step.text;
  state.root.querySelector('.next').textContent = i === STEPS.length - 1 ? 'はじめる' : '次へ';
  setTimeout(place, 60);
}

/** いっしょに見せる一覧が画面の下にはみ出していたら、見えるところまでずらす（スマホで、タブの下の一覧が切れないように） */
function showArea(step) {
  const a = step.area && state.frame.contentDocument.querySelector(step.area);
  if (a) a.scrollIntoView({ block: 'nearest' });
}

/** 明るくする場所（説明する場所と、いっしょに見せる一覧）のまわりに幕を置き、吹き出しをそこにかぶらない位置に出す */
function place() {
  if (!state) return;
  const el = target();
  if (!el) return;
  const f = state.frame.getBoundingClientRect();
  const area = STEPS[state.i].area && state.frame.contentDocument.querySelector(STEPS[state.i].area);
  const rects = [el.getBoundingClientRect()].concat(area && !area.hidden ? [area.getBoundingClientRect()] : []);
  const r = { left: Math.min(...rects.map(q => q.left)), top: Math.min(...rects.map(q => q.top)), right: Math.max(...rects.map(q => q.right)), bottom: Math.max(...rects.map(q => q.bottom)) };
  r.width = r.right - r.left; r.height = r.bottom - r.top;
  const pad = 6;
  const x = Math.max(0, f.left + r.left - pad), y = Math.max(0, f.top + r.top - pad);
  const w = Math.min(window.innerWidth - x, r.width + pad * 2), h = Math.min(window.innerHeight - y, r.height + pad * 2);
  const s = k => state.root.querySelector('[data-s="' + k + '"]').style;
  Object.assign(s('t'), { left: '0', top: '0', width: '100%', height: y + 'px' });
  Object.assign(s('b'), { left: '0', top: (y + h) + 'px', width: '100%', height: Math.max(0, window.innerHeight - y - h) + 'px' });
  Object.assign(s('l'), { left: '0', top: y + 'px', width: x + 'px', height: h + 'px' });
  Object.assign(s('r'), { left: (x + w) + 'px', top: y + 'px', width: Math.max(0, window.innerWidth - x - w) + 'px', height: h + 'px' });
  Object.assign(state.root.querySelector('.ring').style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  const b = state.root.querySelector('.bubble');
  const bw = b.offsetWidth, bh = b.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight, gap = 12;
  const clampX = v => Math.max(8, Math.min(v, vw - bw - 8));
  const clampY = v => Math.max(8, Math.min(v, vh - bh - 8));
  // 明るい場所にかぶらない位置：下 → 上 → 右 → 左 の順に、入るところ
  const spots = [
    y + h + gap + bh <= vh - 8 && { left: clampX(x), top: y + h + gap },
    y - gap - bh >= 8 && { left: clampX(x), top: y - gap - bh },
    x + w + gap + bw <= vw - 8 && { left: x + w + gap, top: clampY(y) },
    x - gap - bw >= 8 && { left: x - gap - bw, top: clampY(y) },
  ].filter(Boolean);
  // どこにも入らない（スマホで大きい場所など）ときは、画面の上か下の、明るい場所から遠いほう
  const spot = spots[0] || { left: clampX(x), top: y > vh - (y + h) ? 8 : vh - bh - 8 };
  b.style.left = spot.left + 'px';
  b.style.top = spot.top + 'px';
}
