// 決定的なゲームシミュレーション。描画・入力・通信には一切依存しない。
// ホスト権威型なので「ホストがこのstepを回し、結果をスナップショットで配る」構造。

export const EMPTY = 0, WALL = 1, BLOCK = 2;
export const COLS = 15, ROWS = 13;

export const ITEM_FIRE = 1, ITEM_BOMB = 2, ITEM_SPEED = 3;

export const PLAYER_COLORS = ['#ff5d5d', '#5db4ff', '#6ee7a0', '#ffd25d'];
export const SPAWNS = [[1, 1], [13, 11], [13, 1], [1, 11]];

const PLAYER_R = 0.34;        // プレイヤーの半径（タイル単位）
const SPEED_BASE = 3.4;       // タイル/秒
const SPEED_STEP = 0.7;
const SPEED_MAX_LV = 4;
const BOMB_FUSE = 2.4;
const BLAST_LIFE = 0.42;
const ENEMY_SPEED = 1.9;
const RESPAWN_TIME = 2.0;
const BATTLE_TIME = 150;
const COOP_LIVES = 3;
const OVER_HOLD = 1.1;        // 決着後、演出のために回し続ける秒数

// ------------------------------------------------------------------ 乱数
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------ マップ生成
function generateMap(rng, playerCount, density) {
  const tiles = new Uint8Array(COLS * ROWS);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      if (x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1) tiles[i] = WALL;
      else if (x % 2 === 0 && y % 2 === 0) tiles[i] = WALL;
      else tiles[i] = rng() < density ? BLOCK : EMPTY;
    }
  }
  // 各スタート地点の周りは必ず動けるように空ける
  const n = Math.max(2, Math.min(4, playerCount));
  for (let s = 0; s < 4; s++) {
    if (s >= n && s >= 2) { /* 空き枠も一応空けておく（CPU補充用） */ }
    const [sx, sy] = SPAWNS[s];
    const clear = [[0, 0], [1, 0], [2, 0], [-1, 0], [-2, 0], [0, 1], [0, 2], [0, -1], [0, -2]];
    for (const [dx, dy] of clear) {
      const x = sx + dx, y = sy + dy;
      if (x <= 0 || y <= 0 || x >= COLS - 1 || y >= ROWS - 1) continue;
      const i = y * COLS + x;
      if (tiles[i] === BLOCK) tiles[i] = EMPTY;
    }
  }
  return tiles;
}

// ------------------------------------------------------------------ 状態作成
/**
 * @param {object} opts
 *   seed: number, mode: 'battle'|'coop',
 *   players: [{id, name, isBot}]
 */
export function createState(opts) {
  const seed = (opts.seed ?? randomSeed()) >>> 0;
  const rng = mulberry32(seed);
  const mode = opts.mode === 'coop' ? 'coop' : 'battle';
  const defs = opts.players.slice(0, 4);
  const tiles = generateMap(rng, defs.length, opts.density ?? 0.76);

  // ブロックの下にアイテムを仕込む
  const hidden = new Uint8Array(COLS * ROWS);
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === BLOCK && rng() < 0.34) {
      const r = rng();
      hidden[i] = r < 0.44 ? ITEM_FIRE : r < 0.84 ? ITEM_BOMB : ITEM_SPEED;
    }
  }

  const players = defs.map((d, slot) => ({
    id: d.id,
    name: d.name || `P${slot + 1}`,
    slot,
    color: PLAYER_COLORS[slot],
    isBot: !!d.isBot,
    x: SPAWNS[slot][0] + 0.5,
    y: SPAWNS[slot][1] + 0.5,
    dir: 2,
    alive: true,
    bombMax: 1,
    power: 1,
    speedLv: 0,
    bombsOut: 0,
    respawn: 0,
    kills: 0,
    anim: 0,
    invuln: 0,
    lastBombSeq: 0,
  }));

  const state = {
    seed, mode, cols: COLS, rows: ROWS,
    tiles, hidden,
    players,
    bombs: [],
    blasts: [],
    items: [],
    enemies: [],
    fire: new Uint8Array(COLS * ROWS), // 爆風が乗っているタイル（1以上で危険）
    time: 0,
    timeLeft: mode === 'battle' ? BATTLE_TIME : 0,
    lives: mode === 'coop' ? COOP_LIVES : 0,
    over: null,
    overHold: 0,
    events: [],
  };

  state._rng = rng;
  if (mode === 'coop') spawnEnemies(state, rng, 4 + defs.length * 2);
  state.rngState = seed; // 以降のランダムはホストのみが使う（通信で配るので同期不要）
  return state;
}

