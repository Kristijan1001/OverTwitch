// ==UserScript==
// @name         OverTwitch - Cinematic Chat Overlay
// @namespace    overtwitch-chat-overlay
// @version      2.0.1
// @description  Twitch chat on top of the player: transparent message text when idle, full solid chat on hover. Drag, resize, restyle. Works in fullscreen and theater, live and VODs. Opens automatically, settings apply everywhere, auto-claim channel points. Userscript port of Anu Twitch Chat Overlay.
// @author       Kristijan1001
// @icon         https://www.google.com/s2/favicons?sz=64&domain=twitch.tv
// @homepageURL  https://github.com/Kristijan1001/OverTwitch
// @supportURL   https://github.com/Kristijan1001/OverTwitch/issues
// @downloadURL  https://raw.githubusercontent.com/Kristijan1001/OverTwitch/main/OverTwitch.user.js
// @updateURL    https://raw.githubusercontent.com/Kristijan1001/OverTwitch/main/OverTwitch.user.js
// @match        https://www.twitch.tv/*
// @exclude      https://www.twitch.tv/popout/*
// @exclude      https://www.twitch.tv/embed/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @license      ISC
// ==/UserScript==

/*
  OverTwitch — a single-file userscript port of Anu Twitch Chat Overlay
  (https://github.com/akhanubis/anu_twitch_chat_overlay) by Pablo Bianciotto
  (akhanubis), ISC licensed. See LICENSE for both copyright notices.

  Architecture — deliberately the same as anu's, because anu's works
  -----------------------------------------------------------------
  LIVE -> an <iframe> pointing at twitch.tv/popout/<channel>/chat, floated over
          the player and restyled from the outside. Same origin, so its
          document is fully reachable.
  VOD  -> the real `.video-chat` node is moved into the overlay, because a VOD
          has no popout chat to point an iframe at.

  Version 1.x used the moved-node approach for live too, on the theory that it
  was strictly better: one code path, no second connection, third-party emotes
  guaranteed. It is not better. Twitch's live chat lays itself out and drives
  its own auto-scroll against the box it was mounted in, so hosting it in a
  small repositioned container leaves it appending messages the viewport never
  scrolls to — which reads as chat being frozen. VODs were unaffected, which is
  exactly the live/VOD split anu's own code implies. Inside an iframe the chat
  page owns its whole document, lays out normally and scrolls itself, so there
  is nothing to fight.

  The cost is a second chat connection, and third-party emote add-ons only show
  up if they also run on popout chat. That is the trade anu makes by default,
  and chat that works beats chat that is elegant.
*/

