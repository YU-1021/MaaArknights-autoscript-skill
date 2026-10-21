#!/usr/bin/env node
/* 只校验一份作业 JSON —— 不跑视频，秒级返回。
 *
 * 用法：
 *   node bin/validate.cjs <作业.json> [--maa=<MAA目录>] [--stage=<关卡>]
 *
 * 为什么单独做这个：
 *   手改完作业（比如把占位名改成真实干员）后，需要马上知道有没有写错。
 *   跑整条流水线要几分钟，而这个只要零点几秒。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require(path.join(__dirname, '..', 'lib', 'copilot.cjs'));

function arg(n, d) {
  const h = process.argv.slice(2).find((a) => a === '--' + n || a.startsWith('--' + n + '='));
  if (!h) return d;
  const i = h.indexOf('=');
  return i < 0 ? true : h.slice(i + 1);
}
const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('用法: node bin/validate.cjs <作业.json> [--maa=<MAA目录>] [--stage=<关卡>]');
  process.exit(2);
}
const MAA = String(arg('maa', 'F:\\dspet\\MAA-v6.19.0-win-x64。2'));
const stageArg = arg('stage', null);

if (!fs.existsSync(file)) { console.error('❌ 文件不存在: ' + file); process.exit(2); }

let script;
try { script = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error('❌ JSON 解析失败: ' + ((e && e.message) || e)); process.exit(1); }

const tp = path.join(MAA, 'resource', 'Arknights-Tile-Pos');
if (!fs.existsSync(tp)) { console.error('❌ 找不到 Tile-Pos: ' + tp); process.exit(2); }

const stage = String(stageArg || script.stage_name || '');
const t = C.findTile(tp, stage, {});
if (!t.ok) {
  console.error('❌ 找不到关卡数据：「' + stage + '」  ' + t.reason);
  console.error('   作业里的 stage_name 必须能在 Arknights-Tile-Pos 里查到（写 YW-1 或 act52side_01 都行）');
  process.exit(1);
}
const lv = t.data;
console.log('关卡 ' + (lv.code || stage) + '  ' + lv.width + 'x' + lv.height);

const v = C.validate(script, lv);
console.log('');
console.log('校验 ok=' + v.ok + '  errors=' + v.errors.length + '  warnings=' + v.warnings.length);
v.errors.forEach((e) => console.log('  E ' + e));
v.warnings.forEach((e) => console.log('  W ' + e));
if (v.stats) console.log('');
if (v.stats) console.log('统计: ' + JSON.stringify(v.stats));

/* 额外：把每条 Deploy 的落点格子类型打出来，方便人工核对 */
const deploys = (script.actions || []).filter((a) => {
  const ty = String(a.type || '').toLowerCase();
  return ty === 'deploy' || ty === '部署' || (!a.type && a.location);
});
if (deploys.length) {
  console.log('');
  console.log('Deploy 落点:');
  for (const a of deploys) {
    const l = a.location;
    if (!Array.isArray(l) || l.length < 2) { console.log('  ' + (a.name || '?') + '  无 location'); continue; }
    const tx = l[0], ty = l[1];
    const d = (lv.tiles[ty] || [])[tx];
    if (!d) { console.log('  ' + (a.name || '?') + ' [' + tx + ',' + ty + ']  越界'); continue; }
    const kind = d.buildableType === 0 ? '不可部署' : d.buildableType === 1 ? '地面' : d.buildableType === 2 ? '高台' : '通用';
    console.log('  ' + String(a.name || '?').padEnd(8) + ' [' + tx + ',' + ty + ']  ' + kind + '  ' + d.tileKey);
  }
}
process.exit(v.ok ? 0 : 1);
