// 画面遷移・ゲームループ・通信の繋ぎ込み。
import {
  createState, createViewState, step, serialize, applySnapshot,
  moveEntity, playerSpeed, randomSeed, PLAYER_COLORS, CONST,
} from './engine.js';
import { Renderer } from './render.js';
import { Input, isTouchDevice } from './input.js';
import { botInput } from './bots.js';
import { Sfx } from './audio.js';
import { Net, normalizeCode } from './net.js';

const $ = (s) => document.querySelector(s);
const FIXED = 1 / 60;
const SNAPSHOT_HZ = 20;
const INPUT_HZ = 30;

const sfx = new Sfx();
const input = new Input();
const renderer = new Renderer($('#cv'));

const App = {
  nickname: 'プレイヤー1',
  role: 'local',          // 'local' | 'host' | 'guest'
  mode: 'battle',
  localCount: 1,
  defs: [],               // [{id, name, isBot}]
  localMap: {},            // playerId -> 入力スロット番号
  state: null,
  net: null,
  remoteInputs: {},
  running: false,
  acc: 0,
  lastTs: 0,
  snapTimer: 0,
  inputTimer: 0,
  lastSentBs: -1,
  hudTimer: 0,
  pred: null,
  overlayShown: false,
  fillBots: true,
};

// ------------------------------------------------------------------ 画面
function showScreen(name) {
  for (const id of ['title', 'help', 'lobby', 'game']) {
    $('#screen-' + id).classList.toggle('hidden', id !== name);
  }
  const wantTouch = isTouchDevice() || window.innerWidth < 760;
  $('#touch').classList.toggle('hidden', !(name === 'game' && wantTouch));
}

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ------------------------------------------------------------------ 起動
function boot() {
  const saved = localStorage.getItem('bb.name');
  if (saved) App.nickname = saved;
  $('#nickname').value = App.nickname;
  $('#nickname').addEventListener('input', (e) => {
    App.nickname = e.target.value.trim().slice(0, 10) || 'プレイヤー1';
    localStorage.setItem('bb.name', App.nickname);
  });

  input.bindTouch($('#pad'), $('#btn-bomb'));
  input.onFirstInteract = () => sfx.unlock();
  document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    sfx.unlock();
    sfx.play('click');
    handleAction(btn.dataset.act);
  });

  $('#screen-lobby').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    $('#screen-lobby').querySelectorAll('.seg').forEach((s) => s.classList.remove('active'));
    seg.classList.add('active');
    App.mode = seg.dataset.mode;
    if (App.role === 'host') pushLobby();
  });

  $('#btn-start').addEventListener('click', () => {
    sfx.play('click');
    hostStart();
  });
  $('#fill-bots').addEventListener('change', (e) => { App.fillBots = e.target.checked; });
  $('#room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAction('do-join');
  });

  window.addEventListener('beforeunload', () => { if (App.net) App.net.close(); });

  const roomParam = normalizeCode(new URLSearchParams(location.search).get('room'));
  if (roomParam) {
    openJoin();
    $('#room-input').value = roomParam;
    toast('招待リンクからの参加です。名前を確認して「参加する」を押してください');
  }

  requestAnimationFrame(frame);
}

