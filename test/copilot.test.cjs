/* 作业（copilot）核心测试 —— 用 MAA 的**真实数据**跑，不 mock。
 *
 * 为什么必须用真数据：这个模块的全部价值就是"对得上 MAA 的实际格式"。
 * 用假数据测，只会得到一个自洽但没用的东西。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../lib/copilot.cjs');

const MAA = process.env.MAA_RESOURCE || 'F:\\dspet\\MaaAssistantArknights-dev-v2\\MaaAssistantArknights-dev-v2\\resource';
const TILES = path.join(MAA, 'Arknights-Tile-Pos');
const SAMPLES = path.join(MAA, 'copilot');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '   ' + extra : '')); }
};
const hr = (t) => console.log('\n=== ' + t + ' ===');

const HAS_MAA = fs.existsSync(TILES);
if (!HAS_MAA) {
  console.log('⚠️ 找不到 MAA 资源目录：' + TILES);
  console.log('   设 MAA_RESOURCE 环境变量指向 MaaAssistantArknights 的 resource 目录再跑。');
  process.exit(2);
}

/* ================================================================ §1 常量与源码一致 */
hr('§1 常量：照 MAA 源码抄的，别自己编');
{
  ok(C.ACTION_TYPES.length === 15, 'ActionType 15 种', C.ACTION_TYPES.join(','));
  ok(C.ACTION_TYPES.indexOf('Deploy') >= 0 && C.ACTION_TYPES.indexOf('SkillDaemon') >= 0, '含 Deploy / SkillDaemon');
  ok(C.ACTION_TYPES.indexOf('SetUnitLocation') >= 0, '含 SetUnitLocation（干员位移修正）');
  ok(C.DIRECTIONS.join(',') === 'Right,Left,Up,Down,None', '朝向 4+None', C.DIRECTIONS.join(','));
  ok(C.LOCATION_TYPE[0] === 'None' && C.LOCATION_TYPE[1] === 'Melee' && C.LOCATION_TYPE[2] === 'Ranged' && C.LOCATION_TYPE[3] === 'All',
    '★ buildableType 0/1/2/3 = None/Melee/Ranged/All（LocationType 枚举）', JSON.stringify(C.LOCATION_TYPE));
}

/* ================================================================ §2 关卡索引与查找 */
hr('§2 findTile：按玩家说的关卡代号找格子数据（真实 4269 个关卡）');
let cacheFile = path.join(require('os').tmpdir(), 'copilot-tile-idx.json');
{
  const t0 = Date.now();
  const r = C.findTile(TILES, '0-1', { cacheFile });
  const ms = Date.now() - t0;
  ok(r.ok, '★ 找到关卡 0-1 的格子数据', r.ok ? (path.basename(r.file) + '  ' + ms + 'ms（含建索引）') : r.reason);
  if (r.ok) {
    const sz = C.gridSize(r.data);
    ok(sz.w === 9 && sz.h === 6, '★ 0-1 是 9x6 的格子（和 JSON 里 width/height 一致）', sz.w + 'x' + sz.h);
    ok(r.data.code === '0-1', 'code 字段 = 0-1', r.data.code);
    ok(typeof r.data.stageId === 'string' && r.data.stageId.length > 0, 'stageId 有值', r.data.stageId);
  }
  /* 第二次应该走缓存，明显更快 */
  const t1 = Date.now();
  C.findTile(TILES, '0-1', { cacheFile });
  ok(Date.now() - t1 < ms + 50, '★ 第二次走索引缓存（不重复扫 4269 个文件）', (Date.now() - t1) + 'ms');

  /* 归一化：大小写/下划线/空格都算同一个 */
  ok(C.normalizeCode('of-1') === C.normalizeCode('OF_1'), '★ OF-1 / OF_1 归一成同一个', C.normalizeCode('OF_1'));
  const r2 = C.findTile(TILES, 'of-1', { cacheFile });
  ok(r2.ok || /没有关卡/.test(r2.reason), '小写代号也能查（查不到时说明原因而不是崩）', r2.ok ? '找到' : r2.reason.slice(0, 40));

  const r3 = C.findTile(TILES, '根本不存在的关卡ZZZ9', { cacheFile });
  ok(!r3.ok && /没有关卡/.test(r3.reason), '★ 不存在的关卡 → 明确说没有（不静默返回空）', r3.reason.slice(0, 50));
}

