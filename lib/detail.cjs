/* 作战详情面板读取器 —— 干员名 + 技能名 + 技能触发方式 + 等级。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 面板长什么样（实测 YW-1 @16.9s，1920×1080）：
 *
 *   攻击范围图（黑底白格）        ← y 250..262 附近
 *   职业徽章
 *   干员名「山」                  ← y 281..308,  x 28..54   白字
 *   LV 60                        ← y ~325..355
 *   攻击 654 / 防御 442 / 法抗 0 / 阻挡 1
 *   技能 / 特性 / 天赋  (tab)     ← y 578..598
 *   技能名「横扫架势」             ← y 624..648,  x 140..244
 *   自动回复  手动触发             ← y ~660..690
 *   技能描述（多行小字）
 *
 * 【技能序号的定法（关键）】
 *   面板上只有**技能名**，没有"这是第几个技能"。
 *   所以：先用名字认出干员 → 从 lib/skills.json 拿到该干员的 3 个技能名
 *   → 只对这 3 个候选做匹配 → 命中的下标就是 skill (1/2/3)。
 *   候选只有 3 个，几乎不可能认错。
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ON = require('./opername.cjs');

/* 各区域（**1280×720 基准**） */
const REGION = {
  name: ON.NAME_REGION,                          /* {10,185,127,22} */
  skill: { x: 87, y: 412, w: 150, h: 22 },
  /* 触发方式：面板上有两个标签——
   *   左边「自动回复/攻击回复/受击回复」是**绿底白字**（x139..247 @1920）
   *   右边「手动触发 / 自动触发」是**灰底白字**（x252..362 @1920）
   *
   * 【关键教训】「手动触发」和「自动触发」只差第一个字，后三字完全相同。
   * 拿整串做 NCC，相同的 3/4 会主导相似度（实测 0.451 vs 0.351，判错）。
   * 所以只取**第一个字**来比：手 vs 自。 */
  activationFirst: { x: 176, y: 440, w: 15, h: 22 },
  level: { x: 58, y: 215, w: 70, h: 22 },
};

/* 面板是否显示 —— 用名字区能不能读出字来判断 */
function panelVisible(frameRgb, videoW, videoH, opts) {
  const g = ON.readGlyph(frameRgb, videoW, videoH, Object.assign({ region: REGION.name }, opts || {}));
  return { ok: !!g.ok, glyph: g };
}

/* 读技能名：只在调用方给的候选里选（通常是该干员的 3 个技能名） */
function readSkillName(frameRgb, videoW, videoH, candidates, opts) {
  const o = Object.assign({ minScore: 0.35, minMargin: 0.06 }, opts || {});
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return { ok: false, reason: '无候选技能名' };
  const g = ON.readGlyph(frameRgb, videoW, videoH, { region: REGION.skill });
  if (!g.ok) return { ok: false, reason: '技能名区没读出字：' + g.reason };
  /* 只为这几个候选建模板（快） */
  const tmpl = ON.renderTemplates(list, { size: 100 });
  if (!tmpl.names || !tmpl.names.length) return { ok: false, reason: '候选技能名渲染失败' };
  const r = ON.identify(g, tmpl, o);
  let index = tmpl.names.indexOf(r.name);
  const score = r.score, margin = r.margin;
  /* 候选里可能有重名技能（不同干员），下标按 list 找 */
  if (index < 0) index = -1;
  return {
    ok: r.ok, name: r.name, score, margin,
    slot: index >= 0 ? index + 1 : 0,        /* skill 序号 1/2/3 */
    top: r.top, reason: r.reason,
  };
}

/* 读技能触发方式：只比第二个标签的**第一个字**（手 / 自）。
 * 理由见 REGION.activationFirst 的注释：整串对比会被相同的后三字带偏。 */
function readActivation(frameRgb, videoW, videoH, opts) {
  const g = ON.readGlyph(frameRgb, videoW, videoH, { region: REGION.activationFirst });
  if (!g.ok) return { ok: false, reason: '触发方式区没读出字：' + g.reason };
  const tmpl = ON.renderTemplates(['手', '自'], { size: 100 });
  const r = ON.identify(g, tmpl, Object.assign({ minScore: 0.40, minMargin: 0.10 }, opts || {}));
  if (!r.ok) return { ok: false, reason: '无法判定手/自：' + r.reason, top: r.top };
  const manual = r.name === '手';
  return {
    ok: true,
    text: manual ? '手动触发' : '自动触发',
    manual,
    score: r.score, margin: r.margin, top: r.top,
  };
}

/* 读等级：面板上「LV 60」。数字不用中文字体，用 7 段式太重，
 * 这里先返回原始字形尺寸让上层判断，数字识别交给 readDigits。 */
function levelRegionInfo(videoW, videoH) {
  const sx = videoW / 1280, sy = videoH / 720;
  return {
    x: Math.round(REGION.level.x * sx), y: Math.round(REGION.level.y * sy),
    w: Math.round(REGION.level.w * sx), h: Math.round(REGION.level.h * sy),
  };
}

/* 数字识别：用 0-9 渲染模板 + NCC（数字比汉字简单得多） */
let DIGIT_TMPL = null;
function digitTemplates(font) {
  if (DIGIT_TMPL) return DIGIT_TMPL;
  DIGIT_TMPL = ON.renderTemplates(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], { size: 100, font });
  return DIGIT_TMPL;
}

/* 从一段字形里切出多个数字，逐个识别，拼成整数。
 * bin: 归一化前的二值图（w×h），按列空隙切分。 */
function readDigitsFromBin(bin, w, h, tmpl) {
  const cols = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) if (bin[y * w + x]) { cols[x] = 1; break; }
  }
  /* 找连续段（字符），空隙 ≥2 列算分隔 */
  const spans = [];
  let s = -1, gap = 0;
  for (let x = 0; x < w; x++) {
    if (cols[x]) { if (s < 0) s = x; gap = 0; }
    else if (s >= 0) { gap++; if (gap >= 2) { spans.push([s, x - gap]); s = -1; gap = 0; } }
  }
  if (s >= 0) spans.push([s, w - 1]);
  const out = [];
  for (const [x0, x1] of spans) {
    const cw = x1 - x0 + 1;
    if (cw < 2) continue;
    const sub = new Uint8Array(cw * h);
    for (let y = 0; y < h; y++) for (let x = x0; x <= x1; x++) sub[y * cw + (x - x0)] = bin[y * w + x];
    const n = ON.normalize(sub, cw, h);
    if (!n) continue;
    let best = null;
    for (let k = 0; k < tmpl.names.length; k++) {
      const off = k * ON.NPIX;
      let sa = 0, sb = 0;
      for (let i = 0; i < ON.NPIX; i++) { sa += n.v[i]; sb += tmpl.bits[off + i]; }
      const ma = sa / ON.NPIX, mb = sb / ON.NPIX;
      let nu = 0, da = 0, db = 0;
      for (let i = 0; i < ON.NPIX; i++) { const p = n.v[i] - ma, q = tmpl.bits[off + i] - mb; nu += p * q; da += p * p; db += q * q; }
      const d = Math.sqrt(da * db);
      const sc = d > 0 ? nu / d : 0;
      if (!best || sc > best.s) best = { s: sc, d: tmpl.names[k] };
    }
    if (best) out.push(best);
  }
  return out;
}

module.exports = { REGION, panelVisible, readSkillName, readActivation, digitTemplates, readDigitsFromBin, levelRegionInfo };
