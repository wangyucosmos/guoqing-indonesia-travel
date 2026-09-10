/* 国庆印尼旅游 · 云端协作版
 *
 * 两种状态：
 *   没有小组 —— 只读公开攻略（数据来自 seed.js），底部引导创建小组
 *   有小组   —— 全部内容从云端来，所有人可编辑；模块和字段本身也能改
 *
 * 身份：没有账号。链接里的 #k= 是入场券，本机随机生成一个 member id 用来标记"谁改的"。
 * 密钥放 # 片段（浏览器不会发给服务器），调接口时才放进 X-Trip-Key 请求头。
 */
import { qrSvg } from './qr.js';
import { DAYS, ESSENTIALS, PINS, TOP10 } from './seed.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
const LS = { get: k => { try { return localStorage.getItem(k) } catch { return null } },
             set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } };

/* ---------------- 本机状态 ---------------- */
const me = {
  gid: '', key: '',
  id: LS.get('idn.member') || '',
  name: LS.get('idn.name') || ''
};
if (!me.id) { me.id = uid(); LS.set('idn.member', me.id); }

let cloud = null;                 // {group, modules, entries, members}
let tab = 'overview';
let busy = false, lastSync = '', netError = '';
let editing = null;               // {mode:'entry'|'module', ...}
let openDays = new Set([DAYS[0].date]);
let filter = {};                  // moduleId -> 当前筛选值
let trashMode = false;
let theme = LS.get('idn.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/* 从 # 片段读小组信息，读完立刻清掉地址栏，避免截图/转发时泄露密钥 */
(function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const g = h.get('g'), k = h.get('k');
  if (g && k) {
    me.gid = g; me.key = k;
    LS.set('idn.gid', g); LS.set('idn.key.' + g, k);
    history.replaceState(null, '', location.pathname);
  } else {
    const last = LS.get('idn.gid');
    if (last) { me.gid = last; me.key = LS.get('idn.key.' + last) || ''; }
  }
})();

/* ---------------- 接口 ---------------- */
async function api(body) {
  const r = await fetch('./api/travel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Trip-Key': me.key },
    body: JSON.stringify({ ...body, group: me.gid, member: me.id, who: me.name || '搭子' })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || '操作没有完成'); e.status = r.status; throw e; }
  return d;
}
async function pull() {
  if (!me.gid || !me.key) return;
  const r = await fetch(`./api/travel?g=${encodeURIComponent(me.gid)}&m=${encodeURIComponent(me.id)}`,
    { headers: { 'X-Trip-Key': me.key }, cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || '读取失败');
  cloud = d;
  lastSync = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  netError = '';
}
async function act(body, { keepDialog = false } = {}) {
  busy = true; $('#bar').classList.add('on'); paint();
  try {
    const r = await api(body);
    await pull();
    if (!keepDialog) editing = null;
    return r;
  } catch (e) {
    if (e.status === 409) { await pull().catch(() => {}); if (editing) editing.conflict = e.message; }
    else toast(e.message);
    throw e;
  } finally {
    busy = false; $('#bar').classList.remove('on'); paint();
  }
}

let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div'); el.id = 'toast';
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(22px + env(safe-area-inset-bottom,0px));background:#16323c;color:#fff;padding:11px 18px;border-radius:22px;font-size:14px;z-index:99;max-width:88vw;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.22);transition:opacity .3s';
    document.body.appendChild(el);
  }
  // <dialog open> 在浏览器顶层，z-index 再高也盖不过它 —— 弹窗开着时把提示挂进弹窗里
  const host = $('#dlg')?.open ? $('#dlg') : document.body;
  if (el.parentNode !== host) host.appendChild(el);
  el.textContent = msg; el.style.opacity = '1';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.style.opacity = '0', 2600);
}

/* ---------------- 小工具 ---------------- */
const modules = () => (cloud?.modules || []).filter(m => !m.hidden);
const moduleById = id => (cloud?.modules || []).find(m => m.id === id);
const entriesOf = id => (cloud?.entries || []).filter(e => e.module_id === id && !e.deleted);
const trashed = () => (cloud?.entries || []).filter(e => e.deleted);
const initials = n => (n || '?').trim().slice(0, 2);
const dayLabel = d => d ? d.slice(5).replace('-', '/') : '';
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINS = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));
const timeText = d => d.start && d.end ? `${d.start} – ${d.end}` : d.start || d.label || '时间待定';

/* 日期选项：攻略里的 8 天 + 记录里出现过的其它日期 */
function allDays() {
  const set = new Set(DAYS.map(d => d.date));
  (cloud?.entries || []).forEach(e => e.day && set.add(e.day));
  return [...set].sort();
}
const dayTitle = d => DAYS.find(x => x.date === d)?.title || dayLabel(d);