function handleAction(act) {
  switch (act) {
    case 'solo':
      startLocal('battle', 1, 4);
      break;
    case 'local2':
      startLocal('battle', 2, 4);
      break;
    case 'coop-local':
      startLocal('coop', 1, 2);
      break;
    case 'host':
      openHost();
      break;
    case 'join':
      openJoin();
      break;
    case 'do-join':
      doJoin();
      break;
    case 'help':
      showScreen('help');
      break;
    case 'back-title':
      showScreen('title');
      break;
    case 'copy-link':
      copyInvite();
      break;
    case 'leave-lobby':
      leaveAll();
      break;
    case 'quit':
      leaveAll();
      break;
    case 'again':
      restart();
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ ローカル開始
function startLocal(mode, humans, total) {
  App.role = 'local';
  App.mode = mode;
  App.localCount = humans;
  input.setLocalCount(humans);
  const defs = [];
  for (let i = 0; i < humans; i++) {
    defs.push({ id: 'L' + i, name: humans === 1 ? App.nickname : `${App.nickname}${i ? ' 2P' : ' 1P'}`, isBot: false });
  }
  for (let i = humans; i < total; i++) defs.push({ id: 'B' + i, name: 'CPU ' + (i - humans + 1), isBot: true });
  App.defs = defs;
  App.localMap = {};
  for (let i = 0; i < humans; i++) App.localMap[defs[i].id] = i;
  beginGame(randomSeed());
}

// ------------------------------------------------------------------ ロビー（ホスト）
async function openHost() {
  App.role = 'host';
  App.mode = $('#screen-lobby').querySelector('.seg.active').dataset.mode || 'battle';
  App.localCount = 1;
  input.setLocalCount(1);
  showScreen('lobby');
  $('#lobby-title').textContent = 'ルームを作成中…';
  $('#host-box').classList.add('hidden');
  $('#join-box').classList.add('hidden');
  $('#btn-start').classList.add('hidden');
  $('#lobby-status').textContent = 'サーバーに接続しています…';
  renderPlayerList([]);

  App.net = new Net();
  wireHostNet();
  try {
    const code = await App.net.host();
    $('#lobby-title').textContent = 'あなたがホストです';
    $('#host-box').classList.remove('hidden');
    $('#btn-start').classList.remove('hidden');
    $('#room-code').textContent = code;
    $('#lobby-status').textContent = 'コードを友達に送って、参加を待ちましょう。';
    App.defs = [{ id: 'host', name: App.nickname, isBot: false }];
    App.localMap = { host: 0 };
    renderPlayerList(App.defs);
  } catch (err) {
    $('#lobby-status').textContent = 'エラー: ' + (err.message || 'ルームを作れませんでした');
    $('#lobby-title').textContent = 'ルーム作成に失敗';
  }
}

function wireHostNet() {
  const net = App.net;
  net.on.join = (id) => {
    $('#lobby-status').textContent = '参加者が接続しました。';
  };
  net.on.leave = (id) => {
    const def = App.defs.find((d) => d.id === id);
    if (!def) return;
    if (App.running) {
      def.isBot = true;
      const p = App.state.players.find((q) => q.id === id);
      if (p) p.isBot = true;
      toast(`${def.name} が切断。CPUが引き継ぎます`);
      App.net.broadcast({ t: 'defs', defs: App.defs });
    } else {
      App.defs = App.defs.filter((d) => d.id !== id);
      renderPlayerList(App.defs);
      pushLobby();
    }
  };
  net.on.data = (id, msg) => hostOnData(id, msg);
  net.on.error = (err) => { if (err && err.type !== 'peer-unavailable') console.warn(err); };
}

function hostOnData(id, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'hello') {
    if (App.running) { App.net.sendTo(id, { t: 'busy' }); return; }
    if (App.defs.length >= 4) { App.net.sendTo(id, { t: 'full' }); return; }
    const name = String(msg.name || 'ゲスト').slice(0, 10);
    if (!App.defs.some((d) => d.id === id)) App.defs.push({ id, name, isBot: false });
    sfx.play('join');
    renderPlayerList(App.defs);
    pushLobby();
    return;
  }
  if (msg.t === 'in') {
    App.remoteInputs[id] = { dx: msg.dx | 0, dy: msg.dy | 0, bs: msg.bs | 0 };
  }
}

function pushLobby() {
  if (App.role !== 'host' || !App.net) return;
  App.net.broadcast({ t: 'lobby', defs: App.defs, mode: App.mode });
}

function hostStart() {
  const defs = App.defs.filter((d) => !d.gone);
  if (App.mode === 'coop' && defs.length + (App.fillBots ? 1 : 0) < 2) {
    toast('協力モードは2人以上（CPU含む）で遊べます');
  }
  const total = App.mode === 'coop' ? Math.max(2, defs.length) : 4;
  const full = defs.slice(0, 4);
  if (App.fillBots) {
    let n = 1;
    while (full.length < total) full.push({ id: 'B' + full.length, name: 'CPU ' + n++, isBot: true });
  }
  if (full.length < 2) {
    toast('もう1人の参加かCPU補充が必要です');
    return;
  }
  App.defs = full;
  App.localMap = { host: 0 };
  const seed = randomSeed();
  App.net.broadcast({ t: 'start', seed, mode: App.mode, defs: App.defs });
  beginGame(seed);
}

// ------------------------------------------------------------------ ロビー（ゲスト）
function openJoin() {
  App.role = 'guest';
  showScreen('lobby');
  $('#lobby-title').textContent = 'ルームに参加';
  $('#join-box').classList.remove('hidden');
  $('#host-box').classList.add('hidden');
  $('#btn-start').classList.add('hidden');
  $('#lobby-status').textContent = 'ホストから聞いた5文字のコードを入力してください。';
  renderPlayerList([]);
  setTimeout(() => $('#room-input').focus(), 80);
}

async function doJoin() {
  const code = normalizeCode($('#room-input').value);
  if (code.length !== 5) { toast('コードは5文字です'); return; }
  $('#lobby-status').textContent = '接続中…';
  App.role = 'guest';
  App.localCount = 1;
  input.setLocalCount(1);
  App.net = new Net();
  wireGuestNet();
  try {
    await App.net.join(code);
    App.net.sendHost({ t: 'hello', name: App.nickname });
    $('#join-box').classList.add('hidden');
    $('#lobby-title').textContent = `ルーム ${code} に参加中`;
    $('#lobby-status').textContent = 'ホストが開始するのを待っています…';
  } catch (err) {
    $('#lobby-status').textContent = 'エラー: ' + (err.message || '接続に失敗しました');
    App.net.close();
    App.net = null;
    $('#join-box').classList.remove('hidden');
  }
}

function wireGuestNet() {
  const net = App.net;
  net.on.data = (_id, msg) => guestOnData(msg);
  net.on.closed = () => {
    toast('ホストとの接続が切れました');
    endGame();
    showScreen('title');
    if (App.net) { App.net.close(); App.net = null; }
  };
  net.on.error = (err) => console.warn(err);
}

function guestOnData(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'lobby':
      App.defs = msg.defs;
      App.mode = msg.mode;
      renderPlayerList(msg.defs);
      break;
    case 'defs':
      App.defs = msg.defs;
      break;
    case 'start':
      App.defs = msg.defs;
      App.mode = msg.mode;
      App.localMap = {};
      beginGame(msg.seed);
      break;
    case 'snap':
      if (!App.state) break;
      applySnapshot(App.state, msg.s);
      onSnapshot();
      break;
    case 'full':
      toast('このルームは満員です');
      break;
    case 'busy':
      toast('このルームはゲーム中です。終わるまで待ってください');
      break;
    default:
      break;
  }
}

