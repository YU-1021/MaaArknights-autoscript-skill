#!/usr/bin/env node
/* 视频 → MAA 作业（copilot JSON）一站式脚本。
 *
 * 用法：
 *   node bin/build.cjs --video=F:\dspet\video\YW-1.mp4 --stage=YW-1 \
 *                      --maa="F:\dspet\MAA-v6.19.0-win-x64。2" \
 *                      --out=out/YW-1.json [--from=20 --to=130 --step=40]
 *
 * 流程（全部纯脚本，不用视觉模型）：
 *   ① 从 MAA 的 Arknights-Tile-Pos 读该关卡 width/height/view/tiles
 *   ② 用 MAA 的投影公式算出**每一格的屏幕像素**（1280×720 基准 → 视频分辨率）
 *   ③ ffmpeg 按时间点抽帧，相邻帧差分 → 连通域 → 找战场上的变化块
 *   ④ 每个变化块映射到"最近的可部署格" → 得到 location [x,y]
 *   ⑤ 按该格的 buildableType 从干员库里挑 MELEE/RANGED 的真实干员名
 *   ⑥ 生成 JSON 并用本项目的 validate() 校验（含"格子能不能站这个干员"）
 *
 * 已知边界（诚实写在最前面）：
 *   · 干员身份目前是**按位置自动挑的占位名**，不是视频里真实的那个干员
 *     （真实身份要 avatar 模板匹配，尚未接入）
 *   · 朝向一律 Right（尚未从视频推断）
 *   · 时序用 kills 递增占位（尚未从视频读费用/击杀）
 *   这三项都会在输出里标 warnings，不会被当成成品。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'lib');
const P = require(path.join(LIB, 'tileproj.cjs'));
const C = require(path.join(LIB, 'copilot.cjs'));
const O = require(path.join(LIB, 'operdb.cjs'));

/* ---------------------------------------------------------------- 参数 */
function arg(name, dflt) {
  const hit = process.argv.slice(2).find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return dflt;
  const i = hit.indexOf('=');
  return i < 0 ? true : hit.slice(i + 1);
}
const VIDEO = String(arg('video', ''));
const STAGE = String(arg('stage', ''));
const MAA = String(arg('maa', 'F:\\dspet\\MAA-v6.19.0-win-x64。2'));
const OUT = String(arg('out', ''));
const FROM = Number(arg('from', 20));
const TO = Number(arg('to', 130));
const STEP = Number(arg('step', 40));

if (!VIDEO || !STAGE) {
  console.error('用法: node bin/build.cjs --video=<视频> --stage=<关卡代号> --maa=<MAA目录> --out=<输出json>');
  process.exit(2);
}
if (!fs.existsSync(VIDEO)) { console.error('视频不存在: ' + VIDEO); process.exit(2); }

const log = (...a) => console.log(...a);