function spawnEnemies(state, rng, count) {
  const spots = [];
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (state.tiles[y * COLS + x] !== EMPTY) continue;
      let near = false;
      for (const [sx, sy] of SPAWNS) {
        if (Math.abs(sx - x) + Math.abs(sy - y) < 5) { near = true; break; }
      }
      if (!near) spots.push([x, y]);
    }
  }
  for (let i = 0; i < count && spots.length; i++) {
    const k = Math.floor(rng() * spots.length);
    const [x, y] = spots.splice(k, 1)[0];
    state.enemies.push({
      id: i + 1, x: x + 0.5, y: y + 0.5,
      dir: Math.floor(rng() * 4), alive: true,
    });
  }
}

// ------------------------------------------------------------------ 補助
export function tileAt(state, x, y) {
  if (x < 0 || y < 0 || x >= state.cols || y >= state.rows) return WALL;
  return state.tiles[y * state.cols + x];
}

function bombAt(state, x, y) {
  for (const b of state.bombs) if (!b.dead && b.x === x && b.y === y) return b;
  return null;
}

function solidFor(state, x, y, who) {
  const t = tileAt(state, x, y);
  if (t === WALL || t === BLOCK) return true;
  const b = bombAt(state, x, y);
  if (b && !(who && b.pass.includes(who.id))) return true;
  return false;
}

function blocked(state, who, x, y, r) {
  const minX = Math.floor(x - r), maxX = Math.floor(x + r);
  const minY = Math.floor(y - r), maxY = Math.floor(y + r);
  for (let ty = minY; ty <= maxY; ty++)
    for (let tx = minX; tx <= maxX; tx++)
      if (solidFor(state, tx, ty, who)) return true;
  return false;
}

/** エンティティを移動させる（軸分離＋コーナー補正）。guest側の予測でも使う。 */
export function moveEntity(state, e, dx, dy, speed, dt, r = PLAYER_R) {
  if (dx === 0 && dy === 0) return false;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const step = speed * dt;
  let moved = false;

  // X方向
  if (dx !== 0) {
    const nx = e.x + dx * step;
    if (!blocked(state, e, nx, e.y, r)) { e.x = nx; moved = true; }
    else if (dy === 0) {
      // 通路の中心からズレて引っかかっている場合は寄せてあげる
      const cy = Math.floor(e.y) + 0.5;
      const pull = Math.sign(cy - e.y) * Math.min(Math.abs(cy - e.y), step);
      if (pull !== 0 && !blocked(state, e, e.x, e.y + pull, r)) { e.y += pull; moved = true; }
    }
  }
  // Y方向
  if (dy !== 0) {
    const ny = e.y + dy * step;
    if (!blocked(state, e, e.x, ny, r)) { e.y = ny; moved = true; }
    else if (dx === 0) {
      const cx = Math.floor(e.x) + 0.5;
      const pull = Math.sign(cx - e.x) * Math.min(Math.abs(cx - e.x), step);
      if (pull !== 0 && !blocked(state, e, e.x + pull, e.y, r)) { e.x += pull; moved = true; }
    }
  }
  return moved;
}

export function playerSpeed(p) {
  return SPEED_BASE + SPEED_STEP * Math.min(p.speedLv, SPEED_MAX_LV);
}

// ------------------------------------------------------------------ 爆発処理
function destroyBlock(state, x, y, destroyed) {
  const i = y * state.cols + x;
  state.tiles[i] = EMPTY;
  destroyed.add(i);
  if (state.hidden[i]) {
    state.items.push({ x, y, k: state.hidden[i] });
    state.hidden[i] = 0;
  }
}

