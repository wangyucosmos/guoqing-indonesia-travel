/* 国庆印尼旅游 · 云端协作接口（Cloudflare Worker + D1）
 *
 * 权限模型（B 方案）：
 *   - 每个成员有自己的钥匙（token），存在他自己的浏览器里；服务器只存哈希。
 *     请求头 X-Trip-Key 带 token，服务器由此确定"你是谁"—— 不再信任客户端自报的身份。
 *   - 建组的人是组长（groups.owner_id）。只有组长能：管成员、设角色、锁模块、
 *     换邀请链接、开关入组审批、改模块结构。
 *   - 角色：owner / editor / viewer。viewer 只读。
 *   - 邀请链接只带 invite_code，不带任何钥匙。扫码填名字后服务器才发钥匙。
 *   - 换设备：旧设备生成 8 位数字码（10 分钟有效、一次性），新设备输入后拿到自己的钥匙。
 *   - 每次改动前把旧版本快照进 history，可以回滚。
 *
 * 过渡：迁移前的小组还有一把旧万能钥匙（groups.secret）。legacy_until 之前，
 * 已有成员用旧钥匙读取时自动换发个人钥匙；组长身份只能通过设置码激活，不走这条路。
 */

import { getPlanData } from './seed.js';

const PLAN_IDS = ['A', 'B'];
const planId = value => PLAN_IDS.includes(value) ? value : 'A';

const J = (data, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const bad = (msg, status = 400) => J({ error: msg }, status);
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const key40 = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '').slice(0, 40);
const inviteCode = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);
const digits8 = () => String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v.trim() : null);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'time', 'select', 'url', 'check'];
const LAYOUTS = ['card', 'check', 'day'];
const HISTORY_KEEP = 20;

/* ---------- 内置模块 ---------- */
const F = (key, label, type = 'text', options) => ({ key, label, type, ...(options ? { options } : {}) });
const BUILTIN = [
  { builtin: 'route', name: '路线计划', icon: '🗺', layout: 'day', locked: 1, fields: [
    F('notes', '具体计划 / 提醒', 'textarea')] },
  { builtin: 'guide', name: '出发前要知道', icon: '📖', layout: 'card', fields: [
    F('notes', '内容', 'textarea'), F('url', '参考链接', 'url')] },
  { builtin: 'flight', name: '航班', icon: '✈️', layout: 'card', groupBy: 'who', fields: [
    F('who', '谁的航班'),
    F('from', '出发'), F('to', '到达'), F('no', '航班号'),
    F('dep', '起飞（当地时间）'), F('arr', '到达（当地时间）'),
    F('status', '状态', 'select', ['待预订', '已预订', '已出票', '已值机', '有变动']),
    F('notes', '备注', 'textarea')] },
  { builtin: 'pack', name: '行李清单', icon: '🎒', layout: 'check', fields: [
    F('cat', '分类', 'select', ['预订', '证件入境', '通信', '衣物', '摄影', '随身', '药品', '当日携带', '自定义']),
    F('notes', '备注', 'textarea')] },
  { builtin: 'music', name: '旅途歌单', icon: '🎵', layout: 'card', fields: [
    F('artist', '歌手'),
    F('scene', '场景', 'select', ['布罗莫日出', '巴厘岛日落', '科莫多山海', '路上', '其他']),
    F('url', '分享链接', 'url'), F('notes', '推荐理由', 'textarea')] },
  { builtin: 'budget', name: '预算', icon: '💰', layout: 'card', fields: [
    F('amount', '金额', 'number'), F('cur', '币种', 'select', ['CNY', 'IDR', 'USD']),
    F('rate', '折合人民币汇率', 'number'), F('people', '分摊人数', 'number'),
    F('status', '状态', 'select', ['预算', '已支付']), F('notes', '备注', 'textarea')] },
  { builtin: 'note', name: '自由笔记', icon: '📝', layout: 'card', fields: [
    F('notes', '内容', 'textarea'), F('url', '参考链接', 'url')] }
];

