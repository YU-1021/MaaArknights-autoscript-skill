/* Arknights 地图格 → 屏幕像素 的投影计算。
 *
 * 逐行移植自 MAA 的 MaaAssistantArknights 3rdparty/include/Arknights-Tile-Pos/TileCalc2.hpp
 * 为什么要移植而不是自己拟合：这是**游戏自己的相机模型**，用它算出来的坐标
 * 和 MAA 内部 `m_normal_tile_info` 表里的数字**同源**，残差才有意义。
 *
 * 关键结论（决定了"缺数据也能救"）：
 *   · 欧拉角是**常量**：正视图 (0, 30°, 0)，侧视图 (10°, 30°, 0)
 *   · fov 是**常量**：20°（半角）——注意 tan_f = tan(20°)
 *   · near/far 常量：0.3 / 1000
 *   · 每个关卡真正变化的只有 **view[0] 的 x,y,z 三个数** + width/height
 *   ⇒ 所以一个关卡的完整投影只需要 5 个数字就能复现。
 */
'use strict';

const DEG = Math.PI / 180;

/* 4x4 矩阵乘法（行主序，和 C++ cv::Matx44d 的初始化顺序一致） */
function mul(a, b) {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      r[i * 4 + j] = s;
    }
  }
  return r;
}

function matVec(m, v) {
  const r = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    r[i] = m[i * 4 + 0] * v[0] + m[i * 4 + 1] * v[1] + m[i * 4 + 2] * v[2] + m[i * 4 + 3] * v[3];
  }
  return r;
}

/* camera_pos：view[idx] + 一个按宽高比做的小调整（16:9 时调整量为 0） */
function cameraPos(view, side, width, height) {
  const p = view[side ? 1 : 0];
  if (!p) return [0, 0, 0];
  const fromRatio = 9 / 16;
  const toRatio = 3 / 4;
  const ratio = height / width;
  const t = (fromRatio - ratio) / (fromRatio - toRatio);
  const adj = [-1.4 * t, -2.8 * t, 0];
  return [p[0] + adj[0], p[1] + adj[1], p[2] + adj[2]];
}

/* 欧拉角是常量 */
function cameraEuler(side) {
  return side ? [10 * DEG, 30 * DEG, 0] : [0, 30 * DEG, 0];
}

function cameraMatrix(pos, euler, ratio, fov2y, farC, nearC) {
  const fov = fov2y === undefined ? 20 * DEG : fov2y;
  const far = farC === undefined ? 1000 : farC;
  const near = nearC === undefined ? 0.3 : nearC;
  const cosY = Math.cos(euler[0]), sinY = Math.sin(euler[0]);
  const cosX = Math.cos(euler[1]), sinX = Math.sin(euler[1]);
  const tanF = Math.tan(fov);

  const translate = [
    1, 0, 0, -pos[0],
    0, 1, 0, -pos[1],
    0, 0, 1, -pos[2],
    0, 0, 0, 1,
  ];
  const matrixY = [
    cosY, 0, sinY, 0,
    0, 1, 0, 0,
    -sinY, 0, cosY, 0,
    0, 0, 0, 1,
  ];
  const matrixX = [
    1, 0, 0, 0,
    0, cosX, -sinX, 0,
    0, -sinX, -cosX, 0,
    0, 0, 0, 1,
  ];
  const proj = [
    ratio / tanF, 0, 0, 0,
    0, 1 / tanF, 0, 0,
    0, 0, -(far + near) / (far - near), -(far * near * 2) / (far - near),
    0, 0, -1, 0,
  ];
  return mul(mul(mul(proj, matrixX), matrixY), translate);
}

/* 格子 → 世界坐标（以地图中心为原点，高度按 heightType 抬 0.4） */
function tileWorldPos(width, height, tileY, tileX, heightType) {
  return [
    tileX - (width - 1) / 2,
    (height - 1) / 2 - tileY,
    (heightType || 0) * -0.4,
  ];
}

/* 世界坐标 → 屏幕像素（1280×720 基准） */
function worldToScreen(level, worldPos, side, offset) {
  const W = 1280, H = 720;
  const p = cameraPos(level.view || [], side, W, H);
  const off = offset || [0, 0, 0];
  const posCam = [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
  const euler = cameraEuler(side);
  const m = cameraMatrix(posCam, euler, H / W);
  let r = matVec(m, [worldPos[0], worldPos[1], worldPos[2], 1]);
  const w = r[3];
  if (!w) return null;
  r = [r[0] / w, r[1] / w, r[2] / w, 1];
  r = [r[0] + 1, r[1] + 1, r[2] + 1, r[3] + 1].map((v) => v / 2);
  return {
    x: Math.round(r[0] * W),
    y: Math.round((1 - r[1]) * H),
  };
}

/* 便捷：直接给 (col,row) 且可指定 heightType 表 */
function tileToScreen(level, tileX, tileY, side, offset) {
  const ht = (level.tiles && level.tiles[tileY] && level.tiles[tileY][tileX])
    ? level.tiles[tileY][tileX].heightType : 0;
  return worldToScreen(level, tileWorldPos(level.width, level.height, tileY, tileX, ht), side, offset);
}

/* 整张地图的格子像素（用于自验 / 生成 m_normal_tile_info 等价表） */
function projectAll(level, side) {
  const out = [];
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const p = tileToScreen(level, x, y, side);
      const t = level.tiles && level.tiles[y] && level.tiles[y][x];
      out.push({ x, y, px: p ? p.x : null, py: p ? p.y : null, tileKey: t ? t.tileKey : '', buildableType: t ? t.buildableType : 0 });
    }
  }
  return out;
}

module.exports = {
  DEG, cameraPos, cameraEuler, cameraMatrix, tileWorldPos, worldToScreen, tileToScreen, projectAll,
  BASE_W: 1280, BASE_H: 720,
};