function detonate(state, bomb) {
  bomb.dead = true;
  const owner = state.players.find((p) => p.id === bomb.owner);
  if (owner) owner.bombsOut = Math.max(0, owner.bombsOut - 1);

  const hit = [[bomb.x, bomb.y]];
  const destroyed = new Set();
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of dirs) {
    for (let i = 1; i <= bomb.power; i++) {
      const tx = bomb.x + dx * i, ty = bomb.y + dy * i;
      const t = tileAt(state, tx, ty);
      if (t === WALL) break;
      hit.push([tx, ty]);
      if (t === BLOCK) { destroyBlock(state, tx, ty, destroyed); break; }
    }
  }

  state.blasts.push({ tiles: hit, timer: BLAST_LIFE, life: BLAST_LIFE, owner: bomb.owner });
  state.events.push({ k: 'boom' });

  for (const [tx, ty] of hit) {
    // 誘爆
    const other = bombAt(state, tx, ty);
    if (other && other !== bomb && !other.dead) other.timer = 0;
    // 爆風でアイテムは消える（ただしこの爆発で出たばかりのものは残す）
    if (!destroyed.has(ty * state.cols + tx)) {
      const ii = state.items.findIndex((it) => it.x === tx && it.y === ty);
      if (ii >= 0) state.items.splice(ii, 1);
    }
  }
}

function rebuildFire(state) {
  state.fire.fill(0);
  for (const b of state.blasts) {
    for (const [x, y] of b.tiles) {
      if (x < 0 || y < 0 || x >= state.cols || y >= state.rows) continue;
      state.fire[y * state.cols + x] = 1;
    }
  }
}

// ------------------------------------------------------------------ 1ステップ
/**
 * @param {object} state
 * @param {Record<string,{dx:number,dy:number,bs:number}>} inputs プレイヤーIDごとの入力
 * @param {number} dt 固定ステップ（1/60想定）
 */
export function step(state, inputs, dt) {
  if (state.over && state.overHold <= 0) return;
  state.time += dt;
  if (state.over) state.overHold -= dt;

  if (!state.over && state.mode === 'battle') {
    state.timeLeft = Math.max(0, state.timeLeft - dt);
  }

  // --- プレイヤー ---
  for (const p of state.players) {
    if (!p.alive) {
      if (p.respawn > 0) {
        p.respawn -= dt;
        if (p.respawn <= 0) {
          p.alive = true;
          p.x = SPAWNS[p.slot][0] + 0.5;
          p.y = SPAWNS[p.slot][1] + 0.5;
          p.invuln = 1.2;
        }
      }
      continue;
    }
    if (p.invuln > 0) p.invuln -= dt;

    const inp = inputs[p.id] || { dx: 0, dy: 0, bs: p.lastBombSeq };
    let dx = Math.max(-1, Math.min(1, inp.dx || 0));
    let dy = Math.max(-1, Math.min(1, inp.dy || 0));
    // 斜めは入れず、入力が強い方を優先（グリッドゲームらしく）
    if (dx !== 0 && dy !== 0) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0;
    }
    // 爆弾設置（bombSeqの増加で判定＝通信でも取りこぼさない）
    const seq = inp.bs | 0;
    if (seq > p.lastBombSeq) {
      p.lastBombSeq = seq;
      placeBomb(state, p);
    }

    if (dx !== 0 || dy !== 0) {
      p.dir = dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0;
      const moved = moveEntity(state, p, dx, dy, playerSpeed(p), dt);
      p.anim += moved ? dt : 0;
      p.moving = moved;
    } else {
      p.moving = false;
    }

    // アイテム取得
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    for (let i = state.items.length - 1; i >= 0; i--) {
      const it = state.items[i];
      if (it.x === tx && it.y === ty) {
        if (it.k === ITEM_FIRE) p.power = Math.min(8, p.power + 1);
        else if (it.k === ITEM_BOMB) p.bombMax = Math.min(8, p.bombMax + 1);
        else p.speedLv = Math.min(SPEED_MAX_LV, p.speedLv + 1);
        state.items.splice(i, 1);
        state.events.push({ k: 'item' });
      }
    }
  }

  // --- 爆弾 ---
  for (const b of state.bombs) {
    if (b.dead) continue;
    b.timer -= dt;
    // 爆弾から完全に離れるまではすり抜けを許す（置いた直後に挟まらないように）
    if (b.pass.length) {
      b.pass = b.pass.filter((id) => {
        const p = state.players.find((q) => q.id === id);
        if (!p || !p.alive) return false;
        return p.x + PLAYER_R > b.x && p.x - PLAYER_R < b.x + 1 &&
               p.y + PLAYER_R > b.y && p.y - PLAYER_R < b.y + 1;
      });
    }
  }
  let guard = 0;
  while (guard++ < 64) {
    const b = state.bombs.find((q) => !q.dead && q.timer <= 0);
    if (!b) break;
    detonate(state, b);
  }
  state.bombs = state.bombs.filter((b) => !b.dead);

  // --- 爆風 ---
  for (const b of state.blasts) b.timer -= dt;
  state.blasts = state.blasts.filter((b) => b.timer > 0);
  rebuildFire(state);

  // --- 敵（協力モード） ---
  for (const e of state.enemies) {
    if (!e.alive) continue;
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    let [dx, dy] = dirs[e.dir];
    const moved = moveEntity(state, e, dx, dy, ENEMY_SPEED, dt, 0.32);
    const atCenter = Math.abs(e.x - (Math.floor(e.x) + 0.5)) < 0.08 &&
                     Math.abs(e.y - (Math.floor(e.y) + 0.5)) < 0.08;
    if (!moved || (atCenter && state._rng() < 0.02)) {
      const cx = Math.floor(e.x), cy = Math.floor(e.y);
      const open = [];
      for (let d = 0; d < 4; d++) {
        const [ax, ay] = dirs[d];
        if (!solidFor(state, cx + ax, cy + ay, null)) open.push(d);
      }
      if (open.length) e.dir = open[Math.floor(state._rng() * open.length)];
      else e.dir = (e.dir + 2) % 4;
      // 通路の中心に寄せる（詰まり防止）
      if (!moved) { e.x = cx + 0.5; e.y = cy + 0.5; }
    }
  }

  // --- ダメージ判定 ---
  for (const e of state.enemies) {
    if (!e.alive) continue;
    if (state.fire[Math.floor(e.y) * state.cols + Math.floor(e.x)]) {
      e.alive = false;
      state.events.push({ k: 'enemyDie' });
    }
  }
  state.enemies = state.enemies.filter((e) => e.alive);

  for (const p of state.players) {
    if (!p.alive || p.invuln > 0) continue;
    const i = Math.floor(p.y) * state.cols + Math.floor(p.x);
    let dead = state.fire[i] === 1;
    if (!dead) {
      for (const e of state.enemies) {
        if (!e.alive) continue;
        if (Math.hypot(e.x - p.x, e.y - p.y) < 0.62) { dead = true; break; }
      }
    }
    if (dead) killPlayer(state, p);
  }

  checkEnd(state);
}

