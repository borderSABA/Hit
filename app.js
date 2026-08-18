(() => {
  'use strict';

  const COLORS = ['red','blue','yellow','green','purple','orange'];
  const COLOR_NAMES = {red:'赤',blue:'青',yellow:'黄',green:'緑',purple:'紫',orange:'橙'};
  const SERVER_URL = (window.HIT_BLOW_SERVER_URL || '').replace(/\/$/, '');
  const ROOM_IDS = ['1','2','3','4'];

  const $ = (s) => document.querySelector(s);
  const els = {
    setup: $('#setupScreen'), game: $('#gameScreen'),
    modeCards: [...document.querySelectorAll('.mode-card')],
    onlineSetup: $('#onlineSetup'), playerName: $('#playerName'), roomGrid: $('#roomGrid'),
    refreshRooms: $('#refreshRoomsBtn'), resetRoom: $('#resetRoomBtn'), serverStatus: $('#serverStatus'),
    duplicate: $('#duplicateToggle'), duplicateLabel: $('#duplicateLabel'),
    start: $('#startBtn'), newGame: $('#newGameBtn'), rules: $('#rulesBtn'), leave: $('#leaveBtn'),
    modeLabel: $('#modeLabel'), turnLabel: $('#turnLabel'), guessCount: $('#guessCount'),
    onlineBar: $('#onlineBar'), onlineRoomName: $('#onlineRoomName'), connectionText: $('#connectionText'),
    playerStrip: $('#playerStrip'), onlineStart: $('#onlineStartBtn'),
    secret: $('#secretPegs'), history: $('#history'), current: $('#currentGuess'), palette: $('#palette'),
    clear: $('#clearBtn'), confirm: $('#confirmBtn'), toast: $('#toast'),
    resultOverlay: $('#resultOverlay'), resultTitle: $('#resultTitle'), resultText: $('#resultText'),
    resultKicker: $('#resultKicker'), answerReveal: $('#answerReveal'), rematch: $('#rematchBtn'), backTitle: $('#backTitleBtn'),
    rulesOverlay: $('#rulesOverlay'), closeRules: $('#closeRulesBtn')
  };

  let mode = 'online';
  let duplicateAllowed = false;
  let answer = [];
  let currentGuess = [null,null,null,null];
  let selectedSlot = 0;
  let history = [];
  let turn = 0;
  let gameOver = false;
  let cpuCandidates = [];
  let cpuThinking = false;

  let selectedRoom = '1';
  let ws = null;
  let onlineState = null;
  let mySeat = null;
  let reconnectTimer = null;
  let intentionalClose = false;
  const clientId = getOrCreateClientId();

  const modeNames = {solo:'1人で遊ぶ',local2:'2人で遊ぶ',cpu:'CPUと対戦',online:'オンライン対戦'};

  function getOrCreateClientId() {
    let id = localStorage.getItem('hitBlowClientId');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `hb-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      localStorage.setItem('hitBlowClientId', id);
    }
    return id;
  }

  function peg(color, extra='') {
    const d = document.createElement('div');
    d.className = `peg ${extra}`.trim();
    d.dataset.color = color;
    d.title = COLOR_NAMES[color] || '';
    return d;
  }

  function makeAllCodes(allowDup) {
    const out = [];
    function rec(prefix) {
      if (prefix.length === 4) { out.push(prefix.slice()); return; }
      for (const c of COLORS) {
        if (!allowDup && prefix.includes(c)) continue;
        prefix.push(c); rec(prefix); prefix.pop();
      }
    }
    rec([]);
    return out;
  }

  function randomAnswer() {
    const pool = makeAllCodes(duplicateAllowed);
    return pool[Math.floor(Math.random() * pool.length)].slice();
  }

  function scoreGuess(guess, target) {
    let hits = 0;
    const gRemain = [], tRemain = [];
    for (let i=0;i<4;i++) {
      if (guess[i] === target[i]) hits++;
      else { gRemain.push(guess[i]); tRemain.push(target[i]); }
    }
    let blows = 0;
    const counts = {};
    for (const c of tRemain) counts[c] = (counts[c] || 0) + 1;
    for (const c of gRemain) {
      if (counts[c] > 0) { blows++; counts[c]--; }
    }
    return {hits, blows};
  }

  function setMode(next) {
    mode = next;
    els.modeCards.forEach(c => c.classList.toggle('selected', c.dataset.mode === mode));
    els.onlineSetup.classList.toggle('hidden', mode !== 'online');
    els.start.textContent = mode === 'online' ? '部屋に入る' : 'ゲーム開始';
    els.resetRoom.disabled = mode !== 'online';
  }

  function startGame() {
    if (mode === 'online') {
      joinOnline();
      return;
    }
    duplicateAllowed = els.duplicate.checked;
    answer = randomAnswer();
    currentGuess = [null,null,null,null];
    selectedSlot = 0;
    history = [];
    turn = 0;
    gameOver = false;
    cpuThinking = false;
    cpuCandidates = makeAllCodes(duplicateAllowed);
    onlineState = null;
    els.resultOverlay.classList.add('hidden');
    els.setup.classList.remove('active');
    els.game.classList.add('active');
    els.onlineBar.classList.add('hidden');
    els.leave.classList.add('hidden');
    els.modeLabel.textContent = modeNames[mode];
    renderAll();
    showToast(mode === 'solo' ? '推理スタート' : 'プレイヤー1からスタート');
  }

  function backToTitle() {
    if (mode === 'online') disconnectOnline(true);
    gameOver = true;
    cpuThinking = false;
    els.resultOverlay.classList.add('hidden');
    els.game.classList.remove('active');
    els.setup.classList.add('active');
    els.leave.classList.add('hidden');
    els.onlineBar.classList.add('hidden');
    refreshRooms();
  }

  function rematch() {
    if (mode === 'online') {
      els.resultOverlay.classList.add('hidden');
      if (isOnlineHost()) sendOnline({type:'rematch'});
      else showToast('ホストの再戦開始を待っています');
      return;
    }
    startGame();
  }

  function renderAll() {
    if (mode === 'online') renderOnlineAll();
    else {
      renderSecret(); renderHistory(); renderCurrent(); renderPalette(); renderStatus();
    }
  }

  function renderSecret(reveal=false) {
    els.secret.replaceChildren();
    for (let i=0;i<4;i++) {
      els.secret.appendChild(reveal || gameOver ? peg(answer[i]) : Object.assign(document.createElement('div'),{className:'secret-cover'}));
    }
  }

  function renderCurrent() {
    els.current.replaceChildren();
    currentGuess.forEach((c,i) => {
      const slot = document.createElement('button');
      slot.className = `slot${i===selectedSlot ? ' selected':''}`;
      slot.type = 'button';
      slot.setAttribute('aria-label', `${i+1}番目の色`);
      slot.addEventListener('click', () => {
        if (!canHumanInput()) return;
        selectedSlot = i; renderCurrent();
      });
      if (c) slot.appendChild(peg(c));
      els.current.appendChild(slot);
    });
    els.confirm.disabled = !canHumanInput() || currentGuess.some(v => !v);
    els.clear.disabled = !canHumanInput();
  }

  function renderPalette() {
    els.palette.replaceChildren();
    COLORS.forEach(c => {
      const b = document.createElement('button');
      b.type='button'; b.className='color-btn'; b.title=COLOR_NAMES[c]; b.appendChild(peg(c));
      b.disabled = !canHumanInput();
      b.addEventListener('click', () => chooseColor(c));
      els.palette.appendChild(b);
    });
  }

  function chooseColor(color) {
    if (!canHumanInput()) return;
    currentGuess[selectedSlot] = color;
    const nextEmpty = currentGuess.findIndex((v,i) => i>selectedSlot && !v);
    if (nextEmpty !== -1) selectedSlot = nextEmpty;
    else {
      const anyEmpty = currentGuess.findIndex(v=>!v);
      if (anyEmpty !== -1) selectedSlot = anyEmpty;
    }
    renderCurrent();
  }

  function clearGuess() {
    if (!canHumanInput()) return;
    currentGuess = [null,null,null,null]; selectedSlot = 0; renderCurrent();
  }

  function renderHistory() {
    els.history.replaceChildren();
    [...history].reverse().forEach((h,revIndex) => {
      const actualIndex = history.length - 1 - revIndex;
      const row = document.createElement('div');
      const mine = h.seat != null ? h.seat === mySeat : h.actor !== 'CPU';
      row.className = `history-row ${mine ? 'mine' : 'cpu'}`;
      const n = document.createElement('div'); n.className='row-num'; n.textContent=`#${actualIndex+1}`;
      const guess = document.createElement('div'); guess.className='row-guess'; h.guess.forEach(c=>guess.appendChild(peg(c)));
      const result = document.createElement('div'); result.className='row-result';
      const txt = document.createElement('div'); txt.className='result-text'; txt.textContent=`${h.hits} HIT  ${h.blows} BLOW`;
      const tag = document.createElement('div'); tag.className='player-tag'; tag.textContent=h.actor || (h.seat != null ? playerNameForSeat(h.seat) : '');
      result.append(txt,tag); row.append(n,guess,result); els.history.appendChild(row);
    });
  }

  function renderStatus() {
    const used = history.length;
    els.guessCount.textContent = Math.min(used + 1, 8);
    if (gameOver) return;
    if (mode === 'solo') els.turnLabel.textContent = 'あなたの予想';
    else if (mode === 'local2') els.turnLabel.textContent = `プレイヤー${turn+1}の予想`;
    else if (mode === 'cpu') els.turnLabel.textContent = turn === 0 ? 'あなたの予想' : 'CPUが推理中…';
  }

  function canHumanInput() {
    if (gameOver || cpuThinking) return false;
    if (mode === 'cpu' && turn === 1) return false;
    if (mode === 'online') {
      return !!onlineState && onlineState.phase === 'playing' && mySeat === onlineState.turnSeat && ws && ws.readyState === WebSocket.OPEN;
    }
    return true;
  }

  function submitHumanGuess() {
    if (!canHumanInput() || currentGuess.some(v=>!v)) return;
    if (mode === 'online') {
      sendOnline({type:'guess', guess:currentGuess.slice()});
      return;
    }
    const actor = mode === 'local2' ? `P${turn+1}` : 'YOU';
    submitGuess(currentGuess.slice(), actor);
  }

  function submitGuess(guess, actor) {
    if (gameOver) return;
    const s = scoreGuess(guess, answer);
    history.push({guess:guess.slice(), hits:s.hits, blows:s.blows, actor});
    currentGuess = [null,null,null,null]; selectedSlot = 0;
    renderAll();
    showToast(s.hits === 4 ? '4 HIT！' : `${s.hits} HIT  ${s.blows} BLOW`);

    if (s.hits === 4) {
      if (mode === 'solo') finish(true, `正解です。${history.length}回で見破りました。`, 'CLEAR!');
      else if (mode === 'local2') finish(true, `${actor === 'P1' ? 'プレイヤー1' : 'プレイヤー2'}の勝利です。`, 'WINNER!');
      else finish(true, actor === 'CPU' ? 'CPUが先に答えを見破りました。' : 'あなたがCPUより先に正解しました。', actor === 'CPU' ? 'CPU WIN' : 'YOU WIN');
      return;
    }

    if (history.length >= 8) {
      finish(false, mode === 'solo' ? '8回以内に正解できませんでした。' : '8回の予想で正解者は出ませんでした。', 'GAME OVER');
      return;
    }

    if (mode === 'local2') {
      turn = 1 - turn;
      renderAll();
      showToast(`プレイヤー${turn+1}の番`);
    } else if (mode === 'cpu') {
      if (actor !== 'CPU') {
        turn = 1; renderAll(); scheduleCpuTurn();
      } else {
        turn = 0; cpuThinking = false; renderAll(); showToast('あなたの番');
      }
    }
  }

  function scheduleCpuTurn() {
    cpuThinking = true; renderCurrent(); renderPalette(); renderStatus();
    setTimeout(() => {
      if (gameOver || mode !== 'cpu') return;
      const cpuGuess = chooseCpuGuess();
      cpuThinking = false;
      submitGuess(cpuGuess, 'CPU');
    }, 850);
  }

  function chooseCpuGuess() {
    cpuCandidates = makeAllCodes(duplicateAllowed).filter(code => history.every(h => {
      const s = scoreGuess(h.guess, code);
      return s.hits === h.hits && s.blows === h.blows;
    }));
    if (cpuCandidates.length <= 2) return cpuCandidates[0].slice();
    const sample = cpuCandidates.length > 220 ? cpuCandidates.filter((_,i)=>i % Math.ceil(cpuCandidates.length/220) === 0) : cpuCandidates;
    let best = sample[0], bestScore = -Infinity;
    for (const guess of sample) {
      const buckets = new Map();
      for (const target of cpuCandidates) {
        const s = scoreGuess(guess,target); const k=`${s.hits}:${s.blows}`;
        buckets.set(k,(buckets.get(k)||0)+1);
      }
      let entropy = 0;
      for (const count of buckets.values()) { const p=count/cpuCandidates.length; entropy -= p*Math.log2(p); }
      if (cpuCandidates.some(c=>sameCode(c,guess))) entropy += .02;
      if (entropy > bestScore) { bestScore=entropy; best=guess; }
    }
    return best.slice();
  }

  function sameCode(a,b){ return a.every((v,i)=>v===b[i]); }

  function finish(success, text, title) {
    gameOver = true; cpuThinking = false; renderSecret(true); renderCurrent(); renderPalette();
    els.resultKicker.textContent = success ? 'RESULT' : 'ANSWER';
    els.resultTitle.textContent = title;
    els.resultText.textContent = text;
    els.answerReveal.replaceChildren(...answer.map(c=>peg(c)));
    setTimeout(()=>els.resultOverlay.classList.remove('hidden'), 450);
  }

  function onlineApi(path) {
    return `${SERVER_URL}${path}`;
  }

  function wsUrl(roomId, name) {
    const base = onlineApi(`/api/rooms/${encodeURIComponent(roomId)}/ws`);
    const u = new URL(base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('name', name);
    u.searchParams.set('clientId', clientId);
    return u.toString();
  }

  async function refreshRooms() {
    renderRoomGrid(null, true);
    if (!SERVER_URL) {
      els.serverStatus.textContent = 'SERVER_URL が未設定です';
      return;
    }
    try {
      const res = await fetch(onlineApi('/api/rooms'), {cache:'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderRoomGrid(data.rooms || []);
      els.serverStatus.textContent = 'サーバー接続OK';
    } catch (err) {
      renderRoomGrid([]);
      els.serverStatus.textContent = 'サーバー未接続';
    }
  }

  function renderRoomGrid(rooms, loading=false) {
    els.roomGrid.replaceChildren();
    ROOM_IDS.forEach(id => {
      const info = rooms ? rooms.find(r => String(r.id) === id) : null;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `room-card${selectedRoom===id?' selected':''}`;
      const count = info ? info.playerCount : 0;
      const status = loading ? '確認中…' : info ? (info.phase === 'playing' ? '対戦中' : info.phase === 'finished' ? '終了' : count >= 2 ? '満員' : '参加可能') : '---';
      btn.innerHTML = `<b>ROOM ${id}</b><span>${count}/2人</span><small>${status}</small>`;
      btn.addEventListener('click', () => { selectedRoom=id; renderRoomGrid(rooms, loading); });
      els.roomGrid.appendChild(btn);
    });
  }

  async function resetSelectedRoom() {
    if (!SERVER_URL || !selectedRoom) return;
    if (!confirm(`ROOM ${selectedRoom} を初期化しますか？`)) return;
    try {
      const res = await fetch(onlineApi(`/api/rooms/${selectedRoom}/reset`), {method:'POST'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(`ROOM ${selectedRoom} を初期化しました`);
      await refreshRooms();
    } catch (e) {
      showToast('部屋の初期化に失敗しました');
    }
  }

  function joinOnline() {
    const name = (els.playerName.value || '').trim().slice(0,12);
    if (!name) { showToast('名前を入力してください'); els.playerName.focus(); return; }
    if (!SERVER_URL) { showToast('SERVER_URL が未設定です'); return; }
    localStorage.setItem('hitBlowPlayerName', name);
    clearTimeout(reconnectTimer);
    if (ws) disconnectOnline(true);
    intentionalClose = false;
    els.start.disabled = true;
    els.start.textContent = '接続中…';
    try {
      ws = new WebSocket(wsUrl(selectedRoom, name));
    } catch (e) {
      els.start.disabled = false;
      els.start.textContent = '部屋に入る';
      showToast('接続URLを確認してください');
      return;
    }
    ws.addEventListener('open', () => {
      els.start.disabled = false;
      els.start.textContent = '部屋に入る';
    });
    ws.addEventListener('message', handleOnlineMessage);
    ws.addEventListener('close', handleOnlineClose);
    ws.addEventListener('error', () => {});
  }

  function handleOnlineMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'welcome') {
      mySeat = msg.seat;
      onlineState = msg.state;
      mode = 'online';
      gameOver = onlineState.phase === 'finished';
      history = onlineState.history || [];
      currentGuess = [null,null,null,null]; selectedSlot = 0;
      els.resultOverlay.classList.add('hidden');
      els.setup.classList.remove('active'); els.game.classList.add('active');
      els.leave.classList.remove('hidden'); els.onlineBar.classList.remove('hidden');
      els.modeLabel.textContent = 'オンライン対戦';
      renderAll();
      showToast(`ROOM ${selectedRoom} に参加しました`);
      return;
    }
    if (msg.type === 'seat') {
      mySeat = msg.seat;
      renderAll();
      return;
    }
    if (msg.type === 'state') {
      const oldPhase = onlineState && onlineState.phase;
      const oldLen = onlineState && onlineState.history ? onlineState.history.length : 0;
      onlineState = msg.state;
      history = onlineState.history || [];
      gameOver = onlineState.phase === 'finished';
      if (history.length > oldLen) {
        const last = history[history.length-1];
        currentGuess = [null,null,null,null]; selectedSlot = 0;
        showToast(last.hits === 4 ? '4 HIT！' : `${last.hits} HIT  ${last.blows} BLOW`);
      } else if (oldPhase !== 'playing' && onlineState.phase === 'playing') {
        els.resultOverlay.classList.add('hidden');
        currentGuess = [null,null,null,null]; selectedSlot = 0;
        showToast(`${playerNameForSeat(onlineState.turnSeat)}の番`);
      }
      renderAll();
      if (onlineState.phase === 'finished') showOnlineResult();
      return;
    }
    if (msg.type === 'error') {
      showToast(msg.message || '操作できません');
      if (msg.code === 'ROOM_FULL') disconnectOnline(true);
    }
  }

  function handleOnlineClose() {
    const wasIntentional = intentionalClose;
    ws = null;
    if (els.game.classList.contains('active') && mode === 'online') {
      els.connectionText.textContent = '再接続中…';
      renderCurrent(); renderPalette();
      if (!wasIntentional) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (mode === 'online' && els.game.classList.contains('active')) joinOnline();
        }, 1500);
      }
    }
  }

  function disconnectOnline(intentional=true) {
    intentionalClose = intentional;
    clearTimeout(reconnectTimer);
    if (ws) {
      const socket = ws;
      ws = null;
      if (intentional && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({type:'leave'})); } catch {}
        setTimeout(() => { try { socket.close(1000, 'leave'); } catch {} }, 40);
      } else {
        try { socket.close(1000, 'disconnect'); } catch {}
      }
    }
  }

  function sendOnline(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('サーバーへ再接続中です'); return; }
    ws.send(JSON.stringify(payload));
  }

  function isOnlineHost() {
    return mySeat === 0;
  }

  function playerNameForSeat(seat) {
    if (!onlineState || !onlineState.players) return `P${Number(seat)+1}`;
    const p = onlineState.players.find(x => x.seat === seat);
    return p ? p.name : `P${Number(seat)+1}`;
  }

  function renderOnlineAll() {
    if (!onlineState) return;
    history = onlineState.history || [];
    duplicateAllowed = !!onlineState.duplicateAllowed;
    els.onlineRoomName.textContent = `ROOM ${selectedRoom}`;
    els.connectionText.textContent = ws && ws.readyState === WebSocket.OPEN ? '接続中' : '再接続中…';
    renderOnlinePlayers();
    renderOnlineSecret();
    renderHistory();
    renderCurrent();
    renderPalette();
    renderOnlineStatus();
  }

  function renderOnlinePlayers() {
    els.playerStrip.replaceChildren();
    for (let seat=0; seat<2; seat++) {
      const p = (onlineState.players || []).find(x => x.seat === seat);
      const d = document.createElement('div');
      d.className = `online-player${seat===mySeat?' me':''}${p && p.connected ? '' : ' offline'}`;
      d.innerHTML = `<small>P${seat+1}</small><b>${p ? escapeHtml(p.name) : '空席'}</b><span>${p ? (p.connected ? '接続中' : '離席中') : '募集中'}</span>`;
      els.playerStrip.appendChild(d);
    }
    const connected = (onlineState.players || []).filter(p=>p.connected).length;
    els.onlineStart.classList.toggle('hidden', !isOnlineHost() || onlineState.phase === 'playing');
    els.onlineStart.disabled = connected < 2;
    els.onlineStart.textContent = onlineState.phase === 'finished' ? '再戦開始' : 'ゲーム開始';
  }

  function renderOnlineSecret() {
    els.secret.replaceChildren();
    const reveal = onlineState.phase === 'finished' && Array.isArray(onlineState.answer);
    for (let i=0;i<4;i++) {
      els.secret.appendChild(reveal ? peg(onlineState.answer[i]) : Object.assign(document.createElement('div'),{className:'secret-cover'}));
    }
  }

  function renderOnlineStatus() {
    const used = history.length;
    els.guessCount.textContent = Math.min(used + 1, 8);
    if (onlineState.phase === 'waiting') {
      const connected = (onlineState.players || []).filter(p=>p.connected).length;
      els.turnLabel.textContent = connected < 2 ? '対戦相手を待っています' : (isOnlineHost() ? 'ゲームを開始できます' : 'ホストの開始待ち');
    } else if (onlineState.phase === 'playing') {
      els.turnLabel.textContent = mySeat === onlineState.turnSeat ? 'あなたの予想' : `${playerNameForSeat(onlineState.turnSeat)}の予想`;
    } else {
      els.turnLabel.textContent = '対局終了';
    }
  }

  function showOnlineResult() {
    if (!onlineState || onlineState.phase !== 'finished') return;
    const winner = onlineState.winnerSeat;
    els.resultKicker.textContent = winner == null ? 'ANSWER' : 'RESULT';
    els.resultTitle.textContent = winner == null ? 'GAME OVER' : (winner === mySeat ? 'YOU WIN' : 'YOU LOSE');
    els.resultText.textContent = winner == null ? '8回の予想で正解者は出ませんでした。' : `${playerNameForSeat(winner)}が4HITしました。`;
    els.answerReveal.replaceChildren(...(onlineState.answer || []).map(c=>peg(c)));
    els.rematch.textContent = isOnlineHost() ? 'もう一度' : 'ホスト待ち';
    els.rematch.disabled = !isOnlineHost();
    setTimeout(()=>els.resultOverlay.classList.remove('hidden'), 350);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  let toastTimer;
  function showToast(text) {
    clearTimeout(toastTimer); els.toast.textContent=text; els.toast.classList.add('show');
    toastTimer=setTimeout(()=>els.toast.classList.remove('show'),1000);
  }

  els.modeCards.forEach(card => card.addEventListener('click', () => setMode(card.dataset.mode)));
  els.duplicate.addEventListener('change',()=>els.duplicateLabel.textContent=els.duplicate.checked?'あり':'なし');
  els.start.addEventListener('click', startGame);
  els.confirm.addEventListener('click', submitHumanGuess);
  els.clear.addEventListener('click', clearGuess);
  els.newGame.addEventListener('click',()=>{
    if (!els.game.classList.contains('active')) return;
    if (mode === 'online') {
      if (isOnlineHost()) sendOnline({type:'resetGame'});
      else showToast('オンラインではホストのみやり直せます');
    } else startGame();
  });
  els.leave.addEventListener('click', backToTitle);
  els.rematch.addEventListener('click', rematch);
  els.backTitle.addEventListener('click', backToTitle);
  els.rules.addEventListener('click',()=>els.rulesOverlay.classList.remove('hidden'));
  els.closeRules.addEventListener('click',()=>els.rulesOverlay.classList.add('hidden'));
  els.rulesOverlay.addEventListener('click',(e)=>{if(e.target===els.rulesOverlay)els.rulesOverlay.classList.add('hidden')});
  els.refreshRooms.addEventListener('click', refreshRooms);
  els.resetRoom.addEventListener('click', resetSelectedRoom);
  els.onlineStart.addEventListener('click', () => {
    if (!isOnlineHost()) return;
    if (onlineState && onlineState.phase === 'finished') sendOnline({type:'rematch'});
    else sendOnline({type:'start', duplicateAllowed:els.duplicate.checked});
  });

  els.playerName.value = localStorage.getItem('hitBlowPlayerName') || '';
  els.duplicateLabel.textContent = 'なし';
  setMode('online');
  refreshRooms();
})();
