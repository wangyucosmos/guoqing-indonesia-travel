/* 国庆印尼旅游 · 云端协作版
 *
 * 状态：
 *   没有小组 —— 只读公开攻略（数据来自 seed.js），底部引导创建小组
 *   有小组   —— 全部内容从云端来；能改什么由角色和模块锁决定
 *
 * 身份：没有账号，但每个人有自己的钥匙（token），存在本机 localStorage，
 * 调接口时放进 X-Trip-Key 请求头。服务器由钥匙确定"你是谁"，不信任客户端自报。
 * 邀请链接 #g=…&i=… 只带邀请码；换设备用 #t=… 的 8 位数字码。
 * 旧版 #g=…&k=… 链接过渡期内仍能读，读一次就自动换发个人钥匙。
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
  gid: '', token: '', legacyKey: '',
  id: LS.get('idn.member') || '',
  name: LS.get('idn.name') || ''
};
if (!me.id) { me.id = uid(); LS.set('idn.member', me.id); }
/* 从地址栏拿到但还没处理的东西 */
let pendingInvite = null;    // {gid, code}   扫了邀请码，等填名字
let pendingTransfer = '';    // 8 位换设备码

let cloud = null;                 // {group, me, members, pending, modules, entries}
let tab = 'overview';
let busy = false, lastSync = '', netError = '';
let editing = null;               // {mode:'entry'|'module', ...}
let openDay = DAYS[0].date;   // 手风琴：同一时刻只展开一天
let filter = {};                  // moduleId -> 当前筛选值
let trashMode = false;
let theme = LS.get('idn.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

const loadGroup = gid => {
  me.gid = gid;
  me.token = LS.get('idn.tok.' + gid) || '';
  me.legacyKey = LS.get('idn.key.' + gid) || '';
};
/* 从 # 片段读信息，读完立刻清掉地址栏，避免截图/转发时泄露 */
(function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const g = h.get('g'), i = h.get('i'), k = h.get('k'), t = h.get('t');
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (t && /^\d{8}$/.test(t)) { pendingTransfer = t; return; }
  if (g && i) { pendingInvite = { gid: g, code: i }; loadGroup(g); return; }
  if (g && k) {                          // 旧版链接：存下来走过渡通道
    LS.set('idn.gid', g); LS.set('idn.key.' + g, k); loadGroup(g); return;
  }
  const last = LS.get('idn.gid');
  if (last) loadGroup(last);
})();
const authKey = () => me.token || me.legacyKey;
const saveToken = (gid, tok) => { me.token = tok; LS.set('idn.tok.' + gid, tok); LS.set('idn.gid', gid); me.gid = gid; };

