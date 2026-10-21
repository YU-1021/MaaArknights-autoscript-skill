/* 绿掩膜 → 干员站位类型（MELEE / RANGED）+ 合法落点集合。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【这是怎么想出来的】
 *   部署时游戏会把「这个干员所有能放的位置」染成绿色高亮。
 *   于是那一帧就同时给了两样东西：
 *     · 合法落点集合（哪些格能放）
 *     · 这些格的地块类型（地面 bt=1 / 高台 bt=2）
 *   近战干员的合法落点几乎全是地面格，远程几乎全是高台格
 *   ⇒ **从绿掩膜的 bt 分布，可以直接判出这个干员是 MELEE 还是 RANGED**。
 *
 *   这比"按职业猜"靠得住，也比等视频里看清干员头像便宜得多。
 *
 * 【方法上踩过的坑（重要）】
 *   第一版用**连通域**找绿块 → 失败：相邻格子被糊成一整块
 *   （13 万绿像素只切出 4 个连通域，跨了 9 个格子）。
 *   改成**逐格检查**：对每个已知格位，在格心周围采样绿色占比。
 *   顺序从"从颜色找格子"改成"用已知格子验颜色" —— 立刻稳了。
 *   这跟前面反复栽的那个坑是同一条教训：从像素反推格子不行，从格子验证像素可以。
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';
const P = require('./tileproj.cjs');

/* 默认绿色判据：偏饱和的青绿。不同皮肤不同，用 opts 覆盖。 */
const DEF = {
  green: { gMin: 110, grRatio: 1.35, gbRatio: 1.25 },
  /* 单格采样半径（1280 基准像素） */
  sampleR: 15,
  /* 格心周围绿色占比 ≥ 它才算"高亮" */
  tileThreshold: 0.45,
};

function isGreenPixel(r, g, b, o) {
  const G = (o && o.green) || DEF.green;
  return g > G.gMin && g > r * G.grRatio && g > b * G.gbRatio;
}

/* 逐格检查一帧里哪些格被绿色高亮。
 *
 * frame: { rgb: Buffer, width, height }  —— 视频原始尺寸
 * level: Tile-Pos 的关卡对象（width/height/tiles/view）
 * 返回 { ok, tiles:[{tx,ty,bt,ratio,key}], byType, positionType, hint }
 */
function highlightTiles(frame, level, opts) {
  const o = Object.assign({}, DEF, opts || {});
  const vw = frame.width, vh = frame.height;
  const sx = vw / P.BASE_W, sy = vh / P.BASE_H;
  const R = Math.max(3, Math.round(o.sampleR * Math.max(sx, sy)));
  const rgb = frame.rgb, W = vw, H = vh;
  const tiles = [];
  for (let ty = 0; ty < level.height; ty++) {
    for (let tx = 0; tx < level.width; tx++) {
      const s = P.tileToScreen(level, tx, ty, false);
      if (!s) continue;
      const X = Math.round(s.x * sx), Y = Math.round(s.y * sy);
      let g = 0, n = 0;
      for (let y = Y - R; y <= Y + R; y += 2) {
        for (let x = X - R; x <= X + R; x += 2) {
          n++;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const i = (y * W + x) * 3;
          if (isGreenPixel(rgb[i], rgb[i + 1], rgb[i + 2], o)) g++;
        }
      }
      const ratio = n ? g / n : 0;
      const d = level.tiles[ty][tx];
      tiles.push({ tx, ty, bt: d.buildableType, ratio, key: d.tileKey, hi: ratio >= o.tileThreshold });
    }
  }
  const hi = tiles.filter((t) => t.hi);
  const byType = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const t of hi) byType[t.bt] = (byType[t.bt] || 0) + 1;
  /* 判站位类型：地面 vs 高台，多数票。两边都不足 → unknown */
  const ground = byType[1] || 0, high = byType[2] || 0, any = byType[3] || 0;
  let positionType = 'UNKNOWN';
  if (hi.length >= 3) {
    if (high > ground * 2 && high >= 3) positionType = 'RANGED';
    else if (ground > high * 2 && ground >= 3) positionType = 'MELEE';
    else if (any >= Math.max(ground, high) && any >= 3) positionType = 'ANY';
  }
  return {
    ok: hi.length > 0,
    tiles: hi, byType, positionType,
    total: tiles.length,
    hint: hi.length < 3 ? '高亮格太少（' + hi.length + '），可能这帧不在部署预览状态' : '',
  };
}

