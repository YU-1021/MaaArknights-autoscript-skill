#!/usr/bin/env node
/* 视频 → MAA 作业（最终版）。
 *
 * 与 build2.cjs 的区别：**带真实干员身份和技能**。
 *
 * 流程：
 *   ① MAA Arknights-Tile-Pos → 关卡格子（width/height/view/tiles）
 *   ② tileproj：格子坐标 ↔ 屏幕像素（移植 TileCalc2.hpp）
 *   ③ deploy.findBattleStart()：干员栏饱和度 + 连续 8 帧 → 进入战斗那一帧
 *   ④ deploy.scanBarChanges()：干员栏每 1.5s 色块比对 → 部署窗口
 *   ⑤ 窗口内每 0.2s 找**橙色斜纹格** → 放置格（实测 40.8% vs 背景 10%）
 *   ⑥ 邻格唯一非零 / 范围形状匹配 → 朝向（实测 6/6）
 *   ⑦ **详情面板读干员名**（NCC 闭集匹配，实测 3/3）+ 技能名 → skill 序号
 *   ⑧ 技能触发类型取自 skills.json 的 skillType（AUTO/MANUAL），**不从视频猜**
 *   ⑨ 站位类型 = 放置格 buildableType（1→MELEE, 2→RANGED），并用它**交叉验证干员名**
 *   ⑩ MANUAL 技能：按亮黄菱形检出就绪时刻 → UseSkill(location)；AUTO 技能：跳过
 *   ⑪ copilot.validate() 校验后写出
 *
 * 明确不做（用户指定）：撤退、召唤物/装置、关卡自动识别。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib');
const P = require(path.join(LIB, 'tileproj.cjs'));
const C = require(path.join(LIB, 'copilot.cjs'));
const O = require(path.join(LIB, 'operdb.cjs'));
const D = require(path.join(LIB, 'deploy.cjs'));
const M = require(path.join(LIB, 'posmask.cjs'));
const RF = require(path.join(LIB, 'rangefit.cjs'));
const ON = require(path.join(LIB, 'opername.cjs'));
const DT = require(path.join(LIB, 'detail.cjs'));
const DIR = require(path.join(LIB, 'direction.cjs'));

function arg(n, d) {
  const h = process.argv.slice(2).find((a) => a === '--' + n || a.startsWith('--' + n + '='));
  if (!h) return d;
  const i = h.indexOf('=');
  return i < 0 ? true : h.slice(i + 1);
}
const VIDEO = String(arg('video', ''));
const STAGE = String(arg('stage', ''));
const MAA = String(arg('maa', 'F:\\dspet\\MAA-v6.19.0-win-x64。2'));
const OUT = String(arg('out', ''));
const STEP_SEC = Number(arg('stripe-step', 0.2));
const PANEL_SPAN = Number(arg('panel-span', 1.2));   /* 往放置时刻前找面板的秒数（不能太宽，会读到上一个干员的面板） */
const PANEL_STEP = Number(arg('panel-step', 0.3));
if (!VIDEO || !STAGE) { console.error('用法: node bin/build3.cjs --video=<视频> --stage=<关卡> --maa=<MAA目录> --out=<json>'); process.exit(2); }

const log = (...a) => console.log(...a);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp3-'));
const FF = D.ffmpeg();

