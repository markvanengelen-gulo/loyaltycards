(() => {
  'use strict';

  const vault = window.VAULT;
  const $ = (id) => document.getElementById(id);

  const views = { lock: $('lock'), wallet: $('wallet'), card: $('card') };
  const PIN_LENGTH = (vault && vault.pinLength) || 4;
  const AUTO_LOCK_MS = 5 * 60 * 1000; // lock again after this long in the background
  const QUIET_ZONE = 10;              // blank modules either side of a barcode
  const RECENT_KEY = 'loyaltycards.recent'; // when each card was last opened, on this device

  let cards = null;   // decrypted list, held in memory only
  let current = null; // card being shown
  let pin = '';
  let busy = false;
  let hiddenAt = 0;
  let wakeLock = null;
  let recent = {};    // card id -> time last opened

  // ---------- unlocking ----------

  const bytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  async function unlock(candidate) {
    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(candidate), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(vault.salt), iterations: vault.iter },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(vault.iv) }, key, bytes(vault.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function hint(text, wrong) {
    $('lock-hint').textContent = text;
    views.lock.classList.toggle('is-wrong', Boolean(wrong));
  }

  function paintDots() {
    [...$('dots').children].forEach((dot, i) => dot.classList.toggle('is-filled', i < pin.length));
  }

  async function submit() {
    busy = true;
    views.lock.classList.add('is-busy');
    hint('Unlocking…');
    try {
      cards = await unlock(pin);
      await tagCards(cards);
      loadRecent();
      sortCards();
      buildGrid();
      hint('Enter your PIN');
      show('wallet');
    } catch (error) {
      hint('That PIN didn’t work. Try again.', true);
    } finally {
      pin = '';
      busy = false;
      views.lock.classList.remove('is-busy');
      paintDots();
    }
  }

  function press(key) {
    if (busy) return;
    if (key === 'del') {
      pin = pin.slice(0, -1);
    } else if (pin.length < PIN_LENGTH) {
      if (pin.length === 0) hint('Enter your PIN');
      pin += key;
    }
    paintDots();
    if (pin.length === PIN_LENGTH) submit();
  }

  function lock() {
    cards = null;
    current = null;
    pin = '';
    $('grid').replaceChildren();
    $('code').replaceChildren();
    $('pass-name').textContent = '';
    $('pass-number').textContent = '';
    keepAwake(false);
    paintDots();
    hint('Enter your PIN');
    show('lock');
  }

  // ---------- most recently opened first ----------

  // Each card gets an id that gives away neither its name nor its number,
  // so the saved order says nothing about the cards while the site is locked.
  async function tagCards(list) {
    const encoder = new TextEncoder();
    await Promise.all(list.map(async (card) => {
      const hash = await crypto.subtle.digest('SHA-256', encoder.encode(`${card.name}\n${card.value}`));
      card.id = Array.from(new Uint8Array(hash).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
    }));
  }

  function loadRecent() {
    recent = {};
    try {
      const saved = JSON.parse(localStorage.getItem(RECENT_KEY)) || {};
      for (const card of cards) {
        if (Number.isFinite(saved[card.id])) recent[card.id] = saved[card.id];
      }
    } catch (error) { /* nothing saved, or storage is blocked: fall back to A to Z */ }
  }

  function markOpened(card) {
    recent[card.id] = Date.now();
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch (error) { /* the order still holds until the page closes */ }
  }

  // Cards opened before come first, newest first. The rest follow from A to Z.
  function sortCards() {
    cards.sort((a, b) =>
      (recent[b.id] || 0) - (recent[a.id] || 0) || a.name.localeCompare(b.name));
  }

  // ---------- views ----------

  function show(name) {
    for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
    window.scrollTo(0, 0);
  }

  function buildGrid() {
    const grid = $('grid');
    grid.replaceChildren();
    cards.forEach((card, index) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.style.setProperty('--bg', card.bg || '#2d2870');
      tile.style.setProperty('--fg', card.fg || '#ffffff');
      const name = document.createElement('span');
      name.className = 'tile-name' + (card.name.length > 16 ? ' is-long' : '');
      name.textContent = card.name;
      tile.append(name);
      tile.addEventListener('click', () => openCard(index));
      grid.append(tile);
    });
  }

  function openCard(index) {
    current = cards[index];
    markOpened(current);
    const pass = $('pass');
    pass.style.setProperty('--bg', current.bg || '#2d2870');
    pass.style.setProperty('--fg', current.fg || '#ffffff');
    pass.classList.toggle('is-number-only', current.format === 'NONE');
    $('pass-name').textContent = current.name;
    $('pass-number').textContent = current.number || '';
    $('pass-number').hidden = !current.number;
    $('copy').hidden = !current.number;
    $('copy').textContent = 'Copy number';
    show('card');
    history.pushState({ card: true }, '');
    drawCode();
    $('pass-name').focus({ preventScroll: true });
    keepAwake(true);
  }

  function closeCard() {
    current = null;
    keepAwake(false);
    $('code').replaceChildren();
    if (cards) {
      sortCards();
      buildGrid();
      show('wallet');
    }
  }

  // Keep the screen on while a barcode is up, where the browser allows it.
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (error) { /* not allowed right now; the barcode still shows */ }
  }

  // ---------- barcodes ----------

  // Black/white pattern for a one-row barcode, as a string of 1s and 0s.
  function bars(card) {
    const result = {};
    JsBarcode(result, card.value, { format: card.format, flat: true });
    return result.encodings.map((part) => part.data).join('');
  }

  function squares(card) {
    const qr = qrcode(0, 'M');
    qr.addData(card.value);
    qr.make();
    return qr;
  }

  // Every module is a whole number of screen pixels, so bars stay sharp for scanners.
  function drawCode() {
    const holder = $('code');
    holder.replaceChildren();
    holder.hidden = Boolean(current) && current.format === 'NONE'; // a card with only a number
    if (!current || holder.hidden) return;
    const room = holder.clientWidth;
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.setAttribute('role', 'img');

    try {
      if (current.format === 'QR') {
        const qr = squares(current);
        const count = qr.getModuleCount();
        const quiet = 4;
        const side = count + quiet * 2;
        const unit = Math.max(1, Math.floor(Math.min(room, 280) * ratio / side));
        canvas.width = canvas.height = unit * side;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        for (let row = 0; row < count; row++) {
          for (let col = 0; col < count; col++) {
            if (qr.isDark(row, col)) ctx.fillRect((col + quiet) * unit, (row + quiet) * unit, unit, unit);
          }
        }
        canvas.setAttribute('aria-label', `QR code for ${current.name}`);
      } else {
        const pattern = bars(current);
        const total = pattern.length + QUIET_ZONE * 2;
        const unit = Math.max(1, Math.floor(room * ratio / total));
        canvas.width = unit * total;
        canvas.height = Math.round(Math.min(room * 0.42, 170) * ratio);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        for (let i = 0; i < pattern.length; i++) {
          if (pattern[i] === '1') ctx.fillRect((i + QUIET_ZONE) * unit, 0, unit, canvas.height);
        }
        canvas.setAttribute('aria-label', `Barcode for ${current.name}`);
      }
      canvas.style.width = `${canvas.width / ratio}px`;
      canvas.style.height = `${canvas.height / ratio}px`;
      holder.append(canvas);
    } catch (error) {
      const note = document.createElement('p');
      note.className = 'code-error';
      note.textContent = 'This barcode can’t be drawn. Read the number out instead.';
      holder.append(note);
    }
  }

  // ---------- wiring ----------

  function start() {
    const dots = $('dots');
    for (let i = 0; i < PIN_LENGTH; i++) dots.append(document.createElement('span'));

    if (!vault || !window.crypto || !crypto.subtle) {
      hint(vault ? 'This browser can’t unlock the cards. Open the site over https.'
                 : 'The card file is missing (vault.js).', true);
      $('keypad').hidden = true;
      return;
    }

    $('keypad').addEventListener('click', (event) => {
      const key = event.target.closest('button');
      if (key) press(key.dataset.key);
    });

    document.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!views.lock.hidden) {
        if (/^\d$/.test(event.key)) press(event.key);
        else if (event.key === 'Backspace') press('del');
      } else if (!views.card.hidden && event.key === 'Escape') {
        history.back();
      }
    });

    $('lock-now').addEventListener('click', lock);
    $('back').addEventListener('click', () => history.back());
    window.addEventListener('popstate', () => { if (!views.card.hidden) closeCard(); });

    $('copy').addEventListener('click', async () => {
      const button = $('copy');
      try {
        await navigator.clipboard.writeText(current.number.replace(/\s/g, ''));
        button.textContent = 'Copied';
      } catch (error) {
        button.textContent = 'Couldn’t copy. Select the number instead.';
      }
      setTimeout(() => { button.textContent = 'Copy number'; }, 1800);
    });

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (current) drawCode(); }, 120);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else {
        if (cards && hiddenAt && Date.now() - hiddenAt > AUTO_LOCK_MS) lock();
        else if (current) keepAwake(true);
        hiddenAt = 0;
      }
    });

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  start();
})();