/* 把高亮格排成可读的地图（数字=buildableType，点=未高亮） */
function renderMask(level, hi) {
  const set = new Map();
  for (const t of hi) set.set(t.tx + ',' + t.ty, t.bt);
  const lines = [];
  for (let ty = 0; ty < level.height; ty++) {
    let s = '  y=' + ty + '  ';
    for (let tx = 0; tx < level.width; tx++) {
      const v = set.get(tx + ',' + ty);
      s += (v === undefined ? '.' : String(v));
    }
    lines.push(s);
  }
  return lines.join('\n');
}

/* 橙色斜纹格检测 —— 部署时"落点/朝向标记"是整格的橙色斜纹。
 *
 * 为什么这个是朝向的最强信号（前面 4 版都失败）：
 *   · 橙色 V 箭头只有 ~40×40，颜色和血条(浅黄)、别的干员的箭头糊在一起 → 不稳
 *   · 橙色斜纹格**占满整个格子**（~150×90），面积大 20 倍，
 *     形态是"橙/深斜条交替"，和任何细长条、小三角都不会混
 *   实测 17.0s：斜纹格在干员左侧，与 17.3s 那个朝左的 V 箭头一致。
 *
 * 判据：整格内"橙色像素占比"最高、且超过阈值的那一格。
 * 斜纹是橙/深交替，所以占比大约 0.25~0.6；纯色小箭头在整格尺度上占比极低。
 */
const ORANGE = { rMin: 170, gMin: 80, gMax: 185, bMax: 95, rgMin: 45 };

function isOrange(r, g, b, o) {
  const O = o || ORANGE;
  return r >= O.rMin && g >= O.gMin && g <= O.gMax && b <= O.bMax && (r - g) >= O.rgMin;
}

/* 逐格算橙色占比，返回占比最高且达标的格。
 * opts.tileR：格内采样半径（1280 基准），默认 22（覆盖格子大部分面积） */
function findOrangeTile(frame, level, opts) {
  const o = Object.assign({ tileR: 22, minRatio: 0.12, orange: ORANGE }, opts || {});
  const vw = frame.width, vh = frame.height;
  const sx = vw / P.BASE_W, sy = vh / P.BASE_H;
  const R = Math.max(4, Math.round(o.tileR * Math.max(sx, sy)));
  const rgb = frame.rgb, W = vw, H = vh;
  const scores = [];
  for (let ty = 0; ty < level.height; ty++) {
    for (let tx = 0; tx < level.width; tx++) {
      const s = P.tileToScreen(level, tx, ty, false);
      if (!s) continue;
      const X = Math.round(s.x * sx), Y = Math.round(s.y * sy);
      let hit = 0, n = 0;
      for (let y = Y - R; y <= Y + R; y += 2) {
        for (let x = X - R; x <= X + R; x += 2) {
          n++;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const i = (y * W + x) * 3;
          if (isOrange(rgb[i], rgb[i + 1], rgb[i + 2], o.orange)) hit++;
        }
      }
      const ratio = n ? hit / n : 0;
      const d = level.tiles[ty][tx];
      scores.push({ tx, ty, ratio, bt: d.buildableType, key: d.tileKey });
    }
  }
  const sorted = scores.slice().sort((a, b) => b.ratio - a.ratio);
  const top = sorted[0];
  return {
    ok: !!(top && top.ratio >= o.minRatio),
    top,
    above: sorted.filter((t) => t.ratio >= o.minRatio),
    all: scores,
  };
}

/* 用橙色斜纹格的位置判朝向：斜纹格相对干员格的偏移方向。
 * 注意：调用方要确认"斜纹格 ≠ 干员自己那格"（同一格说明只是落点标记，不含方向）。 */
function directionFromStripe(operatorTile, stripeTile) {
  if (!operatorTile || !stripeTile) return null;
  const dx = stripeTile.tx - operatorTile.tx;
  const dy = stripeTile.ty - operatorTile.ty;
  if (!dx && !dy) return { dir: null, reason: '斜纹格就是干员格，不含方向信息' };
  if (Math.abs(dx) >= Math.abs(dy)) return { dir: dx > 0 ? 'Right' : 'Left', delta: { dx, dy } };
  return { dir: dy > 0 ? 'Up' : 'Down', delta: { dx, dy } };
}

module.exports = {
  DEF, ORANGE, isGreenPixel, isOrange, highlightTiles, renderMask, findOrangeTile, directionFromStripe,
};