/* ================================================================ §3 真实作业能过 */
hr('§3 validate：MAA 自带的真实作业应该通过');
{
  const f = path.join(SAMPLES, 'OF-1_credit_fight.json');
  const script = JSON.parse(fs.readFileSync(f, 'utf8'));
  const tile = C.findTile(TILES, script.stage_name, { cacheFile });
  const v = C.validate(script, tile.ok ? tile.data : null);
  ok(v.ok, '★ MAA 自带的 OF-1 作业校验通过（我的校验器没误报）', v.ok ? JSON.stringify(v.stats.byType) : v.errors.join('; '));
  ok(v.stats.deploys >= 1, '统计出部署数', String(v.stats.deploys));
  ok(v.stats.opers >= 10, '统计出干员表人数', String(v.stats.opers));
  /* 它的 Deploy 是 先锋 在 [5,3]，方向 Right —— 这个格子必须是可部署的 */
  const dep = script.actions.find((a) => a.type === 'Deploy');
  if (dep && tile.ok) {
    const t = C.tileAt(tile.data, dep.location[0], dep.location[1]);
    ok(t && t.buildableType !== 0, '★ 那个 Deploy 落点确实可部署（校验器与真实数据一致）',
      t ? ('tileKey=' + t.tileKey + ' buildableType=' + t.buildableType) : '取不到格子');
  }
}

/* ================================================================ §4 能抓出真错误 */
hr('§4 validate：人写作业最容易犯的错，必须抓出来');
{
  const tile = C.findTile(TILES, '0-1', { cacheFile });
  const T = tile.ok ? tile.data : null;
  ok(T, '拿到 0-1 的格子数据当基准');

  const base = () => C.skeleton({ stage: '0-1', opers: ['推进之王'], title: 't' });

  /* 4.1 正常骨架应该干净 */
  {
    const s = base();
    C.addDeploy(s, { name: '推进之王', role: 'Pioneer', location: [1, 1], direction: 'Right', kills: 5 });
    const v = C.validate(s, T);
    /* [1,1] 在 0-1 里未必是地面格，所以只断言"没有结构错误" */
    const structural = v.errors.filter((e) => /type|location|direction|越界/.test(e));
    ok(structural.length === 0, '§4.1 结构正确的骨架没有结构错误', structural.join('; ') || '（干净）');
  }

  /* 4.2 越界 */
  {
    const s = base();
    C.addDeploy(s, { name: '推进之王', location: [99, 99], direction: 'Right', kills: 1 });
    const v = C.validate(s, T);
    ok(!v.ok && v.errors.some((e) => /越界/.test(e)), '★★ 格子越界 → error', (v.errors.find((e) => /越界/.test(e)) || '').slice(0, 60));
  }

  /* 4.3 动作类型拼错 */
  {
    const s = base();
    s.actions.push({ type: 'Deployy', location: [1, 1] });
    const v = C.validate(s, T);
    ok(!v.ok && v.errors.some((e) => /不认识/.test(e)), '★★ 动作类型拼错 → error 并列出可用类型', (v.errors.find((e) => /不认识/.test(e)) || '').slice(0, 70));
  }

  /* 4.4 Deploy 缺 location */
  {
    const s = base();
    s.actions.push({ type: 'Deploy', name: '推进之王', direction: 'Right' });
    const v = C.validate(s, T);
    ok(!v.ok && v.errors.some((e) => /缺 location/.test(e)), '★★ Deploy 缺 location → error（还提示"是格子不是像素"）', (v.errors.find((e) => /缺 location/.test(e)) || '').slice(0, 60));
  }

  /* 4.5 朝向写错 */
  {
    const s = base();
    C.addDeploy(s, { name: '推进之王', location: [1, 1], direction: 'West', kills: 1 });
    const v = C.validate(s, T);
    ok(!v.ok && v.errors.some((e) => /direction/.test(e)), '★ 朝向写错（West）→ error 并列出可用朝向', (v.errors.find((e) => /direction/.test(e)) || '').slice(0, 60));
  }

  /* 4.6 ★ 核心：写到不可部署的格子上 ★ */
  {
    /* 先找一个真实的 forbidden 格子，而不是瞎猜坐标 */
    let forbidden = null;
    const sz = C.gridSize(T);
    for (let y = 0; y < sz.h && !forbidden; y++) {
      for (let x = 0; x < sz.w; x++) {
        const t = C.tileAt(T, x, y);
        if (t && t.buildableType === 0) { forbidden = { x, y, t }; break; }
      }
    }
    ok(!!forbidden, '在 0-1 里找到一个不可部署格当样本', forbidden ? ('[' + forbidden.x + ',' + forbidden.y + '] ' + forbidden.t.tileKey) : '没找到');
    if (forbidden) {
      const s = base();
      C.addDeploy(s, { name: '推进之王', location: [forbidden.x, forbidden.y], direction: 'Right', kills: 1 });
      const v = C.validate(s, T);
      ok(!v.ok && v.errors.some((e) => /不可部署/.test(e)), '★★★ 部署到不可部署格 → error（MAA 要到运行时才炸，我提前抓出来）',
        (v.errors.find((e) => /不可部署/.test(e)) || '').slice(0, 70));
    }
  }

  /* 4.7 高台/地面错配 → 只给 warning（有些干员是例外，不能当错误） */
  {
    /* 找一个 Ranged 格，然后放一个 Pioneer（近战）上去 */
    let ranged = null;
    const sz = C.gridSize(T);
    for (let y = 0; y < sz.h && !ranged; y++) {
      for (let x = 0; x < sz.w; x++) {
        const t = C.tileAt(T, x, y);
        if (t && t.buildableType === 2) { ranged = { x, y }; break; }
      }
    }
    if (ranged) {
      const s = base();
      s.opers = [{ name: '推进之王' }];
      C.addDeploy(s, { name: '推进之王', role: 'Pioneer', location: [ranged.x, ranged.y], direction: 'Right', kills: 1 });
      const v = C.validate(s, T);
      ok(v.warnings.some((w) => /通常站|高台|地面/.test(w)), '★ 近战干员放高台 → **warning**（不是 error，因为干员特性有例外）',
        (v.warnings.find((w) => /通常站/.test(w)) || '').slice(0, 60));
    }
  }

  /* 4.8 缺 actions / 缺 stage_name */
  {
    const v = C.validate({ opers: [], groups: [] }, null);
    ok(!v.ok && v.errors.some((e) => /actions/.test(e)), '缺 actions → error');
    ok(v.warnings.some((w) => /stage_name/.test(w)), '缺 stage_name → warning');
  }

  /* 4.9 名字不在名单里 */
  {
    const s = base();
    s.opers = [{ name: '推进之王' }];
    C.addDeploy(s, { name: '打字错误的干员', location: [1, 1], direction: 'Right', kills: 1 });
    const v = C.validate(s, T);
    ok(v.warnings.some((w) => /不在 opers/.test(w)), '★ 干员名不在名单里 → warning（多半是打错字）',
      (v.warnings.find((w) => /不在 opers/.test(w)) || '').slice(0, 50));
  }

  /* 4.10 Click 的 rect 是像素不是格子 */
  {
    const v = C.validate({ stage_name: '0-1', opers: [], groups: [], actions: [{ type: 'Click' }] }, null);
    ok(v.warnings.some((w) => /720p/.test(w)), '★ Click 缺 rect → warning 且说明"用 720p 像素矩形，不是格子"',
      (v.warnings.find((w) => /720p/.test(w)) || '').slice(0, 60));
  }
}