(function () {
  'use strict';

  const TAG = '[OverTwitch]';
  const NS = 'otw';
  const VERSION = '2.0.1';
  const HOME = 'https://github.com/Kristijan1001/OverTwitch';

  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */

  const store = (() => {
    const hasSync = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    const hasAsync = typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function';
    const lsKey = k => `${NS}:${k}`;
    const parse = (raw, fallback) => {
      if (raw == null) return fallback;
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return fallback; }
    };
    return {
      async get(key, fallback) {
        try {
          if (hasSync) return parse(GM_getValue(key, null), fallback);
          if (hasAsync) return parse(await GM.getValue(key, null), fallback);
          return parse(localStorage.getItem(lsKey(key)), fallback);
        } catch (e) { return fallback; }
      },
      async set(key, value) {
        const raw = JSON.stringify(value);
        try {
          if (hasSync) return GM_setValue(key, raw);
          if (hasAsync) return GM.setValue(key, raw);
          localStorage.setItem(lsKey(key), raw);
        } catch (e) { warn('could not save settings', e); }
      },
      async removeMatching(match) {
        try {
          if (typeof GM_listValues === 'function' && typeof GM_deleteValue === 'function') {
            for (const k of GM_listValues()) if (match(k)) GM_deleteValue(k);
          }
          const prefix = `${NS}:`;
          for (const k of Object.keys(localStorage)) {
            if (k.startsWith(prefix) && match(k.slice(prefix.length))) localStorage.removeItem(k);
          }
        } catch (e) { /* nothing to clean */ }
      },
    };
  })();

  /* ------------------------------------------------------------------ *
   * Settings — one global set, no per-channel overrides
   * ------------------------------------------------------------------ */

  const DEFAULTS = Object.freeze({
    position: { left: 77, top: 6, right: 1.5, bottom: 8 },
    background: 'rgba(0, 0, 0, 0)',
    font: {
      family: '', size: 13, weight: 'normal',
      color: 'rgba(255, 255, 255, 1)', outline: 'rgba(0, 0, 0, 1)',
    },
    hideUsernames: false,
    hideTimestamps: true,
    autoClaim: true,
  });

  const SETTINGS_KEY = '__default__';
  const ENABLED_KEY = '__enabled__';

  const mergeSettings = stored => {
    const out = structuredClone(DEFAULTS);
    if (!stored || typeof stored !== 'object') return out;
    for (const key of Object.keys(DEFAULTS)) {
      const value = stored[key];
      if (value == null) continue;
      if (key === 'position' || key === 'font') {
        if (typeof value !== 'object') continue;
        for (const sub of Object.keys(DEFAULTS[key])) {
          if (value[sub] != null && typeof value[sub] === typeof DEFAULTS[key][sub]) out[key][sub] = value[sub];
        }
      } else if (typeof value === typeof DEFAULTS[key]) out[key] = value;
    }
    return out;
  };

  const loadSettings = async () => mergeSettings(await store.get(SETTINGS_KEY, null));
  const saveSettings = settings => store.set(SETTINGS_KEY, settings);

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
  const round2 = n => Math.round(n * 100) / 100;

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style') node.style.cssText = v;
      else if (v != null) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  };

  const svg = (viewBox, paths, size = 20) =>
    `<svg viewBox="${viewBox}" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    paths.map(d => `<path d="${d}"></path>`).join('') + '</svg>';

  const ICONS = {
    chatOn: svg('0 0 32 32', ['M 3 6 L 3 26 L 12.585938 26 L 16 29.414063 L 19.414063 26 L 29 26 L 29 6 Z M 5 8 L 27 8 L 27 24 L 18.585938 24 L 16 26.585938 L 13.414063 24 L 5 24 Z M 9 11 L 9 13 L 23 13 L 23 11 Z M 9 15 L 9 17 L 23 17 L 23 15 Z M 9 19 L 9 21 L 19 21 L 19 19 Z']),
    chatOff: svg('0 0 32 32', ['M 3 5 L 3 23 L 8 23 L 8 28.078125 L 14.351563 23 L 29 23 L 29 5 Z M 5 7 L 27 7 L 27 21 L 13.648438 21 L 10 23.917969 L 10 21 L 5 21 Z']),
    gear: svg('0 0 20 20', ['M10 8a2 2 0 100 4 2 2 0 000-4z', 'M9 2h2a2.01 2.01 0 001.235 1.855l.53.22a2.01 2.01 0 002.185-.439l1.414 1.414a2.01 2.01 0 00-.439 2.185l.22.53A2.01 2.01 0 0018 9v2a2.01 2.01 0 00-1.855 1.235l-.22.53a2.01 2.01 0 00.44 2.185l-1.415 1.414a2.01 2.01 0 00-2.184-.439l-.531.22A2.01 2.01 0 0011 18H9a2.01 2.01 0 00-1.235-1.854l-.53-.22a2.009 2.009 0 00-2.185.438L3.636 14.95a2.009 2.009 0 00.438-2.184l-.22-.531A2.01 2.01 0 002 11V9c.809 0 1.545-.487 1.854-1.235l.22-.53a2.009 2.009 0 00-.438-2.185L5.05 3.636a2.01 2.01 0 002.185.438l.53-.22A2.01 2.01 0 009 2zm-4 8l1.464 3.536L10 15l3.535-1.464L15 10l-1.465-3.536L10 5 6.464 6.464 5 10z'], 16),
    move: svg('0 0 32 32', ['M 16 1.5859375 L 10.292969 7.2929688 L 11.707031 8.7070312 L 15 5.4140625 L 15 15 L 5.4140625 15 L 8.7070312 11.707031 L 7.2929688 10.292969 L 1.5859375 16 L 7.2929688 21.707031 L 8.7070312 20.292969 L 5.4140625 17 L 15 17 L 15 26.585938 L 11.707031 23.292969 L 10.292969 24.707031 L 16 30.414062 L 21.707031 24.707031 L 20.292969 23.292969 L 17 26.585938 L 17 17 L 26.585938 17 L 23.292969 20.292969 L 24.707031 21.707031 L 30.414062 16 L 24.707031 10.292969 L 23.292969 11.707031 L 26.585938 15 L 17 15 L 17 5.4140625 L 20.292969 8.7070312 L 21.707031 7.2929688 L 16 1.5859375 z'], 16),
  };

  const parseRgba = v => {
    const m = String(v || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/i);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] } : { r: 0, g: 0, b: 0, a: 1 };
  };
  const toHex = v => { const { r, g, b } = parseRgba(v); return '#' + [r, g, b].map(n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join(''); };
  const toAlpha = v => Math.round(parseRgba(v).a * 100);
  const buildRgba = (hex, pct) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    const n = m ? parseInt(m[1], 16) : 0;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${round2(clamp(pct, 0, 100) / 100)})`;
  };
  const outlineShadow = c => `-1px -1px 0 ${c}, 1px -1px 0 ${c}, 1px 1px 0 ${c}, -1px 1px 0 ${c}`;

  /* ------------------------------------------------------------------ *
   * Twitch page
   * ------------------------------------------------------------------ */

  const SEL = {
    playerOverlay: '.video-player__overlay',
    rightControls: '.player-controls__right-control-group',
    vodChat: '.video-chat',
    claimable: '.claimable-bonus__icon',
  };

  const NON_CHANNEL = new Set([
    '', 'directory', 'videos', 'settings', 'subscriptions', 'inventory', 'wallet',
    'drops', 'friends', 'downloads', 'jobs', 'turbo', 'prime', 'store', 'search',
    'following', 'u', 'p', 'products', 'payments', 'moderator', 'popout', 'embed',
  ]);

  const detectTarget = () => {
    const path = location.pathname.replace(/^\/+|\/+$/g, '');
    const parts = path.split('/');
    const vod = path.match(/^videos\/(\d+)/);
    if (vod) return { kind: 'vod', id: vod[1], key: `vod:${vod[1]}` };
    const name = (parts[0] || '').toLowerCase();
    if (!name || NON_CHANNEL.has(name) || !/^[a-z0-9_]+$/.test(name)) return null;
    if (parts[1] && !['home', 'squad'].includes(parts[1])) return null;
    return { kind: 'live', id: name, key: `ch:${name}` };
  };

  /* ------------------------------------------------------------------ *
   * Page stylesheet
   * ------------------------------------------------------------------ */

  const PAGE_CSS = `
  .otw-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 3rem; height: 3rem; padding: 0; margin: 0;
    background: none; border: 0; border-radius: .4rem;
    color: #fff; cursor: pointer; opacity: .9;
    transition: opacity .1s ease-in, background-color .1s ease-in;
  }
  .otw-toggle:hover { opacity: 1; background-color: rgba(255,255,255,.2); }
  .otw-toggle svg { fill: currentColor; width: 20px; height: 20px; pointer-events: none; }
  .otw-toggle .otw-icon-on { display: none; }
  body.otw-on .otw-toggle .otw-icon-on { display: block; }
  body.otw-on .otw-toggle .otw-icon-off { display: none; }

  .otw-frame {
    position: absolute; display: none; z-index: 15;
    min-width: 160px; min-height: 90px; overflow: hidden; border-radius: 4px;
  }
  body.otw-on .otw-frame { display: block; }
  body.otw-dragging, body.otw-dragging * { cursor: grabbing !important; user-select: none !important; }
  body.otw-resizing * { user-select: none !important; }

  .otw-host { position: absolute; inset: 0; }
  .otw-host > iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; }

  /* While dragging or resizing, let pointer events pass over the iframe. */
  body.otw-dragging .otw-host, body.otw-resizing .otw-host { pointer-events: none; }

  /* VOD only: the real chat node lives here, so it needs sizing. */
  .otw-host > .video-chat { width: 100%; height: 100%; background: transparent !important; }
  .otw-frame:not(.otw-hover) .otw-host > .video-chat { background: var(--otw-bg) !important; }
  .otw-frame:not(.otw-hover) .video-chat__header { display: none !important; }
  .otw-frame:not(.otw-hover) .video-chat__message-list-wrapper { scrollbar-width: none; }
  .otw-frame:not(.otw-hover) .video-chat__message-list-wrapper::-webkit-scrollbar { width: 0 !important; }
  .otw-frame:not(.otw-hover) .vod-message {
    font-family: var(--otw-font-family); font-size: var(--otw-font-size);
    font-weight: var(--otw-font-weight); color: var(--otw-color);
    text-shadow: var(--otw-outline); line-height: calc(var(--otw-font-size) * 1.45);
  }
  .otw-frame.otw-hide-stamps [class*="timestamp" i] { display: none !important; }
  .otw-frame.otw-hide-users .vod-message__header { display: none !important; }

  .otw-bar {
    position: absolute; top: 0; left: 0; right: 0; height: 32px; z-index: 20;
    display: none; align-items: center; gap: 6px; padding: 0 6px;
    background: linear-gradient(to bottom, rgba(0,0,0,.75), rgba(0,0,0,0));
    color: #fff; font: 600 11px/1 inherit; letter-spacing: .06em;
    text-transform: uppercase; cursor: grab; touch-action: none;
  }
  .otw-frame.otw-hover .otw-bar { display: flex; }
  .otw-bar-title { flex: 1 1 auto; text-align: center; opacity: .85; pointer-events: none;
                   overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .otw-bar-btn { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px;
    background: none; color: #fff; opacity: .8; cursor: pointer; }
  .otw-bar-btn:hover { opacity: 1; background: rgba(255,255,255,.2); }
  .otw-bar-btn svg { fill: currentColor; pointer-events: none; }

  .otw-grip { position: absolute; z-index: 21; display: none; touch-action: none; }
  .otw-frame.otw-hover .otw-grip { display: block; }
  .otw-grip-l, .otw-grip-r { top: 0; width: 6px; height: 100%; cursor: ew-resize; }
  .otw-grip-t, .otw-grip-b { left: 0; width: 100%; height: 6px; cursor: ns-resize; }
  .otw-grip-l { left: 0; } .otw-grip-r { right: 0; }
  .otw-grip-t { top: 0; }  .otw-grip-b { bottom: 0; }
  .otw-grip-tl, .otw-grip-tr, .otw-grip-bl, .otw-grip-br { width: 12px; height: 12px; z-index: 22; }
  .otw-grip-tl { top: 0; left: 0; cursor: nwse-resize; }
  .otw-grip-br { bottom: 0; right: 0; cursor: nwse-resize; }
  .otw-grip-tr { top: 0; right: 0; cursor: nesw-resize; }
  .otw-grip-bl { bottom: 0; left: 0; cursor: nesw-resize; }

  .otw-modal { position: absolute; inset: 0; z-index: 9000; display: none; }
  .otw-modal.otw-open { display: flex; align-items: center; justify-content: center; }
  .otw-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.65); }
  .otw-modal-box { position: relative; display: flex; flex-direction: column;
    width: min(520px, 94%); max-height: min(94%, 560px);
    background: var(--color-background-base, #18181b); color: var(--color-text-base, #efeff1);
    border-radius: 6px; box-shadow: 0 8px 32px rgba(0,0,0,.6); font: 400 13px/1.5 inherit; overflow: hidden; }
  .otw-modal-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
    border-bottom: 1px solid var(--color-border-base, rgba(83,83,95,.48)); font-weight: 600; font-size: 14px; }
  .otw-modal-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 14px 14px; }
  .otw-modal-foot { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
    border-top: 1px solid var(--color-border-base, rgba(83,83,95,.48));
    background: var(--color-background-alt, #26262c); }
  .otw-spacer { flex: 1 1 auto; }
  .otw-note { opacity: .7; font-size: 12px; margin: 10px 0 4px; }
  .otw-row { display: flex; align-items: center; gap: 10px; padding: 9px 0;
             border-top: 1px solid var(--color-border-base, rgba(83,83,95,.28)); }
  .otw-row:first-of-type { border-top: 0; }
  .otw-row > .otw-label { flex: 0 0 38%; font-size: 13px; }
  .otw-row > .otw-control { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .otw-tip { flex-basis: 100%; opacity: .6; font-size: 11px; }
  .otw-btn { padding: 5px 11px; border: 0; border-radius: 4px; cursor: pointer; font: 600 12px/1.6 inherit;
    background: rgba(255,255,255,.15); color: var(--color-text-base, #efeff1); }
  .otw-btn:hover { filter: brightness(1.2); }
  .otw-btn.otw-primary { background: var(--color-background-button-primary-default, #9147ff); color: #fff; }
  .otw-seg { display: inline-flex; border-radius: 4px; overflow: hidden; }
  .otw-seg .otw-btn { border-radius: 0; }
  .otw-seg .otw-btn[aria-pressed="true"] { background: var(--color-background-button-primary-default, #9147ff); color: #fff; }
  .otw-modal input[type="number"], .otw-modal select, .otw-modal input[type="text"] {
    background: var(--color-background-input, #18181b); color: var(--color-text-base, #efeff1);
    border: 1px solid var(--color-border-base, rgba(83,83,95,.48)); border-radius: 4px;
    padding: 4px 6px; font: inherit; font-size: 12px; }
  .otw-modal input[type="number"] { width: 68px; }
  .otw-modal input[type="text"] { flex: 1 1 120px; min-width: 0; }
  .otw-modal select { min-width: 130px; }
  .otw-modal input[type="color"] { width: 34px; height: 26px; padding: 0; border: 0; background: none; cursor: pointer; }
  .otw-modal input[type="range"] { flex: 1 1 90px; min-width: 80px; }
  .otw-swatch { width: 26px; height: 26px; border-radius: 4px; border: 1px solid rgba(255,255,255,.3);
    background-image: linear-gradient(45deg,#666 25%,transparent 25%,transparent 75%,#666 75%),
                      linear-gradient(45deg,#666 25%,#999 25%,#999 75%,#666 75%);
    background-size: 10px 10px; background-position: 0 0, 5px 5px; }
  .otw-swatch > span { display: block; width: 100%; height: 100%; border-radius: 3px; }
  .otw-map { position: relative; width: 190px; aspect-ratio: 16 / 9; background: #3a3a3d; border-radius: 3px; overflow: hidden; flex: 0 0 auto; }
  .otw-map-box { position: absolute; background: rgba(145,71,255,.55); border: 1px solid #fff; cursor: grab; touch-action: none; }
  .otw-map-grip { position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px; background: #fff; cursor: nwse-resize; touch-action: none; }
  .otw-about a { color: var(--color-text-link, #bf94ff); }
  .otw-about p { margin: 8px 0; }
  .otw-version { opacity: .5; font-size: 11px; }
  `;

  /*
   * Injected into the popout chat document. Everything the overlay does to
   * live chat happens here, inside a document Twitch lays out itself. Note it
   * only ever hides or repaints — nothing changes the boxes Twitch measures to
   * drive its own auto-scroll.
   */
  const IFRAME_CSS = `
  html, body { background: transparent !important; overflow: hidden !important; }
  .stream-chat-header, .chat-room__notifications, .chat-room__viewer-card { display: none !important; }
  html:not(.otw-hover) .chat-room__content > *:first-child { display: none !important; }
  html:not(.otw-hover) .chat-input { display: none !important; }
  html:not(.otw-hover) .chat-line__icons { display: none !important; }

  /* section.chat-room is the element that actually paints Twitch's solid chat
     background — .chat-room__content and .chat-list--default above and below it
     are already transparent, which is why styling only those left chat opaque.
     Clear every layer and let exactly one carry the tint, so a translucent
     colour is not stacked on itself. */
  html:not(.otw-hover) .chat-room,
  html:not(.otw-hover) .chat-list--default,
  html:not(.otw-hover) .chat-scrollable-area__message-container { background: transparent !important; }
  html:not(.otw-hover) .chat-room__content { background: var(--otw-bg) !important; }

  /* Hovering brings the real, solid chat back. --otw-solid is pushed in from
     the parent page, because the popout document defines Twitch's theme
     variables below <html>, so reading them at this level yields white. */
  html.otw-hover, html.otw-hover body, html.otw-hover .chat-room,
  html.otw-hover .chat-room__content { background: var(--otw-solid, #18181b) !important; }

  html:not(.otw-hover) .scrollable-area { scrollbar-width: none; }
  html:not(.otw-hover) .scrollable-area::-webkit-scrollbar { width: 0 !important; height: 0 !important; }

  html:not(.otw-hover) .chat-line__message {
    font-family: var(--otw-font-family); font-size: var(--otw-font-size);
    font-weight: var(--otw-font-weight); color: var(--otw-color);
    text-shadow: var(--otw-outline); line-height: calc(var(--otw-font-size) * 1.45);
  }
  html:not(.otw-hover) .chat-line__message .tw-elevation-1 { box-shadow: none !important; }

  html.otw-hide-stamps [class*="timestamp" i] { display: none !important; }
  html.otw-hide-users .chat-line__username-container,
  html.otw-hide-users .chat-line__username-container + span,
  html.otw-hide-users .chat-author__display-name,
  html.otw-hide-users .message-author__display-name { display: none !important; }
  `;

  const injectPageStyle = () => {
    if (!document.getElementById('otw-style')) {
      document.head.append(el('style', { id: 'otw-style', text: PAGE_CSS }));
    }
  };

  /* ------------------------------------------------------------------ *
   * Geometry, drag and resize
   * ------------------------------------------------------------------ */

  const MIN_W = 160, MIN_H = 90;

  const applyRect = (node, r) => {
    node.style.left = `${r.left}%`; node.style.top = `${r.top}%`;
    node.style.right = `${r.right}%`; node.style.bottom = `${r.bottom}%`;
  };
  const pxToRect = (b, minX, minY, maxX, maxY) => ({
    left: round2(clamp((100 * minX) / b.width, 0, 100)),
    top: round2(clamp((100 * minY) / b.height, 0, 100)),
    right: round2(clamp(100 - (100 * maxX) / b.width, 0, 100)),
    bottom: round2(clamp(100 - (100 * maxY) / b.height, 0, 100)),
  });
  const minPercent = () => {
    const p = document.querySelector(SEL.playerOverlay);
    return {
      w: clamp((MIN_W / (p?.clientWidth || 1280)) * 100, 1, 90),
      h: clamp((MIN_H / (p?.clientHeight || 720)) * 100, 1, 90),
    };
  };

  const makeDraggable = (node, container, handle, { onMove, onEnd } = {}) => {
    handle.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 || ev.target.closest('.otw-bar-btn, .otw-map-grip')) return;
      ev.preventDefault(); ev.stopPropagation();
      const b = container.getBoundingClientRect(), s = node.getBoundingClientRect();
      const gx = ev.clientX - s.left, gy = ev.clientY - s.top, w = s.width, h = s.height;
      handle.setPointerCapture(ev.pointerId);
      document.body.classList.add('otw-dragging');
      let last = pxToRect(b, s.left - b.left, s.top - b.top, s.left - b.left + w, s.top - b.top + h);
      const move = e => {
        const x = clamp(e.clientX - b.left - gx, 0, Math.max(0, b.width - w));
        const y = clamp(e.clientY - b.top - gy, 0, Math.max(0, b.height - h));
        last = pxToRect(b, x, y, x + w, y + h);
        applyRect(node, last); onMove?.(last);
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        try { handle.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
        document.body.classList.remove('otw-dragging');
        onEnd?.(last);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  };

  const makeResizable = (node, container, grip, dirs, { onMove, onEnd } = {}) => {
    grip.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      ev.preventDefault(); ev.stopPropagation();
      const b = container.getBoundingClientRect(), s = node.getBoundingClientRect();
      const ox = ev.clientX, oy = ev.clientY;
      const x0 = s.left - b.left, y0 = s.top - b.top, x1 = x0 + s.width, y1 = y0 + s.height;
      grip.setPointerCapture(ev.pointerId);
      document.body.classList.add('otw-resizing');
      const pct = minPercent();
      const minW = (b.width * pct.w) / 100, minH = (b.height * pct.h) / 100;
      let last = null;
      const move = e => {
        const dx = e.clientX - ox, dy = e.clientY - oy;
        let minX = x0, minY = y0, maxX = x1, maxY = y1;
        if (dirs.includes('l')) minX = clamp(x0 + dx, 0, x1 - minW);
        if (dirs.includes('r')) maxX = clamp(x1 + dx, x0 + minW, b.width);
        if (dirs.includes('t')) minY = clamp(y0 + dy, 0, y1 - minH);
        if (dirs.includes('b')) maxY = clamp(y1 + dy, y0 + minH, b.height);
        last = pxToRect(b, minX, minY, maxX, maxY);
        applyRect(node, last); onMove?.(last);
      };
      const end = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        grip.removeEventListener('pointercancel', end);
        try { grip.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
        document.body.classList.remove('otw-resizing');
        if (last) onEnd?.(last);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    });
  };

  /* ------------------------------------------------------------------ *
   * Modal
   * ------------------------------------------------------------------ */

  const createModal = ({ title, body, footer, extraClass = '' }) => {
    const box = el('div', { class: 'otw-modal-box' }, [
      el('div', { class: 'otw-modal-head' }, title),
      el('div', { class: `otw-modal-body ${extraClass}` }, body),
      el('div', { class: 'otw-modal-foot' }, footer),
    ]);
    const modal = el('div', { class: 'otw-modal' }, [el('div', { class: 'otw-modal-backdrop' }), box]);
    modal.open = () => modal.classList.add('otw-open');
    modal.close = () => modal.classList.remove('otw-open');
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); modal.close(); } });
    return modal;
  };

  /* ------------------------------------------------------------------ *
   * Session
   * ------------------------------------------------------------------ */

  let session = null;
  let overlayEnabled = false;

  const createSession = async target => {
    const overlay = document.querySelector(SEL.playerOverlay);
    const controls = document.querySelector(SEL.rightControls);
    if (!overlay || !controls) return null;

    const settings = await loadSettings();

    const host = el('div', { class: 'otw-host' });
    const bar = el('div', { class: 'otw-bar' }, [
      el('button', { class: 'otw-bar-btn', type: 'button', title: 'Overlay settings', html: ICONS.gear }),
      el('div', { class: 'otw-bar-title', text: 'Chat' }),
      el('span', { class: 'otw-bar-btn', title: 'Drag to move', html: ICONS.move }),
    ]);
    const grips = ['l', 'r', 't', 'b', 'tl', 'tr', 'bl', 'br']
      .map(d => el('div', { class: `otw-grip otw-grip-${d}`, 'data-dir': d }));
    const frame = el('div', { class: 'otw-frame' }, [host, bar, ...grips]);
    applyRect(frame, settings.position);

    const toggleBtn = el('button', {
      class: 'otw-toggle', type: 'button', title: 'Chat overlay (Alt+C)', 'aria-label': 'Toggle chat overlay',
      html: `<span class="otw-icon-on">${ICONS.chatOn}</span><span class="otw-icon-off">${ICONS.chatOff}</span>`,
    });

    const state = {
      target, settings, saved: structuredClone(settings),
      frame, host, toggleBtn, overlay,
      iframe: null, iframeDoc: null,
      vodChat: null,
      claimTimer: 0, modals: [], destroyed: false,
    };

    /* --- settings applied to whichever surface holds chat ---------------- */
    const surfaces = () => [frame, state.iframeDoc?.documentElement].filter(Boolean);

    const applyLook = s => {
      for (const root of surfaces()) {
        root.style.setProperty('--otw-bg', s.background);
        root.style.setProperty('--otw-font-family', s.font.family || 'inherit');
        root.style.setProperty('--otw-font-size', `${s.font.size}px`);
        root.style.setProperty('--otw-font-weight', s.font.weight);
        root.style.setProperty('--otw-color', s.font.color);
        root.style.setProperty('--otw-outline', parseRgba(s.font.outline).a > 0 ? outlineShadow(s.font.outline) : 'none');
        root.classList.toggle('otw-hide-users', !!s.hideUsernames);
        root.classList.toggle('otw-hide-stamps', !!s.hideTimestamps);
      }
      setAutoClaim(!!s.autoClaim);
    };
    const applyAll = s => { applyRect(frame, s.position); applyLook(s); };

    /* --- auto-claim ------------------------------------------------------ */
    const claimNow = () => {
      for (const doc of [state.iframeDoc, document]) {
        const btn = doc && doc.querySelector(SEL.claimable);
        if (btn) { btn.click(); return; }
      }
    };
    const setAutoClaim = on => {
      clearInterval(state.claimTimer); state.claimTimer = 0;
      if (!on) return;
      claimNow();
      state.claimTimer = setInterval(claimNow, 3000);
    };

    /* --- LIVE: popout chat in an iframe, as anu does --------------------- */
    const mountIframe = () => {
      if (state.iframe) return true;
      const iframe = el('iframe', {
        src: `https://www.twitch.tv/popout/${target.id}/chat`,
        frameborder: '0',
        title: 'Twitch chat',
      });
      iframe.addEventListener('load', () => {
        try {
          const doc = iframe.contentDocument; // same origin
          if (!doc) { warn('chat iframe is not reachable'); return; }
          state.iframeDoc = doc;
          const style = doc.createElement('style');
          style.id = 'otw-iframe-style';
          style.textContent = IFRAME_CSS;
          (doc.head || doc.documentElement).append(style);
          syncTheme();
          applyLook(state.settings);
          doc.documentElement.classList.toggle('otw-hover', frame.classList.contains('otw-hover'));
          log('chat iframe ready');
        } catch (e) {
          warn('could not style the chat iframe', e);
        }
      });
      host.append(iframe);
      state.iframe = iframe;
      return true;
    };

    const syncTheme = () => {
      const root = state.iframeDoc?.documentElement;
      if (!root) return;
      const dark = document.documentElement.classList.contains('tw-root--theme-dark');
      root.classList.toggle('tw-root--theme-dark', dark);
      root.classList.toggle('tw-root--theme-light', !dark);
      // Resolve the solid chat colour on this page, where the variable is real.
      const solid = getComputedStyle(document.documentElement)
        .getPropertyValue('--color-background-base').trim();
      root.style.setProperty('--otw-solid', solid || (dark ? '#18181b' : '#ffffff'));
    };

    /* --- VOD: move the real chat node ------------------------------------ */
    const attachVodChat = () => {
      if (state.vodChat) return true;
      const node = document.querySelector(SEL.vodChat);
      if (!node) return false;
      state.vodChat = { node, parent: node.parentElement, next: node.nextSibling };
      host.append(node);
      return true;
    };
    const restoreVodChat = () => {
      const d = state.vodChat; state.vodChat = null;
      if (!d?.node) return;
      if (d.parent?.isConnected) d.parent.insertBefore(d.node, d.next?.parentElement === d.parent ? d.next : null);
      else d.node.remove();
    };

    const attachChat = () => (target.kind === 'live' ? mountIframe() : attachVodChat());

    /* --- hover ------------------------------------------------------------ */
    const scrollChatToBottom = () => {
      const areas = [
        ...(state.iframeDoc ? state.iframeDoc.querySelectorAll('.chat-list--default .scrollable-area') : []),
        ...host.querySelectorAll('.video-chat__message-list-wrapper'),
      ];
      for (const a of areas) a.scrollTop = a.scrollHeight;
    };

    const setHover = on => {
      frame.classList.toggle('otw-hover', on);
      state.iframeDoc?.documentElement.classList.toggle('otw-hover', on);
      if (on) scrollChatToBottom(); // anu's one scroll nudge: jump to newest when you engage
    };

    /* --- enable / disable -------------------------------------------------- */
    const setEnabled = (on, persist = false) => {
      if (persist) store.set(ENABLED_KEY, on);
      overlayEnabled = on;
      if (on) {
        document.body.classList.add('otw-on');
        applyAll(state.settings);
        if (!attachChat()) { document.body.classList.remove('otw-on'); return false; }
      } else {
        document.body.classList.remove('otw-on');
        setHover(false);
        if (target.kind === 'vod') restoreVodChat();
        setAutoClaim(false);
      }
      return true;
    };
    state.setEnabled = setEnabled;

    toggleBtn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      setEnabled(!overlayEnabled, true);
    });

    frame.addEventListener('mouseenter', () => setHover(true));
    frame.addEventListener('mouseleave', () => setHover(false));

    /* --- drag & resize ----------------------------------------------------- */
    const persistPosition = rect => {
      state.settings.position = rect;
      state.saved = structuredClone(state.settings);
      saveSettings(state.settings);
    };
    makeDraggable(frame, overlay, bar, { onEnd: persistPosition });
    for (const g of grips) makeResizable(frame, overlay, g, g.dataset.dir, { onEnd: persistPosition });

    /* --- panels ------------------------------------------------------------ */
    const panel = buildSettingsPanel(state, { applyAll, applyLook });
    const about = buildAboutPanel();
    state.modals.push(panel, about);
    panel.onAbout = () => about.open();
    bar.querySelector('.otw-bar-btn').addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      panel.showWith(state.settings);
    });

    overlay.append(frame, panel, about);
    controls.prepend(toggleBtn);
    applyAll(settings);

    state.destroy = () => {
      if (state.destroyed) return;
      state.destroyed = true;
      clearInterval(state.claimTimer);
      restoreVodChat();
      frame.remove(); toggleBtn.remove();
      for (const m of state.modals) m.remove();
    };

    log(`ready for ${target.kind === 'vod' ? 'VOD ' : ''}${target.id}`);
    return state;
  };

  /* ------------------------------------------------------------------ *
   * Settings panel
   * ------------------------------------------------------------------ */

  const FONT_FAMILIES = [
    ['Twitch default', ''], ['System UI', 'system-ui, sans-serif'], ['Sans-serif', 'sans-serif'],
    ['Serif', 'serif'], ['Monospace', 'ui-monospace, monospace'], ['Cursive', 'cursive'],
    ['Fantasy', 'fantasy'], ['Custom…', 'custom'],
  ];

  const colourControl = onChange => {
    const hex = el('input', { type: 'color' });
    const alpha = el('input', { type: 'range', min: '0', max: '100', step: '1' });
    const fill = el('span');
    const swatch = el('div', { class: 'otw-swatch' }, fill);
    const emit = () => { const v = buildRgba(hex.value, +alpha.value); fill.style.background = v; onChange(v); };
    hex.addEventListener('input', emit); alpha.addEventListener('input', emit);
    return {
      nodes: [hex, alpha, swatch],
      set(v) { hex.value = toHex(v); alpha.value = toAlpha(v); fill.style.background = v; },
    };
  };

  const segmented = (options, onChange) => {
    const buttons = options.map(([text, value]) =>
      el('button', { class: 'otw-btn', type: 'button', 'data-value': value, text, 'aria-pressed': 'false' }));
    const group = el('div', { class: 'otw-seg' }, buttons);
    const select = v => { for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === String(v))); };
    for (const b of buttons) b.addEventListener('click', e => { e.preventDefault(); select(b.dataset.value); onChange(b.dataset.value); });
    return { node: group, set: select };
  };

  const row = (label, controls, tip) => el('div', { class: 'otw-row' }, [
    el('div', { class: 'otw-label', text: label }),
    el('div', { class: 'otw-control' }, [...[].concat(controls), tip ? el('div', { class: 'otw-tip', text: tip }) : null]),
  ]);

  function buildSettingsPanel(state, { applyAll, applyLook }) {
    const draft = structuredClone(state.settings);
    const preview = () => applyLook(draft);

    const mapBox = el('div', { class: 'otw-map-box' }, el('div', { class: 'otw-map-grip' }));
    const map = el('div', { class: 'otw-map' }, mapBox);
    const onMap = r => { draft.position = r; applyRect(state.frame, r); };
    makeDraggable(mapBox, map, mapBox, { onMove: onMap, onEnd: onMap });
    makeResizable(mapBox, map, mapBox.querySelector('.otw-map-grip'), 'rb', { onMove: onMap, onEnd: onMap });

    const background = colourControl(v => { draft.background = v; preview(); });
    const fontColour = colourControl(v => { draft.font.color = v; preview(); });
    const outline = colourControl(v => { draft.font.outline = v; preview(); });

    const familySelect = el('select', {}, FONT_FAMILIES.map(([t, v]) => el('option', { value: v, text: t })));
    const familyCustom = el('input', { type: 'text', placeholder: 'e.g. "Comic Sans MS", cursive', style: 'display:none' });
    const syncFamily = () => {
      familyCustom.style.display = familySelect.value === 'custom' ? '' : 'none';
      draft.font.family = familySelect.value === 'custom' ? familyCustom.value.trim() : familySelect.value;
      preview();
    };
    familySelect.addEventListener('change', syncFamily);
    familyCustom.addEventListener('input', syncFamily);

    const sizeInput = el('input', { type: 'number', min: '8', max: '48', step: '1' });
    sizeInput.addEventListener('input', () => {
      const n = parseInt(sizeInput.value, 10);
      if (Number.isFinite(n) && n >= 8 && n <= 48) { draft.font.size = n; preview(); }
    });

    const weight = segmented([['Normal', 'normal'], ['Bold', 'bold'], ['Bolder', '900']], v => { draft.font.weight = v; preview(); });
    const users = segmented([['Show', 'false'], ['Hide', 'true']], v => { draft.hideUsernames = v === 'true'; preview(); });
    const stamps = segmented([['Show', 'false'], ['Hide', 'true']], v => { draft.hideTimestamps = v === 'true'; preview(); });
    const claim = segmented([['Off', 'false'], ['On', 'true']], v => { draft.autoClaim = v === 'true'; preview(); });

    const body = [
      el('div', { class: 'otw-note', text: 'These settings apply to every channel and VOD.' }),
      row('Placement', map, 'You can also drag the top bar and pull the edges of the overlay.'),
      row('Background', background.nodes, 'Shown when your mouse is away; hovering restores solid chat.'),
      row('Font', [familySelect, familyCustom]),
      row('Font size', [sizeInput, el('span', { text: 'px', style: 'opacity:.6;font-size:12px' })]),
      row('Font colour', fontColour.nodes),
      row('Outline', outline.nodes, 'Set opacity to 0 for no outline.'),
      row('Font weight', weight.node),
      row('Usernames', users.node),
      row('Timestamps', stamps.node),
      row('Auto-claim channel points', claim.node),
    ];

    const resetBtn = el('button', { class: 'otw-btn', type: 'button', text: 'Reset to defaults' });
    const cancelBtn = el('button', { class: 'otw-btn', type: 'button', text: 'Cancel' });
    const saveBtn = el('button', { class: 'otw-btn otw-primary', type: 'button', text: 'Apply everywhere' });
    const aboutBtn = el('button', { class: 'otw-bar-btn', type: 'button', title: 'About', text: '?', style: 'font-weight:700' });

    const modal = createModal({
      title: [el('span', { text: 'Overlay settings' }), el('span', { class: 'otw-spacer' }), aboutBtn],
      body,
      footer: [resetBtn, el('span', { class: 'otw-spacer' }), cancelBtn, saveBtn],
    });

    const load = src => {
      Object.assign(draft, structuredClone(src));
      applyRect(mapBox, draft.position);
      background.set(draft.background);
      fontColour.set(draft.font.color);
      outline.set(draft.font.outline);
      const known = FONT_FAMILIES.some(([, v]) => v === draft.font.family);
      familySelect.value = known ? draft.font.family : 'custom';
      familyCustom.value = known ? '' : draft.font.family;
      familyCustom.style.display = familySelect.value === 'custom' ? '' : 'none';
      sizeInput.value = draft.font.size;
      weight.set(draft.font.weight);
      users.set(String(!!draft.hideUsernames));
      stamps.set(String(!!draft.hideTimestamps));
      claim.set(String(!!draft.autoClaim));
      applyAll(draft);
    };

    resetBtn.addEventListener('click', () => load(DEFAULTS));
    cancelBtn.addEventListener('click', () => {
      modal.close();
      Object.assign(state.settings, structuredClone(state.saved));
      applyAll(state.settings);
    });
    saveBtn.addEventListener('click', () => {
      modal.close();
      Object.assign(state.settings, structuredClone(draft));
      state.saved = structuredClone(draft);
      applyAll(state.settings);
      saveSettings(state.settings);
    });
    aboutBtn.addEventListener('click', () => modal.onAbout?.());
    modal.querySelector('.otw-modal-backdrop').addEventListener('click', () => cancelBtn.click());

    modal.showWith = current => { load(current); modal.open(); saveBtn.focus(); };
    return modal;
  }

  function buildAboutPanel() {
    const closeBtn = el('button', { class: 'otw-btn otw-primary', type: 'button', text: 'Close' });
    const modal = createModal({
      title: 'About OverTwitch',
      extraClass: 'otw-about',
      body: [
        el('p', { html: `A userscript port of <a href="https://github.com/akhanubis/anu_twitch_chat_overlay" target="_blank" rel="noopener">Anu Twitch Chat Overlay</a> by akhanubis.` }),
        el('p', { html: `Alt+C toggles the overlay. Hover it for the real chat, input, drag bar and resize grips.` }),
        el('p', { html: `Bugs and requests: <a href="${HOME}/issues" target="_blank" rel="noopener">issue tracker</a>.` }),
      ],
      footer: [el('span', { class: 'otw-version', text: `Version ${VERSION}` }), el('span', { class: 'otw-spacer' }), closeBtn],
    });
    closeBtn.addEventListener('click', () => modal.close());
    modal.querySelector('.otw-modal-backdrop').addEventListener('click', () => modal.close());
    return modal;
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  let building = false;

  const teardown = () => {
    session?.destroy();
    session = null;
    document.body.classList.remove('otw-on');
  };

  const tick = async () => {
    if (building) return;
    const target = detectTarget();
    if (!target) { if (session) teardown(); return; }

    if (session) {
      if (session.target.key !== target.key) teardown();
      else if (!session.toggleBtn.isConnected || !session.frame.isConnected) teardown();
      else {
        // Only VOD chat can be pulled out from under us; live is an iframe.
        if (overlayEnabled && target.kind === 'vod' && state_vodLost(session)) {
          session.vodChat = null;
          session.setEnabled(true);
        }
        return;
      }
    }

    if (!document.querySelector(SEL.playerOverlay) || !document.querySelector(SEL.rightControls)) return;
    building = true;
    try {
      session = await createSession(target);
      if (session && overlayEnabled) session.setEnabled(true);
    } catch (e) {
      warn('setup failed', e);
      session = null;
    } finally { building = false; }
  };

  const state_vodLost = s => !s.vodChat || !s.vodChat.node.isConnected;

  const onHotkey = e => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (String(e.key).toLowerCase() !== 'c') return;
    const a = document.activeElement;
    if (a && (a.isContentEditable || /^(input|textarea|select)$/i.test(a.tagName))) return;
    if (!session) return;
    e.preventDefault();
    session.setEnabled(!overlayEnabled, true);
  };

  injectPageStyle();
  document.addEventListener('keydown', onHotkey, true);

  (async () => {
    await store.removeMatching(k => k.startsWith('ch:') || k.startsWith('vod:')); // 1.x leftovers
    overlayEnabled = (await store.get(ENABLED_KEY, false)) === true;
    setInterval(tick, 1000);
    tick();
    log(`v${VERSION} loaded${overlayEnabled ? ' (opens automatically)' : ''}`);
  })();
})();