function renderPlayerList(defs) {
  const ul = $('#player-list');
  ul.innerHTML = '';
  const slots = 4;
  for (let i = 0; i < slots; i++) {
    const d = defs[i];
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = PLAYER_COLORS[i];
    dot.style.color = PLAYER_COLORS[i];
    li.appendChild(dot);
    const nm = document.createElement('span');
    nm.textContent = d ? d.name : '空き';
    if (!d) nm.style.color = '#6c7490';
    li.appendChild(nm);
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = !d ? '' : d.isBot ? 'CPU' : (i === 0 && App.role !== 'guest' ? 'ホスト' : '');
    li.appendChild(tag);
    ul.appendChild(li);
  }
}

function copyInvite() {
  const code = $('#room-code').textContent;
  const url = `${location.origin}${location.pathname}?room=${code}`;
  const done = () => { $('#copy-note').textContent = 'コピーしました: ' + url; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => { $('#copy-note').textContent = url; });
  } else {
    $('#copy-note').textContent = url;
  }
}

// ------------------------------------------------------------------ ゲーム開始/終了
function beginGame(seed) {
  App.remoteInputs = {};
  App.overlayShown = false;
  $('#overlay').classList.add('hidden');

  if (App.role === 'guest') {
    App.state = createViewState(App.mode, App.defs);
    const me = App.net && App.net.peer ? App.net.peer.id : null;
    const mine = App.state.players.find((p) => p.id === me);
    App.localMap = mine ? { [mine.id]: 0 } : {};
    App.pred = mine ? { x: mine.x, y: mine.y, id: mine.id } : null;
  } else {
    App.state = createState({ seed, mode: App.mode, players: App.defs });
    App.pred = null;
  }

  App.running = true;
  App.acc = 0;
  App.snapTimer = 0;
  App.inputTimer = 0;
  App.lastSentBs = -1;
  showScreen('game');
  renderHud(true);
  if (isTouchDevice() || window.innerWidth < 760) toast('左のパッドで移動、右のボタンで爆弾');
}

