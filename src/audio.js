// 効果音はWebAudioで合成する（音声ファイル不要）。
export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.3;
    this.master.connect(this.ctx.destination);
  }

  _tone({ freq = 440, to = freq, type = 'square', dur = 0.12, gain = 0.5, delay = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  _noise({ dur = 0.3, gain = 0.5, cutoff = 900, delay = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff * 2.2, t0);
    lp.frequency.exponentialRampToValueAtTime(cutoff * 0.3, t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t0);
  }

  play(kind) {
    if (!this.enabled || !this.ctx) return;
    switch (kind) {
      case 'place':
        this._tone({ freq: 220, to: 120, type: 'triangle', dur: 0.1, gain: 0.3 });
        break;
      case 'boom':
        this._noise({ dur: 0.42, gain: 0.55, cutoff: 700 });
        this._tone({ freq: 90, to: 40, type: 'sawtooth', dur: 0.3, gain: 0.3 });
        break;
      case 'item':
        this._tone({ freq: 660, type: 'square', dur: 0.07, gain: 0.25 });
        this._tone({ freq: 990, type: 'square', dur: 0.09, gain: 0.25, delay: 0.07 });
        break;
      case 'die':
        this._tone({ freq: 400, to: 60, type: 'sawtooth', dur: 0.5, gain: 0.3 });
        break;
      case 'enemyDie':
        this._tone({ freq: 500, to: 180, type: 'square', dur: 0.14, gain: 0.2 });
        break;
      case 'win':
        [523, 659, 784, 1046].forEach((f, i) =>
          this._tone({ freq: f, type: 'square', dur: 0.16, gain: 0.26, delay: i * 0.1 }));
        break;
      case 'lose':
        [392, 330, 262, 196].forEach((f, i) =>
          this._tone({ freq: f, type: 'triangle', dur: 0.22, gain: 0.26, delay: i * 0.13 }));
        break;
      case 'click':
        this._tone({ freq: 880, type: 'square', dur: 0.04, gain: 0.14 });
        break;
      case 'join':
        this._tone({ freq: 600, to: 900, type: 'square', dur: 0.12, gain: 0.2 });
        break;
      default:
        break;
    }
  }
}
