import assert from 'node:assert/strict';
import { PLAN_CONFIG, getPlanData } from '../cloud/src/seed.js';

assert.deepEqual(Object.keys(PLAN_CONFIG), ['A', 'B']);
assert.equal(getPlanData('unknown').id, 'A');
assert.equal(PLAN_CONFIG.A.days[0].date, '2026-10-01');
assert.equal(PLAN_CONFIG.A.days.at(-1).date, '2026-10-08');
assert.match(JSON.stringify(PLAN_CONFIG.A), /Padar Island/);
assert.match(JSON.stringify(PLAN_CONFIG.A), /Pink Beach/);
assert.match(JSON.stringify(PLAN_CONFIG.A), /Taka Makassar/);
assert.match(JSON.stringify(PLAN_CONFIG.A), /10\/02 08:05/);
assert.match(JSON.stringify(PLAN_CONFIG.A), /10\/08 13:15/);
assert.doesNotMatch(JSON.stringify(PLAN_CONFIG.A), /Bima|BMU|09\/30|9月30日/);
assert.notEqual(PLAN_CONFIG.A.days, PLAN_CONFIG.B.days);
assert.notEqual(PLAN_CONFIG.A.pins, PLAN_CONFIG.B.pins);
console.log('plan seed validation passed');