function seedStatements(db, gid, mid, who, t, plan) {
  const { days: DAYS, essentials: ESSENTIALS, music: MUSIC, flights: FLIGHTS, pack: PACK } = getPlanData(plan);
  const st = [], modIds = {};
  BUILTIN.forEach((m, i) => {
    const id = uid(); modIds[m.builtin] = id;
    st.push(db.prepare(
      `INSERT INTO modules (id,group_id,plan,name,icon,layout,fields,group_by,locked,sort,builtin,hidden,version,updated_at,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,1,?,?)`
    ).bind(id, gid, plan, m.name, m.icon, m.layout, JSON.stringify(m.fields), m.groupBy || '', m.locked || 0,
           (i + 1) * 100, m.builtin, t, who));
  });
  const entry = (modKey, title, data, day = '', sort = 0) => st.push(db.prepare(
    `INSERT INTO entries (id,group_id,plan,module_id,title,data,scope,owner,day,sort,version,updated_at,updated_by,deleted)
     VALUES (?,?,?,?,?,?,'group',?,?,?,1,?,?,0)`
  ).bind(uid(), gid, plan, modIds[modKey], title, JSON.stringify(data), mid, day, sort, t, who));
  DAYS.forEach(d => d.items.forEach(([time, title, note], n) => {
    const range = /^(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})$/.exec(time);
    const one = /^(\d{1,2}:\d{2})$/.exec(time);
    const start = range ? range[1] : one ? one[1] : '';
    entry('route', title, { start, end: range ? range[2] : '', label: start ? '' : time, notes: note },
      d.date, start ? Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) : 9000 + n);
  }));
  ESSENTIALS.forEach((e, i) => entry('guide', e.t, { notes: e.x, url: e.links[0]?.[1] || '' }, '', i));
  FLIGHTS.forEach(([title, from, to, dep, arr, notes], i) =>
    entry('flight', title, { who, from, to, no: '', dep, arr, status: '待预订', notes }, '', i));
  PACK.forEach(([title, cat, day], i) => entry('pack', title, { cat, notes: '', done: '' }, day, i));
  MUSIC.forEach(([title, artist, scene, notes], i) => entry('music', title, { artist, scene, url: '', notes }, '', i));
  return st;
}

/* ---------- 身份 ---------- */
async function issueToken(db, gid, mid, label) {
  const raw = key40();
  await db.prepare('INSERT INTO tokens (hash,group_id,member_id,created_at,label) VALUES (?,?,?,?,?)')
    .bind(await sha256(raw), gid, mid, now(), label || '').run();
  return raw;
}
/** 返回 { group, me, legacy } 或 null。me 是 members 行（含 role/status）。 */
async function auth(db, req, gid) {
  const key = req.headers.get('X-Trip-Key') || '';
  if (!gid || key.length !== 40) return null;
  const group = await db.prepare('SELECT * FROM groups WHERE id=?').bind(gid).first();
  if (!group) return null;
  const tok = await db.prepare('SELECT member_id FROM tokens WHERE hash=? AND group_id=?')
    .bind(await sha256(key), gid).first();
  if (tok) {
    const me = await db.prepare('SELECT * FROM members WHERE group_id=? AND member_id=?')
      .bind(gid, tok.member_id).first();
    if (!me || me.status === 'removed') return null;
    return { group, me, legacy: false };
  }
  if (group.secret === key && group.legacy_until && group.legacy_until > now()) return { group, me: null, legacy: true };
  return null;
}
const canEdit = (ctx, mod) => ctx.me && ctx.me.status === 'active' &&
  (ctx.me.role === 'owner' || (ctx.me.role === 'editor' && !mod.locked));

const memberPublic = m => ({ member_id: m.member_id, name: m.name, role: m.role, status: m.status, seen_at: m.seen_at });

