// PeerJS(WebRTC)によるP2P通信。ホストが1人、ゲストが最大3人。
// 公開サーバーはシグナリング（出会わせ役）だけに使い、ゲームのデータは端末同士で直接やり取りする。

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_PREFIX = 'bakudan-battle-';
const CONNECT_TIMEOUT = 15000;

function makeCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

export class Net {
  constructor() {
    this.role = null;       // 'host' | 'guest'
    this.peer = null;
    this.code = null;
    this.conns = new Map(); // host: connId -> DataConnection
    this.hostConn = null;   // guest: ホストへの接続
    this.on = {
      join: () => {}, leave: () => {}, data: () => {},
      error: () => {}, closed: () => {},
    };
  }

  static available() {
    return typeof window !== 'undefined' && typeof window.Peer === 'function';
  }

  // ---------------------------------------------------------------- ホスト
  host() {
    return new Promise((resolve, reject) => {
      if (!Net.available()) return reject(new Error('通信ライブラリ（PeerJS）を読み込めませんでした。ネットワーク接続を確認してページを再読み込みしてください'));
      this.role = 'host';
      let attempts = 0;

      const tryOnce = () => {
        attempts++;
        const code = makeCode();
        const peer = new window.Peer(ID_PREFIX + code, { debug: 0 });
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { peer.destroy(); } catch (_) {}
          reject(new Error('接続サーバーに届きませんでした。ネットワーク（社内/学校のWi‑Fiなど）が通信を制限している可能性があります'));
        }, CONNECT_TIMEOUT);

        peer.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.peer = peer;
          this.code = code;
          this._wireHost(peer);
          resolve(code);
        });

        peer.on('error', (err) => {
          if (settled) {
            this.on.error(err);
            return;
          }
          if (err.type === 'unavailable-id' && attempts < 5) {
            clearTimeout(timer);
            settled = true;
            try { peer.destroy(); } catch (_) {}
            tryOnce();
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
      };
      tryOnce();
    });
  }

  _wireHost(peer) {
    peer.on('connection', (conn) => {
      if (this.conns.size >= 3) {
        conn.on('open', () => {
          conn.send({ t: 'full' });
          setTimeout(() => conn.close(), 300);
        });
        return;
      }
      conn.on('open', () => {
        this.conns.set(conn.peer, conn);
        this.on.join(conn.peer);
      });
      conn.on('data', (msg) => this.on.data(conn.peer, msg));
      conn.on('close', () => {
        this.conns.delete(conn.peer);
        this.on.leave(conn.peer);
      });
      conn.on('error', () => {
        this.conns.delete(conn.peer);
        this.on.leave(conn.peer);
      });
    });
    peer.on('disconnected', () => {
      // シグナリングが切れてもP2Pは生きている。再接続だけ試す。
      try { peer.reconnect(); } catch (_) {}
    });
  }

  // ---------------------------------------------------------------- ゲスト
  join(code) {
    return new Promise((resolve, reject) => {
      if (!Net.available()) return reject(new Error('通信ライブラリ（PeerJS）を読み込めませんでした。ネットワーク接続を確認してページを再読み込みしてください'));
      this.role = 'guest';
      this.code = code;
      const peer = new window.Peer({ debug: 0 });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { peer.destroy(); } catch (_) {}
        reject(new Error('ルームに接続できませんでした。コードを確認してください'));
      }, CONNECT_TIMEOUT);

      peer.on('open', () => {
        const conn = peer.connect(ID_PREFIX + code, { reliable: true });
        conn.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.peer = peer;
          this.hostConn = conn;
          resolve(conn);
        });
        conn.on('data', (msg) => this.on.data('host', msg));
        conn.on('close', () => this.on.closed());
        conn.on('error', (err) => {
          if (!settled) { settled = true; clearTimeout(timer); reject(err); }
          else this.on.error(err);
        });
      });

      peer.on('error', (err) => {
        if (settled) { this.on.error(err); return; }
        settled = true;
        clearTimeout(timer);
        const msg = err.type === 'peer-unavailable'
          ? new Error('そのルームコードは見つかりませんでした')
          : err;
        reject(msg);
      });
    });
  }

  // ---------------------------------------------------------------- 送信
  broadcast(msg) {
    for (const conn of this.conns.values()) {
      if (conn.open) { try { conn.send(msg); } catch (_) {} }
    }
  }

  sendTo(id, msg) {
    const conn = this.conns.get(id);
    if (conn && conn.open) { try { conn.send(msg); } catch (_) {} }
  }

  sendHost(msg) {
    if (this.hostConn && this.hostConn.open) {
      try { this.hostConn.send(msg); } catch (_) {}
    }
  }

  close() {
    try {
      for (const c of this.conns.values()) c.close();
    } catch (_) {}
    this.conns.clear();
    try { if (this.hostConn) this.hostConn.close(); } catch (_) {}
    this.hostConn = null;
    try { if (this.peer) this.peer.destroy(); } catch (_) {}
    this.peer = null;
    this.role = null;
    this.code = null;
  }
}

export { makeCode };