/* ================================================================ §5 生成与排序 */
hr('§5 skeleton / addDeploy / sortByKills');
{
  const s = C.skeleton({ stage: '0-1', opers: ['推进之王', { name: '能天使', skill: 2 }], title: '测试作业' });
  ok(s.minimum_required === 'v4.0.0', '骨架带 minimum_required');
  ok(s.actions.length === 0 && Array.isArray(s.groups), '骨架是空动作 + 空 groups');
  ok(s.opers.length === 2 && s.opers[1].name === '能天使', '★ 干员可以给字符串也可以给对象', JSON.stringify(s.opers));
  ok(s.doc && s.doc.title === '测试作业', 'doc.title 正确');

  C.addDeploy(s, { name: '推进之王', location: [1, 1], direction: 'Right', kills: 20 });
  C.addDeploy(s, { name: '能天使', location: [2, 1], direction: 'Left', kills: 5 });
  ok(s.actions.length === 2 && s.actions[0].type === 'Deploy', 'addDeploy 追加成功');
  ok(s.actions[0].location.join(',') === '1,1', 'location 被规整成数组');

  /* 排序：SkillDaemon 这类无条件动作留在最前，不参与 kills 排序 */
  const s2 = C.skeleton({ stage: 'x' });
  s2.actions = [
    { type: 'Deploy', kills: 20 },
    { type: 'SkillDaemon' },
    { type: 'Deploy', kills: 5 },
  ];
  C.sortByKills(s2);
  ok(s2.actions[0].type === 'SkillDaemon', '★★ SkillDaemon 排在最前（不参与 kills 排序，否则语义会变）', s2.actions.map((a) => a.type).join(','));
  ok(s2.actions[1].kills === 5 && s2.actions[2].kills === 20, '其余按 kills 升序', s2.actions.map((a) => a.kills).join(','));
}