/* ---------- 历史快照 ---------- */
async function snapshot(db, gid, old, action, who, t) {
  await db.prepare(
    `INSERT INTO history (id,group_id,entry_id,version,title,data,scope,day,sort,deleted,changed_at,changed_by,action)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(uid(), gid, old.id, old.version, old.title, old.data, old.scope, old.day, old.sort, old.deleted,
         t, who, action).run();
  await db.prepare(
    `DELETE FROM history WHERE entry_id=? AND id NOT IN
       (SELECT id FROM history WHERE entry_id=? ORDER BY version DESC LIMIT ?)`
  ).bind(old.id, old.id, HISTORY_KEEP).run();
}

/* ================= 读 ================= */
export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) return bad('云端数据库暂时不可用', 503);
    const db = env.DB, url = new URL(request.url);
    const gid = url.searchParams.get('g') || '';
    const plan = PLAN_IDS.includes(url.searchParams.get('p')) ? url.searchParams.get('p') : 'B';
    const invite = url.searchParams.get('i') || '';

    /* 邀请预览：扫码后进组前那一屏需要的信息，不需要钥匙 */
    if (gid && invite) {
      const g = await db.prepare('SELECT id,name,owner_id,approval FROM groups WHERE id=? AND invite_code=?')
        .bind(gid, invite).first();
      if (!g) return bad('邀请链接已失效，找组长要一条新的', 404);
      const n = await db.prepare(`SELECT count(*) c FROM members WHERE group_id=? AND status='active'`).bind(gid).first();
      const owner = await db.prepare('SELECT name FROM members WHERE group_id=? AND member_id=?').bind(gid, g.owner_id).first();
      return J({ invite: { name: g.name, approval: !!g.approval, memberCount: n?.c ?? 0, ownerName: owner?.name || '组长' } });
    }

    const ctx = await auth(db, request, gid);
    if (!ctx) return bad('链接无效或已失效，找组长重新发一次', 404);
    let me = ctx.me, issued = '';

    /* 旧钥匙过渡：已有成员自动换发个人钥匙；组长不走这条路 */
    if (ctx.legacy) {
      const mid = url.searchParams.get('m') || '';
      const row = mid ? await db.prepare('SELECT * FROM members WHERE group_id=? AND member_id=?').bind(gid, mid).first() : null;
      if (!row || row.status === 'removed') return bad('这条链接已经换过了，找组长要新的邀请', 403);
      if (row.member_id === ctx.group.owner_id) return J({ ownerSetupNeeded: true, group: { id: gid, name: ctx.group.name } });
      // 每台设备各发一把（客户端拿到后就不再用旧钥匙了，不会重复领）
      issued = await issueToken(db, gid, mid, '旧链接自动升级');
      me = row;
    }

    if (me.status === 'pending')
      return J({ pending: true, group: { id: gid, name: ctx.group.name }, me: memberPublic(me), issuedToken: issued });

    await db.prepare('UPDATE members SET seen_at=? WHERE group_id=? AND member_id=?').bind(now(), gid, me.member_id).run();
    const seeded = await db.prepare('SELECT 1 FROM modules WHERE group_id=? AND plan=? LIMIT 1').bind(gid, plan).first();
    if (!seeded) await db.batch(seedStatements(db, gid, me.member_id, me.name, now(), plan));
    const owner = me.role === 'owner';
    const [modules, entries, members] = await Promise.all([
      db.prepare('SELECT * FROM modules WHERE group_id=? AND plan=? ORDER BY sort').bind(gid, plan).all(),
      db.prepare(`SELECT * FROM entries WHERE group_id=? AND plan=? AND (scope='group' OR owner=?)`).bind(gid, plan, me.member_id).all(),
      db.prepare(`SELECT * FROM members WHERE group_id=? AND status<>'removed' ORDER BY joined_at`).bind(gid).all()
    ]);
    const g = ctx.group;
    return J({
      group: { id: g.id, name: g.name, owner_id: g.owner_id, approval: !!g.approval,
               ...(owner ? { invite_code: g.invite_code, legacy_until: g.legacy_until } : {}) },
      me: memberPublic(me),
      members: members.results.filter(m => m.status === 'active').map(memberPublic),
      pendingMembers: owner ? members.results.filter(m => m.status === 'pending').map(memberPublic) : [],
      modules: modules.results.map(m => ({ ...m, fields: JSON.parse(m.fields), hidden: !!m.hidden, locked: !!m.locked })),
      entries: entries.results.map(e => ({ ...e, data: JSON.parse(e.data), deleted: !!e.deleted })),
      plan, issuedToken: issued, serverTime: now()
    });
  } catch (e) {
    return bad('读取失败，请稍后重试；本次没有改动任何数据', 503);
  }
}

/* ================= 写 ================= */
export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return bad('云端数据库暂时不可用', 503);
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return bad('请求来源无效', 403);
    const raw = await request.text();
    if (raw.length > 200000) return bad('内容过长', 413);
    let b; try { b = JSON.parse(raw); } catch { return bad('请求格式错误'); }
    const db = env.DB, t = now(), a = b.action;

    /* —— 不需要钥匙的三个动作 —— */
    if (a === 'create') {
      const name = str(b.name, 60) || '我们的旅行';
      const who = str(b.who, 24) || '发起人';
      const gid = uid(), mid = str(b.member, 40) || uid();
      const st = [
        db.prepare('INSERT INTO groups (id,name,secret,created_at,owner_id,invite_code,approval,legacy_until) VALUES (?,?,?,?,?,?,0,\'\')')
          .bind(gid, name, key40(), t, mid, inviteCode()),
        db.prepare(`INSERT INTO members (group_id,member_id,name,joined_at,seen_at,role,status) VALUES (?,?,?,?,?,'owner','active')`)
          .bind(gid, mid, who, t, t),
        ...seedStatements(db, gid, mid, who, t, 'A'),
        ...seedStatements(db, gid, mid, who, t, 'B')
      ];
      await db.batch(st);
      const token = await issueToken(db, gid, mid, '建组设备');
      return J({ group: gid, member: mid, token });
    }

    if (a === 'join') {
      const gid = str(b.group, 40), code = str(b.invite, 40), who = str(b.who, 24);
      if (!gid || !code) return bad('邀请链接不完整');
      if (!who) return bad('填个名字吧');
      const g = await db.prepare('SELECT id,approval FROM groups WHERE id=? AND invite_code=?').bind(gid, code).first();
      if (!g) return bad('邀请链接已失效，找组长要一条新的', 404);
      const n = await db.prepare(`SELECT count(*) c FROM members WHERE group_id=? AND status<>'removed'`).bind(gid).first();
      if ((n?.c ?? 0) >= 30) return bad('这个小组人数已满');
      const mid = str(b.member, 40) || uid();
      const status = g.approval ? 'pending' : 'active';
      // 同一设备重复进组：沿用同一个 member id；已经是活跃成员的保持活跃，其余按当前规则
      await db.prepare(
        `INSERT INTO members (group_id,member_id,name,joined_at,seen_at,role,status) VALUES (?,?,?,?,?,'editor',?)
         ON CONFLICT(group_id,member_id) DO UPDATE SET name=excluded.name, seen_at=excluded.seen_at,
           status=CASE WHEN members.status='active' THEN 'active' ELSE excluded.status END`
      ).bind(gid, mid, who, t, t, status).run();
      const token = await issueToken(db, gid, mid, '扫码进组');
      const row = await db.prepare('SELECT status FROM members WHERE group_id=? AND member_id=?').bind(gid, mid).first();
      return J({ member: mid, token, status: row.status });
    }

    if (a === 'transferRedeem') {
      const code = str(b.code, 8);
      if (!code || !/^\d{8}$/.test(code)) return bad('换设备码是 8 位数字');
      const tr = await db.prepare('SELECT * FROM transfers WHERE code=? AND used=0').bind(code).first();
      if (!tr || tr.expires_at < t) { await sleep(400); return bad('换设备码不对或已过期（10 分钟内有效）', 404); }
      const m = await db.prepare('SELECT * FROM members WHERE group_id=? AND member_id=?').bind(tr.group_id, tr.member_id).first();
      if (!m || m.status !== 'active') return bad('这个身份已不在小组里', 404);
      await db.prepare('UPDATE transfers SET used=1 WHERE code=?').bind(code).run();
      const token = await issueToken(db, tr.group_id, tr.member_id, '换设备');
      return J({ group: tr.group_id, member: tr.member_id, name: m.name, role: m.role, token });
    }

    /* —— 以下都要个人钥匙 —— */
    const gid = str(b.group, 40);
    const ctx = await auth(db, request, gid);
    if (!ctx || ctx.legacy || !ctx.me) return bad('这条链接已经换过了，请刷新页面重新进组', 403);
    const me = ctx.me, mid = me.member_id, who = me.name;
    const plan = planId(b.plan);
    if (me.status !== 'active') return bad('组长还没同意你加入', 403);
    const owner = me.role === 'owner';
    const ownerOnly = () => owner ? null : bad('只有组长能做这个操作', 403);

    /* —— 成员自己 —— */
    if (a === 'renameMe') {
      const name = str(b.name, 24); if (!name) return bad('名字不能为空');
      await db.prepare('UPDATE members SET name=? WHERE group_id=? AND member_id=?').bind(name, gid, mid).run();
      return J({ ok: true });
    }
    if (a === 'transferCreate') {
      let code = digits8();
      for (let i = 0; i < 5; i++) {
        const dup = await db.prepare('SELECT 1 FROM transfers WHERE code=?').bind(code).first();
        if (!dup) break;
        code = digits8();
      }
      const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await db.prepare('DELETE FROM transfers WHERE expires_at < ? OR (group_id=? AND member_id=?)').bind(t, gid, mid).run();
      await db.prepare('INSERT INTO transfers (code,group_id,member_id,expires_at,used) VALUES (?,?,?,?,0)')
        .bind(code, gid, mid, exp).run();
      return J({ code, expires_at: exp });
    }

    /* —— 组长：小组与成员 —— */
    if (a === 'rename') {
      const deny = ownerOnly(); if (deny) return deny;
      const name = str(b.name, 60); if (!name) return bad('小组名需要 1–60 字');
      await db.prepare('UPDATE groups SET name=? WHERE id=?').bind(name, gid).run();
      return J({ ok: true });
    }
    if (a === 'inviteRotate') {
      const deny = ownerOnly(); if (deny) return deny;
      const code = inviteCode();
      await db.prepare(`UPDATE groups SET invite_code=?, legacy_until='' WHERE id=?`).bind(code, gid).run();
      return J({ invite_code: code });
    }
    if (a === 'approvalSet') {
      const deny = ownerOnly(); if (deny) return deny;
      await db.prepare('UPDATE groups SET approval=? WHERE id=?').bind(b.on ? 1 : 0, gid).run();
      return J({ ok: true });
    }
    if (a === 'memberApprove' || a === 'memberReject' || a === 'memberRole' || a === 'memberRemove') {
      const deny = ownerOnly(); if (deny) return deny;
      const target = str(b.target, 40);
      if (!target) return bad('缺少成员标识');
      if (target === mid) return bad('不能对自己做这个操作');
      const row = await db.prepare('SELECT * FROM members WHERE group_id=? AND member_id=?').bind(gid, target).first();
      if (!row) return bad('成员不存在', 404);
      if (a === 'memberApprove') {
        await db.prepare(`UPDATE members SET status='active' WHERE group_id=? AND member_id=?`).bind(gid, target).run();
      } else if (a === 'memberRole') {
        const role = ['editor', 'viewer'].includes(b.role) ? b.role : null;
        if (!role) return bad('角色只能是可编辑或只读');
        await db.prepare('UPDATE members SET role=? WHERE group_id=? AND member_id=?').bind(role, gid, target).run();
      } else {
        // 拒绝 / 移除：作废他所有钥匙，当场失效
        await db.batch([
          db.prepare('DELETE FROM tokens WHERE group_id=? AND member_id=?').bind(gid, target),
          db.prepare('DELETE FROM transfers WHERE group_id=? AND member_id=?').bind(gid, target),
          db.prepare(`UPDATE members SET status='removed' WHERE group_id=? AND member_id=?`).bind(gid, target)
        ]);
      }
      return J({ ok: true });
    }

    /* —— 组长：模块结构 —— */
    if (a === 'moduleAdd' || a === 'moduleUpdate') {
      const deny = ownerOnly(); if (deny) return deny;
      const name = str(b.name, 30); if (!name) return bad('模块名需要 1–30 字');
      const icon = str(b.icon, 8) || '📌';
      const layout = LAYOUTS.includes(b.layout) ? b.layout : 'card';
      if (!Array.isArray(b.fields) || b.fields.length > 12) return bad('字段最多 12 个');
      const fields = [];
      for (const f of b.fields) {
        const label = str(f.label, 20); if (!label) return bad('每个字段都要有名称');
        if (!FIELD_TYPES.includes(f.type)) return bad('字段类型无效');
        const opts = f.type === 'select'
          ? (Array.isArray(f.options) ? f.options.map(o => str(o, 20)).filter(Boolean).slice(0, 20) : []) : null;
        if (f.type === 'select' && !opts.length) return bad(`「${label}」是下拉框，至少要一个选项`);
        fields.push({ key: str(f.key, 24) || 'f' + fields.length, label, type: f.type, ...(opts ? { options: opts } : {}) });
      }
      const groupBy = str(b.groupBy, 24) || '';
      if (groupBy && !fields.some(f => f.key === groupBy)) return bad('分组字段不存在');
      const locked = b.locked ? 1 : 0;
      if (a === 'moduleAdd') {
        const n = await db.prepare('SELECT count(*) c, max(sort) s FROM modules WHERE group_id=? AND plan=?').bind(gid, plan).first();
        if (n.c >= 24) return bad('模块最多 24 个');
        const id = uid();
        await db.prepare(
          `INSERT INTO modules (id,group_id,plan,name,icon,layout,fields,group_by,locked,sort,builtin,hidden,version,updated_at,updated_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,NULL,0,1,?,?)`
        ).bind(id, gid, plan, name, icon, layout, JSON.stringify(fields), groupBy, locked, (n.s || 0) + 100, t, who).run();
        return J({ id });
      }
      const changed = await db.prepare(
        `UPDATE modules SET name=?,icon=?,fields=?,group_by=?,locked=?,hidden=?,version=version+1,updated_at=?,updated_by=?
         WHERE id=? AND group_id=? AND plan=? AND version=? RETURNING id`
      ).bind(name, icon, JSON.stringify(fields), groupBy, locked, b.hidden ? 1 : 0, t, who, b.id, gid, plan, b.version).first();
      return changed ? J({ ok: true }) : bad('这个模块刚被改过，刷新后再改一次', 409);
    }
    if (a === 'moduleDelete') {
      const deny = ownerOnly(); if (deny) return deny;
      const m = await db.prepare('SELECT builtin FROM modules WHERE id=? AND group_id=? AND plan=?').bind(b.id, gid, plan).first();
      if (!m) return bad('模块不存在', 404);
      if (m.builtin) return bad('内置模块不能删除，可以在设置里隐藏它');
      await db.batch([
        db.prepare('DELETE FROM history WHERE group_id=? AND entry_id IN (SELECT id FROM entries WHERE module_id=?)').bind(gid, b.id),
        db.prepare('DELETE FROM entries WHERE group_id=? AND plan=? AND module_id=?').bind(gid, plan, b.id),
        db.prepare('DELETE FROM modules WHERE group_id=? AND plan=? AND id=?').bind(gid, plan, b.id)
      ]);
      return J({ ok: true });
    }
    if (a === 'moduleSort') {
      const deny = ownerOnly(); if (deny) return deny;
      if (!Array.isArray(b.order) || b.order.length > 24) return bad('排序参数无效');
      await db.batch(b.order.map((id, i) => db.prepare('UPDATE modules SET sort=? WHERE id=? AND group_id=? AND plan=?').bind((i + 1) * 100, id, gid, plan)));
      return J({ ok: true });
    }

    /* —— 记录 —— */
    const loadMod = async id => {
      const m = await db.prepare('SELECT * FROM modules WHERE id=? AND group_id=? AND plan=?').bind(id, gid, plan).first();
      return m ? { ...m, locked: !!m.locked } : null;
    };
    const denyEdit = mod => bad(mod?.locked ? '这个模块只有组长能改' : '你是只读成员，改不了', 403);

    if (a === 'entryAdd' || a === 'entryUpdate') {
      const mod = await loadMod(b.module);
      if (!mod) return bad('模块不存在', 404);
      if (!canEdit(ctx, mod)) return denyEdit(mod);
      const title = str(b.title, 120); if (title === null) return bad('标题最多 120 字');
      const scope = b.scope === 'private' ? 'private' : 'group';
      const day = str(b.day, 10) || '';
      const src = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};
      const data = {};
      for (const [k, v] of Object.entries(src)) {
        if (k.length > 24) continue;
        const s = String(v ?? ''); if (s.length > 8000) return bad('单个字段最多 8000 字');
        data[k] = s;
      }
      if (a === 'entryAdd') {
        const n = await db.prepare('SELECT count(*) c FROM entries WHERE group_id=? AND plan=?').bind(gid, plan).first();
        if (n.c >= 3000) return bad('记录太多了，先清理一下回收站');
        const id = uid();
        await db.prepare(
          `INSERT INTO entries (id,group_id,plan,module_id,title,data,scope,owner,day,sort,version,updated_at,updated_by,deleted)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,0)`
        ).bind(id, gid, plan, b.module, title, JSON.stringify(data), scope, mid, day, Number(b.sort) || 0, t, who).run();
        return J({ id });
      }
      const old = await db.prepare(`SELECT * FROM entries WHERE id=? AND group_id=? AND plan=? AND (scope='group' OR owner=?)`)
        .bind(b.id, gid, plan, mid).first();
      if (!old) return bad('记录不存在或没有权限', 404);
      if (old.scope === 'private' && old.owner !== mid) return bad('私人记录只有本人能改', 403);
      if (old.scope !== scope && old.owner !== mid) return bad('只有添加这条的人能改可见范围', 403);
      if (old.version !== b.version) return bad('队友刚刚改过这一条。你填的内容还在，刷新看到最新版本后再合并一次。', 409);
      await snapshot(db, gid, old, 'update', who, t);
      const changed = await db.prepare(
        `UPDATE entries SET title=?,data=?,scope=?,day=?,sort=?,version=version+1,updated_at=?,updated_by=?
         WHERE id=? AND group_id=? AND plan=? AND version=? AND deleted=0 RETURNING id`
      ).bind(title, JSON.stringify(data), scope, day, Number(b.sort) || 0, t, who, b.id, gid, plan, b.version).first();
      return changed ? J({ ok: true }) : bad('队友刚刚改过这一条。你填的内容还在，刷新看到最新版本后再合并一次。', 409);
    }

    if (a === 'entryDelete' || a === 'entryRestore') {
      const old = await db.prepare(`SELECT * FROM entries WHERE id=? AND group_id=? AND plan=? AND (scope='group' OR owner=?)`)
        .bind(b.id, gid, plan, mid).first();
      if (!old) return bad('记录不存在或没有权限', 404);
      const mod = await loadMod(old.module_id);
      if (!mod || !canEdit(ctx, mod)) return denyEdit(mod);
      if (old.version !== b.version) return bad('队友刚刚改过这一条，刷新后再试', 409);
      await snapshot(db, gid, old, a === 'entryDelete' ? 'delete' : 'restore', who, t);
      const changed = await db.prepare(
        `UPDATE entries SET deleted=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND group_id=? AND plan=? AND version=? RETURNING id`
      ).bind(a === 'entryDelete' ? 1 : 0, t, who, b.id, gid, plan, b.version).first();
      return changed ? J({ ok: true }) : bad('队友刚刚改过这一条，刷新后再试', 409);
    }

    if (a === 'entryHistory') {
      const en = await db.prepare(`SELECT id FROM entries WHERE id=? AND group_id=? AND plan=? AND (scope='group' OR owner=?)`)
        .bind(b.id, gid, plan, mid).first();
      if (!en) return bad('记录不存在', 404);
      const rows = await db.prepare('SELECT * FROM history WHERE entry_id=? ORDER BY version DESC').bind(b.id).all();
      return J({ history: rows.results.map(h => ({ ...h, data: JSON.parse(h.data), deleted: !!h.deleted })) });
    }
    if (a === 'entryRevert') {
      const old = await db.prepare(`SELECT * FROM entries WHERE id=? AND group_id=? AND plan=? AND (scope='group' OR owner=?)`)
        .bind(b.id, gid, plan, mid).first();
      if (!old) return bad('记录不存在', 404);
      const mod = await loadMod(old.module_id);
      if (!mod || !canEdit(ctx, mod)) return denyEdit(mod);
      const h = await db.prepare('SELECT * FROM history WHERE entry_id=? AND version=?').bind(b.id, Number(b.to)).first();
      if (!h) return bad('找不到那个版本', 404);
      await snapshot(db, gid, old, 'revert', who, t);
      await db.prepare(
        `UPDATE entries SET title=?,data=?,scope=?,day=?,sort=?,deleted=?,version=version+1,updated_at=?,updated_by=?
         WHERE id=? AND group_id=? AND plan=?`
      ).bind(h.title, h.data, h.scope, h.day, h.sort, h.deleted, t, who, b.id, gid, plan).run();
      return J({ ok: true });
    }
    if (a === 'entryPurge') {
      const deny = ownerOnly(); if (deny) return deny;
      await db.batch([
        db.prepare('DELETE FROM history WHERE group_id=? AND entry_id IN (SELECT id FROM entries WHERE group_id=? AND plan=? AND deleted=1)').bind(gid, gid, plan),
        db.prepare('DELETE FROM entries WHERE group_id=? AND plan=? AND deleted=1').bind(gid, plan)
      ]);
      return J({ ok: true });
    }

    return bad('未知操作');
  } catch (e) {
    return bad('保存没有完成，请重试。你填的内容还留在页面上。', 503);
  }
}
