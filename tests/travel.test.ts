import test from 'node:test';
import assert from 'node:assert/strict';
import {cost,durationHours,validateEntry,safeUrl} from '../lib/travel.ts';
import {seedEntries} from '../lib/guide.ts';
test('cross-midnight and cross-timezone flights use absolute time',()=>{assert.equal(durationHours({departure:'2026-10-01T21:50',departureZone:'UTC+8',arrival:'2026-10-02T02:00',arrivalZone:'UTC+7'}),31/6);assert.equal(durationHours({departure:'2026-10-06T16:40',departureZone:'UTC+8',arrival:'2026-10-06T17:00',arrivalZone:'UTC+7'}),4/3)});
test('budget converts then splits once',()=>{assert.deepEqual(cost({amount:'100000',rate:'0.00045',people:'3'}),{total:45,each:15});assert.throws(()=>validateEntry({kind:'budget',title:'a',scope:'private',data:{amount:'1',rate:'1',people:'0'}}));assert.throws(()=>validateEntry({kind:'budget',title:'a',scope:'private',data:{amount:'1',rate:'2',people:'1',currency:'CNY'}}))});
test('unsafe URLs and nonfinite amounts rejected',()=>{assert.equal(safeUrl('javascript:alert(1)'),'');assert.throws(()=>validateEntry({kind:'music',title:'a',scope:'group',data:{url:'javascript:alert(1)'}}));assert.throws(()=>validateEntry({kind:'budget',title:'a',scope:'private',data:{amount:'Infinity',rate:'1',people:'1'}}))});
test('all public templates validate and contain no personal cost records',()=>{for(const e of seedEntries)validateEntry({...e,scope:'group'});assert.equal(seedEntries.filter(e=>e.kind==='budget').length,0);assert.equal(seedEntries.filter(e=>e.kind==='music').length,26);assert.equal(seedEntries.filter(e=>e.kind==='route').length,8)});