function endGame() {
  App.running = false;
  App.state = null;
}

function restart() {
  if (App.role === 'local') {
    beginGame(randomSeed());
  } else if (App.role === 'host') {
    for (const d of App.defs) { /* 切断済みはCPUのまま */ }
    const seed = randomSeed();
    App.net.broadcast({ t: 'start', seed, mode: App.mode, defs: App.defs });
    beginGame(seed);
  }
}

function leaveAll() {
  endGame();
  if (App.net) { App.net.close(); App.net = null; }
  App.defs = [];
  App.role = 'local';
  $('#overlay').classList.add('hidden');
  showScreen('title');
}

// ------------------------------------------------------------------ メインループ
function frame(ts) {
  const dt = Math.min(0.05, (ts - App.lastTs) / 1000 || 0);
  App.lastTs = ts;

  if (App.running && App.state) {
    if (App.role === 'guest') guestUpdate(dt);
    else hostUpdate(dt);

    renderer.draw(App.state, dt, Object.keys(App.localMap));

    App.hudTimer -= dt;
    if (App.hudTimer <= 0) { App.hudTimer = 0.12; renderHud(false); }

    drainEvents();
    maybeShowResult();
  }
  requestAnimationFrame(frame);
}

function hostUpdate(dt) {
  const st = App.state;
  App.acc += dt;
  let steps = 0;
  while (App.acc >= FIXED && steps < 5) {
    App.acc -= FIXED;
    steps++;
    const inputs = {};
    for (const p of st.players) {
      const slot = App.localMap[p.id];
      if (slot !== undefined) inputs[p.id] = input.get(slot);
      else if (p.isBot) inputs[p.id] = botInput(st, p, FIXED);
      else inputs[p.id] = App.remoteInputs[p.id] || { dx: 0, dy: 0, bs: p.lastBombSeq };
    }
    step(st, inputs, FIXED);
  }

  if (App.role === 'host' && App.net) {
    App.snapTimer -= dt;
    if (App.snapTimer <= 0) {
      App.snapTimer = 1 / SNAPSHOT_HZ;
      App.net.broadcast({ t: 'snap', s: serialize(st) });
      st.events.length = 0;
    }
  }
}

function guestUpdate(dt) {
  const st = App.state;

  // 入力送信
  const myInput = input.get(0);
  App.inputTimer -= dt;
  if (App.inputTimer <= 0 || myInput.bs !== App.lastSentBs) {
    App.inputTimer = 1 / INPUT_HZ;
    App.lastSentBs = myInput.bs;
    App.net.sendHost({ t: 'in', dx: myInput.dx, dy: myInput.dy, bs: myInput.bs });
  }

  // サーバー位置へ寄せる（自分だけはローカル予測）
  const k = 1 - Math.exp(-dt * 20);
  for (const p of st.players) {
    if (p.sx === undefined) continue;
    if (App.pred && p.id === App.pred.id && p.alive) {
      const ghost = { id: p.id, x: App.pred.x, y: App.pred.y };
      moveEntity(st, ghost, myInput.dx, myInput.dy, playerSpeed(p), dt);
      App.pred.x = ghost.x + (p.sx - ghost.x) * (1 - Math.exp(-dt * 7));
      App.pred.y = ghost.y + (p.sy - ghost.y) * (1 - Math.exp(-dt * 7));
      if (Math.hypot(App.pred.x - p.sx, App.pred.y - p.sy) > 1.3) {
        App.pred.x = p.sx; App.pred.y = p.sy;
      }
      p.x = App.pred.x; p.y = App.pred.y;
    } else {
      p.x += (p.sx - p.x) * k;
      p.y += (p.sy - p.y) * k;
    }
    p.anim += p.moving ? dt : 0;
  }
  for (const e of st.enemies) {
    if (e.sx === undefined) continue;
    e.x += (e.sx - e.x) * k;
    e.y += (e.sy - e.y) * k;
  }
  for (const b of st.blasts) b.timer -= dt;
  st.time += dt;
}