/* ---------------- 接口 ---------------- */
async function api(body, { auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && authKey()) headers['X-Trip-Key'] = authKey();
  const r = await fetch('./api/travel', { method: 'POST', headers,
    body: JSON.stringify({ ...body, group: body.group ?? me.gid }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || '操作没有完成'); e.status = r.status; throw e; }
  return d;
}
/* 拉全量。旧钥匙过渡时服务器可能顺手发一把个人钥匙，收到就存起来、丢掉旧的。 */
async function pull() {
  if (!me.gid || !authKey()) return;
  const q = `g=${encodeURIComponent(me.gid)}&m=${encodeURIComponent(me.id)}`;
  const r = await fetch(`./api/travel?${q}`, { headers: { 'X-Trip-Key': authKey() }, cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || '读取失败');
  if (d.issuedToken) { saveToken(me.gid, d.issuedToken); me.legacyKey = ''; LS.set('idn.key.' + me.gid, ''); }
  if (d.me?.name) { me.name = d.me.name; LS.set('idn.name', me.name); }
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
const isOwner = () => cloud?.me?.role === 'owner';
const canEdit = m => !!cloud?.me && cloud.me.status === 'active' &&
  (cloud.me.role === 'owner' || (cloud.me.role === 'editor' && !m.locked));
const ROLE_NAME = { owner: '组长', editor: '可编辑', viewer: '只读' };
const modules = () => (cloud?.modules || []).filter(m => !m.hidden);
const moduleById = id => (cloud?.modules || []).find(m => m.id === id);
const entriesOf = id => (cloud?.entries || []).filter(e => e.module_id === id && !e.deleted);
const trashed = () => (cloud?.entries || []).filter(e => e.deleted);
const initials = n => (n || '?').trim().slice(0, 2);
const dayLabel = d => d ? d.slice(5).replace('-', '/') : '';
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINS = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));
const timeText = d => d.start && d.end ? `${d.start} – ${d.end}` : d.start || d.label || '时间待定';
/* 分组字段：模块指定了就用它，没指定就退回第一个下拉字段（行李清单、歌单原来就是这个行为） */
const groupField = m => m.group_by ? m.fields.find(f => f.key === m.group_by)
                                   : m.fields.find(f => f.type === 'select');
/* 分组选项：下拉字段用它自己的选项，自由文本字段就从现有数据里收集 */
function groupValues(m, list) {
  const f = groupField(m);
  if (!f) return [];
  const seen = [...new Set(list.map(e => (e.data[f.key] || '').trim()).filter(Boolean))];
  return f.options ? f.options.filter(o => seen.includes(o)) : seen.sort((a, b) => a.localeCompare(b, 'zh'));
}

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
  $('#main').innerHTML = !cloud ? viewLanding()
    : cloud.pending ? viewPending()
    : cloud.ownerSetupNeeded ? viewOwnerSetup()
    : tab === 'overview' ? viewOverview() : viewModule(tab);
}
function viewPending() {
  return `<section class="landing"><p class="eyebrow">等待确认</p>
    <h1>已经申请加入「${esc(cloud.group.name)}」</h1>
    <p class="muted">这个小组开了入组审批，组长同意后就能看到内容。这个页面会自动刷新，你也可以先关掉，之后再打开。</p>
    <div style="margin:18px 0"><button class="btn out" data-act="refresh">刷新看看</button></div></section>`;
}
function viewOwnerSetup() {
  return `<section class="landing"><p class="eyebrow">组长身份待激活</p>
    <h1>「${esc(cloud.group.name)}」升级了权限系统</h1>
    <p class="muted">这台设备之前是用旧链接进的。组长身份需要用<strong>专门的设置链接</strong>激活一次，
      不能通过旧链接自动升级 —— 不然拿到旧链接的人也能当组长。</p>
    <p class="small">设置链接由部署的人单独交给你，打开就好。如果这台设备只是你的第二台设备，
      在已经激活的那台上点「换设备」拿一个 8 位码，在这里输入。</p>
    <div style="margin:18px 0"><button class="btn out" data-act="transfer-redeem">我有换设备码</button></div></section>`;
}
function paintTabs() {
  const nav = $('#tabs');
  if (!cloud) { nav.innerHTML = ''; return; }
  if (cloud.pending || cloud.ownerSetupNeeded) { nav.innerHTML = ''; return; }
  nav.innerHTML = `<button role="tab" data-tab="overview" aria-selected="${tab === 'overview'}">总览</button>` +
    modules().map(m => `<button role="tab" data-tab="${m.id}" aria-selected="${tab === m.id}">${esc(m.icon)} ${esc(m.name)}${m.locked && !isOwner() ? ' 🔒' : ''}</button>`).join('') +
    (isOwner() ? `<button role="tab" data-act="module-add" style="color:var(--primary)">＋ 新模块</button>` : '');
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
  ${DAYS.map(d => `<details class="day" data-day="${d.date}"${openDay === d.date ? ' open' : ''}>
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
    ${route ? `<button class="btn sm out" data-act="goto" data-id="${route.id}">${canEdit(route) ? '去编辑行程' : '看行程'}</button>` : ''}</div>
  <div class="tip">这里是只读总览，改行程去「${esc(route?.name || '路线计划')}」。所有时刻以当地时间为准：雅加达 / 泗水 <strong>UTC+7</strong>，巴厘岛 / Labuan Bajo / 中国 <strong>UTC+8</strong>。</div>
  ${days.map(d => {
    const list = byDay[d].sort((a, b) => (a.data.start || '99:99').localeCompare(b.data.start || '99:99'));
    return `<details class="day" id="ov-${d}" data-day="${d}"${openDay === d ? ' open' : ''}>
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
      ${isOwner() ? `<button class="btn out sm" data-act="invite">邀请 / 二维码${(cloud.pendingMembers || []).length ? ` <b style="color:var(--warn)">${cloud.pendingMembers.length} 待批</b>` : ''}</button>`
                  : `<span class="chip plain">${ROLE_NAME[cloud.me?.role] || ''}</span>`}
      <button class="iconbtn" data-act="refresh" aria-label="刷新">↻</button>
    </span>
  </div>
  ${isOwner() && ms.length < 2 ? `<div class="tip">现在只有你一个人。<strong>点上面的「邀请 / 二维码」</strong>把链接或二维码发给搭子，他们打开就能一起改 —— 随时都能再找到，不用现在就发。</div>` : ''}
  ${cloud.me?.role === 'viewer' ? `<div class="tip">你是<strong>只读成员</strong>，能看不能改。想参与编辑，找组长把你改成「可编辑」。</div>` : ''}`;
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
      ${isOwner() ? `<button class="iconbtn" data-act="module-edit" data-id="${m.id}" aria-label="模块设置">⚙</button>` : ''}
      ${trashMode ? `<button class="btn sm out" data-act="trash-off">返回</button>`
        : canEdit(m) ? `<button class="btn sm out" data-act="trash-on">回收站</button>
           <button class="btn sm" data-act="entry-add" data-id="${m.id}">＋ 添加</button>` : ''}
    </div></div>
  ${m.locked && !isOwner() ? `<div class="tip">🔒 这个模块<strong>只有组长能改</strong>，你可以看。</div>` : ''}`;
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
    return `<details class="day" id="d-${d}" data-day="${d}"${openDay === d ? ' open' : ''}>
      <summary><span class="date">${dayLabel(d)}</span>
        <span class="ttl"><strong>${esc(dayTitle(d))}</strong><small>${items.length} 个时间段</small></span>
        <span class="caret">▾</span></summary>
      <div class="daybody">
        ${items.map(e => slotCard(m, e)).join('') || `<p class="small" style="padding:14px 0 0">这一天还没有安排。</p>`}
        ${canEdit(m) ? `<button class="btn out sm" style="margin-top:12px" data-act="entry-add" data-id="${m.id}" data-day="${d}">＋ 添加时间段</button>` : ''}
        ${packs.length ? `<div class="packhint"><h4>🎒 这一天出门要带</h4>
          <div class="chips">${packs.map(p => `<span class="chip${p.data.done ? ' plain' : ''}">${p.data.done ? '✓ ' : ''}${esc(p.title)}</span>`).join('')}</div>
          <p class="small" style="margin:9px 0 0">在勾选类模块里给条目设置日期，就会出现在这里。</p></div>` : ''}
      </div></details>`;
  }).join('');
}
function slotCard(m, e) {
  return `<div class="slot">
    <div class="slothead"><span class="slottime">${esc(timeText(e.data))}</span>
      ${canEdit(m) ? `<button class="iconbtn" data-act="entry-edit" data-id="${e.id}" aria-label="编辑 ${esc(e.title)}">✎</button>` : ''}</div>
    <h4>${esc(e.title) || '未命名'}</h4>
    ${e.data.notes ? `<p class="body">${esc(e.data.notes)}</p>` : ''}
    <div class="byline">${esc(e.updated_by)} · ${new Date(e.updated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
  </div>`;
}

