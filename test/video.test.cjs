/* 视频分析引擎测试 —— 用 ffmpeg 合成一段"已知变化时刻"的视频来验。
 *
 * 为什么合成而不是等真实攻略视频：
 *   引擎的正确性（能不能在正确时刻抓到关键帧、倍速切换能不能分段）
 *   可以用已知答案的视频验死；而阈值灵敏度只能拿真实视频调。
 *   先把"逻辑对不对"钉住，真实视频到位后只调阈值，不用重写。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const V = require('../lib/video.cjs');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '   ' + extra : '')); }
};
const hr = (t) => console.log('\n=== ' + t + ' ===');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vidtest-'));

/* CJS 里没有顶层 await，所以整体包进 async IIFE */
(async () => {

/* ================================================================ §1 纯函数 */
hr('§1 toAnalysis / sig / sigDiff / gameTimeAt（纯函数）');
{
  /* 1280x720 基准 → 320x180 分析空间，正好 1/4 */
  const r = V.toAnalysis(V.REGIONS.operBar, 1280, 720, 320, 180);
  ok(r.x === 225 && r.y === 140 && r.w === 95 && r.h === 40, '★ 干员栏 900,560,380,160 → 225,140,95,40', JSON.stringify(r));

  /* 两块纯色区域的签名差 */
  const W = 32, H = 32;
  const black = Buffer.alloc(W * H * 3, 0);
  const white = Buffer.alloc(W * H * 3, 255);
  const mid = Buffer.alloc(W * H * 3, 128);
  const rect = { x: 0, y: 0, w: W, h: H };
  const sB = V.sig(black, W, rect, 8), sW = V.sig(white, W, rect, 8), sM = V.sig(mid, W, rect, 8);
  ok(sB.length === 64, '签名 = 8x8 = 64 个格', String(sB.length));
  ok(sB[0] === 0 && sW[0] === 255, '纯黑/纯白均值对', sB[0] + ' / ' + sW[0]);
  ok(Math.abs(V.sigDiff(sB, sW) - 1) < 0.01, '★ 黑白差 = 1', V.sigDiff(sB, sW).toFixed(3));
  ok(V.sigDiff(sB, sB) === 0, '自己和自己差 = 0');
  ok(Math.abs(V.sigDiff(sB, sM) - 0.502) < 0.01, '黑 vs 中灰 ≈ 0.5', V.sigDiff(sB, sM).toFixed(3));
  ok(V.sigDiff(sB, null) === 1, 'null 输入 → 视为完全不同（不崩）');

  /* 倍速 → 游戏时间 */
  const segs = [
    { fromMs: 0, toMs: 1000, value: 1 },
    { fromMs: 1000, toMs: null, value: 2 },
  ];
  ok(V.gameTimeAt(segs, 500) === 500, '1x 段：视频 500ms = 游戏 500ms');
  ok(V.gameTimeAt(segs, 1500) === 2000, '★★ 跨段：1000×1 + 500×2 = 2000ms', String(V.gameTimeAt(segs, 1500)));
  ok(V.gameTimeAt(segs, 2000) === 3000, '★★ 2x 段：视频 1s = 游戏 2s', String(V.gameTimeAt(segs, 2000)));
  /* 未知倍速按 1x 保守处理 */
  ok(V.gameTimeAt([{ fromMs: 0, toMs: null, value: null }], 1000) === 1000, '★ 倍速未知 → 按 1x 保守算（不假装快进）');
  ok(V.gameTimeAt(null, 1234) === 1234, '没有分段表 → 原样返回（不崩）');
}

/* ================================================================ §2 合成视频 */
hr('§2 合成一段已知变化时刻的视频');
let VIDEO = null;
{
  const ff = V.ffmpeg();
  ok(!!ff, '找得到 ffmpeg', ff ? path.basename(ff) : '没找到');
  if (ff) {
    VIDEO = path.join(TMP, 'synth.mp4');
    /* 黑底 6 秒；三个区域分别在 1.5s / 2.5s / 3.5s 变亮 —— 答案是已知的 */
    const vf = [
      "drawbox=x=90:y=80:w=1100:h=470:color=blue@1:t=fill:enable='gte(t,1.5)'",     // 战场
      "drawbox=x=900:y=560:w=380:h=160:color=red@1:t=fill:enable='gte(t,2.5)'",      // 干员栏
      "drawbox=x=1130:y=0:w=150:h=70:color=yellow@1:t=fill:enable='gte(t,3.5)'",     // 倍速标记
    ].join(',');
    try {
      execFileSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=6:r=10',
        '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', VIDEO], { timeout: 60000, windowsHide: true });
    } catch (e) { /* 下面断言会报 */ }
    ok(fs.existsSync(VIDEO) && fs.statSync(VIDEO).size > 1000, '合成成功', VIDEO ? Math.round(fs.statSync(VIDEO).size / 1024) + ' KB' : '');
  }
}

