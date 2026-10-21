#!/usr/bin/env node
/* 把作业画成一张「标注地图」：每个干员放在哪格、朝哪、什么时候开技能。
 *
 * 用法：
 *   node bin/annotate.cjs --json=out/YW-1.json [--stage=YW-1] [--frame=30]
 *                         [--maa=<MAA目录>] [--out=out/YW-1-标注地图.png]
 *
 * 为什么用 Node 调 ffmpeg 而不是 PowerShell：
 *   drawtext 里要写中文（山 / 娜仁图亚 / 待填_01），
 *   PowerShell 传参容易被代码页搞成乱码；Node 的 execFileSync 直接传 UTF-16 argv，
 *   实测渲染中文正常（干员名模板就是这么渲的）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const LIB = path.join(__dirname, '..', 'lib');
const P = require(path.join(LIB, 'tileproj.cjs'));
const C = require(path.join(LIB, 'copilot.cjs'));
const D = require(path.join(LIB, 'deploy.cjs'));

function arg(n, d) {
  const h = process.argv.slice(2).find((a) => a === '--' + n || a.startsWith('--' + n + '='));
  if (!h) return d;
  const i = h.indexOf('=');
  return i < 0 ? true : h.slice(i + 1);
}
const JSONF = String(arg('json', ''));
const MAA = String(arg('maa', 'F:\\dspet\\MAA-v6.19.0-win-x64。2'));
const STAGE = String(arg('stage', ''));
const FRAME_T = Number(arg('frame', 30));
const OUT = String(arg('out', ''));

if (!JSONF || !fs.existsSync(JSONF)) { console.error('用法: node bin/annotate.cjs --json=<作业.json> [--frame=30]'); process.exit(2); }
const script = JSON.parse(fs.readFileSync(JSONF, 'utf8'));
const stage = STAGE || script.stage_name;
const t = C.findTile(path.join(MAA, 'resource', 'Arknights-Tile-Pos'), stage, {});
if (!t.ok) { console.error('找不到关卡数据: ' + stage); process.exit(1); }
const lv = t.data;

/* 视频哪来的？优先用作业 doc 里记的，否则让用户给 */
const VIDEO = String(arg('video', 'F:\\dspet\\video\\YW-1.mp4'));
if (!fs.existsSync(VIDEO)) { console.error('找不到视频: ' + VIDEO); process.exit(1); }
const info = D.probe(VIDEO);
const vw = info.width, vh = info.height;
const FF = D.ffmpeg();
const S = vw / 1280;

const DIR_ARROW = { Right: '→', Left: '←', Up: '↑', Down: '↓' };
const COLORS = ['0x00E5FF', '0xFFD400', '0xFF4FD8', '0x7CFF4F', '0xFF8A3D', '0xB388FF'];

/* 收集动作 */
const deploys = [];
const skills = [];
for (const a of (script.actions || [])) {
  const ty = String(a.type || '').toLowerCase();
  if ((ty === 'deploy' || ty === '部署' || (!a.type && a.location)) && a.location) deploys.push(a);
  else if ((ty === 'useskill' || ty === 'skill' || ty === '技能') && a.location) skills.push(a);
}
if (!deploys.length) { console.error('作业里没有 Deploy 动作'); process.exit(1); }

function timeOf(a) {
  const m = String(a.doc || '').match(/视频\s*([\d.]+)\s*s/);
  return m ? Number(m[1]) : null;
}

/* 技能按 location 归到对应干员 */
function skillFor(a) {
  return skills.find((s) => Array.isArray(s.location) && Array.isArray(a.location)
    && s.location[0] === a.location[0] && s.location[1] === a.location[1]);
}
function skillTime(a) {
  const s = skillFor(a);
  if (!s) return null;
  const m = String(s.doc || '').match(/@(?:视频)?([\d.]+)\s*s/);
  return m ? Number(m[1]) : null;
}