/* ---------------- 示意地图（与静态版一致） ---------------- */
const MX = lon => lon <= 112.7 ? (lon - 104) * 26 : lon <= 114 ? 226 + (lon - 112.7) * 48 : 288 + (lon - 114) * 81.6;
const MY = lat => (lat - 4.8) * 48;
function mapSvg() {
  const islands = [
    'M 26 56 C 70 48, 160 82, 226 104 C 280 122, 330 142, 337 162 C 330 178, 300 172, 262 162 C 200 144, 110 122, 56 100 C 26 90, 16 64, 26 56 Z',
    'M 323 168 C 338 155, 386 154, 408 168 C 426 181, 404 198, 368 196 C 338 194, 313 180, 323 168 Z',
    'M 442 172 C 460 161, 494 166, 502 184 C 509 202, 472 208, 454 198 C 438 190, 434 178, 442 172 Z',
    'M 511 172 C 563 158, 633 166, 675 180 C 699 190, 675 204, 627 203 C 571 202, 525 194, 509 183 C 501 177, 503 174, 511 172 Z',
    'M 738 166 C 778 156, 828 162, 830 176 C 830 190, 776 195, 744 190 C 726 187, 726 171, 738 166 Z',
    'M 731 186 C 741 181, 753 185, 753 192 C 753 200, 737 202, 730 196 C 725 192, 725 188, 731 186 Z'
  ];
  const order = [0, 6, 7, 6, 4, 3, 4, 1, 2, 1, 0];
  const path = order.map((i, k) => `${k ? 'L' : 'M'} ${MX(PINS[i].lon).toFixed(0)} ${MY(PINS[i].lat).toFixed(0)}`).join(' ');
  const LAB = { right: ['start', 12, -7, 9], left: ['end', -12, -7, 9], up: ['middle', 0, -22, -8], down: ['middle', 0, 24, 38] };
  return `<svg viewBox="0 34 862 205" role="img" aria-label="印尼行程示意地图">
    ${islands.map(d => `<path d="${d}" fill="var(--primary-soft)" stroke="var(--line)" stroke-width="1.5"/>`).join('')}
    <path d="${path}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-dasharray="6 5" opacity=".6" stroke-linejoin="round"/>
    ${PINS.map((p, i) => {
      const x = MX(p.lon), y = MY(p.lat), [an, dx, dy1, dy2] = LAB[p.pos] || LAB.right;
      return `<g class="pin" tabindex="0" role="button" data-pin="${i}" aria-label="${esc(p.n)}，${esc(p.d)}">
        <circle class="hit" cx="${x}" cy="${y}" r="22"/>
        <circle class="dot" cx="${x}" cy="${y}" r="6" fill="var(--primary)" stroke="var(--card)" stroke-width="2.5"/>
        <text x="${x + dx}" y="${y + dy1}" text-anchor="${an}" font-size="14" font-weight="600" fill="var(--fg)" stroke="var(--card)" stroke-width="3.5" paint-order="stroke">${esc(p.n)}</text>
        <text x="${x + dx}" y="${y + dy2}" text-anchor="${an}" font-size="11.5" fill="var(--muted)" stroke="var(--card)" stroke-width="3" paint-order="stroke">${esc(p.d)}</text>
      </g>`;
    }).join('')}
  </svg>`;
}

/* ================= 渲染 ================= */
function paint() {
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
  $('#teamBtn').textContent = cloud ? '👥 ' + (cloud.group.name.length > 6 ? cloud.group.name.slice(0, 6) + '…' : cloud.group.name) : '创建小组';
  paintTabs();
  $('#main').innerHTML = !cloud ? viewLanding() : tab === 'overview' ? viewOverview() : viewModule(tab);
}
function paintTabs() {
  const nav = $('#tabs');
  if (!cloud) { nav.innerHTML = ''; return; }
  nav.innerHTML = `<button role="tab" data-tab="overview" aria-selected="${tab === 'overview'}">总览</button>` +
    modules().map(m => `<button role="tab" data-tab="${m.id}" aria-selected="${tab === m.id}">${esc(m.icon)} ${esc(m.name)}</button>`).join('') +
    `<button role="tab" data-act="module-add" style="color:var(--primary)">＋ 新模块</button>`;
}

/* ---------- 没建组：只读公开攻略 ---------- */
function viewLanding() {
  return `
  <section class="landing">
    <p class="eyebrow">10.01 — 10.09 / 国庆旅行计划</p>
    <h1>去山海之间，<br>把时间留给风景。</h1>
    <p class="muted">科莫多 · 巴厘岛 / 罗威纳 · 布罗莫</p>
    <div style="margin:20px 0"><button class="btn" data-act="create">建一个小组，大家一起改</button></div>
    <p class="small">建好之后会生成一条链接和二维码，发给搭子，扫码就能一起编辑。<br>不用注册，不用装 App，没有账号。</p>
    <p class="small"><button class="textbtn" data-act="join-manual" style="color:var(--primary);text-decoration:underline">已经有搭子发给你的链接？点这里</button></p>
  </section>
  <div class="tip">下面是公开攻略，谁都能看。<strong>建小组之后，这些内容会复制一份到你们组里，所有人都能改。</strong></div>
  <div class="mapwrap"><div class="mapscroll">${mapSvg()}</div>
    <p class="swipehint">← 左右滑动看完整行程 →</p>
    <p class="maplegend">位置为示意，只表示相对方位和行程顺序，不能当导航用。</p></div>
  <div class="sec"><h2>每天怎么走</h2></div>
  ${DAYS.map((d, i) => `<details class="day"${i === 0 ? ' open' : ''}>
    <summary><span class="date">${dayLabel(d.date)}</span>
      <span class="ttl"><strong>${esc(d.title)}</strong><small>${esc(d.tag)} · ${d.zone}</small></span>
      <span class="caret">▾</span></summary>
    <div class="daybody"><div class="tl">
      ${d.items.map(([t, h, p]) => `<time>${esc(t)}</time><div><h4>${esc(h)}</h4><p>${esc(p)}</p></div>`).join('')}
    </div></div></details>`).join('')}
  <div class="sec"><h2>少一点临时慌张</h2></div>
  <div class="list two">${ESSENTIALS.map(e => `<div class="item"><h4>${esc(e.t)}</h4>
    <p style="font-size:14px;color:var(--muted)">${esc(e.x)}</p></div>`).join('')}</div>
  ${foot()}`;
}

