/* 国庆印尼旅游 · 云端协作接口（Cloudflare Worker + D1）
 *
 * 没有账号系统。一个小组 = 一条 groups 记录 + 一串 40 位密钥。
 * 密钥只走 X-Trip-Key 请求头，不放 URL query —— 放 query 会进 Cloudflare 访问日志和 Referer。
 * 前端把密钥存在链接的 # 片段里，# 片段浏览器不会发给服务器。
 *
 * 安全边界（写清楚免得以后误用）：拿到链接的人就能读写整组内容，
 * 这是给几个人的旅行小组用的，不适合放任何敏感信息。
 */

import { DAYS, ESSENTIALS, MUSIC, FLIGHTS, PACK } from './seed.js';

const J = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  });
const bad = (msg, status = 400) => J({ error: msg }, status);
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const key40 = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '').slice(0, 40);

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v.trim() : null);
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'time', 'select', 'url', 'check'];
const LAYOUTS = ['card', 'check', 'day'];

/* ---------- 模块字段定义 ---------- */
const F = (key, label, type = 'text', options) => ({ key, label, type, ...(options ? { options } : {}) });

const BUILTIN = [
  { builtin: 'route', name: '路线计划', icon: '🗺', layout: 'day', fields: [
    F('notes', '具体计划 / 提醒', 'textarea')] },
  { builtin: 'guide', name: '出发前要知道', icon: '📖', layout: 'card', fields: [
    F('notes', '内容', 'textarea'), F('url', '参考链接', 'url')] },
  { builtin: 'flight', name: '航班', icon: '✈️', layout: 'card', fields: [
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

/* ---------- 建组时铺初始内容 ---------- */
function seedStatements(db, gid, mid, who, t) {
  const st = [];
  const modIds = {};
  BUILTIN.forEach((m, i) => {
    const id = uid();
    modIds[m.builtin] = id;
    st.push(db.prepare(
      `INSERT INTO modules (id,group_id,name,icon,layout,fields,sort,builtin,hidden,version,updated_at,updated_by)
       VALUES (?,?,?,?,?,?,?,?,0,1,?,?)`
    ).bind(id, gid, m.name, m.icon, m.layout, JSON.stringify(m.fields), (i + 1) * 100, m.builtin, t, who));
  });

  const entry = (modKey, title, data, day = '', sort = 0) => st.push(db.prepare(
    `INSERT INTO entries (id,group_id,module_id,title,data,scope,owner,day,sort,version,updated_at,updated_by,deleted)
     VALUES (?,?,?,?,?,'group',?,?,?,1,?,?,0)`
  ).bind(uid(), gid, modIds[modKey], title, JSON.stringify(data), mid, day, sort, t, who));

  // 路线计划：把攻略里每天的时间段铺成可编辑记录
  DAYS.forEach(d => d.items.forEach(([time, title, note], n) => {
    const range = /^(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})$/.exec(time);
    const one = /^(\d{1,2}:\d{2})$/.exec(time);
    const start = range ? range[1] : one ? one[1] : '';
    entry('route', title, {
      start, end: range ? range[2] : '', label: start ? '' : time, notes: note
    }, d.date, start ? Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) : 9000 + n);
  }));

  ESSENTIALS.forEach((e, i) => entry('guide', e.t, {
    notes: e.x, url: e.links[0]?.[1] || '',
    links: e.links.map(l => l.join('|')).join('\n')
  }, '', i));
  FLIGHTS.forEach(([title, from, to, dep, arr, notes], i) =>
    entry('flight', title, { from, to, no: '', dep, arr, status: '待预订', notes }, '', i));
  PACK.forEach(([title, cat, day], i) => entry('pack', title, { cat, notes: '', done: '' }, day, i));
  MUSIC.forEach(([title, artist, scene, notes], i) =>
    entry('music', title, { artist, scene, url: '', notes }, '', i));

  return st;
}

/* ---------- 身份校验 ---------- */
async function auth(env, req, gid) {
  if (!env.DB) throw new Response(null, { status: 503 });
  const secret = req.headers.get('X-Trip-Key') || '';
  if (!gid || secret.length !== 40) return null;
  const g = await env.DB.prepare('SELECT id,name FROM groups WHERE id=? AND secret=?')
    .bind(gid, secret).first();
  return g || null;
}

/* ---------- 读 ---------- */
export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const gid = url.searchParams.get('g');
    const mid = url.searchParams.get('m') || '';
    const g = await auth(env, request, gid);
    if (!g) return bad('链接无效或已失效，找建组的人重新发一次', 404);

    const db = env.DB;
    if (mid) await db.prepare('UPDATE members SET seen_at=? WHERE group_id=? AND member_id=?')
      .bind(now(), gid, mid).run();

    const [modules, entries, members] = await Promise.all([
      db.prepare('SELECT * FROM modules WHERE group_id=? ORDER BY sort').bind(gid).all(),
      db.prepare(`SELECT * FROM entries WHERE group_id=? AND (scope='group' OR owner=?)`)
        .bind(gid, mid).all(),
      db.prepare('SELECT member_id,name,seen_at FROM members WHERE group_id=? ORDER BY joined_at')
        .bind(gid).all()
    ]);

    return J({
      group: g,
      modules: modules.results.map(m => ({ ...m, fields: JSON.parse(m.fields), hidden: !!m.hidden })),
      entries: entries.results.map(e => ({ ...e, data: JSON.parse(e.data), deleted: !!e.deleted })),
      members: members.results,
      serverTime: now()
    });
  } catch (e) {
    console.error('GET /api/travel 失败:', e?.stack || e);   // 面向用户的话术不带细节，细节进服务端日志
    if (e instanceof Response) return bad('云端数据库暂时不可用', 503);
    return bad('读取失败，请稍后重试；本次没有改动任何数据', 503);
  }
}