/* ================================================================ §3 探针 */
hr('§3 probe：分辨率/时长/帧率');
if (VIDEO && fs.existsSync(VIDEO)) {
  const p = V.probe(VIDEO);
  ok(p.ok, 'probe 成功', p.ok ? '' : p.reason);
  ok(p.width === 1280 && p.height === 720, '★ 分辨率 1280x720', p.width + 'x' + p.height);
  ok(p.durationMs >= 5500 && p.durationMs <= 6500, '时长 ≈ 6 秒', p.durationMs + 'ms');
  ok(p.fps > 0, '帧率读得到', String(Math.round(p.fps)));
}

/* ================================================================ §4 关键帧 */
hr('§4 analyze：在正确时刻抓到关键帧');
if (VIDEO && fs.existsSync(VIDEO)) {
  const r = await V.analyze(VIDEO, {});
  ok(r.ok, 'analyze 成功', r.ok ? '' : r.reason);
  if (r.ok) {
    ok(r.video && r.video.width === 1280, '报出原视频尺寸');
    ok(r.analysis.framesScanned > 50, '扫了足够多帧', String(r.analysis.framesScanned));
    ok(Array.isArray(r.keyframes) && r.keyframes.length >= 3, '★ 至少 3 个关键帧', String(r.keyframes.length));

    /* 三个变化点各应命中一次 */
    const near = (ms, tol) => r.keyframes.find((k) => Math.abs(k.atMs - ms) <= tol);
    const kField = near(1500, 400);
    const kBar = near(2500, 400);
    const kSpeed = near(3500, 400);
    ok(!!kField && kField.reasons.indexOf('field') >= 0, '★★ 战场变化 ≈1.5s 命中且归因 field',
      kField ? (kField.atMs + 'ms ' + JSON.stringify(kField.reasons)) : '没找到');
    ok(!!kBar && kBar.reasons.indexOf('operBar') >= 0, '★★ 干员栏变化 ≈2.5s 命中且归因 operBar',
      kBar ? (kBar.atMs + 'ms ' + JSON.stringify(kBar.reasons)) : '没找到');
    ok(!!kSpeed && kSpeed.reasons.indexOf('speed') >= 0, '★★ 倍速标记变化 ≈3.5s 命中且归因 speed',
      kSpeed ? (kSpeed.atMs + 'ms ' + JSON.stringify(kSpeed.reasons)) : '没找到');

    /* 关键帧不该多到爆（minGapMs 在起作用） */
    ok(r.keyframes.length <= 12, '★ 关键帧数量没爆炸（一个动作没刷成十几帧）', String(r.keyframes.length));

    /* 倍速分段 */
    ok(Array.isArray(r.speed) && r.speed.length >= 2, '★ 倍速被切成至少 2 段（切换点找到了）',
      JSON.stringify(r.speed.map((s) => s.value)));
    const sw = r.speed.find((s) => s.fromMs >= 3000);
    ok(!!sw, '切换点在 3.5s 之后开新段', sw ? ('from ' + sw.fromMs + 'ms') : '没找到');
    /* 没给分类器时必须明说"分不清 1x/2x"，不能假装知道 */
    ok(r.warnings.some((w) => /classifySpeed/.test(w)), '★★ 没提供 classifySpeed 时明确警告（不假装分得清 1x/2x）',
      (r.warnings[0] || '').slice(0, 46));
  }

  /* 第二遍：注入一个"假分类器"，验证它能影响分段值 */
  const r2 = await V.analyze(VIDEO, { classifySpeed: () => 2 });
  ok(r2.ok && r2.speed.some((s) => s.value === 2), '★ 注入 classifySpeed 后分段值被填上（2x）',
    JSON.stringify(r2.speed.map((s) => s.value)));
}

/* ================================================================ §5 校准导出 */
hr('§5 calibrate：导出带网格和区域框的帧（没有它只能猜坐标）');
if (VIDEO && fs.existsSync(VIDEO)) {
  const out = path.join(TMP, 'cal.png');
  const c = V.calibrate(VIDEO, 1000, out);
  ok(c.ok && fs.existsSync(out) && fs.statSync(out).size > 5000, '★ 导出成功', c.ok ? Math.round(fs.statSync(out).size / 1024) + ' KB' : c.reason);
  ok(c.ok && c.regions && c.regions.operBar, '带回区域定义（供人核对）');
}

/* ================================================================ §6 错误路径 */
hr('§6 错误路径：不崩、说清楚');
{
  const p = V.probe(path.join(TMP, 'nope.mp4'));
  ok(!p.ok && /不存在/.test(p.reason), '不存在的文件 → 明确说文件不存在', p.reason);
  let threw = null;
  try { await V.scan(path.join(TMP, 'nope.mp4'), {}, () => {}); } catch (e) { threw = e; }
  ok(threw && /不存在/.test(String(threw.message)), 'scan 对不存在的文件抛明确错误');
  const a = await V.analyze(path.join(TMP, 'nope.mp4'), {});
  ok(!a.ok, 'analyze 对不存在的文件返回 ok:false 而不是崩');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log('\n通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);

})().catch((e) => {
  console.error('测试自身崩了：' + (e && e.stack || e));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(2);
});
