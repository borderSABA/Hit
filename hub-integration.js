(() => {
  'use strict';
  const HUB_SCRIPT_URL = 'https://bordersaba.github.io/hub-client.js';
  const GAME_NAME = 'HIT & BLOW';

  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      .hub-game-btn{white-space:nowrap}
      @media(max-width:720px){
        .topbar{padding-left:10px!important;padding-right:10px!important}
        .top-actions{gap:5px!important;flex-wrap:wrap;justify-content:flex-end}
        .top-actions .ghost-btn{padding:7px 8px!important;font-size:11px!important}
      }
    `;
    document.head.appendChild(style);
  }

  function loadHubClient() {
    if (window.BoardgameHub) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HUB_SCRIPT_URL;
      s.onload = resolve;
      s.onerror = () => reject(new Error('HOME共通機能を読み込めません'));
      document.head.appendChild(s);
    });
  }

  function selectedMode() {
    const card = document.querySelector('.mode-card.selected');
    return card ? card.dataset.mode : 'online';
  }

  function selectedRoomId() {
    const b = document.querySelector('.room-card.selected b');
    const m = b && b.textContent.match(/ROOM\s*([0-9]+)/i);
    return m ? m[1] : '1';
  }

  async function currentRoomCount(roomId) {
    const base = String(window.HIT_BLOW_SERVER_URL || '').replace(/\/$/, '');
    if (!base) throw new Error('ゲームサーバーURLが未設定です');
    const r = await fetch(`${base}/api/rooms`, {cache:'no-store'});
    if (!r.ok) throw new Error('部屋状態を確認できません');
    const data = await r.json();
    const room = (data.rooms || []).find(x => String(x.id) === String(roomId));
    return room ? Number(room.playerCount || 0) : 0;
  }

  function addTopButtons() {
    const actions = document.querySelector('.top-actions');
    if (!actions || document.getElementById('hubHomeBtn')) return;
    const home = document.createElement('button');
    home.id = 'hubHomeBtn'; home.className = 'ghost-btn hub-game-btn'; home.type='button'; home.textContent='HOME';
    home.addEventListener('click', () => BoardgameHub.openHome());
    const logs = document.createElement('button');
    logs.id = 'hubPlayRecordsBtn'; logs.className = 'ghost-btn hub-game-btn'; logs.type='button'; logs.textContent='プレイ記録';
    logs.addEventListener('click', () => BoardgameHub.openPlayRecords());
    actions.prepend(logs); actions.prepend(home);
  }

  function syncName() {
    const input = document.getElementById('playerName');
    if (!input) return;
    const shared = BoardgameHub.getPlayerName();
    const old = (localStorage.getItem('hitBlowPlayerName') || '').trim();
    if (shared) {
      input.value = shared;
      localStorage.setItem('hitBlowPlayerName', shared);
    } else if (old) {
      BoardgameHub.setPlayerName(old);
      input.value = old;
    }
    input.addEventListener('change', () => {
      const name = BoardgameHub.setPlayerName(input.value);
      if (name) localStorage.setItem('hitBlowPlayerName', name);
    });
  }

  function toast(text) {
    const el = document.getElementById('toast');
    if (!el) { alert(text); return; }
    el.textContent = text; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1800);
  }

  function installHostGate() {
    const start = document.getElementById('startBtn');
    if (!start) return;
    let bypass = false;
    start.addEventListener('click', async (e) => {
      const input = document.getElementById('playerName');
      const name = (input && input.value || '').trim().slice(0, 32);
      if (name) {
        BoardgameHub.setPlayerName(name);
        localStorage.setItem('hitBlowPlayerName', name);
      }
      if (selectedMode() !== 'online' || bypass) { bypass = false; return; }

      e.preventDefault();
      e.stopImmediatePropagation();
      if (!name) { toast('名前を入力してください'); return; }

      start.disabled = true;
      const oldText = start.textContent;
      start.textContent = '権限確認中…';
      try {
        const roomId = selectedRoomId();
        const count = await currentRoomCount(roomId);
        if (count === 0) {
          const allowed = await BoardgameHub.isHost(name);
          if (!allowed) {
            toast('この名前には部屋を立てる権限がありません');
            return;
          }
        }
        bypass = true;
        start.disabled = false;
        start.textContent = oldText;
        start.click();
      } catch (err) {
        toast(err.message || '権限を確認できません');
      } finally {
        if (!bypass) {
          start.disabled = false;
          start.textContent = oldText;
        }
      }
    }, true);
  }

  function installPlayLogger() {
    let pendingOnline = false;
    let pendingMode = '';

    const onlineStart = document.getElementById('onlineStartBtn');
    if (onlineStart) onlineStart.addEventListener('click', () => {
      if (!onlineStart.disabled) { pendingOnline = true; pendingMode = onlineStart.textContent.includes('再戦') ? 'online-rematch' : 'online'; }
    }, true);

    const rematch = document.getElementById('rematchBtn');
    if (rematch) rematch.addEventListener('click', () => {
      if (selectedMode() === 'online' && !rematch.disabled) { pendingOnline = true; pendingMode = 'online-rematch'; }
    }, true);

    const turnLabel = document.getElementById('turnLabel');
    if (turnLabel) {
      new MutationObserver(async () => {
        if (!pendingOnline) return;
        const text = turnLabel.textContent || '';
        const started = text.includes('あなたの予想') || text.includes('の予想');
        if (!started) return;
        pendingOnline = false;
        const roomText = (document.getElementById('onlineRoomName')?.textContent || '').trim();
        const players = [...document.querySelectorAll('#playerStrip .online-player b')]
          .map(x => x.textContent.trim()).filter(x => x && x !== '空席');
        try { await BoardgameHub.logPlay({ game:GAME_NAME, room:roomText, players, mode:pendingMode || 'online' }); }
        catch (e) { console.warn('play log failed', e); }
      }).observe(turnLabel, {childList:true, subtree:true, characterData:true});
    }

    const start = document.getElementById('startBtn');
    if (start) start.addEventListener('click', () => {
      const mode = selectedMode();
      if (mode === 'online') return;
      const name = BoardgameHub.getPlayerName() || '名前未設定';
      setTimeout(() => BoardgameHub.logPlay({game:GAME_NAME, room:'', players:[name], mode}).catch(()=>{}), 0);
    });
  }

  async function init() {
    injectStyle();
    try {
      await loadHubClient();
      addTopButtons();
      syncName();
      installHostGate();
      installPlayLogger();
    } catch (e) {
      console.warn(e);
    }
  }
  init();
})();
