/* 朝向 = 攻击范围形状匹配（用 MAA 的真实范围数据，不猜颜色）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么这是正解】
 *   battle_data.json 里的 `ranges` 有 **73 种攻击范围形状**，每种是一组格子偏移：
 *     "1-1": [[0,0],[1,0]]        ← 近战 2 格，默认朝右
 *     "3-1": [...10 格...]         ← 远程，默认朝右
 *   每个干员还有 rangeId（按精0/精1/精2 三档）：
 *     陈 = ["1-1","1-1","1-1"]，阿米娅 = ["3-6","3-1","3-1"]
 *
 *   所以朝向问题是**4 选 1 的形状匹配**：
 *     把干员的攻击范围旋转 0°/90°/180°/270° → 4 个候选格集合
 *     → 和画面上"被范围覆盖的格"比对 → 命中的旋转角度就是朝向
 *
 * 【为什么不用橙色箭头】
 *   试了三版都不稳（跨帧差集被地图偏移淹没；橙块和血条/其他箭头粘连，
 *   质心近乎对称）。而范围形状是**离散的格集合**，不存在"像素混色"问题。
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./tileproj.cjs');

const DIRS = ['Right', 'Up', 'Left', 'Down'];

let cache = { file: '', ranges: null };

function loadRanges(maaResource) {
  const f = path.join(maaResource, 'resource', 'battle_data.json');
  if (!fs.existsSync(f)) {
    const alt = path.join(maaResource, 'battle_data.json');
    if (!fs.existsSync(alt)) return { ok: false, reason: '找不到 battle_data.json' };
    return loadFrom(alt);
  }
  return loadFrom(f);
}
function loadFrom(f) {
  if (cache.ranges && cache.file === f) return { ok: true, count: Object.keys(cache.ranges).length, cached: true };
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    cache = { file: f, ranges: j.ranges || {} };
    return { ok: true, count: Object.keys(cache.ranges).length };
  } catch (e) { return { ok: false, reason: '解析失败：' + ((e && e.message) || e) }; }
}

/* 把范围偏移旋转到某个朝向。原始数据默认朝 Right（+x）。 */
function rotate(offsets, dir) {
  const k = DIRS.indexOf(dir);
  if (k < 0) return null;
  const out = [];
  for (const [x, y] of offsets) {
    let nx = x, ny = y;
    for (let i = 0; i < k; i++) { const t = nx; nx = -ny; ny = t; }  /* 逆时针 90° */
    out.push([nx, ny]);
  }
  return out;
}

/* 给出 4 个候选：朝向 → 相对干员格的格偏移集合 */
function candidates(rangeOffsets) {
  const out = {};
  for (const d of DIRS) {
    const r = rotate(rangeOffsets, d);
    if (r) out[d] = r;
  }
  return out;
}

/* 用"逐格亮度相对中位数"检出被范围覆盖的格。
 * 范围覆盖会把格子**提亮**，所以判据是"明显比全图中位数亮"。 */
function detectCovered(frame, level, opts) {
  const o = Object.assign({ sampleR: 15, minGain: 14 }, opts || {});
  const vw = frame.width, vh = frame.height;
  const sx = vw / P.BASE_W, sy = vh / P.BASE_H;
  const R = Math.max(3, Math.round(o.sampleR * Math.max(sx, sy)));
  const rgb = frame.rgb, W = vw, H = vh;
  const lum = [];
  for (let ty = 0; ty < level.height; ty++) {
    for (let tx = 0; tx < level.width; tx++) {
      const s = P.tileToScreen(level, tx, ty, false);
      if (!s) continue;
      const X = Math.round(s.x * sx), Y = Math.round(s.y * sy);
      let sum = 0, n = 0;
      for (let y = Y - R; y <= Y + R; y += 2) {
        for (let x = X - R; x <= X + R; x += 2) {
          if (x < 0 || y < 0 || x >= W || y >= H) { n++; continue; }
          const i = (y * W + x) * 3;
          sum += rgb[i] * 0.299 + rgb[i + 1] * 0.587 + rgb[i + 2] * 0.114;
          n++;
        }
      }
      lum.push({ tx, ty, v: n ? sum / n : 0 });
    }
  }
  const sorted = lum.map((t) => t.v).slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const set = new Set();
  for (const t of lum) { if (t.v >= med + o.minGain) set.add(t.tx + ',' + t.ty); }
  return { set, med, tiles: lum };
}