/* ---------------------------------------------------------------- ffmpeg */
function ffmpeg() {
  try {
    const out = execFileSync('where.exe', ['ffmpeg'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const f = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (f && fs.existsSync(f)) return f;
  } catch {}
  for (const g of ['C:\\Program Files\\ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe']) {
    if (fs.existsSync(g)) return g;
  }
  return null;
}

/* ---------------------------------------------------------------- 主流程 */
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpbuild-'));
  const notes = [];
  try {
    /* ① 格子数据 */
    const tpDir = path.join(MAA, 'resource', 'Arknights-Tile-Pos');
    if (!fs.existsSync(tpDir)) throw new Error('找不到 Tile-Pos: ' + tpDir);
    const idx = path.join(tmp, 'idx.json');
    const t = C.findTile(tpDir, STAGE, { cacheFile: idx });
    if (!t.ok) throw new Error('关卡数据: ' + t.reason);
    const lv = t.data;
    log('① 关卡 ' + (lv.code || STAGE) + '  ' + lv.width + 'x' + lv.height + '  view=' + JSON.stringify(lv.view && lv.view[0]));

    /* ② 干员库 */
    const oi = O.load(MAA);
    if (!oi.ok) throw new Error('干员库: ' + oi.reason);
    log('② 干员库 ' + oi.count + ' 人');

    /* ③ 视频尺寸 → 缩放 */
    const ff = ffmpeg();
    if (!ff) throw new Error('找不到 ffmpeg');
    let vw = 1920, vh = 1080;
    try {
      const pr = execFileSync(path.join(path.dirname(ff), 'ffprobe.exe'),
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', VIDEO],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const [w, h] = String(pr).trim().split(',').map(Number);
      if (w > 0 && h > 0) { vw = w; vh = h; }
    } catch {}
    const SX = vw / P.BASE_W, SY = vh / P.BASE_H;
    /* 时长/帧率另用 deploy.probe（ffprobe 只读了宽高） */
    const DV0 = require(path.join(LIB, 'deploy.cjs'));
    const info = Object.assign({ width: vw, height: vh, fps: 30, durationMs: 0 }, DV0.probe(VIDEO) || {});
    log('③ 视频 ' + vw + 'x' + vh + '  ' + Math.round((info.durationMs || 0) / 1000) + 's  缩放 ' + SX.toFixed(3) + 'x' + SY.toFixed(3));

    /* ④ 格子→像素表（只留可部署的） */
    const tbl = [];
    for (let ty = 0; ty < lv.height; ty++) {
      for (let tx = 0; tx < lv.width; tx++) {
        const s = P.tileToScreen(lv, tx, ty, false);
        const d = lv.tiles[ty][tx];
        if (s) tbl.push({ tx, ty, X: s.x * SX, Y: s.y * SY, bt: d.buildableType, key: d.tileKey });
      }
    }
    const buildable = tbl.filter((q) => q.bt !== 0);
    log('④ 格子 ' + tbl.length + ' 个，其中可部署 ' + buildable.length + ' 个');

    /* ⑤ 抽帧 + 差分
     * 【时序基准 = 进入战斗那一帧】
     * 视频开头有片头/加载/编队，那些部分完全没用；而且它们的干员栏长得不一样，
     * 不先对齐零点会全是假变动。所以先自动找战斗起点，再从那里开始抽。 */
    const DV0b = require(path.join(LIB, 'deploy.cjs'));
    let battleStartSec = 0;
    try {
      const bs = DV0b.findBattleStart(VIDEO, info);
      if (bs && bs.ok && Number.isFinite(bs.startSec)) battleStartSec = bs.startSec;
    } catch (e) { notes.push('战斗起点检测失败，从 ' + FROM + 's 开始：' + ((e && e.message) || e)); }
    const t0 = arg('from', null) !== null ? FROM : Math.max(0, Math.floor(battleStartSec));
    const times = [];
    for (let s = t0; s <= TO; s += STEP) times.push(s);
    log('⑤ 战斗起点 ' + battleStartSec + 's，抽帧从 ' + t0 + 's 起');
    if (times.length < 2) throw new Error('--from/--to/--step 至少要给两个时间点');
    const grayFiles = [];
    for (const s of times) {
      const f = path.join(tmp, 'g' + s + '.raw');
      execFileSync(ff, ['-y', '-v', 'error', '-ss', String(s), '-i', VIDEO, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', f],
        { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      if (fs.existsSync(f)) grayFiles.push({ s, f });
    }
    log('⑤ 抽帧 ' + grayFiles.length + ' 张（' + times.join(', ') + ' 秒）');
    if (grayFiles.length < 2) throw new Error('抽帧不足');

    /* 战场区域：用可部署格的包围盒，外扩 60px */
    let bx0 = 1e9, bx1 = -1, by0 = 1e9, by1 = -1;
    for (const q of buildable) {
      bx0 = Math.min(bx0, q.X); bx1 = Math.max(bx1, q.X);
      by0 = Math.min(by0, q.Y); by1 = Math.max(by1, q.Y);
    }
    const X0 = Math.max(0, Math.floor(bx0 - 60)), X1 = Math.min(vw - 1, Math.ceil(bx1 + 60));
    const Y0 = Math.max(0, Math.floor(by0 - 60)), Y1 = Math.min(vh - 1, Math.ceil(by1 + 60));
    const FB = vw * vh;
    log('   战场搜索区 x ' + X0 + '..' + X1 + '  y ' + Y0 + '..' + Y1);

    const found = new Map();
    for (let i = 1; i < grayFiles.length; i++) {
      const A = fs.readFileSync(grayFiles[i - 1].f);
      const B = fs.readFileSync(grayFiles[i].f);
      if (A.length < FB || B.length < FB) continue;
      const mask = new Uint8Array(FB);
      for (let y = Y0; y < Y1; y++) {
        for (let x = X0; x < X1; x++) {
          if (Math.abs(B[y * vw + x] - A[y * vw + x]) > 45) mask[y * vw + x] = 1;
        }
      }
      const seen = new Uint8Array(FB);
      for (let y = Y0; y < Y1; y++) {
        for (let x = X0; x < X1; x++) {
          const k = y * vw + x;
          if (!mask[k] || seen[k]) continue;
          const q = [k]; seen[k] = 1;
          let x0 = x, x1 = x, y0 = y, y1 = y, n = 0, sx = 0, sy = 0;
          while (q.length) {
            const c = q.pop(); const cy = Math.floor(c / vw), cx = c % vw;
            x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
            n++; sx += cx; sy += cy;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
              const nx = cx + dx, ny = cy + dy;
              if (nx < X0 || ny < Y0 || nx >= X1 || ny >= Y1) continue;
              const nk = ny * vw + nx;
              if (mask[nk] && !seen[nk]) { seen[nk] = 1; q.push(nk); }
            }
          }
          /* 面积过滤：太小是噪点，太大是背景动画 */
          const minA = Math.round(FB * 0.0008), maxA = Math.round(FB * 0.03);
          if (n < minA || n > maxA) continue;
          const cx = sx / n, cy = sy / n;
          let best = null;
          for (const q2 of buildable) {
            const d = Math.hypot(q2.X - cx, q2.Y - cy);
            if (!best || d < best.d) best = Object.assign({ d }, q2);
          }
          if (!best || best.d > 28) continue;   /* 离任何格心太远 → 不是部署 */
          const key = best.tx + ',' + best.ty;
          const prev = found.get(key);
          if (!prev || prev.d > best.d) {
            found.set(key, { tx: best.tx, ty: best.ty, bt: best.bt, key: best.key, d: best.d, n, at: grayFiles[i].s });
          }
        }
      }
    }
    const occ = [...found.values()].sort((a, b) => a.ty - b.ty || a.tx - b.tx);
    log('⑥ 判定占用格 ' + occ.length + ' 个');
    for (const o of occ) log('   [' + o.tx + ',' + o.ty + '] bt=' + o.bt + '  ' + o.key + '  偏差' + o.d.toFixed(1) + 'px  @' + o.at + 's');

    if (!occ.length) throw new Error('一个干员位置都没找到（可能时间点选得不对，或视频不是这个关卡）');

    /* ⑦ 按位置挑真实干员名 */
    const melee = O.namesByPosition('MELEE');
    const ranged = O.namesByPosition('RANGED');
    let mi = 0, ri = 0;
    const script = C.skeleton({
      stage: lv.code || STAGE,
      title: (lv.code || STAGE) + ' 视频解析自动生成',
      details: '来源视频: ' + path.basename(VIDEO)
        + '\n战斗起点: ' + battleStartSec + 's（视频时间轴）'
        + '\n由 dsh-arknights-copilot 自动生成',
    });
    const used = new Set();
    /* 【时序 = 视频时间轴】按检出时刻排序，不写 kills/costs。
     * 理由：copilot 的动作本来就是**有序执行**的；"一摆到底"流派的作业
     * 也全都不带 kills/costs（用户给的 PRTSPlus 样例就是那样）。
     * 想卡时机才需要 kills/costs —— 那要靠 OCR 读击杀数，不是必须的。
     * 所以我们把视频时刻写进 doc，动作按时间顺序排，交给 MAA 顺序执行。 */
    occ.sort((a, b) => a.at - b.at);
    occ.forEach((o, i) => {
      const pool = o.bt === 2 ? ranged : melee;
      let name = null;
      for (let k = 0; k < pool.length; k++) {
        const cand = o.bt === 2 ? ranged[ri++ % ranged.length] : melee[mi++ % melee.length];
        if (!used.has(cand)) { name = cand; break; }
      }
      if (!name) name = pool[0];
      used.add(name);
      script.opers.push({ name });
      const act = C.addDeploy(script, {
        name,
        location: [o.tx, o.ty],
        direction: 'Right',
        doc: '视频 ' + o.at + 's（战斗起点 +' + (o.at - (battleStartSec || 0)).toFixed(1) + 's）',
      });
      /* 时延：让 MAA 在动作之间留出视频里的实际间隔（毫秒） */
      if (i > 0) {
        const gapMs = Math.max(0, Math.round((o.at - occ[i - 1].at) * 1000));
        if (gapMs > 0 && gapMs < 30000) act.pre_delay = gapMs;
      }
    });

    /* ⑧ 技能：在干员上方宽范围搜亮黄菱形，按时间顺序插 UseSkill */
    const DV = require(path.join(LIB, 'direction.cjs'));
    const skillNotes = [];
    let skillCount = 0;
    for (const o of occ) {
      const c = P.tileToScreen(lv, o.tx, o.ty, false);
      if (!c) continue;
      const sr = DV.scanGold(VIDEO, { x: c.x, y: c.y }, vw, vh, o.at, Math.max(6, (info && info.durationMs ? info.durationMs / 1000 : 130) - o.at));
      if (!sr.ok) { skillNotes.push('[' + o.tx + ',' + o.ty + '] 技能扫描失败：' + sr.reason); continue; }
      if (!sr.readyAt.length) continue;
      skillCount += sr.readyAt.length;
      skillNotes.push('[' + o.tx + ',' + o.ty + '] 金色就绪 ' + sr.readyAt.length + ' 次 @' + sr.readyAt.join(', ') + 's（峰值金占比 ' + (sr.peak * 100).toFixed(1) + '%）');
    }
    if (skillCount) {
      /* 插一条 UseSkill（不带 location，表示"谁好了就开"），
         精确到某个干员的写法需要 100% 确定的身份，当前身份还是占位。 */
      script.actions.push({ type: 'SkillDaemon' });
      script.doc.details += '\n检测到 ' + skillCount + ' 次技能金色就绪，已用 SkillDaemon 兜底（谁好了开谁）';
    } else {
      script.actions.push({ type: 'SkillDaemon' });
    }
    /* 去重 opers */
    const seenN = new Set();
    script.opers = script.opers.filter((x) => (seenN.has(x.name) ? false : (seenN.add(x.name), true)));

    /* ⑧ 校验 */
    const v = C.validate(script, lv);
    log('⑦ 校验 ok=' + v.ok + '  errors=' + v.errors.length + '  warnings=' + v.warnings.length);
    v.errors.forEach((e) => log('   E ' + e));
    v.warnings.slice(0, 8).forEach((e) => log('   W ' + e));
    if (v.warnings.length > 8) log('   … 还有 ' + (v.warnings.length - 8) + ' 条');

    /* ⑨ 写出 */
    const outFile = OUT || path.join(process.cwd(), 'out', (lv.code || STAGE) + '.json');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(script, null, 2), 'utf8');
    log('');
    log('✅ 已写出: ' + outFile);
    log('   动作 ' + script.actions.length + ' 条，干员 ' + script.opers.length + ' 人');
    const uniq = [...new Set(notes)];
    if (uniq.length) { log(''); log('⚠️ 提示：'); uniq.forEach((n) => log('   · ' + n)); }
    if (skillNotes.length) { log(''); log('🎯 技能（干员上方搜亮黄菱形）：'); skillNotes.slice(0, 8).forEach((n) => log('   · ' + n)); }
    log('');
    log('⚠️ 仍需人工校正：');
    log('   · 朝向一律 Right（单帧范围法尚未完成 —— 跨帧差集会被地图位移破坏）');
    log('   · 干员名按"位置类型+格位"从库里挑，不是视频里的真实身份（头像匹配只覆盖 139/462）');
    log('   · 时序用视频时刻 + pre_delay 顺序执行，未写 kills/costs');
    return v.ok ? 0 : 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

try { process.exit(main()); }
catch (e) { console.error('❌ ' + ((e && e.message) || e)); process.exit(1); }