/* ---------- 总览 ---------- */
function viewOverview() {
  const route = (cloud.modules || []).find(m => m.builtin === 'route');
  const items = route ? entriesOf(route.id) : [];
  const byDay = {};
  items.forEach(e => (byDay[e.day || ''] ||= []).push(e));
  const days = allDays().filter(d => byDay[d]?.length);
  return `
  ${cloudbar()}
  <section class="hero">
    <p class="eyebrow">10.01 — 10.09 / 国庆旅行计划</p>
    <h1>去山海之间，把时间留给风景。</h1>
    <p class="sub">科莫多 · 巴厘岛 / 罗威纳 · 布罗莫</p>
  </section>
  <div class="mapwrap"><div class="mapscroll">${mapSvg()}</div>
    <p class="swipehint">← 左右滑动看完整行程 →</p>
    <p class="maplegend">位置为示意，只表示相对方位和行程顺序，<strong>不能当导航用</strong>。点任意一个地点跳到当天。</p></div>
  <div class="sec"><div><p class="eyebrow">THE JOURNEY</p><h2>每天怎么走</h2></div>
    ${route ? `<button class="btn sm out" data-act="goto" data-id="${route.id}">去编辑行程</button>` : ''}</div>
  <div class="tip">这里是只读总览，改行程去「${esc(route?.name || '路线计划')}」。所有时刻以当地时间为准：雅加达 / 泗水 <strong>UTC+7</strong>，巴厘岛 / Labuan Bajo / 中国 <strong>UTC+8</strong>。</div>
  ${days.map(d => {
    const list = byDay[d].sort((a, b) => (a.data.start || '99:99').localeCompare(b.data.start || '99:99'));
    return `<details class="day" id="ov-${d}" data-day="${d}"${openDays.has(d) ? ' open' : ''}>
      <summary><span class="date">${dayLabel(d)}</span>
        <span class="ttl"><strong>${esc(dayTitle(d))}</strong><small>${list.length} 个安排</small></span>
        <span class="caret">▾</span></summary>
      <div class="daybody"><div class="tl">${list.map(e =>
        `<time>${esc(timeText(e.data))}</time><div><h4>${esc(e.title)}</h4>${e.data.notes ? `<p>${esc(e.data.notes)}</p>` : ''}</div>`
      ).join('')}</div></div></details>`;
  }).join('') || `<div class="empty"><h3>行程还是空的</h3><p>去「路线计划」里加第一段。</p></div>`}
  ${foot()}`;
}

function cloudbar() {
  const ms = cloud.members || [];
  return `<div class="cloudbar">
    <span class="dot ${netError ? 'off' : busy ? 'busy' : ''}"></span>
    <span>${netError ? esc(netError) : busy ? '正在保存…' : `已同步 ${lastSync}`}</span>
    <span class="who">
      <span class="avatars">${ms.slice(0, 5).map(m => `<span class="avatar" title="${esc(m.name)}">${esc(initials(m.name))}</span>`).join('')}</span>
      <span class="small">${ms.length} 人</span>
      <button class="btn out sm" data-act="invite">邀请 / 二维码</button>
      <button class="iconbtn" data-act="refresh" aria-label="刷新">↻</button>
    </span>
  </div>
  ${ms.length < 2 ? `<div class="tip">现在只有你一个人。<strong>点上面的「邀请 / 二维码」</strong>把链接或二维码发给搭子，他们打开就能一起改 —— 随时都能再找到，不用现在就发。</div>` : ''}`;
}

/* ---------- 模块页 ---------- */
function viewModule(id) {
  const m = moduleById(id);
  if (!m) { tab = 'overview'; return viewOverview(); }
  const all = trashMode ? trashed().filter(e => e.module_id === id) : entriesOf(id);
  const head = `${cloudbar()}
  <div class="sec"><div><p class="eyebrow">${m.builtin ? 'OUR TRIP' : 'CUSTOM'}</p>
    <h2>${esc(m.icon)} ${esc(m.name)}${trashMode ? ' · 回收站' : ''}</h2></div>
    <div class="actions">
      <button class="iconbtn" data-act="module-edit" data-id="${m.id}" aria-label="模块设置">⚙</button>
      ${trashMode ? `<button class="btn sm out" data-act="trash-off">返回</button>`
        : `<button class="btn sm out" data-act="trash-on">回收站</button>
           <button class="btn sm" data-act="entry-add" data-id="${m.id}">＋ 添加</button>`}
    </div></div>`;
  if (trashMode) return head + trashList(all) + foot();
  return head + (m.layout === 'day' ? dayLayout(m, all)
    : m.layout === 'check' ? checkLayout(m, all)
    : cardLayout(m, all)) + foot();
}

function trashList(list) {
  if (!list.length) return `<div class="empty"><h3>回收站是空的</h3></div>`;
  return `<div class="list two">${list.map(e => `<div class="item">
    <h4>${esc(e.title)}</h4><div class="meta">${esc(e.updated_by)} 删除</div>
    <div class="row" style="margin-top:10px">
      <button class="btn sm out" data-act="entry-restore" data-id="${e.id}" data-v="${e.version}">恢复</button>
    </div></div>`).join('')}</div>`;
}

/* 日程布局 */
function dayLayout(m, list) {
  const byDay = {}; list.forEach(e => (byDay[e.day || ''] ||= []).push(e));
  const checkMods = (cloud.modules || []).filter(x => x.layout === 'check');
  return `<div class="tip">每一天可以自己加时间段：<strong>选开始时间到结束时间</strong>，后面随便填。改完自动按时间排序，队友刷新就能看到。</div>` +
  allDays().map(d => {
    const items = (byDay[d] || []).sort((a, b) => (a.data.start || '99:99').localeCompare(b.data.start || '99:99'));
    const packs = checkMods.flatMap(cm => entriesOf(cm.id).filter(e => e.day === d));
    return `<details class="day" id="d-${d}" data-day="${d}"${openDays.has(d) ? ' open' : ''}>
      <summary><span class="date">${dayLabel(d)}</span>
        <span class="ttl"><strong>${esc(dayTitle(d))}</strong><small>${items.length} 个时间段</small></span>
        <span class="caret">▾</span></summary>
      <div class="daybody">
        ${items.map(e => slotCard(m, e)).join('') || `<p class="small" style="padding:14px 0 0">这一天还没有安排。</p>`}
        <button class="btn out sm" style="margin-top:12px" data-act="entry-add" data-id="${m.id}" data-day="${d}">＋ 添加时间段</button>
        ${packs.length ? `<div class="packhint"><h4>🎒 这一天出门要带</h4>
          <div class="chips">${packs.map(p => `<span class="chip${p.data.done ? ' plain' : ''}">${p.data.done ? '✓ ' : ''}${esc(p.title)}</span>`).join('')}</div>
          <p class="small" style="margin:9px 0 0">在勾选类模块里给条目设置日期，就会出现在这里。</p></div>` : ''}
      </div></details>`;
  }).join('');
}
function slotCard(m, e) {
  return `<div class="slot">
    <div class="slothead"><span class="slottime">${esc(timeText(e.data))}</span>
      <button class="iconbtn" data-act="entry-edit" data-id="${e.id}" aria-label="编辑 ${esc(e.title)}">✎</button></div>
    <h4>${esc(e.title) || '未命名'}</h4>
    ${e.data.notes ? `<p class="body">${esc(e.data.notes)}</p>` : ''}
    <div class="byline">${esc(e.updated_by)} · ${new Date(e.updated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
  </div>`;
}

