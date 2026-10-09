// CPUの思考。危険マップ→逃げる／ブロックを壊す／相手を狙う の優先順で動く。
import { EMPTY, WALL, BLOCK, playerSpeed } from './engine.js';

const INF = Infinity;

function idx(state, x, y) { return y * state.cols + x; }

function isOpen(state, x, y) {
  if (x <= 0 || y <= 0 || x >= state.cols - 1 || y >= state.rows - 1) return false;
  return state.tiles[idx(state, x, y)] === EMPTY;
}

function hasBomb(state, x, y) {
  for (const b of state.bombs) if (b.x === x && b.y === y) return true;
  return false;
}

/** 爆弾が爆発したときに火が通るタイル */
function blastTiles(state, bx, by, power) {
  const out = [[bx, by]];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let i = 1; i <= power; i++) {
      const x = bx + dx * i, y = by + dy * i;
      const t = state.tiles[idx(state, x, y)];
      if (x < 0 || y < 0 || x >= state.cols || y >= state.rows || t === WALL) break;
      out.push([x, y]);
      if (t === BLOCK) break;
    }
  }
  return out;
}

/** 各タイルの「何秒後に火が出るか」。安全なら Infinity */
function dangerMap(state, extra) {
  const d = new Float32Array(state.cols * state.rows).fill(INF);
  const put = (x, y, t) => {
    const i = idx(state, x, y);
    if (i >= 0 && i < d.length && t < d[i]) d[i] = t;
  };
  for (const b of state.blasts) for (const [x, y] of b.tiles) put(x, y, 0);
  for (const b of state.bombs) {
    for (const [x, y] of blastTiles(state, b.x, b.y, b.power)) put(x, y, Math.max(0, b.timer));
  }
  if (extra) {
    for (const [x, y] of blastTiles(state, extra.x, extra.y, extra.power)) put(x, y, extra.timer);
  }
  return d;
}

/** BFS。goalTest を満たす最初のタイルまでの経路を返す */
function bfs(state, sx, sy, goalTest, opts = {}) {
  const { danger, avoidDanger = true, maxDepth = 400 } = opts;
  const W = state.cols, H = state.rows;
  const prev = new Int32Array(W * H).fill(-1);
  const seen = new Uint8Array(W * H);
  const start = idx(state, sx, sy);
  seen[start] = 1;
  const q = [[sx, sy, 0]];
  let head = 0;
  while (head < q.length) {
    const [x, y, dist] = q[head++];
    if (dist > 0 && goalTest(x, y, dist)) return rebuild(prev, start, idx(state, x, y), W);
    if (dist >= maxDepth) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      const ni = idx(state, nx, ny);
      if (seen[ni]) continue;
      if (!isOpen(state, nx, ny)) continue;
      if (hasBomb(state, nx, ny)) continue;
      if (avoidDanger && danger) {
        // そのタイルに着く頃に火が出ているなら通らない
        const eta = (dist + 1) * 0.3;
        if (danger[ni] !== INF && danger[ni] < eta + 0.35) continue;
      }
      seen[ni] = 1;
      prev[ni] = idx(state, x, y);
      q.push([nx, ny, dist + 1]);
    }
  }
  return null;
}

function rebuild(prev, start, goal, W) {
  const path = [];
  let cur = goal;
  while (cur !== -1 && cur !== start) {
    path.push([cur % W, Math.floor(cur / W)]);
    cur = prev[cur];
  }
  path.reverse();
  return path.length ? path : null;
}

function nearSoftBlock(state, x, y) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (state.tiles[idx(state, x + dx, y + dy)] === BLOCK) return true;
  }
  return false;
}

/** そのタイルに置いたら逃げ切れるか */
function canEscapeAfterBomb(state, p, x, y) {
  const d = dangerMap(state, { x, y, power: p.power, timer: 2.4 });
  const path = bfs(state, x, y, (gx, gy) => d[idx(state, gx, gy)] === INF, { danger: d, maxDepth: 12 });
  return !!path;
}

function lineOfBlast(state, p, x, y, targets) {
  const tiles = blastTiles(state, x, y, p.power);
  for (const t of targets) {
    const tx = Math.floor(t.x), ty = Math.floor(t.y);
    if (tiles.some(([bx, by]) => bx === tx && by === ty)) return true;
  }
  return false;
}