/* 勾选布局 */
function checkLayout(m, list) {
  const catField = groupField(m);
  const cats = catField ? ['全部', ...groupValues(m, list)] : [];
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
      <input type="checkbox" data-act="toggle" data-id="${e.id}" data-v="${e.version}"${e.data.done ? ' checked' : ''}${canEdit(m) ? '' : ' disabled'}>
      <span class="t"><h4>${esc(e.title)}</h4>
        ${e.day ? `<div class="meta">📅 ${dayLabel(e.day)} 当天携带</div>` : ''}
        ${e.data.notes ? `<div class="meta">${esc(e.data.notes)}</div>` : ''}</span>
      ${canEdit(m) ? `<button class="iconbtn" data-act="entry-edit" data-id="${e.id}" aria-label="编辑">✎</button>` : ''}
    </label>`).join('')}</div>`).join('') || `<div class="empty"><h3>还没有条目</h3><p>${canEdit(m) ? '点右上角「添加」。' : ''}</p></div>`}
  ${m.builtin === 'pack' ? `<div class="tip warn" style="margin-top:22px">⚠️ 药品部分只是常见出行打包提醒，<strong>不是医疗建议</strong>。是否携带、用什么、用多少，按自己的身体情况咨询医生或药师；处方药备足全程用量并记下英文药名。</div>` : ''}`;
}

/* 卡片布局 */
function cardLayout(m, list) {
  const gf = groupField(m);
  const vals = gf ? groupValues(m, list) : [];
  const cur = filter[m.id] || '全部';
  const blank = gf ? list.filter(e => !(e.data[gf.key] || '').trim()).length : 0;
  const shown = gf && cur !== '全部'
    ? (cur === '未分类' ? list.filter(e => !(e.data[gf.key] || '').trim())
                        : list.filter(e => (e.data[gf.key] || '').trim() === cur))
    : list;
  let extra = '';
  if (vals.length > 1 || (vals.length && blank)) {
    extra += `<div class="filterbar">${['全部', ...vals, ...(blank ? ['未分类'] : [])].map(c => {
      const n = c === '全部' ? list.length
        : c === '未分类' ? blank
        : list.filter(e => (e.data[gf.key] || '').trim() === c).length;
      return `<button data-act="filter" data-m="${m.id}" data-c="${esc(c)}" aria-pressed="${c === cur}">${esc(c)} ${n}</button>`;
    }).join('')}</div>`;
  }
  if (m.builtin === 'budget') {
    const sum = st => list.filter(e => e.data.status === st)
      .reduce((n, e) => n + (Number(e.data.amount) || 0) * (Number(e.data.rate) || 0), 0);
    const f = n => '¥' + n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
    extra = `<div class="stats">
      <div class="ov"><span>预计总额</span><strong>${f(sum('预算'))}</strong></div>
      <div class="ov"><span>已经支付</span><strong>${f(sum('已支付'))}</strong></div>
      <div class="ov"><span>记录数</span><strong>${list.length}</strong></div></div>
      <div class="tip">标成「仅自己可见」的记录只有你能看到，队友看不到，也不计入他们的汇总。汇率手动填。</div>` + extra;
  }
  if (m.builtin === 'music') extra = `<div class="tip">只存 10 首的话：${TOP10.join(' / ')}</div>` + extra;
  if (!shown.length) return extra + `<div class="empty"><h3>还没有内容</h3><p>${canEdit(m) ? '点右上角「添加」。' : ''}</p></div>`;
  return extra + `<div class="list two">${shown.map(e => `<div class="item">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <h4>${esc(e.title)}</h4>
        ${e.day ? `<div class="meta">📅 ${dayLabel(e.day)}</div>` : ''}
      </div>
      ${canEdit(m) ? `<button class="iconbtn" data-act="entry-edit" data-id="${e.id}" aria-label="编辑 ${esc(e.title)}">✎</button>` : ''}
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
  ${cloud ? '别在这里放证件号、卡号这类敏感信息。' : ''}
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
  const gf = groupField(m);
  // 新建时，若分组字段是自由文本（比如"谁的航班"），默认填自己的名字
  const seed = !entry && gf && !gf.options && me.name ? { [gf.key]: me.name } : {};
  const d = dr ? dr.data : (entry?.data || seed);
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
      ${entry && entry.version > 1 ? `<button class="textbtn" data-act="history" data-id="${entry.id}">改动记录</button>` : ''}
      ${entry ? `<button class="iconbtn" data-act="entry-del" data-id="${entry.id}" data-v="${entry.version}" aria-label="移入回收站">🗑</button>` : ''}
    </div>`;
}
function historyDlg(entry, rows) {
  const fmt = t => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ACT = { update: '修改', delete: '移入回收站', restore: '从回收站恢复', revert: '回滚' };
  return `<div class="dlghead"><h3>「${esc(entry.title)}」的改动记录</h3></div>
    <p class="small">当前是第 ${entry.version} 版，${esc(entry.updated_by)} 于 ${fmt(entry.updated_at)} 改的。下面是之前的版本，可以一键恢复到任何一版。</p>
    ${rows.length ? rows.map(h => `<div class="hist">
      <div class="histhead"><strong>第 ${h.version} 版</strong>
        <span class="small">${esc(h.changed_by)} 之后做了「${ACT[h.action] || h.action}」 · ${fmt(h.changed_at)}</span></div>
      <div class="histbody"><b>${esc(h.title)}</b>${h.deleted ? ' <span class="chip plain">当时在回收站</span>' : ''}
        ${Object.entries(h.data).filter(([k, v]) => v && !['start', 'end', 'label'].includes(k)).slice(0, 4)
          .map(([k, v]) => `<div class="meta">${esc(k)}：${esc(String(v).slice(0, 80))}${String(v).length > 80 ? '…' : ''}</div>`).join('')}</div>
      <button class="btn sm out" data-act="revert" data-id="${entry.id}" data-to="${h.version}">恢复到这一版</button>
    </div>`).join('') : '<p class="small">还没有历史版本。</p>'}
    <div class="row" style="margin-top:14px"><button class="btn out" data-act="entry-edit" data-id="${entry.id}">返回编辑</button></div>`;
}

const TYPE_NAMES = { text: '单行文字', textarea: '多行文字', number: '数字', date: '日期', time: '时间', select: '下拉选择', url: '链接', check: '勾选' };
function moduleDlg() {
  const m = editing.mod;
  const fs = editing.fields;
  // 重绘（加字段 / 换类型）时不能把用户已经填的名字图标冲掉
  const dft = editing.draft || { name: m?.name || '', icon: m?.icon || '📌',
                                 layout: m?.layout || 'card', hidden: !!m?.hidden,
                                 locked: !!m?.locked, groupBy: m?.group_by || '' };
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
    <div class="fld"><span class="fieldlabel">分组显示</span>
      <select data-f="groupBy">
        <option value="">不分组，全部列在一起</option>
        ${fs.filter(f => f.label).map(f =>
          `<option value="${esc(f.key)}"${f.key === dft.groupBy ? ' selected' : ''}>按「${esc(f.label)}」分组</option>`).join('')}
      </select>
      <p class="small">选了之后，模块顶部会出现分类标签，点一个只看那一类。<br>
        比如航班按「谁的航班」分组，每个人点自己的名字就只看自己那几段。</p></div>
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
    <div class="fld"><label class="row" style="gap:9px">
      <input type="checkbox" data-f="locked"${dft.locked ? ' checked' : ''} style="width:22px;height:22px;min-height:0">
      🔒 只有组长能改这个模块里的内容</label>
      <p class="small" style="margin:6px 0 0 31px">其他人只能看。适合路线、航班这种定下来就不该随便动的东西。</p></div>
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
function joinDlg(info) {
  return `<div class="dlghead"><h3>加入「${esc(info.name)}」</h3></div>
    <p>${esc(info.ownerName)} 邀请你一起编辑这次旅行的计划。填个名字就能开始，<strong>不用注册，也不用装 App</strong>。
      ${info.memberCount ? `已经有 ${info.memberCount} 个人在里面了。` : ''}</p>
    ${info.approval ? `<div class="tip">这个小组开了入组审批：填完名字后要等组长同意一下。</div>` : ''}
    <div class="fld"><span class="fieldlabel">你叫什么（给搭子看的）</span>
      <input data-f="who" value="${esc(me.name)}" maxlength="24" placeholder="比如：小李" autofocus></div>
    <div class="row" style="margin-top:16px">
      <button class="btn" data-act="join-confirm">${busy ? '正在加入…' : '进去看看'}</button>
    </div>
    <p class="small" style="margin-top:16px">在别的手机或电脑上已经进过这个组？
      <button class="textbtn" data-act="transfer-redeem" style="color:var(--primary);text-decoration:underline">用换设备码进来</button>，
      这样两台设备算同一个人。</p>`;
}
function transferDlg(code, exp) {
  if (code) {
    const url = `${location.origin}${location.pathname}#t=${code}`;
    let qr = ''; try { qr = qrSvg(url, { size: 160 }); } catch {}
    return `<div class="dlghead"><h3>换设备</h3></div>
      <p class="small">在<strong>新设备</strong>上打开网站，输入下面这串数字；或者直接扫这个码。<strong>10 分钟内有效，只能用一次。</strong>
        用完之后两台设备都算你，改的东西都记在同一个名下。</p>
      <div class="codebig">${code.slice(0, 4)} ${code.slice(4)}</div>
      <div style="text-align:center;margin:10px 0"><div class="qrbox">${qr}</div></div>
      <div class="row"><button class="btn out" data-act="team">返回</button></div>`;
  }
  return `<div class="dlghead"><h3>用换设备码进来</h3></div>
    <p class="small">在<strong>已经进组的那台设备</strong>上，点顶部的小组按钮 → 「换设备」，会得到 8 位数字。填在这里：</p>
    <div class="fld"><input data-f="code" inputmode="numeric" maxlength="9" placeholder="8 位数字" style="font-size:22px;letter-spacing:3px;text-align:center"></div>
    <div class="row"><button class="btn" data-act="transfer-go">${busy ? '正在验证…' : '确认'}</button>
      <button class="btn out" data-act="close">取消</button></div>`;
}

function teamDlg() {
  if (!cloud) {
    return `<div class="dlghead"><h3>一起把行程定下来</h3></div>
      <p>建一个小组，公开攻略会复制一份进去，之后你和搭子都能改。<strong>没有账号，不用注册。</strong>建组的人是组长，能管人、锁模块、换邀请链接。</p>
      <div class="fld"><span class="fieldlabel">你叫什么（给搭子看的）</span>
        <input data-f="who" value="${esc(me.name)}" maxlength="24" placeholder="比如：小王"></div>
      <div class="fld"><span class="fieldlabel">小组名字</span>
        <input data-f="name" value="国庆印尼搭子" maxlength="60"></div>
      <div class="row"><button class="btn" data-act="create-go">${busy ? '正在创建…' : '创建小组'}</button>
        <button class="btn out" data-act="close">取消</button></div>
      <hr style="margin:20px 0;border:0;border-top:1px solid var(--line)">
      <div class="fld"><span class="fieldlabel">或者，粘贴搭子发来的邀请链接</span>
        <input data-f="invite" placeholder="https://…/#g=…&i=…"></div>
      <div class="row"><button class="btn out" data-act="join-go">加入这个小组</button>
        <button class="textbtn" data-act="transfer-redeem" style="color:var(--primary)">我有换设备码</button></div>`;
  }
  if (cloud.pending || cloud.ownerSetupNeeded) return `<div class="dlghead"><h3>${esc(cloud.group.name)}</h3></div>
    <p class="small">${cloud.pending ? '等组长同意后这里才会有内容。' : '组长身份待激活。'}</p>
    <div class="row"><button class="btn out" data-act="transfer-redeem">我有换设备码</button>
      <button class="btn out" data-act="leave">在这台设备上退出</button></div>`;

  const g = cloud.group, ms = cloud.members || [], owner = isOwner();
  const fmtSeen = t => t ? new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  let html = '';

  if (owner) {
    const url = `${location.origin}${location.pathname}#g=${g.id}&i=${g.invite_code}`;
    let qr = ''; try { qr = qrSvg(url, { size: 190 }); } catch { qr = '<p class="small">链接太长，直接发链接吧。</p>'; }
    html += `<div class="dlghead"><h3>邀请搭子进来</h3></div>
      <p class="small">扫码或点链接，填名字就能加入。<strong>这个页面随时能再打开</strong> —— 每一页顶部都有「邀请 / 二维码」。</p>
      <div style="text-align:center;margin:14px 0"><div class="qrbox">${qr}</div></div>
      <div class="linkbox"><input readonly value="${esc(url)}" aria-label="邀请链接" onclick="this.select()">
        <button class="btn sm" data-act="copy" data-url="${esc(url)}">复制</button></div>
      <div class="row" style="margin:10px 0 4px;gap:14px;align-items:center">
        <label class="row" style="gap:8px;font-size:14px"><input type="checkbox" data-act="approval-toggle"${g.approval ? ' checked' : ''} style="width:22px;height:22px;min-height:0">
          新人入组要我同意</label>
        <button class="textbtn" data-act="invite-rotate" style="color:var(--warn)">换一条新链接</button></div>
      <p class="small">换链接后旧的二维码立刻作废，已经在组里的人不受影响。有人退出、或怀疑链接流出去了，就换一条。</p>`;
    if ((cloud.pendingMembers || []).length) {
      html += `<hr style="margin:18px 0;border:0;border-top:1px solid var(--line)">
        <div class="fld"><span class="fieldlabel" style="color:var(--warn)">等你同意（${cloud.pendingMembers.length}）</span>
        ${cloud.pendingMembers.map(m => `<div class="memberrow">
          <span class="avatar">${esc(initials(m.name))}</span><span class="mname">${esc(m.name)}</span>
          <button class="btn sm" data-act="member-approve" data-mid="${esc(m.member_id)}">同意</button>
          <button class="btn sm out" data-act="member-reject" data-mid="${esc(m.member_id)}" data-name="${esc(m.name)}">拒绝</button>
        </div>`).join('')}</div>`;
    }
  } else {
    html += `<div class="dlghead"><h3>${esc(g.name)}</h3></div>
      <p class="small">邀请新人由组长来发。你在这个组里是<strong>${ROLE_NAME[cloud.me.role]}</strong>。</p>`;
  }

  html += `<hr style="margin:18px 0;border:0;border-top:1px solid var(--line)">
    <div class="fld"><span class="fieldlabel">成员（${ms.length} 人）</span>
    ${ms.map(m => {
      const self = m.member_id === cloud.me.member_id;
      return `<div class="memberrow">
        <span class="avatar">${esc(initials(m.name))}</span>
        <span class="mname">${esc(m.name)}${self ? ' · 我' : ''}<br><span class="small">${m.role === 'owner' ? '组长' : ''}${m.seen_at ? (m.role === 'owner' ? ' · ' : '') + '最近 ' + fmtSeen(m.seen_at) : ''}</span></span>
        ${owner && !self && m.role !== 'owner' ? `
          <select data-act="member-role" data-mid="${esc(m.member_id)}" style="width:auto;min-height:36px;padding:6px 26px 6px 10px;font-size:13px">
            <option value="editor"${m.role === 'editor' ? ' selected' : ''}>可编辑</option>
            <option value="viewer"${m.role === 'viewer' ? ' selected' : ''}>只读</option></select>
          <button class="iconbtn" data-act="member-remove" data-mid="${esc(m.member_id)}" data-name="${esc(m.name)}" aria-label="移除 ${esc(m.name)}">🗑</button>`
          : !owner || self ? '' : `<span class="chip plain">${ROLE_NAME[m.role]}</span>`}
      </div>`;
    }).join('')}
    ${owner ? `<p class="small" style="margin-top:8px">移除后他的钥匙当场作废，拿着旧链接也进不来；他改过的内容会留着。移除之后记得<strong>换一条新链接</strong>。</p>` : ''}
    </div>
    <div class="fld"><span class="fieldlabel">你的显示名</span>
      <div class="linkbox"><input data-f="who" value="${esc(cloud.me.name)}" maxlength="24">
        <button class="btn sm out" data-act="rename-me">改名</button></div></div>
    ${owner ? `<div class="fld"><span class="fieldlabel">小组名字</span>
      <div class="linkbox"><input data-f="gname" value="${esc(g.name)}" maxlength="60">
        <button class="btn sm out" data-act="rename-group">保存</button></div></div>` : ''}
    <div class="row" style="margin-top:6px;gap:10px">
      <button class="btn out" data-act="transfer-create">📱 换设备</button>
      <button class="btn out" data-act="leave">在这台设备上退出</button></div>
    <p class="small" style="margin-top:10px">换设备：在新手机或电脑上继续用你这个身份。退出：只是这台设备不再自动打开，云端内容不受影响。</p>`;
  return html;
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
    hidden: $('[data-f="hidden"]', root)?.checked ?? editing.draft?.hidden ?? !!editing.mod?.hidden,
    locked: $('[data-f="locked"]', root)?.checked ?? editing.draft?.locked ?? !!editing.mod?.locked,
    groupBy: $('[data-f="groupBy"]', root)?.value ?? editing.draft?.groupBy ?? editing.mod?.group_by ?? ''
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
      openDay = date; tab = 'overview'; paint();
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
      case 'create': case 'join-manual': case 'invite': case 'team': openDlg(teamDlg()); break;
      case 'create-go': {
        const who = readF(root, 'who') || '发起人', name = readF(root, 'name') || '我们的旅行';
        me.name = who; LS.set('idn.name', who);
        busy = true; paint(); openDlg(teamDlg());
        let r;
        try { r = await api({ action: 'create', name, who, member: me.id }, { auth: false }); }
        catch (er) { busy = false; toast(er.message); openDlg(teamDlg()); break; }
        busy = false;
        saveToken(r.group, r.token);
        await pull(); tab = 'overview'; paint(); openDlg(teamDlg());
        toast('小组建好了，你是组长。把二维码发给搭子');
        break;
      }
      case 'join-go': {
        const v = readF(root, 'invite');
        let g = '', i = '';
        try { const h = new URLSearchParams(new URL(v).hash.slice(1)); g = h.get('g'); i = h.get('i'); } catch {}
        if (!g || !i) { toast('这条链接不对，要带 #g= 和 &i= 那一串'); break; }
        pendingInvite = { gid: g, code: i };
        await startInvite();
        break;
      }
      case 'join-confirm': {
        const who = readF(root, 'who');
        if (!who) { toast('填个名字吧，随便什么都行'); break; }
        if (!pendingInvite) { toast('邀请信息丢了，重新打开链接'); break; }
        me.name = who; LS.set('idn.name', who);
        busy = true; openDlg(joinDlg(editing?.inviteInfo || { name: '', ownerName: '组长' }));
        let r;
        try { r = await api({ action: 'join', group: pendingInvite.gid, invite: pendingInvite.code, who, member: me.id }, { auth: false }); }
        catch (er) { busy = false; toast(er.message); break; }
        busy = false;
        saveToken(pendingInvite.gid, r.token); pendingInvite = null;
        await pull(); closeDlg(); tab = 'overview'; paint();
        toast(r.status === 'pending' ? '已申请，等组长同意' : `欢迎，${who}`);
        break;
      }
      /* 换设备 */
      case 'transfer-create': {
        const r = await api({ action: 'transferCreate' });
        openDlg(transferDlg(r.code, r.expires_at));
        break;
      }
      case 'transfer-redeem': openDlg(transferDlg()); break;
      case 'transfer-go': {
        const code = readF(root, 'code').replace(/\D/g, '');
        if (code.length !== 8) { toast('换设备码是 8 位数字'); break; }
        busy = true; openDlg(transferDlg());
        let r;
        try { r = await api({ action: 'transferRedeem', code }, { auth: false }); }
        catch (er) { busy = false; toast(er.message); openDlg(transferDlg()); break; }
        busy = false;
        me.id = r.member; LS.set('idn.member', r.member);
        me.name = r.name; LS.set('idn.name', r.name);
        saveToken(r.group, r.token); pendingInvite = null; pendingTransfer = '';
        await pull(); closeDlg(); tab = 'overview'; paint();
        toast(`这台设备现在是「${r.name}」了`);
        break;
      }
      /* 组长：成员管理 */
      case 'member-approve':
        await act({ action: 'memberApprove', target: b.dataset.mid }, { keepDialog: true }); openDlg(teamDlg()); toast('已同意'); break;
      case 'member-reject':
        if (!confirm(`拒绝「${b.dataset.name}」加入？`)) break;
        await act({ action: 'memberReject', target: b.dataset.mid }, { keepDialog: true }); openDlg(teamDlg()); break;
      case 'member-remove':
        if (!confirm(`把「${b.dataset.name}」移出小组？\n他的钥匙会立刻作废，拿旧链接也进不来。他改过的内容会留着。`)) break;
        await act({ action: 'memberRemove', target: b.dataset.mid }, { keepDialog: true }); openDlg(teamDlg());
        toast('已移除。建议顺手换一条新链接'); break;
      case 'invite-rotate':
        if (!confirm('换一条新邀请链接？旧的二维码立刻作废，已在组里的人不受影响。')) break;
        await act({ action: 'inviteRotate' }, { keepDialog: true }); openDlg(teamDlg()); toast('链接已更换，记得重新发二维码'); break;
      case 'leave':
        if (confirm('只是这台设备不再自动打开这个小组，云端内容不会删。确定吗？')) {
          LS.set('idn.gid', ''); LS.set('idn.tok.' + me.gid, ''); LS.set('idn.key.' + me.gid, '');
          me.gid = ''; me.token = ''; me.legacyKey = ''; cloud = null; pendingInvite = null; closeDlg(); paint();
        }
        break;
      case 'copy': {
        let done = false;
        try { await navigator.clipboard.writeText(b.dataset.url); done = true; } catch {}
        if (!done) {
          // 部分内置浏览器不给用剪贴板 API，退回到"选中 + execCommand"这套老办法
          const box = b.closest('.linkbox')?.querySelector('input[readonly]');
          if (box) {
            box.focus();
            box.setSelectionRange(0, box.value.length);
            try { done = document.execCommand('copy'); } catch {}
          }
        }
        if (done) {
          const label = b.textContent;
          b.textContent = '✓ 已复制';
          setTimeout(() => { b.textContent = label; }, 2000);
          toast('链接已复制，发给搭子就行');
        } else {
          toast('这个浏览器不让自动复制，长按上面的链接手动复制');
        }
        break;
      }
      case 'rename-me': {
        const name = readF(root, 'who'); if (!name) { toast('名字不能为空'); break; }
        await act({ action: 'renameMe', name }, { keepDialog: true }); openDlg(teamDlg()); toast('改好了');
        break;
      }
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
      case 'history': {
        const en = cloud.entries.find(x => x.id === id);
        const r = await api({ action: 'entryHistory', id });
        openDlg(historyDlg(en, r.history));
        break;
      }
      case 'revert':
        if (!confirm('恢复到这一版？当前版本也会存进历史，随时能再回来。')) break;
        await act({ action: 'entryRevert', id, to: +b.dataset.to });
        closeDlg(); paint(); toast('已恢复');
        break;
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
          locked: !!$('[data-f="locked"]', root)?.checked,
          groupBy: $('[data-f="groupBy"]', root)?.value || '',
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
  const ap = e.target.closest('[data-act="approval-toggle"]');
  if (ap) { try { await act({ action: 'approvalSet', on: ap.checked }, { keepDialog: true }); openDlg(teamDlg()); } catch {} return; }
  const rl = e.target.closest('[data-act="member-role"]');
  if (rl) { try { await act({ action: 'memberRole', target: rl.dataset.mid, role: rl.value }, { keepDialog: true }); openDlg(teamDlg()); toast('已更新'); } catch {} return; }
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

/* 手风琴：展开一天，其它自动收起。
   收起别的会让页面高度变化，所以记下点击的那一行原来在屏幕上的位置，
   收完再把滚动条补回去 —— 不然手指点的那一行会突然跳走。 */
document.addEventListener('toggle', e => {
  const el = e.target, d = el.dataset?.day;
  if (!d) return;
  if (!el.open) { if (openDay === d) openDay = ''; return; }
  const before = el.getBoundingClientRect().top;
  openDay = d;
  $$('details.day[data-day]').forEach(o => { if (o !== el) o.open = false; });
  const after = el.getBoundingClientRect().top;
  if (after !== before) window.scrollBy(0, after - before);
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
  if (!cloud || busy || (editing && !cloud.pending) || document.visibilityState !== 'visible') return;
  pull().then(paint).catch(err => { netError = err.message; paint(); });
};
setInterval(sync, 15000);
// 切回前台立刻同步一次，不然要干等一轮才看得到队友的改动
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
window.addEventListener('online', sync);

/* 邀请流程：先拉预览（组名、组长、要不要审批），再问名字 */
async function startInvite() {
  const { gid, code } = pendingInvite;
  const r = await fetch(`./api/travel?g=${encodeURIComponent(gid)}&i=${encodeURIComponent(code)}`, { cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { toast(d.error || '邀请链接无效'); pendingInvite = null; return; }
  // 已经是这个组的成员（比如自己点了自己的二维码）就直接进
  if (LS.get('idn.tok.' + gid)) { loadGroup(gid); pendingInvite = null;
    try { await pull(); tab = 'overview'; paint(); return; } catch {} }
  editing = { mode: 'join', inviteInfo: d.invite };
  paint(); openDlg(joinDlg(d.invite));
}

/* 启动 */
(async () => {
  paint();
  if (pendingTransfer) { openDlg(transferDlg()); $('[data-f="code"]').value = pendingTransfer; return; }
  if (pendingInvite) { await startInvite(); return; }
  if (me.gid && authKey()) {
    try { await pull(); }
    catch (err) {
      netError = err.message;
      // 钥匙失效（被移除 / 链接换过）：清掉本机记录，回到落地页
      if (/失效|换过|重新进组|不在小组/.test(err.message)) {
        LS.set('idn.gid', ''); LS.set('idn.tok.' + me.gid, ''); LS.set('idn.key.' + me.gid, '');
        me.gid = ''; me.token = ''; me.legacyKey = ''; cloud = null;
        toast(err.message);
      }
    }
  }
  paint();
})();