function placeBomb(state, p) {
  const x = Math.floor(p.x), y = Math.floor(p.y);
  if (p.bombsOut >= p.bombMax) return;
  if (bombAt(state, x, y)) return;
  if (tileAt(state, x, y) !== EMPTY) return;
  state.bombs.push({
    x, y, owner: p.id, power: p.power,
    timer: BOMB_FUSE, fuse: BOMB_FUSE, pass: [p.id], dead: false,
  });
  p.bombsOut++;
  state.events.push({ k: 'place' });
}

function killPlayer(state, p) {
  p.alive = false;
  p.moving = false;
  state.events.push({ k: 'die', slot: p.slot });
  // キルの手柄（自爆は加点しない）
  const i = Math.floor(p.y) * state.cols + Math.floor(p.x);
  if (state.fire[i]) {
    const b = state.blasts.find((bl) =>
      bl.tiles.some(([x, y]) => x === Math.floor(p.x) && y === Math.floor(p.y)));
    if (b && b.owner !== p.id) {
      const k = state.players.find((q) => q.id === b.owner);
      if (k) k.kills++;
    }
  }
  if (state.mode === 'coop') {
    state.lives = Math.max(0, state.lives - 1);
    if (state.lives > 0) p.respawn = RESPAWN_TIME;
  }
}

function checkEnd(state) {
  if (state.over) return;
  if (state.mode === 'battle') {
    const alive = state.players.filter((p) => p.alive);
    if (alive.length === 1 && state.players.length > 1) {
      state.over = { result: 'win', winner: alive[0].id };
    } else if (alive.length === 0) {
      state.over = { result: 'draw', winner: null };
    } else if (state.timeLeft <= 0) {
      state.over = { result: 'timeup', winner: null };
    }
  } else {
    const enemiesLeft = state.enemies.filter((e) => e.alive).length;
    if (enemiesLeft === 0) {
      state.over = { result: 'clear', winner: null };
    } else if (state.lives <= 0 && state.players.every((p) => !p.alive)) {
      state.over = { result: 'gameover', winner: null };
    }
  }
  if (state.over) {
    state.overHold = OVER_HOLD;
    state.events.push({ k: 'over', result: state.over.result });
  }
}