/* 画图 */
const parts = [];
const dots = [];
for (let ty2 = 0; ty2 < lv.height; ty2++) {
  for (let tx2 = 0; tx2 < lv.width; tx2++) {
    const p = P.tileToScreen(lv, tx2, ty2, false);
    if (!p) continue;
    const X = Math.round(p.x * S), Y = Math.round(p.y * S);
    parts.push('drawbox=x=' + (X - 2) + ':y=' + (Y - 2) + ':w=5:h=5:color=0xFFFFFF@0.45:t=fill');
  }
}
const FONT = "C\\:/Windows/Fonts/msyh.ttc";
function txt(s, x, y, size, color, extra) {
  return "drawtext=fontfile='" + FONT + "':text='" + s + "':fontsize=" + size
    + ":fontcolor=" + color + ":x=" + Math.round(x) + ":y=" + Math.round(y)
    + (extra || '');
}

const rows = [];
deploys.forEach((a, i) => {
  const p = P.tileToScreen(lv, a.location[0], a.location[1], false);
  const X = Math.round(p.x * S), Y = Math.round(p.y * S);
  const col = COLORS[i % COLORS.length];
  const nm = a.name || '?';
  const dir = a.direction || 'Right';
  const arrow = DIR_ARROW[dir] || '?';
  const tD = timeOf(a), tS = skillTime(a);
  /* 标记：外白框 + 内色块 + 序号 */
  parts.push('drawbox=x=' + (X - 15) + ':y=' + (Y - 15) + ':w=31:h=31:color=0xFFFFFF@0.95:t=3');
  parts.push('drawbox=x=' + (X - 11) + ':y=' + (Y - 11) + ':w=23:h=23:color=' + col + '@0.85:t=fill');
  parts.push(txt(String(i + 1), X - 5, Y - 12, 22, '0x000000'));
  /* 名字 + 箭头：偶数号往右放，奇数号往左放，避免挤在一起 */
  /* 【地图上只放短标注】完整信息（名字/部署时刻/技能时刻）放图例。
   * 踩过的坑：第一版把名字+时刻都画在标记旁，[6,3] 和 [7,3] 只隔一格，
   * 两段文字直接叠在一起，糊成一团看不清。 */
  const lab = '[' + a.location[0] + ',' + a.location[1] + ']' + arrow;
  const labX = (i % 2 === 0) ? X + 22 : X - 22 - (lab.length * 14);
  parts.push(txt(lab, labX, Y - 14, 22, col));
  rows.push((i + 1) + '  ' + nm.padEnd(10) + '  [' + a.location[0] + ',' + a.location[1] + ']  ' + arrow
    + '  部署 ' + (tD != null ? tD.toFixed(1) + 's' : '?')
    + (tS != null ? '   技能 ' + tS.toFixed(2) + 's' : ''));
});

/* 图例（左下角黑底） */
const LX = 14, LY = vh - 30 - 34 * (rows.length + 2);
parts.push('drawbox=x=' + LX + ':y=' + LY + ':w=700:h=' + (34 * (rows.length + 2) + 12) + ':color=0x000000@0.78:t=fill');
parts.push(txt((lv.code || stage) + '  ' + lv.width + 'x' + lv.height + '   白色小点=格子中心', LX + 12, LY + 6, 20, '0x9FE8FF'));
rows.forEach((r, i) => parts.push(txt(r, LX + 12, LY + 34 + i * 34, 24, '0xFFFFFF')));

const filter = parts.join(',');
const outFile = OUT || path.join(process.cwd(), 'out', (lv.code || stage) + '-标注地图.png');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const tmp = path.join(os.tmpdir(), 'ann-' + process.pid + '.png');
console.log('滤镜 ' + filter.length + ' 字符，' + deploys.length + ' 个部署，' + skills.length + ' 个技能');
try {
  execFileSync(FF, ['-y', '-v', 'error', '-ss', String(FRAME_T), '-i', VIDEO,
    '-frames:v', '1', '-vf', filter, tmp], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.copyFileSync(tmp, outFile);
  try { fs.unlinkSync(tmp); } catch {}
  console.log('✅ ' + outFile);
} catch (e) {
  console.error('❌ ffmpeg 失败: ' + ((e && e.message) || e));
  process.exit(1);
}