/* 勾选布局 */
function checkLayout(m, list) {
  const catField = m.fields.find(f => f.type === 'select');
  const cats = catField ? ['全部', ...catField.options.filter(c => list.some(e => e.data[catField.key] === c))] : [];
  const cur = filter[m.id] || '全部';
  const shown = catField && cur !== '全部' ? list.filter(e => e.data[catField.key] === cur) : list;
  const done = shown.filter(e => e.data.done).length;
  const groups = {};
  shown.forEach(e => (groups[catField ? (e.data[catField.key] || '其他') : '全部'] ||= []).push(e));
  return `<div class="tip">已完成 <strong>${done} / ${shown.length}</strong>。给一条设置日期，它会出现在行程里那天的「出门要带」。</div>
  ${cats.length ? `<div class="filterbar">${cats.map(c =>
    `<button data-act="filter" data-m="${m.id}" data-c="${esc(c)}" aria-pressed="${c === cur}">${esc(c)}</button>`).join('')}</div>` : ''}
  ${Object.entries(groups).map(([cat, items]) => `<div class="grouphead">${esc(cat)}</div>
    <div class="list">${items.map(e => `<label class="check${e.data.done ? ' done' : ''}">
      <input type="checkbox" data-act="toggle" data-id="${e.id}" data-v="${e.version}"${e.data.done ? ' checked' : ''}>
      <span class="t"><h4>${esc(e.title)}</h4>
        ${e.day ? `<div class="meta">📅 ${dayLabel(e.day)} 当天携带</div>` : ''}
        ${e.data.notes ? `<div class="meta">${esc(e.data.notes)}</div>` : ''}</span>
      <button class="iconbtn" data-act="entry-edit" data-id="${e.id}" aria-label="编辑">✎</button>
    </label>`).join('')}</div>`).join('') || `<div class="empty"><h3>还没有条目</h3><p>点右上角「添加」。</p></div>`}
  ${m.builtin === 'pack' ? `<div class="tip warn" style="margin-top:22px">⚠️ 药品部分只是常见出行打包提醒，<strong>不是医疗建议</strong>。是否携带、用什么、用多少，按自己的身体情况咨询医生或药师；处方药备足全程用量并记下英文药名。</div>` : ''}`;
}

