import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {validateEntry} from '@/lib/travel';
import {seedEntries} from '@/lib/guide';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
function database(){if(!env.DB)throw Error('云端数据库暂时不可用');return env.DB}
export async function GET(req:Request){try{
 const user=await getChatGPTUser();if(!user)return json({user:null,groups:[],entries:[]});
 const db=database();const groups=(await db.prepare('SELECT g.id,g.name,g.owner,g.invite FROM groups g JOIN members m ON m.group_id=g.id WHERE m.user_id=?').bind(user.userId).all()).results;
 const id=new URL(req.url).searchParams.get('group');let entries:unknown[]=[];let members:unknown[]=[];
 if(id){if(!groups.some(g=>g.id===id))return json({error:'你还没有加入这个小组'},403);
 entries=(await db.prepare('SELECT id,group_id AS groupId,kind,scope,owner,title,data,version,updated_at AS updatedAt,updated_by AS updatedBy,deleted FROM entries WHERE group_id=? AND (scope=\'group\' OR owner=?) ORDER BY updated_at DESC').bind(id,user.userId).all()).results.map(r=>({...r,data:JSON.parse(r.data as string)}));
 members=(await db.prepare('SELECT name FROM members WHERE group_id=?').bind(id).all()).results;
 }
 return json({user:{id:user.userId,name:user.displayName},groups,entries,members});
 }catch{return json({error:'暂时无法读取云端内容，请稍后重试；本次没有覆盖数据。'},503)}}
export async function POST(req:Request){try{
 const origin=req.headers.get('origin');if(!origin||origin!==new URL(req.url).origin)return json({error:'请求来源无效'},403);
 const user=await getChatGPTUser();if(!user)return json({error:'请先登录再编辑'},401);
 const raw=await req.text();if(raw.length>64000)return json({error:'内容过长'},413);let b;try{b=JSON.parse(raw)}catch{return json({error:'请求格式错误'},400)}
 const db=database();const now=new Date().toISOString();
 if(b.action==='create'){
 const name=typeof b.name==='string'?b.name.trim():'';if(!name||name.length>80)return json({error:'小组名称需为 1–80 字'},400);
 const count=await db.prepare('SELECT count(*) AS n FROM groups WHERE owner=?').bind(user.userId).first<{n:number}>();if((count?.n??0)>=10)return json({error:'每个账号最多创建 10 个小组'},400);
 const id=crypto.randomUUID(),invite=crypto.randomUUID()+crypto.randomUUID();
 const statements=[db.prepare('INSERT INTO groups VALUES (?,?,?,?,?)').bind(id,name,user.userId,invite,now),db.prepare('INSERT INTO members VALUES (?,?,?)').bind(id,user.userId,user.displayName)];
 for(const seed of seedEntries){const e=validateEntry({...seed,scope:'group'});statements.push(db.prepare('INSERT INTO entries (id,group_id,kind,scope,owner,title,data,version,updated_at,updated_by,deleted) VALUES (?,?,?,?,?,?,?,1,?,?,0)').bind(crypto.randomUUID(),id,e.kind,'group',user.userId,e.title,JSON.stringify(e.data),now,user.displayName));}
 await db.batch(statements);return json({id});
 }
 if(b.action==='join'){
 if(typeof b.invite!=='string'||b.invite.length!==72)return json({error:'邀请链接无效'},400);
 const g=await db.prepare('SELECT id FROM groups WHERE invite=?').bind(b.invite).first<{id:string}>();if(!g)return json({error:'邀请链接不存在或已更换，请向队友获取新链接'},404);
 await db.prepare('INSERT OR IGNORE INTO members VALUES (?,?,?)').bind(g.id,user.userId,user.displayName).run();return json({id:g.id});
 }
 if(typeof b.group!=='string')return json({error:'请选择小组'},400);
 const membership=await db.prepare('SELECT user_id FROM members WHERE group_id=? AND user_id=?').bind(b.group,user.userId).first();if(!membership)return json({error:'仅小组成员可以操作'},403);
 if(b.action==='rotate'){
 const invite=crypto.randomUUID()+crypto.randomUUID();const changed=await db.prepare('UPDATE groups SET invite=? WHERE id=? AND owner=? RETURNING id').bind(invite,b.group,user.userId).first();return changed?json({ok:true}):json({error:'只有创建者可以更换邀请链接'},403);
 }
 if(b.action==='add'){
 let e;try{e=validateEntry(b.entry)}catch(err){return json({error:(err as Error).message},400)}
 const id=crypto.randomUUID();await db.prepare('INSERT INTO entries (id,group_id,kind,scope,owner,title,data,version,updated_at,updated_by,deleted) VALUES (?,?,?,?,?,?,?,1,?,?,0)').bind(id,b.group,e.kind,e.scope,user.userId,e.title,JSON.stringify(e.data),now,user.displayName).run();return json({id});
 }
 if(!['update','delete','restore'].includes(b.action)||typeof b.id!=='string'||!Number.isInteger(b.version))return json({error:'操作参数无效'},400);
 const old=await db.prepare('SELECT * FROM entries WHERE id=? AND group_id=? AND (scope=\'group\' OR owner=?)').bind(b.id,b.group,user.userId).first();if(!old)return json({error:'记录不存在或无权操作'},404);
 let changed;
 if(b.action==='update'){
 let e;try{e=validateEntry(b.entry)}catch(err){return json({error:(err as Error).message},400)}
 if(e.kind!==old.kind)return json({error:'不能改变记录所属模块'},400);
 if(e.scope!==old.scope&&old.owner!==user.userId)return json({error:'只有记录创建者可以修改可见范围'},403);
 changed=await db.prepare('UPDATE entries SET title=?,data=?,scope=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=? AND deleted=0 RETURNING id').bind(e.title,JSON.stringify(e.data),e.scope,now,user.displayName,b.id,b.version).first();
 }else{changed=await db.prepare('UPDATE entries SET deleted=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=? RETURNING id').bind(b.action==='delete'?1:0,now,user.displayName,b.id,b.version).first();}
 return changed?json({ok:true}):json({error:'队友刚刚更新了这条记录。请保留你的输入，关闭后重新打开最新版本再合并。'},409);
 }catch{return json({error:'保存未完成，请重试。你的输入仍保留在当前页面。'},503)}}