function stepTowards(p, tx, ty) {
  const cx = tx + 0.5, cy = ty + 0.5;
  const ddx = cx - p.x, ddy = cy - p.y;
  if (Math.abs(ddx) > 0.07) return { dx: Math.sign(ddx), dy: 0 };
  if (Math.abs(ddy) > 0.07) return { dx: 0, dy: Math.sign(ddy) };
  return { dx: 0, dy: 0 };
}

/**
 * CPUの入力を返す。state を書き換えないので、ホスト側の step 前に呼ぶだけでよい。
 * @returns {{dx:number,dy:number,bs:number}}
 */
export function botInput(state, p, dt) {
  const ai = p._ai || (p._ai = { bs: 0, think: 0, path: null, bombCool: 0, jitter: Math.random() });
  ai.think -= dt;
  ai.bombCool -= dt;
  if (!p.alive) return { dx: 0, dy: 0, bs: ai.bs };

  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  const danger = dangerMap(state);
  const inDanger = danger[idx(state, cx, cy)] !== INF;

  if (ai.think <= 0 || inDanger || !ai.path || !ai.path.length) {
    ai.think = inDanger ? 0.08 : 0.18 + ai.jitter * 0.12;
    ai.path = plan(state, p, danger, inDanger, ai);
  }

  // 経路の先頭に着いたら消す
  while (ai.path && ai.path.length && ai.path[0][0] === cx && ai.path[0][1] === cy) ai.path.shift();

  let mv = { dx: 0, dy: 0 };
  if (ai.path && ai.path.length) mv = stepTowards(p, ai.path[0][0], ai.path[0][1]);
  return { dx: mv.dx, dy: mv.dy, bs: ai.bs };
}

function plan(state, p, danger, inDanger, ai) {
  const cx = Math.floor(p.x), cy = Math.floor(p.y);

  // 1) 危ない → 安全なタイルへ逃げる
  if (inDanger) {
    let path = bfs(state, cx, cy, (x, y) => danger[idx(state, x, y)] === INF, { danger, maxDepth: 16 });
    if (!path) {
      // 完全な安全地帯がなければ、少しでも猶予のあるタイルへ
      path = bfs(state, cx, cy, (x, y) => danger[idx(state, x, y)] > danger[idx(state, cx, cy)] + 0.5,
        { danger, avoidDanger: false, maxDepth: 10 });
    }
    return path || null;
  }

  const targets = state.mode === 'coop'
    ? state.enemies.filter((e) => e.alive)
    : state.players.filter((q) => q.id !== p.id && q.alive);

  // 2) いま爆弾を置く価値があるか
  const canBomb = p.bombsOut < p.bombMax && ai.bombCool <= 0 && state.tiles[idx(state, cx, cy)] === EMPTY;
  if (canBomb) {
    const worth = nearSoftBlock(state, cx, cy) || lineOfBlast(state, p, cx, cy, targets);
    if (worth && canEscapeAfterBomb(state, p, cx, cy)) {
      ai.bs++;
      ai.bombCool = 0.55;
      const d2 = dangerMap(state, { x: cx, y: cy, power: p.power, timer: 2.4 });
      return bfs(state, cx, cy, (x, y) => d2[idx(state, x, y)] === INF, { danger: d2, maxDepth: 14 });
    }
  }

  // 3) 相手のそばへ（爆風が届く位置を狙う）
  if (targets.length) {
    const hunt = bfs(state, cx, cy,
      (x, y) => lineOfBlast(state, p, x, y, targets) && canEscapeAfterBomb(state, p, x, y),
      { danger, maxDepth: 26 });
    if (hunt) return hunt;
  }

  // 4) アイテムを拾う
  if (state.items.length) {
    const toItem = bfs(state, cx, cy,
      (x, y) => state.items.some((it) => it.x === x && it.y === y),
      { danger, maxDepth: 18 });
    if (toItem) return toItem;
  }

  // 5) 壊せるブロックの隣へ
  const toBlock = bfs(state, cx, cy, (x, y) => nearSoftBlock(state, x, y), { danger, maxDepth: 40 });
  if (toBlock) return toBlock;

  // 6) 手持ち無沙汰ならランダムに歩く
  const wander = bfs(state, cx, cy, (x, y, d) => d >= 3 + Math.floor(Math.random() * 4),
    { danger, maxDepth: 8 });
  return wander;
}

export { playerSpeed };