/* 卡片布局 */
function cardLayout(m, list) {
  const sceneField = m.builtin === 'music' ? m.fields.find(f => f.key === 'scene') : null;
  const cur = filter[m.id] || '全部';
  const shown = sceneField && cur !== '全部' ? list.filter(e => e.data.scene === cur) : list;
  let extra = '';
  if (m.builtin === 'budget') {
    const sum = st => list.filter(e => e.data.status === st)
      .reduce((n, e) => n + (Number(e.data.amount) || 0) * (Number(e.data.rate) || 0), 0);
    const f = n => '¥' + n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
    extra = `<div class="stats">
      <div class="ov"><span>预计总额</span><strong>${f(sum('预算'))}</strong></div>
      <div class="ov"><span>已经支付</span><strong>${f(sum('已支付'))}</strong></div>
      <div class="ov"><span>记录数</span><strong>${list.length}</strong></div></div>
      <div class="tip">标成「仅自己可见」的记录只有你能看到，队友看不到，也不计入他们的汇总。汇率手动填。</div>`;
  }
  if (m.builtin === 'music') extra = `<div class="tip">只存 10 首的话：${TOP10.join(' / ')}</div>` +
    (sceneField ? `<div class="filterbar">${['全部', ...sceneField.options].map(c =>
      `<button data-act="filter" data-m="${m.id}" data-c="${esc(c)}" aria-pressed="${c === cur}">${esc(c)}</button>`).join('')}</div>` : '');
  if (!shown.length) return extra + `<div class="empty"><h3>还没有内容</h3><p>点右上角「添加」，大家都能加。</p></div>`;
  return extra + `<div class="list two">${shown.map(e => `<div class="item">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <h4>${esc(e.title)}</h4>
        ${e.day ? `<div class="meta">📅 ${dayLabel(e.day)}</div>` : ''}
      </div>
      <button class="iconbtn" data-act="entry-edit" data-id="${e.id}" aria-label="编辑 ${esc(e.title)}">✎</button>
    </div>
    <div class="chips" style="margin:8px 0">
      ${e.scope === 'private' ? '<span class="chip">🔒 仅自己可见</span>' : ''}
      ${m.fields.filter(f => f.type === 'select' && e.data[f.key]).map(f => `<span class="chip plain">${esc(e.data[f.key])}</span>`).join('')}
    </div>
    ${m.fields.filter(f => f.type !== 'select' && e.data[f.key]).map(f =>
      f.type === 'url' ? `<a class="link" href="${esc(e.data[f.key])}" target="_blank" rel="noreferrer">${esc(f.label)} ↗</a>`
      : `<p class="${f.type === 'textarea' ? 'notes' : 'meta'}">${f.type === 'textarea' ? '' : esc(f.label) + '：'}${esc(e.data[f.key])}</p>`
    ).join('')}
    <div class="byline">${esc(e.updated_by)} · ${new Date(e.updated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
  </div>`).join('')}</div>`;
}

const foot = () => `<footer class="foot">
  国庆印尼旅游 · 内容基于 V9 方案 B · 2026<br>
  航班、签证政策、海况请在出发前 72 小时再核对一次。<br>
  ${cloud ? '拿到链接的人都能编辑，别在这里放证件号、卡号这类敏感信息。' : ''}
</footer>`;

/* ================= 弹窗 ================= */
const openDlg = html => { $('#dlgBody').innerHTML = html; if (!$('#dlg').open) $('#dlg').showModal(); };
const closeDlg = () => { editing = null; $('#dlg').close(); };

function timeSel(name, v) {
  const [h, m] = (v || '').split(':');
  return `<div class="grp">
    <select aria-label="${name}小时" data-part="${name}-h"><option value=""${h ? '' : ' selected'}>--</option>
      ${HOURS.map(x => `<option${x === h ? ' selected' : ''}>${x}</option>`).join('')}</select><span class="sep">:</span>
    <select aria-label="${name}分钟" data-part="${name}-m"><option value=""${m ? '' : ' selected'}>--</option>
      ${MINS.map(x => `<option${x === m ? ' selected' : ''}>${x}</option>`).join('')}</select></div>`;
}
function fieldInput(f, val) {
  const v = val || '';
  if (f.type === 'textarea') return `<textarea data-f="${f.key}" rows="5" maxlength="8000">${esc(v)}</textarea>`;
  if (f.type === 'select') return `<select data-f="${f.key}"><option value="">（不选）</option>${
    f.options.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  if (f.type === 'check') return `<label class="row" style="gap:8px"><input type="checkbox" data-f="${f.key}" data-check="1"${v ? ' checked' : ''} style="width:22px;height:22px;min-height:0"> 是</label>`;
  const t = { number: 'number', date: 'date', time: 'time', url: 'url' }[f.type] || 'text';
  return `<input type="${t}" data-f="${f.key}" value="${esc(v)}" maxlength="500">`;
}
function entryDlg() {
  const { module: mid, entry } = editing;
  const m = moduleById(mid);
  // 冲突重绘时必须回填用户刚打的字，否则"你填的内容还在"就是句空话
  const dr = editing.draftEntry;
  const d = dr ? dr.data : (entry?.data || {});
  const curTitle = dr ? dr.title : (entry?.title || '');
  const curDay = dr ? dr.day : (editing.day ?? entry?.day ?? '');
  const curScope = dr ? dr.scope : (entry?.scope || 'group');
  const isDay = m.layout === 'day';
  const days = allDays();
  return `<div class="dlghead"><h3>${entry ? '编辑' : '添加'} · ${esc(m.name)}</h3></div>
    ${editing.conflict ? `<div class="conflict">⚠️ ${esc(editing.conflict)}<br>你填的内容还在下面，确认后再点一次保存就会覆盖成你的版本。</div>` : ''}
    ${isDay ? `<div class="fld"><span class="fieldlabel">时间段</span>
      <div class="timepick">
        <div class="trow"><span class="tlab">开始</span>${timeSel('start', d.start)}</div>
        <div class="trow"><span class="tlab">结束</span>${timeSel('end', d.end)}</div>
      </div><p class="small" style="margin:0">结束时间可以不填。</p></div>` : ''}
    <div class="fld"><span class="fieldlabel">${isDay ? '这一段做什么' : '标题'}</span>
      <input data-f="__title" value="${esc(curTitle)}" maxlength="120" placeholder="${isDay ? '例如：Padar Island 登高' : '起个名字'}"></div>
    <div class="fld"><span class="fieldlabel">属于哪一天${isDay ? '' : '（可不选）'}</span>
      <select data-f="__day"><option value="">不指定</option>${days.map(x =>
        `<option value="${x}"${x === curDay ? ' selected' : ''}>${dayLabel(x)} ${esc(dayTitle(x))}</option>`).join('')}</select></div>
    ${m.fields.map(f => `<div class="fld"><span class="fieldlabel">${esc(f.label)}</span>${fieldInput(f, d[f.key])}</div>`).join('')}
    <div class="fld"><span class="fieldlabel">谁能看到</span>
      <select data-f="__scope">
        <option value="group"${curScope !== 'private' ? ' selected' : ''}>小组共享 —— 所有搭子可见可改</option>
        <option value="private"${curScope === 'private' ? ' selected' : ''}>仅自己可见</option>
      </select></div>
    <div class="row" style="margin-top:18px">
      <button class="btn" data-act="entry-save">${busy ? '正在保存…' : '保存'}</button>
      <button class="btn out" data-act="close">取消</button>
      <div style="flex:1"></div>
      ${entry ? `<button class="iconbtn" data-act="entry-del" data-id="${entry.id}" data-v="${entry.version}" aria-label="移入回收站">🗑</button>` : ''}
    </div>`;
}

const TYPE_NAMES = { text: '单行文字', textarea: '多行文字', number: '数字', date: '日期', time: '时间', select: '下拉选择', url: '链接', check: '勾选' };
function moduleDlg() {
  const m = editing.mod;
  const fs = editing.fields;
  // 重绘（加字段 / 换类型）时不能把用户已经填的名字图标冲掉
  const dft = editing.draft || { name: m?.name || '', icon: m?.icon || '📌',
                                 layout: m?.layout || 'card', hidden: !!m?.hidden };
  return `<div class="dlghead"><h3>${m ? '模块设置' : '新建模块'}</h3></div>
    ${m?.builtin ? `<div class="tip">这是内置模块。可以改名字、图标、字段和显示顺序，但不能删除 —— 不想要就隐藏它。</div>` : ''}
    <div class="fld"><span class="fieldlabel">模块名字</span>
      <input data-f="name" value="${esc(dft.name)}" maxlength="30" placeholder="例如：想去的餐厅"></div>
    <div class="fld"><span class="fieldlabel">图标（一个 emoji）</span>
      <input data-f="icon" value="${esc(dft.icon)}" maxlength="4" style="width:90px"></div>
    ${m ? '' : `<div class="fld"><span class="fieldlabel">展示方式</span>
      <select data-f="layout">
        <option value="card"${dft.layout === 'card' ? ' selected' : ''}>卡片 —— 一条一张卡，适合清单、推荐、记录</option>
        <option value="check"${dft.layout === 'check' ? ' selected' : ''}>勾选 —— 带复选框，适合待办和要带的东西</option>
      </select></div>`}
    <div class="fld"><span class="fieldlabel">字段（每条记录要填什么）</span>
      <div id="fieldList">${fs.map((f, i) => `<div class="fieldrow" data-i="${i}">
        <input data-fl="label" value="${esc(f.label)}" placeholder="字段名" maxlength="20">
        <select data-fl="type">${Object.entries(TYPE_NAMES).map(([k, n]) =>
          `<option value="${k}"${k === f.type ? ' selected' : ''}>${n}</option>`).join('')}</select>
        <button class="iconbtn" data-act="field-del" data-i="${i}" aria-label="删除字段">✕</button>
        ${f.type === 'select' ? `<input data-fl="options" style="grid-column:1/-1" value="${esc((f.options || []).join('、'))}" placeholder="下拉选项，用、隔开">` : ''}
      </div>`).join('')}</div>
      <button class="btn out sm" data-act="field-add">＋ 加一个字段</button>
      <p class="small">改字段名不会丢已有内容；删字段只是不再显示，数据还在。</p></div>
    ${m ? `<div class="fld"><label class="row" style="gap:9px">
      <input type="checkbox" data-f="hidden"${dft.hidden ? ' checked' : ''} style="width:22px;height:22px;min-height:0">
      在页签里隐藏这个模块</label></div>` : ''}
    <div class="row" style="margin-top:18px">
      <button class="btn" data-act="module-save">${busy ? '正在保存…' : '保存'}</button>
      <button class="btn out" data-act="close">取消</button>
      <div style="flex:1"></div>
      ${m && !m.builtin ? `<button class="iconbtn" data-act="module-del" data-id="${m.id}" aria-label="删除模块">🗑</button>` : ''}
    </div>`;
}

/* 搭子扫码进来的第一屏。不能用 prompt() —— 微信内置浏览器等环境不支持，会直接卡住 */
function joinDlg() {
  return `<div class="dlghead"><h3>加入「${esc(cloud?.group?.name || '这个旅行小组')}」</h3></div>
    <p>填个名字就能开始，<strong>不用注册，也不用装 App</strong>。名字只是给同行的搭子看的，方便知道每条是谁改的。</p>
    <div class="fld"><span class="fieldlabel">你叫什么</span>
      <input data-f="who" value="${esc(me.name)}" maxlength="24" placeholder="比如：小李" autofocus></div>
    <div class="row" style="margin-top:16px">
      <button class="btn" data-act="join-confirm">${busy ? '正在加入…' : '进去看看'}</button>
    </div>
    <p class="small">进去之后你和其他人改的内容会互相同步。</p>`;
}

function teamDlg() {
  if (!cloud) {
    return `<div class="dlghead"><h3>一起把行程定下来</h3></div>
      <p>建一个小组，公开攻略会复制一份进去，之后你和搭子都能改。<strong>没有账号，不用注册。</strong></p>
      <div class="fld"><span class="fieldlabel">你叫什么（给搭子看的）</span>
        <input data-f="who" value="${esc(me.name)}" maxlength="24" placeholder="比如：小王"></div>
      <div class="fld"><span class="fieldlabel">小组名字</span>
        <input data-f="name" value="国庆印尼搭子" maxlength="60"></div>
      <div class="row"><button class="btn" data-act="create-go">${busy ? '正在创建…' : '创建小组'}</button>
        <button class="btn out" data-act="close">取消</button></div>
      <hr style="margin:20px 0;border:0;border-top:1px solid var(--line)">
      <div class="fld"><span class="fieldlabel">或者，粘贴搭子发来的链接</span>
        <input data-f="invite" placeholder="https://…/#g=…&k=…"></div>
      <button class="btn out" data-act="join-go">加入这个小组</button>`;
  }
  const url = `${location.origin}${location.pathname}#g=${me.gid}&k=${me.key}`;
  let qr = '';
  try { qr = qrSvg(url, { size: 190 }); } catch { qr = '<p class="small">链接太长，生成不了二维码，直接发链接吧。</p>'; }
  return `<div class="dlghead"><h3>邀请搭子进来</h3></div>
    <p class="small">扫码或点链接就能加入，不用注册。<strong>这个页面随时能再打开</strong> —— 每一页顶部都有「邀请 / 二维码」按钮。</p>
    <div style="text-align:center;margin:14px 0"><div class="qrbox">${qr}</div></div>
    <div class="linkbox"><input readonly value="${esc(url)}" aria-label="邀请链接" onclick="this.select()">
      <button class="btn sm" data-act="copy" data-url="${esc(url)}">复制</button></div>
    <div class="tip warn">这条链接就是钥匙 —— <strong>拿到的人不用登录就能编辑全部内容</strong>。只发给同行的搭子，别发到大群或朋友圈。</div>
    <hr style="margin:18px 0;border:0;border-top:1px solid var(--line)">
    <h3 style="font-size:16px;margin-bottom:8px">${esc(cloud.group.name)}</h3>
    <p class="small">成员：${(cloud.members || []).map(m => esc(m.name)).join('、')}（共 ${(cloud.members || []).length} 人）</p>
    <div class="fld"><span class="fieldlabel">你的显示名</span>
      <div class="linkbox"><input data-f="who" value="${esc(me.name)}" maxlength="24" placeholder="给搭子看的名字">
        <button class="btn sm out" data-act="rename-me">改名</button></div></div>
    <div class="fld"><span class="fieldlabel">小组名字</span>
      <div class="linkbox"><input data-f="gname" value="${esc(cloud.group.name)}" maxlength="60">
        <button class="btn sm out" data-act="rename-group">保存</button></div></div>
    <p class="small">数据存在云端，换手机、清缓存都不会丢。退出这台设备只是本机不再自动打开这个小组，内容不受影响。</p>
    <button class="btn out" data-act="leave">在这台设备上退出小组</button>`;
}

/* ================= 事件 ================= */
const readF = (root, name) => $(`[data-f="${name}"]`, root)?.value?.trim() ?? '';
function collectEntry(root, m) {
  const data = {};
  m.fields.forEach(f => {
    const el = $(`[data-f="${f.key}"]`, root);
    if (!el) return;
    data[f.key] = el.dataset.check ? (el.checked ? '1' : '') : el.value.trim();
  });
  if (m.layout === 'day') {
    const t = n => {
      const h = $(`[data-part="${n}-h"]`, root).value, mm = $(`[data-part="${n}-m"]`, root).value;
      return h && mm ? `${h}:${mm}` : h ? `${h}:00` : '';
    };
    data.start = t('start'); data.end = t('end');
    if (data.start) data.label = '';
  }
  return data;
}
function captureDraft(root) {
  editing.draft = {
    name: $('[data-f="name"]', root)?.value ?? editing.draft?.name ?? '',
    icon: $('[data-f="icon"]', root)?.value ?? editing.draft?.icon ?? '📌',
    layout: $('[data-f="layout"]', root)?.value ?? editing.draft?.layout ?? editing.mod?.layout ?? 'card',
    hidden: $('[data-f="hidden"]', root)?.checked ?? editing.draft?.hidden ?? !!editing.mod?.hidden
  };
}
function collectFields(root) {
  return $$('.fieldrow', root).map(row => {
    const label = $('[data-fl="label"]', row).value.trim();
    const type = $('[data-fl="type"]', row).value;
    const optEl = $('[data-fl="options"]', row);
    const key = (editing.fields[+row.dataset.i]?.key) || 'f' + Math.random().toString(36).slice(2, 7);
    const options = type === 'select'
      ? (optEl?.value || '').split(/[、,，]/).map(s => s.trim()).filter(Boolean) : null;
    return { key, label, type, ...(options ? { options } : {}) };
  });   // 不在这里过滤空标签 —— 正在填的行会被吃掉，留到保存时再校验
}

document.addEventListener('click', async e => {
  const pin = e.target.closest('.pin');
  if (pin && cloud) {
    const d = PINS[+pin.dataset.pin].d.match(/\d{2}\/\d{2}/);
    if (d) {
      const date = `2026-${d[0].replace('/', '-')}`;
      openDays.add(date); tab = 'overview'; paint();
      $(`#ov-${date}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act, id = b.dataset.id, root = $('#dlgBody');

  try {
    switch (a) {
      case 'close': closeDlg(); paint(); break;
      case 'refresh': await pull().catch(err => netError = err.message); paint(); break;
      case 'goto': tab = id; paint(); break;
      case 'filter': filter[b.dataset.m] = b.dataset.c; paint(); break;
      case 'trash-on': trashMode = true; paint(); break;
      case 'trash-off': trashMode = false; paint(); break;

      /* 建组 / 加入 */
      case 'create': case 'join-manual': case 'invite': openDlg(teamDlg()); break;
      case 'create-go': {
        const who = readF(root, 'who') || '发起人', name = readF(root, 'name') || '我们的旅行';
        me.name = who; LS.set('idn.name', who);
        busy = true; paint(); openDlg(teamDlg());
        const r = await fetch('./api/travel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', name, who, member: me.id })
        }).then(x => x.json());
        busy = false;
        if (r.error) { toast(r.error); openDlg(teamDlg()); break; }
        me.gid = r.group; me.key = r.secret;
        LS.set('idn.gid', r.group); LS.set('idn.key.' + r.group, r.secret);
        await pull(); tab = 'overview'; paint(); openDlg(teamDlg());
        toast('小组建好了，把二维码发给搭子');
        break;
      }
      case 'join-go': {
        const v = readF(root, 'invite');
        let g = '', k = '';
        try { const h = new URLSearchParams(new URL(v).hash.slice(1)); g = h.get('g'); k = h.get('k'); } catch {}
        if (!g || !k) { toast('这条链接不对，要带 #g= 和 #k= 那一串'); break; }
        me.gid = g; me.key = k;
        LS.set('idn.gid', g); LS.set('idn.key.' + g, k);
        try { await pull(); } catch (er) { toast(er.message); break; }
        openDlg(joinDlg());
        break;
      }
      case 'join-confirm': {
        const who = readF(root, 'who');
        if (!who) { toast('填个名字吧，随便什么都行'); break; }
        me.name = who; LS.set('idn.name', who);
        await act({ action: 'join' }, { keepDialog: true });
        closeDlg(); tab = 'overview'; paint();
        toast(`欢迎，${who}`);
        break;
      }
      case 'leave':
        if (confirm('只是这台设备不再自动打开这个小组，云端内容不会删。确定吗？')) {
          LS.set('idn.gid', ''); me.gid = ''; me.key = ''; cloud = null; closeDlg(); paint();
        }
        break;
      case 'copy':
        try {
          await navigator.clipboard.writeText(b.dataset.url);
          const label = b.textContent;
          b.textContent = '✓ 已复制';
          setTimeout(() => { b.textContent = label; }, 2000);
          toast('链接已复制，发给搭子就行');
        } catch {
          toast('这个浏览器不让自动复制，长按上面的链接手动复制');
        }
        break;
      case 'rename-me':
        me.name = readF(root, 'who') || '搭子'; LS.set('idn.name', me.name);
        await act({ action: 'join' }, { keepDialog: true }); openDlg(teamDlg()); toast('改好了');
        break;
      case 'rename-group':
        await act({ action: 'rename', name: readF(root, 'gname') }, { keepDialog: true });
        openDlg(teamDlg()); break;

      /* 记录 */
      case 'entry-add':
        editing = { mode: 'entry', module: id, entry: null, day: b.dataset.day || '' };
        openDlg(entryDlg()); break;
      case 'entry-edit': {
        const en = cloud.entries.find(x => x.id === id);
        editing = { mode: 'entry', module: en.module_id, entry: en };
        openDlg(entryDlg()); break;
      }
      case 'entry-save': {
        const m = moduleById(editing.module);
        const title = $('[data-f="__title"]', root).value.trim();
        if (!title) { toast('先填个标题'); break; }
        const draft = {
          title,
          day: $('[data-f="__day"]', root).value,
          scope: $('[data-f="__scope"]', root).value,
          data: collectEntry(root, m)
        };
        editing.draftEntry = draft;      // 保存失败时用它回填
        try {
          await act({
            action: editing.entry ? 'entryUpdate' : 'entryAdd',
            module: m.id, id: editing.entry?.id, version: editing.entry?.version, ...draft
          });
          closeDlg(); paint(); toast('已保存，队友刷新就能看到');
        } catch {
          if (editing) {
            // 冲突后 act 已经拉了最新数据，把版本号换成新的：用户确认后再点一次就能覆盖
            const fresh = (cloud?.entries || []).find(x => x.id === editing.entry?.id);
            if (fresh) editing.entry = fresh;
            openDlg(entryDlg());
          }
        }
        break;
      }
      case 'entry-del':
        if (confirm('移入回收站？可以再恢复。')) {
          await act({ action: 'entryDelete', id, version: +b.dataset.v });
          closeDlg(); paint();
        }
        break;
      case 'entry-restore':
        await act({ action: 'entryRestore', id, version: +b.dataset.v }); paint(); break;
      case 'toggle': break;   // 由 change 事件处理

      /* 模块 */
      case 'module-add':
        editing = { mode: 'module', mod: null, draft: null, fields: [{ key: 'notes', label: '备注', type: 'textarea' }] };
        openDlg(moduleDlg()); break;
      case 'module-edit': {
        const m = moduleById(id);
        editing = { mode: 'module', mod: m, draft: null, fields: m.fields.map(f => ({ ...f })) };
        openDlg(moduleDlg()); break;
      }
      case 'field-add':
        captureDraft(root);
        editing.fields = collectFields(root).concat({ key: 'f' + Math.random().toString(36).slice(2, 7), label: '', type: 'text' });
        openDlg(moduleDlg()); break;
      case 'field-del':
        captureDraft(root);
        editing.fields = collectFields(root).filter((_, i) => i !== +b.dataset.i);
        openDlg(moduleDlg()); break;
      case 'module-save': {
        const fields = collectFields(root).filter(f => f.label);
        const name = readF(root, 'name');
        if (!name) { toast('给模块起个名字'); break; }
        const bad = fields.find(f => f.type === 'select' && !f.options?.length);
        if (bad) { toast(`「${bad.label}」是下拉选择，要填至少一个选项`); break; }
        const m = editing.mod;
        await act({
          action: m ? 'moduleUpdate' : 'moduleAdd', id: m?.id, version: m?.version,
          name, icon: readF(root, 'icon') || '📌',
          layout: m ? m.layout : ($('[data-f="layout"]', root)?.value || 'card'),
          hidden: m ? $('[data-f="hidden"]', root)?.checked : false,
          fields
        });
        closeDlg();
        if (!m) tab = cloud.modules[cloud.modules.length - 1]?.id || tab;
        paint(); toast(m ? '模块已更新' : '模块建好了');
        break;
      }
      case 'module-del':
        if (confirm('删掉这个模块，里面的记录也会一起删掉，不能恢复。确定吗？')) {
          await act({ action: 'moduleDelete', id });
          tab = 'overview'; closeDlg(); paint();
        }
        break;
    }
  } catch (err) { /* act() 里已经提示过 */ }
});

document.addEventListener('change', e => {
  // 字段类型换成下拉时要重绘，才能露出"选项"输入框
  if (e.target.matches('[data-fl="type"]') && editing?.mode === 'module') {
    captureDraft($('#dlgBody'));
    editing.fields = collectFields($('#dlgBody'));
    openDlg(moduleDlg());
  }
});

document.addEventListener('change', async e => {
  const cb = e.target.closest('[data-act="toggle"]');
  if (!cb) return;
  const en = cloud.entries.find(x => x.id === cb.dataset.id);
  if (!en) return;
  try {
    await act({
      action: 'entryUpdate', module: en.module_id, id: en.id, version: en.version,
      title: en.title, day: en.day, scope: en.scope,
      data: { ...en.data, done: cb.checked ? '1' : '' }
    });
  } catch { }
  paint();
});

document.addEventListener('toggle', e => {
  const d = e.target.dataset?.day;
  if (d) e.target.open ? openDays.add(d) : openDays.delete(d);
}, true);

$('#tabs').addEventListener('click', e => {
  const t = e.target.closest('button[data-tab]');
  if (t) { tab = t.dataset.tab; trashMode = false; paint(); window.scrollTo(0, 0); }
});
$('#themeBtn').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; LS.set('idn.theme', theme); paint(); });
$('#teamBtn').addEventListener('click', () => openDlg(teamDlg()));
$('#dlg').addEventListener('click', e => { if (e.target.id === 'dlg') { closeDlg(); paint(); } });
$('#dlg').addEventListener('close', () => { editing = null; });

/* 每 15 秒拉一次，编辑中和后台标签页不打扰 */
const sync = () => {
  if (!cloud || busy || editing || document.visibilityState !== 'visible') return;
  pull().then(paint).catch(err => { netError = err.message; paint(); });
};
setInterval(sync, 15000);
// 切回前台立刻同步一次，不然要干等一轮才看得到队友的改动
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
window.addEventListener('online', sync);

/* 启动 */
(async () => {
  paint();
  if (me.gid && me.key) {
    try {
      await pull();
      // 第一次点开邀请链接：先问名字再入组，别自作主张替人取名
      if (!(cloud.members || []).some(m => m.member_id === me.id)) {
        paint();
        openDlg(joinDlg());
        return;
      }
    } catch (err) { netError = err.message; }
  }
  paint();
})();