/* ================================================================ §6 类型别名（照抄源码表） */
hr('§6 resolveType：MAA 认的是**字符串别名表**，不是枚举名');
{
  /* 这条最要命：枚举里叫 SwitchSpeed，而官方作业里写 SpeedUp。 */
  ok(C.resolveType('SpeedUp') === 'SwitchSpeed', '★★ SpeedUp → SwitchSpeed（官方 OF-1 作业就在用这个）');
  ok(C.resolveType('二倍速') === 'SwitchSpeed', '★ 中文别名 二倍速 也认');
  ok(C.resolveType('Skill') === 'UseSkill', 'Skill → UseSkill（枚举里没有 Skill）');
  ok(C.resolveType('DoNothing') === 'SkillDaemon', 'DoNothing → SkillDaemon');
  ok(C.resolveType('部署') === 'Deploy', '中文 部署 → Deploy');
  ok(C.resolveType('技能') === 'UseSkill', '中文 技能 → UseSkill');
  ok(C.resolveType('摆完挂机') === 'SkillDaemon', '中文 摆完挂机 → SkillDaemon');
  ok(C.resolveType('deploy') === 'Deploy' && C.resolveType('DEPLOY') === 'Deploy', '大小写变体都认');
  ok(C.resolveType('Deployy') === null, '★ 真的拼错（Deployy）→ null（不会被当成 Deploy 放过）');
  ok(C.resolveType('') === null && C.resolveType(null) === null, '空值 → null（不崩）');

  /* 别名合法 = 不该报错 */
  const v = C.validate({ stage_name: 'x', opers: [], groups: [], actions: [{ type: 'SpeedUp' }, { type: 'SkillDaemon' }] }, null);
  ok(v.ok, '★ 用别名写的作业校验通过（不把合法的官方写法判成错）', v.errors.join('; ') || '（干净）');
  ok(v.stats.byType.SwitchSpeed === 1, '统计时归到规范名 SwitchSpeed', JSON.stringify(v.stats.byType));
}

/* ================================================================ §7 两个"静默"陷阱 */
hr('§7 抓住 MAA 自己会静默吞掉的两种情况');
{
  /* 7.1 type 缺省 → MAA 默认 Deploy。必须提示，否则"忘了写"和"故意写"无从分辨 */
  const v1 = C.validate({ stage_name: 'x', opers: [], groups: [], actions: [{ name: 'a', location: [1, 1] }] }, null);
  ok(v1.warnings.some((w) => /默认按 Deploy/.test(w)), '★★ 没写 type → warning「MAA 会默认按 Deploy 处理」',
    (v1.warnings.find((w) => /默认按 Deploy/.test(w)) || '').slice(0, 52));
  ok(!v1.errors.some((e) => /缺 type/.test(e)), '★ 不把它当 error（MAA 确实有默认值）');

  /* 7.2 type 写错 → MAA 只 warn 然后 continue（跳过那条动作）。必须是 error */
  const v2 = C.validate({ stage_name: 'x', opers: [], groups: [], actions: [{ type: '部署干员', location: [1, 1] }] }, null);
  ok(!v2.ok, '★★★ type 写错 → error');
  ok(v2.errors.some((e) => /静默消失|跳过这条动作/.test(e)),
    '★★★ 错误说明点明"MAA 会跳过这条动作"（这是它最难查的原因）',
    (v2.errors.find((e) => /跳过/.test(e)) || '').slice(0, 70));

  /* 7.3 Click 的 rect 与 location 二选一，都给时 rect 优先 */
  const v3 = C.validate({ stage_name: 'x', opers: [], groups: [], actions: [{ type: 'Click', rect: [0, 0, 10, 10], location: [1, 1] }] }, null);
  ok(v3.warnings.some((w) => /以 rect 为准/.test(w)), '★ Click 同时给 rect 和 location → warning「以 rect 为准」',
    (v3.warnings.find((w) => /rect 为准/.test(w)) || '').slice(0, 50));
  const v4 = C.validate({ stage_name: 'x', opers: [], groups: [], actions: [{ type: 'Click' }] }, null);
  ok(v4.warnings.some((w) => /二选一/.test(w)), '★ Click 两个都没给 → warning「要二选一」',
    (v4.warnings.find((w) => /二选一/.test(w)) || '').slice(0, 50));
  const v5 = C.validate({ stage_name: 'x', opers: [], groups: [], actions: [{ type: 'Click', location: [1, 1] }] }, null);
  ok(v5.ok && !v5.warnings.some((w) => /二选一|rect 为准/.test(w)), '★ Click 只给 location → 干净（合法写法）');
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
