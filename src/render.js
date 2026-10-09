// Canvas 2D 描画。画像ファイルは使わず、すべて図形で描く。
import { EMPTY, WALL, BLOCK, ITEM_FIRE, ITEM_BOMB, ITEM_SPEED } from './engine.js';

const T = 32; // 1タイルの内部ピクセル

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.shake = 0;
    this.prevBlasts = 0;
  }

  resize(state) {
    const rect = this.cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (this.cv.width !== w || this.cv.height !== h) {
      this.cv.width = w;
      this.cv.height = h;
    }
    const boardW = state.cols * T, boardH = state.rows * T;
    this.scale = Math.min(w / boardW, h / boardH);
    this.ox = (w - boardW * this.scale) / 2;
    this.oy = (h - boardH * this.scale) / 2;
  }

  draw(state, dt, localIds = []) {
    const ctx = this.ctx;
    this.resize(state);

    if (state.blasts.length > this.prevBlasts) this.shake = Math.min(6, this.shake + 3);
    this.prevBlasts = state.blasts.length;
    this.shake = Math.max(0, this.shake - dt * 22);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    const sx = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    ctx.setTransform(this.scale, 0, 0, this.scale, this.ox + sx, this.oy + sy);

    this.drawField(state);
    this.drawItems(state);
    this.drawBombs(state);
    this.drawEnemies(state);
    this.drawPlayers(state, localIds);
    this.drawBlasts(state);
  }

  drawField(state) {
    const ctx = this.ctx;
    ctx.fillStyle = '#242a3c';
    ctx.fillRect(0, 0, state.cols * T, state.rows * T);
    for (let y = 0; y < state.rows; y++) {
      for (let x = 0; x < state.cols; x++) {
        const t = state.tiles[y * state.cols + x];
        const px = x * T, py = y * T;
        if (t === EMPTY) {
          ctx.fillStyle = (x + y) % 2 ? '#2b3249' : '#2f3650';
          ctx.fillRect(px, py, T, T);
        } else if (t === WALL) {
          ctx.fillStyle = '#4b5574';
          ctx.fillRect(px, py, T, T);
          ctx.fillStyle = '#5d6890';
          ctx.fillRect(px + 2, py + 2, T - 4, T - 7);
          ctx.fillStyle = '#39405a';
          ctx.fillRect(px + 2, py + T - 6, T - 4, 4);
        } else {
          // 壊せるブロック
          ctx.fillStyle = '#8a5a3c';
          ctx.fillRect(px + 1, py + 1, T - 2, T - 2);
          ctx.fillStyle = '#a16c47';
          ctx.fillRect(px + 2, py + 2, T - 4, 12);
          ctx.fillStyle = '#6d452d';
          ctx.fillRect(px + 2, py + 16, T - 4, 13);
          ctx.fillStyle = '#5a3824';
          ctx.fillRect(px + 2, py + 15, T - 4, 2);
          ctx.fillRect(px + 14, py + 2, 2, 13);
          ctx.fillRect(px + 7, py + 17, 2, 12);
          ctx.fillRect(px + 22, py + 17, 2, 12);
        }
      }
    }
  }

  drawItems(state) {
    const ctx = this.ctx;
    const pulse = 1 + Math.sin(state.time * 6) * 0.06;
    for (const it of state.items) {
      const cx = it.x * T + T / 2, cy = it.y * T + T / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = '#121622';
      roundRect(ctx, -11, -11, 22, 22, 6);
      ctx.fill();
      if (it.k === ITEM_FIRE) {
        ctx.fillStyle = '#ff8a4c';
        ctx.beginPath();
        ctx.moveTo(0, -9); ctx.quadraticCurveTo(7, -1, 4, 6);
        ctx.quadraticCurveTo(0, 10, -4, 6); ctx.quadraticCurveTo(-7, -1, 0, -9);
        ctx.fill();
        ctx.fillStyle = '#ffd98a';
        ctx.beginPath(); ctx.ellipse(0, 3, 2.5, 4, 0, 0, 7); ctx.fill();
      } else if (it.k === ITEM_BOMB) {
        ctx.fillStyle = '#cfd6ea';
        ctx.beginPath(); ctx.arc(0, 2, 7, 0, 7); ctx.fill();
        ctx.strokeStyle = '#cfd6ea'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(3, -4); ctx.lineTo(6, -9); ctx.stroke();
      } else {
        ctx.fillStyle = '#6ee7a0';
        ctx.beginPath();
        ctx.moveTo(-5, -9); ctx.lineTo(6, -2); ctx.lineTo(0, -1);
        ctx.lineTo(5, 9); ctx.lineTo(-6, 1); ctx.lineTo(0, 0);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
  }

  drawBombs(state) {
    const ctx = this.ctx;
    for (const b of state.bombs) {
      const prog = 1 - b.timer / (b.fuse || 2.4);
      const beat = 1 + Math.sin(prog * Math.PI * 14) * 0.1 * (0.4 + prog);
      const cx = b.x * T + T / 2, cy = b.y * T + T / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(beat, 2 - beat);
      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.beginPath(); ctx.ellipse(0, 11, 11, 4, 0, 0, 7); ctx.fill();
      ctx.fillStyle = prog > 0.82 ? '#6b2222' : '#20242f';
      ctx.beginPath(); ctx.arc(0, 1, 11, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.beginPath(); ctx.arc(-4, -3, 3.4, 0, 7); ctx.fill();
      ctx.strokeStyle = '#8b6b3d'; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(4, -8); ctx.quadraticCurveTo(10, -13, 7, -16); ctx.stroke();
      const spark = 2 + Math.random() * 2.2;
      ctx.fillStyle = prog > 0.5 ? '#ffd25d' : '#ff9d3d';
      ctx.beginPath(); ctx.arc(7, -17, spark, 0, 7); ctx.fill();
      ctx.restore();
    }
  }

  drawBlasts(state) {
    const ctx = this.ctx;
    for (const b of state.blasts) {
      const k = b.timer / (b.life || 0.42);     // 1 → 0
      const a = Math.min(1, k * 1.5);
      const r = (0.55 + (1 - k) * 0.45) * T * 0.5;
      for (const [x, y] of b.tiles) {
        const cx = x * T + T / 2, cy = y * T + T / 2;
        const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, r * 1.5);
        g.addColorStop(0, `rgba(255,255,230,${a})`);
        g.addColorStop(0.45, `rgba(255,186,61,${a * 0.9})`);
        g.addColorStop(1, `rgba(214,54,31,0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r * 1.5, 0, 7); ctx.fill();
      }
    }
  }

  drawEnemies(state) {
    const ctx = this.ctx;
    for (const e of state.enemies) {
      if (!e.alive) continue;
      const cx = e.x * T, cy = e.y * T;
      const wob = Math.sin(state.time * 9 + e.id) * 1.6;
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.beginPath(); ctx.ellipse(cx, cy + 10, 10, 3.5, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#9d6bff';
      ctx.beginPath();
      ctx.ellipse(cx, cy + wob * 0.3, 11, 10 - wob * 0.3, 0, 0, 7);
      ctx.fill();
      ctx.fillStyle = '#c8a9ff';
      ctx.beginPath(); ctx.ellipse(cx - 3, cy - 4, 3.4, 2.6, -0.3, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cx - 3.6, cy, 3, 0, 7); ctx.arc(cx + 3.6, cy, 3, 0, 7); ctx.fill();
      ctx.fillStyle = '#1a1024';
      ctx.beginPath(); ctx.arc(cx - 3.6, cy + 0.6, 1.5, 0, 7); ctx.arc(cx + 3.6, cy + 0.6, 1.5, 0, 7); ctx.fill();
    }
  }

  drawPlayers(state, localIds) {
    const ctx = this.ctx;
    const sorted = [...state.players].sort((a, b) => a.y - b.y);
    for (const p of sorted) {
      if (!p.alive) {
        if (p.respawn > 0) this.drawGhost(p);
        continue;
      }
      if (p.invuln > 0 && Math.floor(state.time * 14) % 2 === 0) continue;
      const cx = p.x * T, cy = p.y * T;
      const bob = p.moving ? Math.sin(p.anim * 16) * 1.8 : 0;

      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.beginPath(); ctx.ellipse(cx, cy + 11, 10, 3.6, 0, 0, 7); ctx.fill();

      if (localIds.includes(p.id)) {
        ctx.strokeStyle = 'rgba(255,255,255,.55)';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.ellipse(cx, cy + 11, 12.5, 5, 0, 0, 7); ctx.stroke();
      }

      // 体
      ctx.fillStyle = p.color;
      roundRect(ctx, cx - 9, cy - 4 + bob, 18, 15, 6);
      ctx.fill();
      // 頭
      ctx.fillStyle = '#f6f2ea';
      ctx.beginPath(); ctx.arc(cx, cy - 8 + bob, 9, 0, 7); ctx.fill();
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(cx, cy - 11 + bob, 9, Math.PI, Math.PI * 2); ctx.fill();
      // 目（向き反映）
      const ex = p.dir === 1 ? 2.4 : p.dir === 3 ? -2.4 : 0;
      const ey = p.dir === 0 ? -1.4 : 0;
      ctx.fillStyle = '#20242f';
      if (p.dir !== 0) {
        ctx.beginPath();
        ctx.arc(cx - 3 + ex, cy - 6 + ey + bob, 1.7, 0, 7);
        ctx.arc(cx + 3 + ex, cy - 6 + ey + bob, 1.7, 0, 7);
        ctx.fill();
      }
      // 足
      ctx.fillStyle = '#20242f';
      const legs = p.moving ? Math.sin(p.anim * 16) * 2.2 : 0;
      ctx.fillRect(cx - 7, cy + 10 + legs, 5, 3);
      ctx.fillRect(cx + 2, cy + 10 - legs, 5, 3);
    }
  }

  drawGhost(p) {
    const ctx = this.ctx;
    const cx = p.x * T, cy = p.y * T - (2.0 - p.respawn) * 8;
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = '#dfe6ff';
    ctx.beginPath(); ctx.arc(cx, cy - 4, 9, Math.PI, 0); ctx.lineTo(cx + 9, cy + 6);
    for (let i = 0; i < 3; i++) ctx.lineTo(cx + 9 - i * 6 - 3, cy + (i % 2 ? 2 : 8));
    ctx.lineTo(cx - 9, cy + 6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#333a52';
    ctx.beginPath(); ctx.arc(cx - 3.2, cy - 5, 1.8, 0, 7); ctx.arc(cx + 3.2, cy - 5, 1.8, 0, 7); ctx.fill();
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export { T as TILE_PX };