/* 在 4 个候选里挑最匹配观测格集合的那个朝向。
 * 打分 = |观测 ∩ 候选| − |观测 \ 候选| × 0.5 − |候选 \ 观测| × 0.5 */
function fitDirection(coveredSet, tile, rangeOffsets, opts) {
  const o = Object.assign({}, opts || {});
  const cands = candidates(rangeOffsets);
  const scores = [];
  for (const d of DIRS) {
    const off = cands[d];
    if (!off) continue;
    const want = new Set();
    want.add(tile.tx + ',' + tile.ty);                 /* 范围一定包含干员自己那格 */
    for (const [dx, dy] of off) want.add((tile.tx + dx) + ',' + (tile.ty + dy));
    let hit = 0, extraObs = 0, extraWant = 0;
    for (const k of want) if (coveredSet.has(k)) hit++;
    for (const k of coveredSet) if (!want.has(k)) extraObs++;
    for (const k of want) if (!coveredSet.has(k)) extraWant++;
    const score = hit - extraObs * 0.5 - extraWant * 0.5;
    scores.push({ dir: d, score: +score.toFixed(2), hit, extraObs, extraWant, size: want.size });
  }
  scores.sort((a, b) => b.score - a.score);
  return { best: scores[0] || null, scores };
}

/* ★ 从"橙色覆盖面积"反解锚点（= 放置格）+ 朝向 + rangeId ★
 *
 * 【为什么需要这个】
 *   橙色斜纹**不是放置格标记，是攻击范围预览**。实测：
 *     20.1s 没有橙色；21.2s 一大片跨约 8 格。
 *   早先假设"橙色占比最高的格 = 放置格"，只在近战 1-1（2格）时碰巧成立；
 *   远程范围十几格时，"最高占比"只是范围里的任意一格，不是干员位置。
 *
 * 【做法】
 *   每个候选锚点 × 每个合法 rangeId × 每个朝向 → 一个"预期覆盖集合"，
 *   和观测橙色分布比对：覆盖内平均占比越高、覆盖外高占比格越少 → 分越高。
 *   最优锚点就是放置格，同时得到朝向和 rangeId。
 *
 * ratios: Map 或普通对象，key='tx,ty'，value=橙色占比(0~1)
 */
function fitAnchor(ratios, ranges, opts) {
  const o = Object.assign({ minRatio: 0.22, penalty: 0.6, minScore: 0.18 }, opts || {});
  const get = (k) => (ratios instanceof Map ? (ratios.get(k) || 0) : (ratios[k] || 0));
  const keys = ratios instanceof Map ? [...ratios.keys()] : Object.keys(ratios);
  const obs = [];
  for (const k of keys) if (get(k) >= o.minRatio) obs.push({ k, v: get(k) });
  if (!obs.length) return { ok: false, reason: '没有橙色格' };
  const obsSet = new Set(obs.map((x) => x.k));
  const obsTotal = obs.reduce((a, b) => a + b.v, 0) || 1;

  let best = null;
  for (const ak of obs) {                       /* 锚点候选 = 有橙色的格 */
    const [ax, ay] = ak.k.split(',').map(Number);
    for (const rid of Object.keys(ranges)) {
      for (const dir of DIRS) {
        const rot = rotate(ranges[rid], dir);
        if (!rot) continue;
        const cov = new Set([ak.k]);
        for (const [dx, dy] of rot) cov.add((ax + dx) + ',' + (ay + dy));
        let sum = 0, n = 0;
        for (const k of cov) { sum += get(k); n++; }
        const inside = n ? sum / n : 0;
        let outside = 0;
        for (const k of obsSet) if (!cov.has(k)) outside += get(k);
        const score = inside - o.penalty * (outside / obsTotal);
        if (!best || score > best.score) {
          best = {
            tx: ax, ty: ay, dir, rid, score: +score.toFixed(3),
            inside: +inside.toFixed(3), outside: +outside.toFixed(3),
            size: cov.size, covKeys: [...cov],
          };
        }
      }
    }
  }
  if (!best || best.score < o.minScore) return { ok: false, reason: '没有吻合的范围形状', best };
  return { ok: true, ...best };
}

module.exports = { DIRS, loadRanges, rotate, candidates, detectCovered, fitDirection, fitAnchor };