function onSnapshot() {
  const st = App.state;
  if (App.pred) {
    const p = st.players.find((q) => q.id === App.pred.id);
    if (p && !p.alive) { App.pred.x = p.sx; App.pred.y = p.sy; }
  }
}

function drainEvents() {
  const st = App.state;
  if (!st.events || !st.events.length) return;
  for (const ev of st.events) {
    if (ev.k === 'over') continue;
    sfx.play(ev.k);
  }
  st.events.length = 0;
}

// ------------------------------------------------------------------ HUD / 結果
let hudBuilt = '';
function renderHud(force) {
  const st = App.state;
  if (!st) return;
  const sig = st.players.map((p) => `${p.id}:${p.alive}:${p.bombMax}:${p.power}:${p.speedLv}:${p.kills}`).join('|');
  if (force || sig !== hudBuilt) {
    hudBuilt = sig;
    const box = $('#hud-players');
    box.innerHTML = '';
    for (const p of st.players) {
      const el = document.createElement('div');
      el.className = 'pchip' + (p.alive ? '' : ' dead');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      el.appendChild(dot);
      const mine = App.localMap[p.id] !== undefined;
      if (mine) el.classList.add('me');
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = (mine ? '▶' : '') + p.name;
      el.appendChild(nm);
      const st2 = document.createElement('span');
      st2.className = 'st';
      st2.textContent = `💣${p.bombMax}🔥${p.power}👟${p.speedLv}` +
        (st.mode === 'battle' ? `⚔${p.kills}` : '');
      el.appendChild(st2);
      box.appendChild(el);
    }
  }
  const info = $('#hud-info');
  if (st.mode === 'battle') {
    const s = Math.max(0, Math.ceil(st.timeLeft));
    info.textContent = `⏱ ${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
  } else {
    info.textContent = `❤ ${st.lives}　👾 残り ${st.enemies.filter((e) => e.alive).length}`;
  }
}

function maybeShowResult() {
  const st = App.state;
  if (!st.over || App.overlayShown) return;
  if (st.overHold > 0 && App.role !== 'guest') return;
  App.overlayShown = true;

  const ov = $('#overlay');
  ov.innerHTML = '';
  const h = document.createElement('h2');
  const p = document.createElement('p');
  const mineIds = Object.keys(App.localMap);
  let win = false;

  if (st.mode === 'battle') {
    if (st.over.result === 'win') {
      const w = st.players.find((q) => q.id === st.over.winner);
      win = mineIds.includes(st.over.winner);
      h.textContent = win ? '勝ち！' : `${w ? w.name : '???'} の勝ち`;
      p.textContent = win ? '最後まで生き残りました' : 'つぎは勝とう';
    } else if (st.over.result === 'timeup') {
      h.textContent = '時間切れ';
      p.textContent = '引き分けです';
    } else {
      h.textContent = '引き分け';
      p.textContent = '全員やられました';
    }
  } else {
    win = st.over.result === 'clear';
    h.textContent = win ? 'ステージクリア！' : 'ゲームオーバー';
    p.textContent = win
      ? `クリアタイム ${st.time.toFixed(1)} 秒　残りライフ ${st.lives}`
      : '敵を全滅させられませんでした';
  }
  h.style.color = win ? '#6ee7a0' : '#ff9d6e';
  ov.appendChild(h);
  ov.appendChild(p);

  if (App.role === 'guest') {
    const note = document.createElement('p');
    note.textContent = 'ホストが「再戦」を押すと次の試合が始まります';
    ov.appendChild(note);
  } else {
    const again = document.createElement('button');
    again.className = 'btn primary';
    again.textContent = App.role === 'host' ? '再戦（全員に反映）' : 'もう一度';
    again.addEventListener('click', () => { sfx.play('click'); restart(); });
    ov.appendChild(again);
  }
  const back = document.createElement('button');
  back.className = 'btn ghost';
  back.textContent = 'タイトルへ';
  back.addEventListener('click', () => { sfx.play('click'); leaveAll(); });
  ov.appendChild(back);

  ov.classList.remove('hidden');
  sfx.play(win ? 'win' : 'lose');
}

boot();