/* ---------- 写 ---------- */
export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return bad('云端数据库暂时不可用', 503);
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return bad('请求来源无效', 403);

    const raw = await request.text();
    if (raw.length > 200000) return bad('内容过长', 413);
    let b;
    try { b = JSON.parse(raw); } catch { return bad('请求格式错误'); }

    const db = env.DB, t = now(), a = b.action;

    /* —— 建组：不需要密钥 —— */
    if (a === 'create') {
      const name = str(b.name, 60) || '我们的旅行';
      const who = str(b.who, 24) || '发起人';
      const gid = uid(), mid = str(b.member, 40) || uid(), secret = key40();
      await db.batch([
        db.prepare('INSERT INTO groups VALUES (?,?,?,?)').bind(gid, name, secret, t),
        db.prepare('INSERT INTO members VALUES (?,?,?,?,?)').bind(gid, mid, who, t, t),
        ...seedStatements(db, gid, mid, who, t)
      ]);
      return J({ group: gid, secret, member: mid });
    }

    /* —— 以下都要密钥 —— */
    const g = await auth(env, request, b.group);
    if (!g) return bad('链接无效或已失效，找建组的人重新发一次', 403);
    const gid = b.group;
    const mid = str(b.member, 40);
    if (!mid) return bad('缺少成员标识');
    const who = str(b.who, 24) || '搭子';

    if (a === 'join') {
      await db.prepare(
        `INSERT INTO members VALUES (?,?,?,?,?)
         ON CONFLICT(group_id,member_id) DO UPDATE SET name=excluded.name, seen_at=excluded.seen_at`
      ).bind(gid, mid, who, t, t).run();
      return J({ ok: true, member: mid });
    }

    const member = await db.prepare('SELECT member_id FROM members WHERE group_id=? AND member_id=?')
      .bind(gid, mid).first();
    if (!member) return bad('还没有加入这个小组', 403);

    /* —— 模块 —— */
    if (a === 'moduleAdd' || a === 'moduleUpdate') {
      const name = str(b.name, 30);
      if (!name) return bad('模块名需要 1–30 字');
      const icon = str(b.icon, 8) || '📌';
      const layout = LAYOUTS.includes(b.layout) ? b.layout : 'card';
      if (!Array.isArray(b.fields) || b.fields.length > 12) return bad('字段最多 12 个');
      const fields = [];
      for (const f of b.fields) {
        const label = str(f.label, 20);
        if (!label) return bad('每个字段都要有名称');
        if (!FIELD_TYPES.includes(f.type)) return bad('字段类型无效');
        const opts = f.type === 'select'
          ? (Array.isArray(f.options) ? f.options.map(o => str(o, 20)).filter(Boolean).slice(0, 20) : [])
          : null;
        if (f.type === 'select' && !opts.length) return bad(`「${label}」是下拉框，至少要一个选项`);
        fields.push({ key: str(f.key, 24) || 'f' + fields.length, label, type: f.type, ...(opts ? { options: opts } : {}) });
      }
      if (a === 'moduleAdd') {
        const n = await db.prepare('SELECT count(*) c, max(sort) s FROM modules WHERE group_id=?')
          .bind(gid).first();
        if (n.c >= 24) return bad('模块最多 24 个');
        const id = uid();
        await db.prepare(
          `INSERT INTO modules (id,group_id,name,icon,layout,fields,sort,builtin,hidden,version,updated_at,updated_by)
           VALUES (?,?,?,?,?,?,?,NULL,0,1,?,?)`
        ).bind(id, gid, name, icon, layout, JSON.stringify(fields), (n.s || 0) + 100, t, who).run();
        return J({ id });
      }
      const changed = await db.prepare(
        `UPDATE modules SET name=?,icon=?,fields=?,hidden=?,version=version+1,updated_at=?,updated_by=?
         WHERE id=? AND group_id=? AND version=? RETURNING id`
      ).bind(name, icon, JSON.stringify(fields), b.hidden ? 1 : 0, t, who, b.id, gid, b.version).first();
      return changed ? J({ ok: true }) : bad('队友刚改过这个模块，刷新后再改一次', 409);
    }

    if (a === 'moduleDelete') {
      const m = await db.prepare('SELECT builtin FROM modules WHERE id=? AND group_id=?')
        .bind(b.id, gid).first();
      if (!m) return bad('模块不存在', 404);
      if (m.builtin) return bad('内置模块不能删除，可以在设置里隐藏它');
      await db.batch([
        db.prepare('DELETE FROM entries WHERE group_id=? AND module_id=?').bind(gid, b.id),
        db.prepare('DELETE FROM modules WHERE group_id=? AND id=?').bind(gid, b.id)
      ]);
      return J({ ok: true });
    }

    if (a === 'moduleSort') {
      if (!Array.isArray(b.order) || b.order.length > 24) return bad('排序参数无效');
      await db.batch(b.order.map((id, i) =>
        db.prepare('UPDATE modules SET sort=? WHERE id=? AND group_id=?').bind((i + 1) * 100, id, gid)));
      return J({ ok: true });
    }

    /* —— 记录 —— */
    if (a === 'entryAdd' || a === 'entryUpdate') {
      const mod = await db.prepare('SELECT id,fields FROM modules WHERE id=? AND group_id=?')
        .bind(b.module, gid).first();
      if (!mod) return bad('模块不存在', 404);
      const title = str(b.title, 120);
      if (title === null) return bad('标题最多 120 字');
      const scope = b.scope === 'private' ? 'private' : 'group';
      const day = str(b.day, 10) || '';
      const src = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};
      const data = {};
      for (const [k, v] of Object.entries(src)) {
        if (k.length > 24) continue;
        const s = String(v ?? '');
        if (s.length > 8000) return bad('单个字段最多 8000 字');
        data[k] = s;
      }
      if (a === 'entryAdd') {
        const n = await db.prepare('SELECT count(*) c FROM entries WHERE group_id=?').bind(gid).first();
        if (n.c >= 3000) return bad('这个小组的记录太多了，先清理一下回收站');
        const id = uid();
        await db.prepare(
          `INSERT INTO entries (id,group_id,module_id,title,data,scope,owner,day,sort,version,updated_at,updated_by,deleted)
           VALUES (?,?,?,?,?,?,?,?,?,1,?,?,0)`
        ).bind(id, gid, b.module, title, JSON.stringify(data), scope, mid, day,
               Number(b.sort) || 0, t, who).run();
        return J({ id });
      }
      const old = await db.prepare(
        `SELECT owner,scope FROM entries WHERE id=? AND group_id=? AND (scope='group' OR owner=?)`
      ).bind(b.id, gid, mid).first();
      if (!old) return bad('记录不存在或没有权限', 404);
      if (old.scope !== scope && old.owner !== mid) return bad('只有添加这条的人能改可见范围', 403);
      const changed = await db.prepare(
        `UPDATE entries SET title=?,data=?,scope=?,day=?,sort=?,version=version+1,updated_at=?,updated_by=?
         WHERE id=? AND group_id=? AND version=? AND deleted=0 RETURNING id`
      ).bind(title, JSON.stringify(data), scope, day, Number(b.sort) || 0, t, who,
             b.id, gid, b.version).first();
      return changed ? J({ ok: true })
        : bad('队友刚刚改过这一条。你填的内容还在，刷新看到最新版本后再合并一次。', 409);
    }

    if (a === 'entryDelete' || a === 'entryRestore') {
      const changed = await db.prepare(
        `UPDATE entries SET deleted=?,version=version+1,updated_at=?,updated_by=?
         WHERE id=? AND group_id=? AND version=? AND (scope='group' OR owner=?) RETURNING id`
      ).bind(a === 'entryDelete' ? 1 : 0, t, who, b.id, gid, b.version, mid).first();
      return changed ? J({ ok: true }) : bad('队友刚刚改过这一条，刷新后再试', 409);
    }

    if (a === 'entryPurge') {
      await db.prepare('DELETE FROM entries WHERE group_id=? AND deleted=1').bind(gid).run();
      return J({ ok: true });
    }

    if (a === 'rename') {
      const name = str(b.name, 60);
      if (!name) return bad('小组名需要 1–60 字');
      await db.prepare('UPDATE groups SET name=? WHERE id=?').bind(name, gid).run();
      return J({ ok: true });
    }

    return bad('未知操作');
  } catch (e) {
    console.error('POST /api/travel 失败:', e?.stack || e);
    return bad('保存没有完成，请重试。你填的内容还留在页面上。', 503);
  }
}
