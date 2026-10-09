// キーボード（最大2人）とタッチパッドの入力をまとめる。
// 爆弾は「押した回数（bs）」で送るので、通信でフレームを取りこぼしても設置が消えない。

const KEYMAPS = [
  { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], bomb: ['Space'] },
  { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], bomb: ['Enter', 'NumpadEnter'] },
];
// 1人プレイのときは矢印キーでも動かせるようにする
const SOLO_EXTRA = { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], bomb: ['Enter', 'NumpadEnter'] };

export class Input {
  constructor() {
    this.keys = new Set();
    this.localCount = 1;
    this.slots = [newSlot(), newSlot()];
    this.touch = { dx: 0, dy: 0 };
    this.onFirstInteract = null;
    this._bindKeys();
  }

  /** ローカルで操作する人数（1 or 2）。1人なら矢印キーも1人目に割り当てる */
  setLocalCount(n) {
    this.localCount = n;
    this.slots.forEach((s) => { s.dx = 0; s.dy = 0; });
  }

  _bindKeys() {
    const isGameKey = (code) =>
      code.startsWith('Arrow') || code === 'Space' || code === 'Enter' ||
      ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code);

    window.addEventListener('keydown', (e) => {
      if (isGameKey(e.code)) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault();
        else return;
      }
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      this._fire();
      // 爆弾キーの押し始めでカウントを増やす
      for (let i = 0; i < 2; i++) {
        const map = this._mapFor(i);
        if (!map) continue;
        if (map.bomb.includes(e.code)) this.slots[i].bs++;
      }
    }, { passive: false });

    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  _mapFor(i) {
    if (i >= this.localCount) return null;
    if (this.localCount === 1 && i === 0) {
      return {
        up: [...KEYMAPS[0].up, ...SOLO_EXTRA.up],
        down: [...KEYMAPS[0].down, ...SOLO_EXTRA.down],
        left: [...KEYMAPS[0].left, ...SOLO_EXTRA.left],
        right: [...KEYMAPS[0].right, ...SOLO_EXTRA.right],
        bomb: [...KEYMAPS[0].bomb, ...SOLO_EXTRA.bomb],
      };
    }
    return KEYMAPS[i];
  }

  _fire() {
    if (this.onFirstInteract) { this.onFirstInteract(); this.onFirstInteract = null; }
  }

  /** タッチUIを配線する */
  bindTouch(root, bombBtn) {
    const pressed = new Set();
    const apply = () => {
      this.touch.dx = (pressed.has('right') ? 1 : 0) - (pressed.has('left') ? 1 : 0);
      this.touch.dy = (pressed.has('down') ? 1 : 0) - (pressed.has('up') ? 1 : 0);
    };
    root.querySelectorAll('[data-dir]').forEach((btn) => {
      const dir = btn.dataset.dir;
      const on = (e) => {
        e.preventDefault();
        pressed.add(dir); btn.classList.add('active'); apply(); this._fire();
      };
      const off = (e) => {
        e.preventDefault();
        pressed.delete(dir); btn.classList.remove('active'); apply();
      };
      btn.addEventListener('pointerdown', on);
      btn.addEventListener('pointerup', off);
      btn.addEventListener('pointercancel', off);
      btn.addEventListener('pointerleave', off);
    });
    bombBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.slots[0].bs++;
      bombBtn.classList.add('active');
      this._fire();
    });
    const up = () => bombBtn.classList.remove('active');
    bombBtn.addEventListener('pointerup', up);
    bombBtn.addEventListener('pointercancel', up);
  }

  /** スロット i（0 or 1）の現在入力 */
  get(i) {
    const s = this.slots[i];
    const map = this._mapFor(i);
    let dx = 0, dy = 0;
    if (map) {
      if (map.left.some((k) => this.keys.has(k))) dx -= 1;
      if (map.right.some((k) => this.keys.has(k))) dx += 1;
      if (map.up.some((k) => this.keys.has(k))) dy -= 1;
      if (map.down.some((k) => this.keys.has(k))) dy += 1;
    }
    if (i === 0 && (this.touch.dx || this.touch.dy)) { dx = this.touch.dx; dy = this.touch.dy; }
    return { dx, dy, bs: s.bs };
  }
}

function newSlot() { return { dx: 0, dy: 0, bs: 0 }; }

export function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches ||
    ('ontouchstart' in window && navigator.maxTouchPoints > 0);
}
