export const kinds = ['route','flight','budget','music','checklist','note'] as const;
export type Kind = typeof kinds[number];
export type Fields = Record<string,string>;
export type Entry = {id:string;groupId:string;kind:Kind;scope:'group'|'private';owner:string;title:string;data:Fields;version:number;updatedAt:string;updatedBy:string;deleted:number};
export const labels:Record<Kind,string>={route:'路线计划',flight:'航班时间',budget:'预算账本',music:'旅途歌单',checklist:'行李清单',note:'自由笔记'};
export const fieldSpecs:Record<Kind,{key:string;label:string;type?:string;options?:string[]}[]>={
 route:[{key:'date',label:'日期',type:'date'},{key:'time',label:'当地时间',type:'time'},{key:'zone',label:'时区',options:['UTC+8','UTC+7']},{key:'place',label:'地点（地图搜索）'},{key:'transport',label:'交通方式',options:['步行','包车','飞机','快艇','吉普','其他']},{key:'order',label:'同日顺序',type:'number'},{key:'notes',label:'安排与提醒',type:'textarea'}],
 flight:[{key:'number',label:'航班号（预订后填写）'},{key:'from',label:'出发机场'},{key:'to',label:'到达机场'},{key:'departure',label:'当地出发日期与时间',type:'datetime-local'},{key:'departureZone',label:'出发时区',options:['UTC+8','UTC+7']},{key:'arrival',label:'当地到达日期与时间',type:'datetime-local'},{key:'arrivalZone',label:'到达时区',options:['UTC+8','UTC+7']},{key:'status',label:'人工确认状态',options:['待预订','已预订','已值机','延误','取消','已抵达']},{key:'terminal',label:'航站楼 / 行李'},{key:'notes',label:'记录 / 动态来源',type:'textarea'}],
 budget:[{key:'amount',label:'总金额',type:'number'},{key:'currency',label:'币种',options:['CNY','IDR','USD']},{key:'rate',label:'1 单位币种折合人民币（手动汇率）',type:'number'},{key:'people',label:'分摊人数',type:'number'},{key:'status',label:'费用状态',options:['预算','已支付']},{key:'notes',label:'备注',type:'textarea'}],
 music:[{key:'artist',label:'歌手 / 艺术家'},{key:'scene',label:'场景',options:['布罗莫日出','巴厘岛日落','科莫多山海','路上','其他']},{key:'url',label:'音乐分享链接',type:'url'},{key:'notes',label:'推荐理由',type:'textarea'}],
 checklist:[{key:'category',label:'分类',options:['证件入境','预订','衣物','摄影','随身','通信','其他']},{key:'done',label:'完成情况',options:['待完成','已完成']},{key:'notes',label:'备注',type:'textarea'}],
 note:[{key:'notes',label:'正文 / 自定义模块内容',type:'textarea'},{key:'url',label:'参考链接',type:'url'}]
};
export function safeUrl(value:string){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:''}catch{return ''}}
export function durationHours(d:Fields){if(!d.departure||!d.arrival)return null;const start=Date.parse(`${d.departure}${d.departureZone==='UTC+7'?'+07:00':'+08:00'}`);const end=Date.parse(`${d.arrival}${d.arrivalZone==='UTC+7'?'+07:00':'+08:00'}`);return Number.isFinite(start)&&Number.isFinite(end)?(end-start)/3600000:null}
export function cost(d:Fields){const amount=Number(d.amount),rate=Number(d.rate),people=Number(d.people);return {total:amount*rate,each:amount*rate/people}}
export function validateEntry(input:unknown):{kind:Kind;scope:'group'|'private';title:string;data:Fields}{
 if(!input||typeof input!=='object')throw Error('记录格式错误');const b=input as Record<string,unknown>;
 if(!kinds.includes(b.kind as Kind))throw Error('模块不存在');
 if(b.scope!=='group'&&b.scope!=='private')throw Error('请选择可见范围');
 if(typeof b.title!=='string'||!b.title.trim()||b.title.length>160)throw Error('标题需为 1–160 字');
 if(!b.data||typeof b.data!=='object'||Array.isArray(b.data))throw Error('内容格式错误');
 const kind=b.kind as Kind;const data:Fields={};
 for(const f of fieldSpecs[kind]){const val=(b.data as Fields)[f.key]??'';if(typeof val!=='string'||val.length>8000)throw Error('内容过长或格式错误');if(f.options&&val&&!f.options.includes(val))throw Error('选项无效');if(f.type==='url'&&val&&!safeUrl(val))throw Error('链接须以 https:// 或 http:// 开头');if((f.type==='date'||f.type==='datetime-local')&&val&&!Number.isFinite(Date.parse(val)))throw Error('日期无效');data[f.key]=val;}
 if(kind==='budget'){if(!Number.isFinite(Number(data.amount))||Number(data.amount)<0||!data.amount||!Number.isFinite(Number(data.rate))||Number(data.rate)<=0||!Number.isInteger(Number(data.people))||Number(data.people)<1||Number(data.people)>1000)throw Error('请填写有效金额、正数汇率和分摊人数');if(data.currency==='CNY'&&Number(data.rate)!==1)throw Error('人民币汇率应为 1');if(!Number.isFinite(cost(data).total))throw Error('金额过大');}
 if(kind==='flight'){const h=durationHours(data);if(h!==null&&h<=0)throw Error('到达时间必须晚于出发时间，请检查日期与时区');}
 return {kind,scope:b.scope,title:b.title.trim(),data};
}