// ------------------------------------------------------------------ 通信用スナップショット
export function serialize(state) {
  return {
    t: +state.time.toFixed(2),
    tl: +state.timeLeft.toFixed(1),
    lv: state.lives,
    tiles: Array.from(state.tiles).join(''),
    ps: state.players.map((p) => ({
      i: p.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), d: p.dir,
      a: p.alive ? 1 : 0, bm: p.bombMax, pw: p.power, sp: p.speedLv,
      bo: p.bombsOut, k: p.kills, rs: +(p.respawn || 0).toFixed(2),
      iv: p.invuln > 0 ? 1 : 0, mv: p.moving ? 1 : 0,
    })),
    bs: state.bombs.map((b) => ({ x: b.x, y: b.y, t: +b.timer.toFixed(2), p: b.power })),
    bl: state.blasts.map((b) => ({ t: +b.timer.toFixed(2), l: b.life, ts: b.tiles.flat() })),
    it: state.items.map((i) => ({ x: i.x, y: i.y, k: i.k })),
    en: state.enemies.filter((e) => e.alive).map((e) => ({
      i: e.id, x: +e.x.toFixed(2), y: +e.y.toFixed(2), d: e.dir,
    })),
    ov: state.over,
    ev: state.events.map((e) => e.k),
  };
}

/** ゲスト側：スナップショットを state 形の入れ物に反映する */
export function applySnapshot(state, s) {
  state.time = s.t;
  state.timeLeft = s.tl;
  state.lives = s.lv;
  for (let i = 0; i < s.tiles.length; i++) state.tiles[i] = s.tiles.charCodeAt(i) - 48;
  for (const ps of s.ps) {
    const p = state.players.find((q) => q.id === ps.i);
    if (!p) continue;
    p.sx = ps.x; p.sy = ps.y;      // サーバー位置（補間用）
    if (p.x === undefined) { p.x = ps.x; p.y = ps.y; }
    p.dir = ps.d; p.alive = !!ps.a;
    p.bombMax = ps.bm; p.power = ps.pw; p.speedLv = ps.sp;
    p.bombsOut = ps.bo; p.kills = ps.k; p.respawn = ps.rs;
    p.invuln = ps.iv ? 1 : 0; p.moving = !!ps.mv;
  }
  state.bombs = s.bs.map((b) => ({ x: b.x, y: b.y, timer: b.t, fuse: BOMB_FUSE, power: b.p, pass: [] }));
  state.blasts = s.bl.map((b) => {
    const tiles = [];
    for (let i = 0; i < b.ts.length; i += 2) tiles.push([b.ts[i], b.ts[i + 1]]);
    return { tiles, timer: b.t, life: b.l };
  });
  state.items = s.it.map((i) => ({ x: i.x, y: i.y, k: i.k }));
  const prev = new Map(state.enemies.map((e) => [e.id, e]));
  state.enemies = s.en.map((e) => {
    const old = prev.get(e.i);
    return { id: e.i, x: old ? old.x : e.x, y: old ? old.y : e.y, sx: e.x, sy: e.y, dir: e.d, alive: true };
  });
  state.over = s.ov;
  state.events = (s.ev || []).map((k) => ({ k }));
  rebuildFire(state);
}

/** ゲスト側の描画用に、プレイヤー定義だけ持った空の state を作る */
export function createViewState(mode, playerDefs) {
  return {
    seed: 0, mode, cols: COLS, rows: ROWS,
    tiles: new Uint8Array(COLS * ROWS),
    hidden: new Uint8Array(COLS * ROWS),
    players: playerDefs.map((d, slot) => ({
      id: d.id, name: d.name, slot, color: PLAYER_COLORS[slot], isBot: !!d.isBot,
      x: SPAWNS[slot][0] + 0.5, y: SPAWNS[slot][1] + 0.5,
      dir: 2, alive: true, bombMax: 1, power: 1, speedLv: 0, bombsOut: 0,
      respawn: 0, kills: 0, anim: 0, invuln: 0, lastBombSeq: 0,
    })),
    bombs: [], blasts: [], items: [], enemies: [],
    fire: new Uint8Array(COLS * ROWS),
    time: 0, timeLeft: 0, lives: 0, over: null, overHold: 0, events: [],
  };
}

export const CONST = { PLAYER_R, BOMB_FUSE, BLAST_LIFE, BATTLE_TIME, COOP_LIVES, SPEED_MAX_LV };
