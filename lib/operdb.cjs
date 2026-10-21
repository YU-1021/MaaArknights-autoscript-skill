/* 干员数据库 —— 直接读 MAA 的 resource/battle_data.json。
 *
 * 为什么用 MAA 的数据而不是自己编：
 *   ① 1384 个干员的**中文名**是 copilot 作业里 `opers[].name` 要求的写法，必须逐字一致；
 *   ② `position` 是 **MELEE / RANGED** —— 直接决定"能站地面格还是高台格"，
 *      这是校验作业能不能落地的硬判据（比按职业猜准得多）；
 *   ③ `profession` / `subProfessionId` 用来推断技能用法；
 *   ④ 配套的 resource/template/char_*.png（462 张）可以拿来做头像模板匹配。
 *
 * 顺便纠正一个我自己埋的坑：copilot.cjs 里原来有一张手写的 ROLE_LOCATION
 * （Warrior→Melee 之类），那是**按职业猜**的，而真实规则是按 position。
 * 有了这个模块，那条猜测就只作为 operdb 不可用时的兜底。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const POSITION_TO_TYPE = {
  /* buildableType: 1=地面(近战) 2=高台(远程) 3=两者皆可 */
  MELEE: [1, 3],
  RANGED: [2, 3],
};

let cache = { file: '', db: null };

/* 找 battle_data.json：显式给路径优先，否则在 maaResource 里找 */
function resolveFile(maaResource) {
  if (!maaResource) return null;
  const direct = path.join(maaResource, 'battle_data.json');
  if (fs.existsSync(direct)) return direct;
  const alt = path.join(maaResource, 'resource', 'battle_data.json');
  if (fs.existsSync(alt)) return alt;
  return null;
}

/* 载入（带缓存）。返回 { ok, file, count } */
function load(maaResource) {
  const f = resolveFile(maaResource);
  if (!f) return { ok: false, reason: '找不到 battle_data.json（给的 maaResource=' + maaResource + '）' };
  if (cache.db && cache.file === f) return { ok: true, file: f, count: cache.db.list.length, cached: true };
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { return { ok: false, reason: '解析失败：' + ((e && e.message) || e) }; }
  const chars = j.chars || {};
  const arr = Array.isArray(chars) ? chars : Object.values(chars);
  const byName = new Map();
  for (const c of arr) {
    if (!c || !c.name) continue;
    /* 同名会有多条（不同分支/星级），保留第一条并记录全部 */
    if (!byName.has(c.name)) byName.set(c.name, c);
  }
  cache = {
    file: f,
    db: {
      list: arr,
      byName,
      ranges: j.ranges || {},
    },
  };
  return { ok: true, file: f, count: arr.length };
}

function ready() { return !!(cache.db && cache.db.byName.size); }

/* 查一个干员。返回 { name, position, profession, subProfessionId, rarity, rangeId } */
function info(name) {
  if (!ready()) return null;
  const c = cache.db.byName.get(String(name || '').trim());
  if (!c) return null;
  return {
    name: c.name,
    name_en: c.name_en || '',
    position: String(c.position || '').toUpperCase(),
    profession: String(c.profession || '').toUpperCase(),
    subProfessionId: c.subProfessionId || '',
    rarity: c.rarity,
    rangeId: c.rangeId,
  };
}

/* 这个干员能不能站 buildableType 这一格？
 * 返回 { ok, why } —— why 用于报错文案 */
function canStandOn(name, buildableType) {
  const i = info(name);
  if (!i) return { ok: true, unknown: true, why: '干员库里没有「' + name + '」，跳过位置校验' };
  if (!i.position) return { ok: true, unknown: true, why: '「' + name + '」没有 position 字段' };
  const allow = POSITION_TO_TYPE[i.position];
  if (!allow) return { ok: true, unknown: true, why: '未知 position：' + i.position };
  if (allow.indexOf(Number(buildableType)) >= 0) return { ok: true };
  return {
    ok: false,
    why: '「' + name + '」是 ' + i.position + '（' + i.profession + '），只能站 '
      + allow.map((b) => (b === 1 ? '地面格' : b === 2 ? '高台格' : '通用格')).join('/')
      + '，但这里是 buildableType=' + buildableType,
  };
}

/* 按位置筛出可用的干员名（给"自动挑干员"用） */
function namesByPosition(pos) {
  if (!ready()) return [];
  const want = String(pos || '').toUpperCase();
  const out = [];
  for (const c of cache.db.list) {
    if (String(c.position || '').toUpperCase() === want && c.name) out.push(c.name);
  }
  return out;
}

/* 名字是否存在（校验作业里的拼写） */
function has(name) { return ready() && cache.db.byName.has(String(name || '').trim()); }

/* 找近似名（拼错一个字的常见情况） */
function suggest(name) {
  if (!ready()) return [];
  const t = String(name || '').trim();
  if (!t) return [];
  const out = [];
  for (const k of cache.db.byName.keys()) {
    if (k.indexOf(t) >= 0 || t.indexOf(k) >= 0) out.push(k);
  }
  return out.slice(0, 5);
}

function stats() {
  if (!ready()) return { loaded: false };
  const pos = {};
  for (const c of cache.db.list) {
    const p = String(c.position || '?').toUpperCase();
    pos[p] = (pos[p] || 0) + 1;
  }
  return { loaded: true, file: cache.file, count: cache.db.list.length, byPosition: pos };
}

module.exports = { load, ready, info, canStandOn, namesByPosition, has, suggest, stats, POSITION_TO_TYPE };