function grabFrame(sec) {
  const f = path.join(tmp, 'f.rgb');
  try {
    execFileSync(FF, ['-y', '-v', 'error', '-ss', String(sec), '-i', VIDEO, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', f], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    const b = fs.readFileSync(f);
    try { fs.unlinkSync(f); } catch {}
    return b;
  } catch { return null; }
}

function main() {
  /* ① 关卡格子 */
  const tp = path.join(MAA, 'resource', 'Arknights-Tile-Pos');
  const t = C.findTile(tp, STAGE, { cacheFile: path.join(tmp, 'idx.json') });
  if (!t.ok) throw new Error('关卡数据: ' + t.reason);
  const lv = t.data;
  log('① 关卡 ' + (lv.code || STAGE) + ' ' + lv.width + 'x' + lv.height);

  /* ② 干员库 + 技能库 */
  const oi = O.load(MAA);
  if (!oi.ok) throw new Error('干员库: ' + oi.reason);
  const skillsFile = path.join(LIB, 'skills.json');
  if (!fs.existsSync(skillsFile)) throw new Error('缺 lib/skills.json');
  const SKILLS = JSON.parse(fs.readFileSync(skillsFile, 'utf8'));
  const RANGES = (function () {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(MAA, 'resource', 'battle_data.json'), 'utf8'));
      const all = j.ranges || {};
      const used = new Set();
      for (const c of Object.values(j.chars || {})) for (const r of (c.rangeId || [])) if (all[r]) used.add(r);
      const out = {};
      for (const k of used) if (/^-?\d+-\d+$/.test(k)) out[k] = all[k];
      return Object.keys(out).length ? out : all;
    } catch { return {}; }
  })();
  log('② 干员 ' + oi.count + '，技能表 ' + Object.keys(SKILLS).length + '，范围 ' + Object.keys(RANGES).length);

  /* ③ 视频信息 + 战斗起点 */
  const info = D.probe(VIDEO);
  if (!info) throw new Error('读不到视频信息');
  const vw = info.width, vh = info.height;
  const bs = D.findBattleStart(VIDEO, info);
  const battleStart = bs.ok ? bs.startSec : 0;
  log('③ 视频 ' + vw + 'x' + vh + ' ' + Math.round(info.durationMs / 1000) + 's  战斗起点 ' + battleStart + 's');

  /* ④ 部署窗口 */
  const sc = D.scanBarChanges(VIDEO, info, battleStart);
  log('④ 干员栏变动 ' + sc.changes.length + ' 次: ' + sc.changes.map((c) => c.fromSec.toFixed(1)).join(' '));
  if (!sc.changes.length) throw new Error('没检出部署窗口');

  /* ⑤⑥ 收集**所有**橙色斜纹检出（不是每个窗口只取第一个）。
   * 踩过的坑：每个窗口 `break` → 一个窗口里有两处部署时只会记一个，覆盖率上不去。 */
  const rawHits = [];
  for (const w of sc.changes) {
    const start = Math.max(battleStart, w.fromSec - 1.5);
    for (let s = start; s <= w.toSec + STEP_SEC / 2; s += STEP_SEC) {
      const rgb = grabFrame(s);
      if (!rgb || rgb.length < vw * vh * 3) continue;
      const r = M.findOrangeTile({ rgb, width: vw, height: vh }, lv, { tileR: 22, minRatio: 0.15 });
      if (!r.ok) continue;
      /* ★ 橙色斜纹 = **攻击范围预览**，不是放置格标记（实测 21.2s 一大片跨约 8 格）。
       * 所以不能用"橙色占比最高的格"当放置格 —— 那只在近战 1-1（2格）时碰巧成立。
       * 改成：拿观测橙色分布反解「哪个锚点 + 哪个范围形状 + 哪个朝向」最吻合，
       * 锚点即放置格，朝向和 rangeId 同时得出。 */
      const ratios = new Map();
      for (const cell of r.all) ratios.set(cell.tx + ',' + cell.ty, cell.ratio);

      /* 【混合策略】两种情形分开处理：
       *   ① 只有 1 个邻格带橙色 → 近战小范围（1-1，2格）。
       *      这时"最高占比格 = 放置格、唯一非零邻格 = 朝向"有强证据支持
       *      （实测 @17.0s：Right 15.7% vs Left/Up/Down 全 0.0%）。
       *      而且 2 格对称范围下锚点反解**本身不唯一**，硬解会把朝向解错（实测把 Right 解成 Down）。
       *   ② 多个邻格带橙色 → 远程大范围，邻格法必然失效，才用锚点反解。
       */
      const top0 = r.top;
      const nb0 = [[1, 0, 'Right'], [-1, 0, 'Left'], [0, -1, 'Up'], [0, 1, 'Down']]
        .map(([dx, dy, d]) => {
          const cell = r.all.find((x) => x.tx === top0.tx + dx && x.ty === top0.ty + dy);
          return { d, v: cell ? cell.ratio : 0, exists: !!cell };
        }).filter((x) => x.exists).sort((a, b) => b.v - a.v);
      const nz0 = nb0.filter((x) => x.v >= 0.06);
      let hit = null;
      if (nz0.length === 1 && top0.ratio <= 0.80) {
        const cellA = (lv.tiles[top0.ty] || [])[top0.tx] || {};
        hit = {
          at: +s.toFixed(2), winStart: +start.toFixed(2),
          tx: top0.tx, ty: top0.ty, bt: cellA.buildableType, key: cellA.tileKey,
          stripe: +(top0.ratio * 100).toFixed(1),
          dir: nz0[0].d, dirCertain: true,
          whyDir: '近战邻格唯一非零', rangeId: '1-1',
          positionType: cellA.buildableType === 1 ? 'MELEE' : cellA.buildableType === 2 ? 'RANGED' : 'UNKNOWN',
        };
      } else {
        const fitA = RF.fitAnchor(ratios, RANGES, { minRatio: 0.22, minScore: 0.20 });
        if (!fitA.ok) continue;
        const cellA = (lv.tiles[fitA.ty] || [])[fitA.tx] || {};
        hit = {
          at: +s.toFixed(2), winStart: +start.toFixed(2),
          tx: fitA.tx, ty: fitA.ty, bt: cellA.buildableType, key: cellA.tileKey,
          stripe: +(fitA.inside * 100).toFixed(1),
          dir: fitA.dir,
          dirCertain: fitA.score >= 0.35,
          whyDir: '范围反解 ' + fitA.rid + ' 得分' + fitA.score + ' 覆盖' + fitA.size + '格',
          rangeId: fitA.rid,
          positionType: cellA.buildableType === 1 ? 'MELEE' : cellA.buildableType === 2 ? 'RANGED' : 'UNKNOWN',
        };
      }
      rawHits.push(hit);
    }
  }
  /* 去重：同格 1.6s 内、或不同格但 0.35s 内（同一瞬间的重复检出），只留斜纹占比最高的一条 */
  rawHits.sort((a, b) => b.stripe - a.stripe);
  const uniq = [];
  for (const e of rawHits) {
    if (uniq.some((x) => Math.abs(x.at - e.at) < 0.35)) continue;
    if (uniq.some((x) => x.tx === e.tx && x.ty === e.ty && Math.abs(x.at - e.at) < 1.6)) continue;
    uniq.push(e);
  }
  /* 真部署的斜纹占比都在 40% 以上；<30% 的多半是结算/取消之类的 UI。
   * 实测：真部署 40.8/55.6/56.7/57.2%；误检 18.3%。这条能干净分开。 */
  const dropped = uniq.filter((e) => e.stripe < 30).map((e) => e.at + 's(' + e.stripe + '%)');
  let events = uniq.filter((e) => e.stripe >= 30).sort((a, b) => a.at - b.at);
  /* 【同格去重】**一个格子不可能站两个干员**。
   * 收集全部检出后，同一格会因拖拽过程中反复高亮而重复出现（实测 [5,4] 和 [7,3] 各出现两次）。
   * 同格只留斜纹占比最高的一条 —— 占比高的那次是"落点已确定"的稳定状态。 */
  const byTile = new Map();
  for (const e of events) {
    const k = e.tx + ',' + e.ty;
    const prev = byTile.get(k);
    if (!prev || e.stripe > prev.stripe) byTile.set(k, e);
  }
  const dupTile = events.length - byTile.size;
  events = [...byTile.values()].sort((a, b) => a.at - b.at);
  log('⑤ 放置事件 ' + events.length + ' 个'
    + (dupTile ? '（同格去重 ' + dupTile + ' 条）' : '')
    + (dropped.length ? '（丢弃低占比 ' + dropped.join(',') + '）' : ''));
  if (!events.length) throw new Error('没检出橙色斜纹格');

  /* ⑦ 详情面板读名字 + 技能名 */
  /* 名字候选集 = skills.json 里的干员（439 个有技能的，正好都是可部署干员）。
   * 不依赖 character_table.json —— 那份原始数据太大，已经在生成 skills.json 时用完了。 */
  const allNames = Object.keys(SKILLS);
  const nameTmpl = ON.renderTemplates(allNames, { cacheFile: path.join(LIB, 'nametpl') });
  log('⑦ 名字模板 ' + nameTmpl.names.length);

  /* ⑦-b 先扫出「面板出现区间（episode）」，再分配给部署事件。
   *
   * 【为什么要两段式】
   *   直接在每个事件前 1.2 秒找面板 → 只命中 3/6（面板可能更早出现）；
   *   放宽到 4 秒 → 命中 5/6 但会读到**上一个干员**的面板，导致 position 交叉验证失败
   *   （实测把 RANGED 的娜仁图亚匹配到了 bt=1 的地面格，MISMATCH）。
   *   所以：整个部署阶段扫一遍 → 把连续同名的帧合成一个 episode →
   *   每个 episode 只能分配给**它之后最近的那个**部署事件，一个面板只用一次。
   */
  const wins = sc.changes.filter((w) => w.fromSec < 100);   /* 100s 后是结算画面，排除 */
  const scanFrom = Math.max(battleStart, (wins[0] || sc.changes[0]).fromSec - 0.5);
  const scanTo = Math.min(info.durationMs / 1000, (wins[wins.length - 1] || sc.changes[sc.changes.length - 1]).toSec + 2.0);
  const rawFrames = [];
  for (let s = scanFrom; s <= scanTo; s += 0.2) {
    const rgb = grabFrame(s);
    if (!rgb) continue;
    const g = ON.readGlyph(rgb, vw, vh);
    if (!g.ok) continue;
    const r = ON.identify(g, nameTmpl, { minScore: 0.42, minMargin: 0.10 });
    if (!r.ok) continue;
    rawFrames.push({ t: +s.toFixed(2), name: r.name, score: r.score, margin: r.margin });
  }
  /* 合并成 episode：同名且间隔 ≤0.45s 的连续帧算一段 */
  const eps = [];
  for (const x of rawFrames) {
    const last = eps[eps.length - 1];
    if (last && last.name === x.name && x.t - last.end <= 0.45) {
      last.end = x.t; last.n++; last.frames.push(x.t);
      if (x.score > last.score) { last.score = x.score; last.at = x.t; }
    } else {
      eps.push({ name: x.name, start: x.t, end: x.t, at: x.t, score: x.score, n: 1, used: false, frames: [x.t] });
    }
  }
  log('   面板 episode ' + eps.length + ' 个: ' + eps.map((e) => e.name + '@' + e.at + 's(' + e.n + '帧)').join('  '));

  /* 分配：每个 episode 给"它之后最近"的部署事件；一个 episode 只用一次 */
  for (const e of events) {
    const cands = eps.filter((p) => !p.used && p.end <= e.at + 0.35 && p.end >= e.at - 4.5)
      .sort((a, b) => Math.abs(e.at - b.end) - Math.abs(e.at - a.end));
    /* 优先选 position 与格子类型相符的 */
    let chosen = null;
    for (const c of cands) {
      const si = SKILLS[c.name];
      const pos = si ? si.position : 'UNKNOWN';
      if (e.positionType === 'UNKNOWN' || pos === e.positionType) { chosen = c; break; }
    }
    if (!chosen && cands.length) chosen = cands[0];   /* 都不符也先用，后面交叉验证会剔除 */
    if (!chosen) continue;
    chosen.used = true;
    e.name = chosen.name;
    e.nameScore = +chosen.score.toFixed(3);
    e.panelAt = chosen.at;
    const si = SKILLS[e.name];
    if (si) {
      e.profession = si.profession;
      e.dataPosition = si.position;
      if (si.skills && si.skills.length) {
        /* 技能名在 episode 内**多帧尝试**取最好的一次。
         * 只读最高分那一帧会失败（山在 17.3s 读不到，16.9s 能读到 0.538）——
         * 因为拖拽过程中面板会移动到不同状态。 */
        let bestSr = null;
        for (const tt of chosen.frames) {
          const rgb2 = grabFrame(tt);
          if (!rgb2) continue;
          const sr = DT.readSkillName(rgb2, vw, vh, si.skills.map((x) => x.name), { minScore: 0.32, minMargin: 0.06 });
          if (sr.ok && (!bestSr || sr.score > bestSr.score)) bestSr = sr;
        }
        if (bestSr) {
          const slot = si.skills.findIndex((x) => x.name === bestSr.name) + 1;
          e.skill = slot || 0;
          e.skillName = bestSr.name;
          e.skillScore = bestSr.score;
          const def = si.skills[slot - 1];
          e.skillAuto = !!def.auto;
          e.skillType = def.skillType;
          e.spTypeCn = def.spTypeCn;
        } else { e.skillNote = '技能名未识别'; }
      }
    }
  }
  const panelHits = events.filter((e) => e.name).length;
  log('   面板命中 ' + panelHits + '/' + events.length);

  /* ⑨ 交叉验证：干员 position vs 格子的 buildableType */
  for (const e of events) {
    if (!e.name) { e.verify = 'no-name'; continue; }
    const si = SKILLS[e.name];
    if (!si) { e.verify = 'name-not-in-skills'; continue; }
    const want = e.positionType;
    const got = si.position;
    e.verify = (want === 'UNKNOWN' || got === want) ? 'ok' : 'MISMATCH';
  }
  log('   交叉验证: ' + events.map((e) => (e.name || '?') + ':' + e.verify).join(' '));

  /* 剔除验证失败的（名字不可能是远程却站在地面格） */
  const good = events.filter((e) => e.verify === 'ok' || e.verify === 'no-name' || e.verify === 'name-not-in-skills');
  const droppedVerify = events.length - good.length;
  log('   因 position 不符剔除 ' + droppedVerify + ' 条');
  events.length = 0; events.push(...good);

  /* ★【用户规则】标记必须能对应到真实干员，否则删除 ★
   * 由来：橙色斜纹是**攻击范围预览**，不是放置格标记。
   * 范围大时"最高占比格"只是范围里的任意一格，会产出**不对应任何干员**的假标记
   * （实测 [5,4]、[6,3] 就是这种，用户当场指出"已经没有干员，为什么标记两个滚木"）。
   * 所以：面板没读到名字的部署 = 无法对应到干员 → 直接丢弃，不留占位。
   * 需要保留时加 --keep-unknown。 */
  const keepUnknown = !!arg('keep-unknown', false);
  if (!keepUnknown) {
    const bad = events.filter((e) => !e.name);
    if (bad.length) {
      log('   无对应干员，删除 ' + bad.length + ' 条: '
        + bad.map((e) => e.at + 's[' + e.tx + ',' + e.ty + ']').join(' '));
    }
    events.length = 0;
    events.push(...good.filter((e) => !!e.name));
  }
  if (!events.length) throw new Error('没有任何一个标记能对应到真实干员（可加 --keep-unknown 保留全部并手填）');

  /* ⑧⑩ 组作业 */
  const script = C.skeleton({
    stage: lv.code || STAGE,
    title: (lv.code || STAGE) + ' 视频解析（含干员身份与技能）',
    details: '视频: ' + path.basename(VIDEO)
      + '\n战斗起点: ' + battleStart + 's'
      + '\n放置格: 橙色斜纹格；朝向: 邻格/范围形状；身份: 详情面板名字 NCC；技能: 面板技能名 + 游戏 skillType'
      + '\ndsh-arknights-copilot 自动生成',
  });
  const speedArg = Number(arg('speed', 2));
  if (speedArg === 2) script.actions.push({ type: 'SpeedUp', doc: '攻略视频惯例：开局切二倍速' });

  events.sort((a, b) => a.at - b.at);
  const used = new Set();
  const manualTracked = [];
  const pending = [];
  let placeholderNo = 1;
  events.forEach((e, i) => {
    let name = e.name;
    if (!name) {
      /* 【不再编假名字】以前这里从干员库按位置类型挑一个真名字填进去，
       * 看起来像"识别成功"，实际是编的（用户当场指出来了）。
       * 改成明确的占位：待填_01 / 待填_02 …
       * 代价：这样的作业 MAA 编队阶段会因"干员缺失"停下 ——
       * 但这比假装认出来好，至少不会让人误以为已经完成。 */
      name = '待填_' + String(placeholderNo).padStart(2, '0');
      placeholderNo++;
      e.name = name;              /* 让下面结果表也显示 待填_xx，而不是 ? */
      e.placeholder = true;
      pending.push({ no: name, at: e.at, tx: e.tx, ty: e.ty, kind: e.positionType });
    }
    used.add(name);
    script.opers.push({
      name,
      ...(e.skill ? { skill: e.skill } : {}),
      ...(e.skill == null ? { skill_usage: 0 } : (e.skillAuto ? { skill_usage: 0 } : { skill_usage: 1 })),
    });
    const act = C.addDeploy(script, {
      name,
      location: [e.tx, e.ty],
      direction: e.dir || 'Right',
      doc: '视频 ' + e.at + 's（战斗起点 +' + (e.at - battleStart).toFixed(1) + 's）'
        + (e.placeholder ? ' ★待填干员名' : '')
        + (e.dirCertain ? '' : ' 朝向不确定')
        + (e.skillName ? ' 技能' + e.skill + '「' + e.skillName + '」' + (e.skillAuto ? '自动' : '手动') : ''),
    });
    if (i > 0) {
      const gap = Math.round((e.at - events[i - 1].at) * 1000);
      if (gap > 0 && gap < 40000) act.pre_delay = gap;
    }
    /* MANUAL 技能 → 后续要追踪开技能时刻；AUTO → 用户要求"之后不用管" */
    if (e.skill && !e.skillAuto) manualTracked.push({ name, e });
  });

  /* ⑩ MANUAL 技能：按亮黄菱形找就绪时刻，发 UseSkill(location) */
  const skillNotes = [];
  let useSkillCount = 0;
  for (const { name, e } of manualTracked) {
    const c = P.tileToScreen(lv, e.tx, e.ty, false);
    if (!c) continue;
    const from = e.at;
    const dur = Math.max(8, (info.durationMs / 1000) - from - 2);
    const sr = DIR.scanGold(VIDEO, { x: c.x, y: c.y }, vw, vh, from, dur, { fps: 4, goldMin: 0.012, stable: 2 });
    if (!sr.ok) { skillNotes.push(name + ' 扫描失败: ' + sr.reason); continue; }
    if (!sr.readyAt.length) { skillNotes.push(name + ' 未检出金色就绪（峰值 ' + (sr.peak * 100).toFixed(1) + '%）'); continue; }
    /* 【可信度门槛】就绪次数多得离谱时说明金色检测被噪声带偏了。
     * 实测：山 3 次（正常）、娜仁图亚 13 次（明显过多 → 不发 UseSkill，宁缺毋滥）。 */
    if (sr.readyAt.length > 6) {
      skillNotes.push(name + ' 金色就绪检出 ' + sr.readyAt.length + ' 次，噪声过大 → 不发 UseSkill（峰值金 ' + (sr.peak * 100).toFixed(1) + '%）');
      continue;
    }
    /* 只取第一次就绪（之后 MAA 自己会按 skill_usage 处理） */
    const at = sr.readyAt[0];
    script.actions.push({
      type: 'UseSkill',
      location: [e.tx, e.ty],
      doc: name + ' 技能' + e.skill + '「' + e.skillName + '」就绪 @视频' + at + 's（峰值金 ' + (sr.peak * 100).toFixed(1) + '%）',
    });
    useSkillCount++;
    skillNotes.push(name + ' MANUAL 技能就绪 ' + sr.readyAt.length + ' 次，取首个 @' + at + 's');
  }
  const autoCount = events.filter((e) => e.skill && e.skillAuto).length;
  if (autoCount) skillNotes.push('AUTO 技能 ' + autoCount + ' 个 → 按需求不追踪');
  /* 有 MANUAL 之外的干员时用 SkillDaemon 兜底剩余 */
  if (!useSkillCount) script.actions.push({ type: 'SkillDaemon' });

  /* 去重 opers（同名只留一条，skill 取第一次出现的） */
  const seen = new Map();
  script.opers = script.opers.filter((x) => {
    if (seen.has(x.name)) {
      const prev = seen.get(x.name);
      if (!prev.skill && x.skill) Object.assign(prev, x);
      return false;
    }
    seen.set(x.name, x); return true;
  });

  /* ⑪ 校验 + 写出 */
  const v = C.validate(script, lv);
  log('');
  log('=== 结果 ===');
  for (const e of events) {
    log('  @' + String(e.at).padEnd(6) + ' [' + e.tx + ',' + e.ty + '] ' + String(e.name || '?').padEnd(7)
      + ' 技能' + (e.skill || '-') + (e.skillName ? '「' + e.skillName + '」' : '')
      + (e.skill ? (e.skillAuto ? '[自动]' : '[手动]') : '')
      + ' 朝向' + (e.dir || '?') + (e.dirCertain ? '✔' : '⚠')
      + '  ' + e.verify
      + (e.placeholder ? '  ★待填' : '')
      + (e.name ? '  NCC=' + e.nameScore : ''));
  }
  log('');
  log('⑪ 校验 ok=' + v.ok + ' errors=' + v.errors.length + ' warnings=' + v.warnings.length);
  v.errors.forEach((x) => log('   E ' + x));
  v.warnings.slice(0, 6).forEach((x) => log('   W ' + x));
  if (v.warnings.length > 6) log('   … 还有 ' + (v.warnings.length - 6) + ' 条');
  if (skillNotes.length) { log(''); log('🎯 技能追踪:'); skillNotes.forEach((n) => log('   · ' + n)); }

  const outFile = OUT || path.join(process.cwd(), 'out', (lv.code || STAGE) + '.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(script, null, 2), 'utf8');
  log('');
  log('✅ ' + outFile);
  log('   动作 ' + script.actions.length + ' 条 / 干员 ' + script.opers.length + ' 人');
  const named = events.filter((e) => e.name).length;
  const withSkill = events.filter((e) => e.skill).length;
  log('   身份识别 ' + named + '/' + events.length + '，技能识别 ' + withSkill + '/' + events.length
    + '，UseSkill ' + useSkillCount + ' 条');

  /* 明确列出需要人工补的占位，别让人去找 */
  if (pending.length) {
    log('');
    log('★ 需要你填的干员名（' + pending.length + ' 个）—— 视频里这些部署没开详情面板，读不到名字');
    for (const p of pending) {
      log('   ' + p.no + '  视频 ' + p.at + 's  放在 [' + p.tx + ',' + p.ty + ']（'
        + (p.kind === 'RANGED' ? '高台 → 必须是远程干员' : p.kind === 'MELEE' ? '地面 → 必须是近战干员' : '通用') + '）');
    }
    log('   改法：直接编辑输出 JSON 里的 opers[].name 和 actions[].name，然后跑 validate.bat 复查');
    log('   注意：不改完这些名字，MAA 编队阶段会因「干员缺失」停下');
  }
  return v.ok ? 0 : 1;
}

try { const rc = main(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(rc); }
catch (e) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} console.error('❌ ' + ((e && e.message) || e)); process.exit(1); }
