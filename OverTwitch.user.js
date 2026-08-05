// ==UserScript==
// @name         OverTwitch - Cinematic Chat Overlay
// @namespace    overtwitch-chat-overlay
// @version      1.0.0
// @description  Puts Twitch's REAL chat on top of the player: transparent message text when idle, full interactive chat (input, badges, cards, mod actions, 7TV/BTTV/FFZ emotes) on hover. Drag, resize, restyle, works in fullscreen and theater, live and VODs. Per-channel settings, auto-claim channel points. Userscript port of Anu Twitch Chat Overlay.
// @author       Kristijan1001
// @icon         https://www.google.com/s2/favicons?sz=64&domain=twitch.tv
// @match        https://www.twitch.tv/*
// @exclude      https://www.twitch.tv/popout/*
// @exclude      https://www.twitch.tv/embed/*
// @exclude      https://www.twitch.tv/*/chat*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @license      ISC
// ==/UserScript==

/*
  OverTwitch — a single-file userscript port of Anu Twitch Chat Overlay
  (https://github.com/akhanubis/anu_twitch_chat_overlay) by Pablo Bianciotto
  (akhanubis), ISC licensed. See LICENSE for both copyright notices.

  How it works
  ------------
  The overlay does NOT clone chat or open a second connection. It physically
  relocates Twitch's own chat node into a floating box inside
  `.video-player__overlay`, so usernames, viewer cards, badges, mod actions,
  emote tooltips, third-party emote extensions and sending all keep working
  natively. Turning the overlay off puts the node back exactly where it was.

  Two visual states:
    • Idle  -> background goes translucent, input/headers/scrollbars hide,
               message text gets your font + outline. OLED-friendly.
    • Hover -> the real chat comes back solid, with the input, plus the
               drag bar, resize grips and the settings gear.

  Notable differences from the original extension:
    • No iframe and no popout chat — one code path for live and VODs, which is
      what the extension's "avoid iframes" option did for performance and for
      third-party emote support.
    • Settings are plain JSON, not underscore-joined strings.
    • Pointer Events with pointer capture for drag/resize, so there are no
      document-level listener leaks across SPA navigations.
    • Selectors updated for Twitch's 2026 DOM. In particular the original's
      username selector (`.chat-line__message > *:nth-child(-n+3)`) would now
      hide the entire message, since a message has a single wrapper child.
    • No bundled dependencies (MicroModal / iro.js are replaced with ~100 lines).

  Known constraint (inherited, not fixable from a userscript): Twitch unmounts
  the chat component when you collapse the right column, so the column has to
  stay expanded. Enabling the overlay re-expands it for you. In fullscreen and
  theater mode the column is out of view anyway, which is the point.

  Shortcut: Alt+C toggles the overlay.
*/

(function () {
  'use strict';

  const TAG = '[OverTwitch]';
  const NS = 'otw';
  const VERSION = '1.0.0';
  const HOME = 'https://github.com/Kristijan1001/OverTwitch';

  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  /* ------------------------------------------------------------------ *
   * Storage — GM_* when available, GM.* for Greasemonkey 4, else
   * localStorage. Everything is stored as a JSON string either way.
   * ------------------------------------------------------------------ */

  const store = (() => {
    const hasSync = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
    const hasAsync = typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function';
    const lsKey = k => `${NS}:${k}`;

    const parse = (raw, fallback) => {
      if (raw == null) return fallback;
      try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) {
        warn('discarding unreadable setting', e);
        return fallback;
      }
    };

    return {
      async get(key, fallback) {
        try {
          if (hasSync) return parse(GM_getValue(key, null), fallback);
          if (hasAsync) return parse(await GM.getValue(key, null), fallback);
          return parse(localStorage.getItem(lsKey(key)), fallback);
        } catch (e) {
          warn('settings read failed', e);
          return fallback;
        }
      },
      async set(key, value) {
        const raw = JSON.stringify(value);
        try {
          if (hasSync) return GM_setValue(key, raw);
          if (hasAsync) return GM.setValue(key, raw);
          localStorage.setItem(lsKey(key), raw);
        } catch (e) {
          warn('settings write failed', e);
        }
      },
    };
  })();

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  const DEFAULTS = Object.freeze({
    position: { left: 77, top: 6, right: 1.5, bottom: 8 }, // percentages of the player box
    background: 'rgba(0, 0, 0, 0.25)',
    font: {
      family: '',            // '' means inherit Twitch's own font
      size: 13,
      weight: 'normal',
      color: 'rgba(255, 255, 255, 1)',
      outline: 'rgba(0, 0, 0, 1)',
    },
    hideUsernames: false,
    hideTimestamps: false,
    autoClaim: false,
  });

  const DEFAULT_KEY = '__default__';

  /** Deep-ish merge that only trusts keys and value shapes we know about. */
  const mergeSettings = (...sources) => {
    const out = structuredClone(DEFAULTS);
    for (const src of sources) {
      if (!src || typeof src !== 'object') continue;
      for (const key of Object.keys(DEFAULTS)) {
        const value = src[key];
        if (value == null) continue;
        if (key === 'position' || key === 'font') {
          if (typeof value !== 'object') continue;
          for (const sub of Object.keys(DEFAULTS[key])) {
            if (value[sub] != null && typeof value[sub] === typeof DEFAULTS[key][sub]) out[key][sub] = value[sub];
          }
        } else if (typeof value === typeof DEFAULTS[key]) {
          out[key] = value;
        }
      }
    }
    return out;
  };

  const loadSettings = async channelKey => {
    const [fallback, mine] = await Promise.all([
      store.get(DEFAULT_KEY, null),
      channelKey ? store.get(channelKey, null) : Promise.resolve(null),
    ]);
    return mergeSettings(fallback, mine);
  };

  /* Saving writes both the channel key and the global default, so a fresh
     channel inherits whatever you tuned last — same as the original. */
  const saveSettings = async (channelKey, settings) => {
    await store.set(DEFAULT_KEY, settings);
    if (channelKey) await store.set(channelKey, settings);
  };

  /* ------------------------------------------------------------------ *
   * Small helpers
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
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v != null) node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  };

  const svg = (viewBox, paths, size = 20) =>
    `<svg viewBox="${viewBox}" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    paths.map(d => `<path d="${d}"></path>`).join('') +
    '</svg>';

  const ICONS = {
    chatOn: svg('0 0 32 32', ['M 3 6 L 3 26 L 12.585938 26 L 16 29.414063 L 19.414063 26 L 29 26 L 29 6 Z M 5 8 L 27 8 L 27 24 L 18.585938 24 L 16 26.585938 L 13.414063 24 L 5 24 Z M 9 11 L 9 13 L 23 13 L 23 11 Z M 9 15 L 9 17 L 23 17 L 23 15 Z M 9 19 L 9 21 L 19 21 L 19 19 Z']),
    chatOff: svg('0 0 32 32', ['M 3 5 L 3 23 L 8 23 L 8 28.078125 L 14.351563 23 L 29 23 L 29 5 Z M 5 7 L 27 7 L 27 21 L 13.648438 21 L 10 23.917969 L 10 21 L 5 21 Z']),
    gear: svg('0 0 20 20', ['M10 8a2 2 0 100 4 2 2 0 000-4z', 'M9 2h2a2.01 2.01 0 001.235 1.855l.53.22a2.01 2.01 0 002.185-.439l1.414 1.414a2.01 2.01 0 00-.439 2.185l.22.53A2.01 2.01 0 0018 9v2a2.01 2.01 0 00-1.855 1.235l-.22.53a2.01 2.01 0 00.44 2.185l-1.415 1.414a2.01 2.01 0 00-2.184-.439l-.531.22A2.01 2.01 0 0011 18H9a2.01 2.01 0 00-1.235-1.854l-.53-.22a2.009 2.009 0 00-2.185.438L3.636 14.95a2.009 2.009 0 00.438-2.184l-.22-.531A2.01 2.01 0 002 11V9c.809 0 1.545-.487 1.854-1.235l.22-.53a2.009 2.009 0 00-.438-2.185L5.05 3.636a2.01 2.01 0 002.185.438l.53-.22A2.01 2.01 0 009 2zm-4 8l1.464 3.536L10 15l3.535-1.464L15 10l-1.465-3.536L10 5 6.464 6.464 5 10z'], 16),
    move: svg('0 0 32 32', ['M 16 1.5859375 L 10.292969 7.2929688 L 11.707031 8.7070312 L 15 5.4140625 L 15 15 L 5.4140625 15 L 8.7070312 11.707031 L 7.2929688 10.292969 L 1.5859375 16 L 7.2929688 21.707031 L 8.7070312 20.292969 L 5.4140625 17 L 15 17 L 15 26.585938 L 11.707031 23.292969 L 10.292969 24.707031 L 16 30.414062 L 21.707031 24.707031 L 20.292969 23.292969 L 17 26.585938 L 17 17 L 26.585938 17 L 23.292969 20.292969 L 24.707031 21.707031 L 30.414062 16 L 24.707031 10.292969 L 23.292969 11.707031 L 26.585938 15 L 17 15 L 17 5.4140625 L 20.292969 8.7070312 L 21.707031 7.2929688 L 16 1.5859375 z'], 16),
  };

  /* --- colour conversion: the pickers are <input type="color"> + alpha --- */

  const parseRgba = value => {
    const m = String(value || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/i);
    if (!m) return { r: 0, g: 0, b: 0, a: 1 };
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
  };
  const toHex = value => {
    const { r, g, b } = parseRgba(value);
    return '#' + [r, g, b].map(n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('');
  };
  const toAlpha = value => Math.round(parseRgba(value).a * 100);
  const buildRgba = (hex, alphaPercent) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    const n = m ? parseInt(m[1], 16) : 0;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${round2(clamp(alphaPercent, 0, 100) / 100)})`;
  };
  const outlineShadow = colour =>
    `-1px -1px 0 ${colour}, 1px -1px 0 ${colour}, 1px 1px 0 ${colour}, -1px 1px 0 ${colour}`;

  /* ------------------------------------------------------------------ *
   * Twitch DOM
   * ------------------------------------------------------------------ */

  const SEL = {
    playerOverlay: '.video-player__overlay',
    rightControls: '.player-controls__right-control-group',
    liveChat: 'section.chat-room, .chat-room__content',
    vodChat: '.video-chat',
    rightColumn: '.channel-root__right-column',
    collapseBtn: '[data-a-target="right-column__toggle-collapse-btn"]',
    scroller: '.chat-list--default .scrollable-area, .video-chat__message-list-wrapper',
    claimable: '.claimable-bonus__icon',
  };

  const NON_CHANNEL = new Set([
    '', 'directory', 'videos', 'settings', 'subscriptions', 'inventory', 'wallet',
    'drops', 'friends', 'downloads', 'jobs', 'turbo', 'prime', 'store', 'search',
    'following', 'u', 'p', 'products', 'payments', 'moderator', 'popout', 'embed',
  ]);

  /**
   * `key` identifies the session (which page we are on). It is not where
   * settings live — see resolveSettings, which maps a VOD onto its channel.
   * @returns {{kind:'live'|'vod', id:string, key:string}|null}
   */
  const detectTarget = () => {
    const path = location.pathname.replace(/^\/+|\/+$/g, '');
    const parts = path.split('/');
    const vod = path.match(/^videos\/(\d+)/);
    if (vod) return { kind: 'vod', id: vod[1], key: `vod:${vod[1]}` };
    const name = (parts[0] || '').toLowerCase();
    if (!name || NON_CHANNEL.has(name) || !/^[a-z0-9_]+$/.test(name)) return null;
    // /<channel>, /<channel>/home and squad views carry a player; /about, /schedule etc. do not.
    if (parts[1] && !['home', 'squad'].includes(parts[1])) return null;
    return { kind: 'live', id: name, key: `ch:${name}` };
  };

  /** The channel a VOD belongs to, so its settings sit with the live channel's. */
  const resolveVodChannel = () => {
    const scope = document.querySelector('.channel-info-content') || document;
    for (const a of scope.querySelectorAll('a[href^="/"]')) {
      const m = a.getAttribute('href').match(/^\/([a-z0-9_]+)(?:[/?#]|$)/i);
      const name = m && m[1].toLowerCase();
      if (name && !NON_CHANNEL.has(name)) return name;
    }
    return null;
  };

  /** Where this page's settings are stored, and what the Apply button says. */
  const resolveSettings = target => {
    if (target.kind === 'live') return { key: `ch:${target.id}`, label: target.id };
    const channel = resolveVodChannel();
    return channel
      ? { key: `ch:${channel}`, label: channel }
      : { key: null, label: `VOD ${target.id}` }; // unresolvable: read/write the global default only
  };

  /**
   * The node we relocate. For live chat that's `section.chat-room` (the header
   * and leaderboard sit above it and stay behind); for VODs, `.video-chat`.
   */
  const findChatNode = kind => {
    if (kind === 'vod') return document.querySelector(SEL.vodChat);
    const section = document.querySelector('section.chat-room');
    if (section) return section;
    const content = document.querySelector('.chat-room__content');
    return content ? content.parentElement : null;
  };

  const isSidebarCollapsed = () => {
    const column = document.querySelector(SEL.rightColumn);
    return !!column && !column.classList.contains('channel-root__right-column--expanded');
  };

  const expandSidebar = () => {
    const btn = document.querySelector(SEL.collapseBtn);
    if (btn && isSidebarCollapsed()) btn.click();
  };

  /* ------------------------------------------------------------------ *
   * Stylesheet — injected once. Everything that varies per user is a CSS
   * custom property set on the frame, so live preview is a one-liner.
   * ------------------------------------------------------------------ */

  const CSS = `
  /* ---- toggle button in the player controls ---- */
  .otw-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 3rem; height: 3rem; padding: 0; margin: 0;
    background: none; border: 0; border-radius: .4rem;
    color: #fff; cursor: pointer; opacity: .9;
    transition: opacity .1s ease-in, background-color .1s ease-in;
  }
  .otw-toggle:hover { opacity: 1; background-color: rgba(255,255,255,.2); }
  .otw-toggle:focus-visible { outline: 2px solid var(--color-background-accent, #9147ff); outline-offset: 1px; }
  .otw-toggle svg { fill: currentColor; width: 20px; height: 20px; pointer-events: none; }
  .otw-toggle .otw-icon-on { display: none; }
  body.otw-on .otw-toggle .otw-icon-on { display: block; }
  body.otw-on .otw-toggle .otw-icon-off { display: none; }

  /* ---- the floating chat frame ---- */
  .otw-frame {
    position: absolute; display: none; z-index: 15;
    min-width: 160px; min-height: 90px;
    overflow: hidden; border-radius: 4px;
    contain: layout paint;
    --otw-bg: rgba(0,0,0,.25);
    --otw-font-size: 13px;
    --otw-font-family: inherit;
    --otw-font-weight: normal;
    --otw-color: #fff;
    --otw-outline: none;
  }
  body.otw-on .otw-frame { display: block; }
  body.otw-dragging, body.otw-dragging * { cursor: grabbing !important; user-select: none !important; }
  body.otw-resizing * { user-select: none !important; }

  .otw-host { position: absolute; inset: 0; display: flex; flex-direction: column; }

  /* Make Twitch's chat fill the frame: every wrapper on the path to the
     message scroller has to be a zero-min-height flex child. */
  .otw-host > .chat-room,
  .otw-host > .video-chat { flex: 1 1 auto; min-height: 0; width: 100%; height: 100%; display: flex; flex-direction: column; background: transparent !important; }
  .otw-host .chat-room__content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; background: transparent !important; }
  .otw-host .chat-list--default { flex: 1 1 auto; min-height: 0; }
  .otw-host .video-chat__message-list-wrapper { flex: 1 1 auto; min-height: 0; }
  .otw-host .chat-input { max-height: 45%; overflow-y: auto; flex: 0 0 auto; }
  /* drops / hype train / channel-point stack: out of the way when idle, back on hover */
  .otw-frame:not(.otw-hover) .otw-host .chat-room__content > *:first-child { display: none; }

  /* ---- idle: get out of the way ---- */
  .otw-frame:not(.otw-hover) .otw-host { background: var(--otw-bg) !important; }
  .otw-frame.otw-hover .otw-host { background: var(--color-background-base, #18181b); }

  .otw-frame:not(.otw-hover) .chat-input,
  .otw-frame:not(.otw-hover) .stream-chat-header,
  .otw-frame:not(.otw-hover) .video-chat__header,
  .otw-frame:not(.otw-hover) .chat-room__notifications,
  .otw-frame:not(.otw-hover) .chat-line__icons,
  .otw-frame:not(.otw-hover) .chat-room__viewer-card { display: none !important; }

  .otw-frame:not(.otw-hover) .scrollable-area,
  .otw-frame:not(.otw-hover) .video-chat__message-list-wrapper { scrollbar-width: none; }
  .otw-frame:not(.otw-hover) .scrollable-area::-webkit-scrollbar,
  .otw-frame:not(.otw-hover) .video-chat__message-list-wrapper::-webkit-scrollbar { width: 0 !important; height: 0 !important; }

  /* message styling only applies idle — on hover you get the real chat back */
  .otw-frame:not(.otw-hover) .chat-line__message,
  .otw-frame:not(.otw-hover) .vod-message {
    font-family: var(--otw-font-family);
    font-size: var(--otw-font-size);
    font-weight: var(--otw-font-weight);
    color: var(--otw-color);
    text-shadow: var(--otw-outline);
    line-height: calc(var(--otw-font-size) * 1.45);
    background: transparent !important;
    padding-left: .5rem; padding-right: .5rem;
  }
  .otw-frame:not(.otw-hover) .chat-line__message .chat-line__message--badges img { vertical-align: middle; }
  .otw-frame:not(.otw-hover) .chat-line__message .tw-elevation-1,
  .otw-frame:not(.otw-hover) .chat-line__message [class*="chat-line__message--"] { box-shadow: none !important; }

  .otw-frame.otw-hide-users:not(.otw-hover) .chat-line__username-container,
  .otw-frame.otw-hide-users:not(.otw-hover) .chat-line__username-container + span,
  .otw-frame.otw-hide-users:not(.otw-hover) .vod-message__header { display: none !important; }
  .otw-frame.otw-hide-stamps:not(.otw-hover) .chat-line__timestamp,
  .otw-frame.otw-hide-stamps:not(.otw-hover) .vod-message__header__timestamp { display: none !important; }

  /* ---- drag bar ---- */
  .otw-bar {
    position: absolute; top: 0; left: 0; right: 0; height: 32px; z-index: 20;
    display: none; align-items: center; gap: 6px; padding: 0 6px;
    background: linear-gradient(to bottom, rgba(0,0,0,.75), rgba(0,0,0,0));
    color: #fff; font: 600 11px/1 var(--otw-ui-font, inherit); letter-spacing: .06em;
    text-transform: uppercase; cursor: grab; touch-action: none;
  }
  .otw-frame.otw-hover .otw-bar { display: flex; }
  .otw-bar-title { flex: 1 1 auto; text-align: center; opacity: .85; pointer-events: none;
                   overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .otw-bar-btn {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px;
    background: none; color: #fff; opacity: .8; cursor: pointer;
  }
  .otw-bar-btn:hover { opacity: 1; background: rgba(255,255,255,.2); }
  .otw-bar-btn svg { fill: currentColor; pointer-events: none; }
  .otw-bar-grab { cursor: grab; }

  /* ---- resize grips ---- */
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

  /* ---- modal ---- */
  .otw-modal { position: absolute; inset: 0; z-index: 9000; display: none; }
  .otw-modal.otw-open { display: flex; align-items: center; justify-content: center; }
  .otw-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.65); }
  .otw-modal-box {
    position: relative; display: flex; flex-direction: column;
    width: min(520px, 94%); max-height: min(94%, 560px);
    background: var(--color-background-base, #18181b);
    color: var(--color-text-base, #efeff1);
    border-radius: 6px; box-shadow: 0 8px 32px rgba(0,0,0,.6);
    font: 400 13px/1.5 inherit; overflow: hidden;
  }
  .otw-modal-head {
    display: flex; align-items: center; gap: 8px; padding: 12px 14px;
    border-bottom: 1px solid var(--color-border-base, rgba(83,83,95,.48));
    font-weight: 600; font-size: 14px;
  }
  .otw-modal-head .otw-spacer { flex: 1 1 auto; }
  .otw-modal-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 14px 14px; }
  .otw-modal-foot {
    display: flex; align-items: center; gap: 8px; padding: 12px 14px;
    border-top: 1px solid var(--color-border-base, rgba(83,83,95,.48));
    background: var(--color-background-alt, #26262c);
  }
  .otw-modal-foot .otw-spacer { flex: 1 1 auto; }

  .otw-note { opacity: .7; font-size: 12px; margin: 10px 0 4px; }
  .otw-row { display: flex; align-items: center; gap: 10px; padding: 9px 0;
             border-top: 1px solid var(--color-border-base, rgba(83,83,95,.28)); }
  .otw-row:first-of-type { border-top: 0; }
  .otw-row > label:first-child, .otw-row > .otw-label { flex: 0 0 38%; font-size: 13px; }
  .otw-row > .otw-control { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .otw-tip { flex-basis: 100%; opacity: .6; font-size: 11px; }

  .otw-btn {
    padding: 5px 11px; border: 0; border-radius: 4px; cursor: pointer;
    font: 600 12px/1.6 inherit;
    background: var(--color-background-button-secondary-default, rgba(255,255,255,.15));
    color: var(--color-text-base, #efeff1);
  }
  .otw-btn:hover { filter: brightness(1.2); }
  .otw-btn.otw-primary { background: var(--color-background-button-primary-default, #9147ff); color: #fff; }
  .otw-seg { display: inline-flex; border-radius: 4px; overflow: hidden; }
  .otw-seg .otw-btn { border-radius: 0; }
  .otw-seg .otw-btn[aria-pressed="true"] { background: var(--color-background-button-primary-default, #9147ff); color: #fff; }

  .otw-modal input[type="number"], .otw-modal select, .otw-modal input[type="text"] {
    background: var(--color-background-input, #18181b);
    color: var(--color-text-base, #efeff1);
    border: 1px solid var(--color-border-base, rgba(83,83,95,.48));
    border-radius: 4px; padding: 4px 6px; font: inherit; font-size: 12px;
  }
  .otw-modal input[type="number"] { width: 68px; }
  .otw-modal input[type="text"] { flex: 1 1 120px; min-width: 0; }
  .otw-modal select { min-width: 130px; }
  .otw-modal input[type="color"] { width: 34px; height: 26px; padding: 0; border: 0; background: none; cursor: pointer; }
  .otw-modal input[type="range"] { flex: 1 1 90px; min-width: 80px; accent-color: var(--color-background-button-primary-default, #9147ff); }
  .otw-swatch { width: 26px; height: 26px; border-radius: 4px; border: 1px solid rgba(255,255,255,.3);
                background-image: linear-gradient(45deg,#666 25%,transparent 25%,transparent 75%,#666 75%),
                                  linear-gradient(45deg,#666 25%,#999 25%,#999 75%,#666 75%);
                background-size: 10px 10px; background-position: 0 0, 5px 5px; }
  .otw-swatch > span { display: block; width: 100%; height: 100%; border-radius: 3px; }

  /* placement mini-map */
  .otw-map { position: relative; width: 190px; aspect-ratio: 16 / 9; background: #3a3a3d;
             border-radius: 3px; overflow: hidden; flex: 0 0 auto; }
  .otw-map-box { position: absolute; background: rgba(145,71,255,.55); border: 1px solid #fff;
                 cursor: grab; touch-action: none; }
  .otw-map-grip { position: absolute; right: -1px; bottom: -1px; width: 12px; height: 12px;
                  background: #fff; cursor: nwse-resize; touch-action: none; }

  .otw-about a { color: var(--color-text-link, #bf94ff); }
  .otw-about p { margin: 8px 0; }
  .otw-version { opacity: .5; font-size: 11px; }
  `;

  const injectStyle = () => {
    if (document.getElementById('otw-style')) return;
    document.head.append(el('style', { id: 'otw-style', text: CSS }));
  };

  /* ------------------------------------------------------------------ *
   * Geometry — a rect is {left, top, right, bottom} in % of its container
   * ------------------------------------------------------------------ */

  const MIN_W = 160;
  const MIN_H = 90;

  /**
   * The minimum overlay size, expressed as a percentage of the player. The
   * settings mini-map is a scale model of the player, so quoting the minimum
   * in percent lets the map enforce exactly the same limit as the real frame
   * without knowing how big either box is.
   */
  const minPercent = () => {
    const player = document.querySelector(SEL.playerOverlay);
    const w = player?.clientWidth || 1280;
    const h = player?.clientHeight || 720;
    return { w: clamp((MIN_W / w) * 100, 1, 90), h: clamp((MIN_H / h) * 100, 1, 90) };
  };

  const applyRect = (node, rect) => {
    node.style.left = `${rect.left}%`;
    node.style.top = `${rect.top}%`;
    node.style.right = `${rect.right}%`;
    node.style.bottom = `${rect.bottom}%`;
  };

  const pxToRect = (bounds, minX, minY, maxX, maxY) => ({
    left: round2(clamp((100 * minX) / bounds.width, 0, 100)),
    top: round2(clamp((100 * minY) / bounds.height, 0, 100)),
    right: round2(clamp(100 - (100 * maxX) / bounds.width, 0, 100)),
    bottom: round2(clamp(100 - (100 * maxY) / bounds.height, 0, 100)),
  });

  /**
   * Drag `node` inside `container` by pressing `handle`. Uses pointer capture
   * so the pointer stream keeps arriving even outside the window, which means
   * no document-level listeners to leak.
   */
  const makeDraggable = (node, container, handle, { onMove, onEnd } = {}) => {
    handle.addEventListener('pointerdown', event => {
      // Buttons in the drag bar, and the mini-map's resize grip, are not drag starts.
      if (event.button !== 0 || event.target.closest('.otw-bar-btn, .otw-map-grip')) return;
      event.preventDefault();
      event.stopPropagation();

      const bounds = container.getBoundingClientRect();
      const start = node.getBoundingClientRect();
      const grabX = event.clientX - start.left;
      const grabY = event.clientY - start.top;
      const width = start.width;
      const height = start.height;

      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('otw-dragging');

      let last = pxToRect(bounds, start.left - bounds.left, start.top - bounds.top,
        start.left - bounds.left + width, start.top - bounds.top + height);
      const move = ev => {
        const x = clamp(ev.clientX - bounds.left - grabX, 0, Math.max(0, bounds.width - width));
        const y = clamp(ev.clientY - bounds.top - grabY, 0, Math.max(0, bounds.height - height));
        last = pxToRect(bounds, x, y, x + width, y + height);
        applyRect(node, last);
        onMove?.(last);
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ }
        document.body.classList.remove('otw-dragging');
        onEnd?.(last);
      };

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  };

  /** Wire one resize grip. `dirs` is a subset of {l,r,t,b}. */
  const makeResizable = (node, container, grip, dirs, { onMove, onEnd } = {}) => {
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const bounds = container.getBoundingClientRect();
      const start = node.getBoundingClientRect();
      const originX = event.clientX;
      const originY = event.clientY;
      const x0 = start.left - bounds.left;
      const y0 = start.top - bounds.top;
      const x1 = x0 + start.width;
      const y1 = y0 + start.height;

      grip.setPointerCapture(event.pointerId);
      document.body.classList.add('otw-resizing');

      // Scale the minimum into this container's pixels, so the mini-map and the
      // real overlay stop at the same place.
      const pct = minPercent();
      const minW = (bounds.width * pct.w) / 100;
      const minH = (bounds.height * pct.h) / 100;

      let last = null;
      const move = ev => {
        const dx = ev.clientX - originX;
        const dy = ev.clientY - originY;
        let minX = x0;
        let minY = y0;
        let maxX = x1;
        let maxY = y1;
        if (dirs.includes('l')) minX = clamp(x0 + dx, 0, x1 - minW);
        if (dirs.includes('r')) maxX = clamp(x1 + dx, x0 + minW, bounds.width);
        if (dirs.includes('t')) minY = clamp(y0 + dy, 0, y1 - minH);
        if (dirs.includes('b')) maxY = clamp(y1 + dy, y0 + minH, bounds.height);
        last = pxToRect(bounds, minX, minY, maxX, maxY);
        applyRect(node, last);
        onMove?.(last);
      };
      const end = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        grip.removeEventListener('pointercancel', end);
        try { grip.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
        document.body.classList.remove('otw-resizing');
        if (last) onEnd?.(last);
      };

      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    });
  };

  /* ------------------------------------------------------------------ *
   * Reusable modal
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
    // Clicks inside the player overlay must not reach Twitch's play/pause handler.
    modal.addEventListener('click', e => e.stopPropagation());
    modal.addEventListener('pointerdown', e => e.stopPropagation());
    return modal;
  };

  /* ------------------------------------------------------------------ *
   * Session — one per channel/VOD. Owns every node and listener it creates.
   * ------------------------------------------------------------------ */

  let session = null;
  let overlayEnabled = false; // survives navigation, like the original

  const createSession = async target => {
    const overlay = document.querySelector(SEL.playerOverlay);
    const controls = document.querySelector(SEL.rightControls);
    if (!overlay || !controls) return null;

    const { key: settingsKey, label } = resolveSettings(target);
    const settings = await loadSettings(settingsKey);

    /* --- frame --------------------------------------------------------- */
    const host = el('div', { class: 'otw-host' });
    const bar = el('div', { class: 'otw-bar' }, [
      el('button', { class: 'otw-bar-btn', type: 'button', title: 'Overlay settings', 'aria-label': 'Overlay settings', html: ICONS.gear }),
      el('div', { class: 'otw-bar-title', text: 'Chat' }),
      el('span', { class: 'otw-bar-btn otw-bar-grab', title: 'Drag to move', html: ICONS.move }),
    ]);
    const grips = ['l', 'r', 't', 'b', 'tl', 'tr', 'bl', 'br'].map(d =>
      el('div', { class: `otw-grip otw-grip-${d}`, 'data-dir': d }));

    const frame = el('div', { class: 'otw-frame' }, [host, bar, ...grips]);
    applyRect(frame, settings.position);

    /* --- toggle button ------------------------------------------------- */
    const toggleBtn = el('button', {
      class: 'otw-toggle',
      type: 'button',
      title: 'Chat overlay (Alt+C)',
      'aria-label': 'Toggle chat overlay',
      html: `<span class="otw-icon-on">${ICONS.chatOn}</span><span class="otw-icon-off">${ICONS.chatOff}</span>`,
    });

    /* --- state --------------------------------------------------------- */
    const state = {
      target,
      settingsKey,
      settings,
      saved: structuredClone(settings), // what's on disk, for Cancel
      frame,
      host,
      toggleBtn,
      overlay,
      detached: null,   // { node, parent, next }
      claimTimer: 0,
      claimObserver: null,
      modals: [],
      destroyed: false,
    };

    /* --- applying settings --------------------------------------------- */
    const applyLook = s => {
      frame.style.setProperty('--otw-bg', s.background);
      frame.style.setProperty('--otw-font-family', s.font.family || 'inherit');
      frame.style.setProperty('--otw-font-size', `${s.font.size}px`);
      frame.style.setProperty('--otw-font-weight', s.font.weight);
      frame.style.setProperty('--otw-color', s.font.color);
      frame.style.setProperty('--otw-outline', parseRgba(s.font.outline).a > 0 ? outlineShadow(s.font.outline) : 'none');
      frame.classList.toggle('otw-hide-users', !!s.hideUsernames);
      frame.classList.toggle('otw-hide-stamps', !!s.hideTimestamps);
      setAutoClaim(!!s.autoClaim);
    };

    const applyAll = s => { applyRect(frame, s.position); applyLook(s); };

    /* --- auto-claim channel points ------------------------------------- */
    const claimNow = () => {
      const button = document.querySelector(SEL.claimable);
      if (button) button.click(); // works even while the bonus stack is display:none
    };
    const setAutoClaim = on => {
      state.claimObserver?.disconnect();
      state.claimObserver = null;
      clearInterval(state.claimTimer);
      state.claimTimer = 0;
      if (!on) return;
      claimNow();
      const root = state.detached?.node || document.querySelector('.chat-room__content');
      if (root) {
        state.claimObserver = new MutationObserver(claimNow);
        state.claimObserver.observe(root, { childList: true, subtree: true });
      }
      // Backstop for the case where the bonus renders outside the observed root.
      state.claimTimer = setInterval(claimNow, 15000);
    };

    /* --- attach / detach the real chat --------------------------------- */
    const attachChat = () => {
      if (state.detached) return true;
      if (isSidebarCollapsed()) {
        expandSidebar();
        return false; // the poll will retry once React has remounted chat
      }
      const node = findChatNode(target.kind);
      if (!node) return false;
      state.detached = { node, parent: node.parentElement, next: node.nextSibling };
      host.append(node);
      if (state.settings.autoClaim) setAutoClaim(true);
      return true;
    };

    const restoreChat = () => {
      const d = state.detached;
      state.detached = null;
      if (!d || !d.node) return;
      if (d.parent && d.parent.isConnected) {
        const before = d.next && d.next.parentElement === d.parent ? d.next : null;
        d.parent.insertBefore(d.node, before);
      } else {
        d.node.remove(); // React already tore the column down
      }
    };

    const scrollToBottom = () => {
      const scroller = host.querySelector(SEL.scroller);
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    };

    /* --- enable / disable ---------------------------------------------- */
    const setEnabled = on => {
      overlayEnabled = on;
      document.body.classList.toggle('otw-on', on);
      if (on) {
        if (!attachChat()) return;
        applyAll(state.settings);
        requestAnimationFrame(scrollToBottom);
      } else {
        frame.classList.remove('otw-hover');
        restoreChat();
        setAutoClaim(false);
      }
    };
    state.setEnabled = setEnabled;

    toggleBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); setEnabled(!overlayEnabled); });

    frame.addEventListener('mouseenter', () => { frame.classList.add('otw-hover'); scrollToBottom(); });
    frame.addEventListener('mouseleave', () => frame.classList.remove('otw-hover'));
    // Keep clicks inside chat from pausing the video.
    frame.addEventListener('click', e => e.stopPropagation());
    frame.addEventListener('dblclick', e => e.stopPropagation());
    frame.addEventListener('pointerdown', e => e.stopPropagation());

    /* --- drag & resize -------------------------------------------------- */
    const persistPosition = rect => {
      state.settings.position = rect;
      saveSettings(settingsKey, state.settings);
      state.saved = structuredClone(state.settings);
    };
    makeDraggable(frame, overlay, bar, { onEnd: persistPosition });
    for (const grip of grips) {
      makeResizable(frame, overlay, grip, grip.dataset.dir, { onEnd: persistPosition });
    }

    /* --- settings panel -------------------------------------------------- */
    const panel = buildSettingsPanel(state, { applyAll, applyLook, label });
    const about = buildAboutPanel();
    state.modals.push(panel, about);
    panel.onAbout = () => about.open();
    bar.querySelector('.otw-bar-btn').addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      panel.showWith(state.settings);
    });

    /* --- mount ---------------------------------------------------------- */
    overlay.append(frame, panel, about);
    controls.prepend(toggleBtn);
    applyAll(settings);

    state.destroy = () => {
      if (state.destroyed) return;
      state.destroyed = true;
      state.claimObserver?.disconnect();
      clearInterval(state.claimTimer);
      restoreChat();
      frame.remove();
      toggleBtn.remove();
      for (const m of state.modals) m.remove();
    };

    log(`ready for ${label}`);
    return state;
  };

  /* ------------------------------------------------------------------ *
   * Settings panel
   * ------------------------------------------------------------------ */

  const FONT_FAMILIES = [
    ['Twitch default', ''],
    ['System UI', 'system-ui, sans-serif'],
    ['Sans-serif', 'sans-serif'],
    ['Serif', 'serif'],
    ['Monospace', 'ui-monospace, monospace'],
    ['Cursive', 'cursive'],
    ['Fantasy', 'fantasy'],
    ['Custom…', 'custom'],
  ];

  const colourControl = onChange => {
    const hex = el('input', { type: 'color' });
    const alpha = el('input', { type: 'range', min: '0', max: '100', step: '1' });
    const fill = el('span');
    const swatch = el('div', { class: 'otw-swatch' }, fill);
    const emit = () => {
      const value = buildRgba(hex.value, +alpha.value);
      fill.style.background = value;
      onChange(value);
    };
    hex.addEventListener('input', emit);
    alpha.addEventListener('input', emit);
    return {
      nodes: [hex, alpha, swatch],
      set(value) {
        hex.value = toHex(value);
        alpha.value = toAlpha(value);
        fill.style.background = value;
      },
      get: () => buildRgba(hex.value, +alpha.value),
    };
  };

  const segmented = (options, onChange) => {
    const buttons = options.map(([text, value]) =>
      el('button', { class: 'otw-btn', type: 'button', 'data-value': value, text, 'aria-pressed': 'false' }));
    const group = el('div', { class: 'otw-seg' }, buttons);
    const select = value => {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === String(value)));
    };
    for (const b of buttons) {
      b.addEventListener('click', e => { e.preventDefault(); select(b.dataset.value); onChange(b.dataset.value); });
    }
    return { node: group, set: select, get: () => buttons.find(b => b.getAttribute('aria-pressed') === 'true')?.dataset.value };
  };

  const row = (labelText, controls, tip) =>
    el('div', { class: 'otw-row' }, [
      el('div', { class: 'otw-label', text: labelText }),
      el('div', { class: 'otw-control' }, [...[].concat(controls), tip ? el('div', { class: 'otw-tip', html: tip }) : null]),
    ]);

  function buildSettingsPanel(state, { applyAll, applyLook, label }) {
    const draft = structuredClone(state.settings);
    const preview = () => applyLook(draft);

    /* placement mini-map */
    const mapBox = el('div', { class: 'otw-map-box' }, el('div', { class: 'otw-map-grip' }));
    const map = el('div', { class: 'otw-map' }, mapBox);
    const onMapChange = rect => {
      draft.position = rect;
      applyRect(state.frame, rect);
    };
    makeDraggable(mapBox, map, mapBox, { onMove: onMapChange, onEnd: onMapChange });
    makeResizable(mapBox, map, mapBox.querySelector('.otw-map-grip'), 'rb', { onMove: onMapChange, onEnd: onMapChange });

    /* controls */
    const background = colourControl(v => { draft.background = v; preview(); });
    const fontColour = colourControl(v => { draft.font.color = v; preview(); });
    const outline = colourControl(v => { draft.font.outline = v; preview(); });

    const familySelect = el('select', {},
      FONT_FAMILIES.map(([text, value]) => el('option', { value, text })));
    const familyCustom = el('input', { type: 'text', placeholder: 'e.g. "Comic Sans MS", cursive', style: 'display:none' });
    const readFamily = () => (familySelect.value === 'custom' ? familyCustom.value.trim() : familySelect.value);
    const syncFamily = () => {
      familyCustom.style.display = familySelect.value === 'custom' ? '' : 'none';
      draft.font.family = readFamily();
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
      el('div', { class: 'otw-note', text: 'Saved per channel. Whatever you apply last also becomes the default for channels you have not customised.' }),
      row('Placement', map, 'You can also drag the top bar and pull the edges of the overlay itself.'),
      row('Background', background.nodes, 'Shown when your mouse is away. Hovering restores the solid chat.'),
      row('Font', [familySelect, familyCustom]),
      row('Font size', [sizeInput, el('span', { text: 'px', style: 'opacity:.6;font-size:12px' })]),
      row('Font colour', fontColour.nodes),
      row('Outline', outline.nodes, 'Set opacity to 0 for no outline.'),
      row('Font weight', weight.node),
      row('Usernames', users.node),
      row('Timestamps', stamps.node),
      row('Auto-claim channel points', claim.node, 'Clicks the bonus chest for you while the overlay is on.'),
    ];

    const resetBtn = el('button', { class: 'otw-btn', type: 'button', text: 'Reset to defaults' });
    const cancelBtn = el('button', { class: 'otw-btn', type: 'button', text: 'Cancel' });
    const saveBtn = el('button', { class: 'otw-btn otw-primary', type: 'button', text: `Apply to ${label}` });
    const aboutBtn = el('button', { class: 'otw-bar-btn', type: 'button', title: 'About', text: '?', style: 'font-weight:700' });

    const modal = createModal({
      title: [el('span', { text: 'Overlay settings' }), el('span', { class: 'otw-spacer' }), aboutBtn],
      body,
      footer: [resetBtn, el('span', { class: 'otw-spacer' }), cancelBtn, saveBtn],
    });

    const load = source => {
      Object.assign(draft, structuredClone(source));
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
    cancelBtn.addEventListener('click', () => { modal.close(); applyAll(state.saved); Object.assign(state.settings, structuredClone(state.saved)); });
    saveBtn.addEventListener('click', () => {
      modal.close();
      Object.assign(state.settings, structuredClone(draft));
      state.saved = structuredClone(draft);
      applyAll(state.settings);
      saveSettings(state.settingsKey, state.settings);
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
        el('p', { html: `A userscript port of <a href="https://github.com/akhanubis/anu_twitch_chat_overlay" target="_blank" rel="noopener">Anu Twitch Chat Overlay</a> by akhanubis, rebuilt as a single dependency-free file.` }),
        el('p', { html: `Alt+C toggles the overlay. Hover it to get the real chat back, with the input, the drag bar and the resize grips.` }),
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
   *
   * Twitch is an SPA that rebuilds the player on navigation, so rather than
   * a subtree MutationObserver (which would fire on every chat message) we
   * poll cheaply and rebuild whenever our nodes go missing.
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
    if (!target) {
      if (session) teardown();
      return;
    }

    if (session) {
      if (session.target.key !== target.key) teardown();
      else if (!session.toggleBtn.isConnected || !session.frame.isConnected) teardown(); // React replaced the player
      else {
        // Chat can be unmounted underneath us (sidebar collapse, reconnect).
        if (overlayEnabled && session.detached && !session.detached.node.isConnected) {
          session.detached = null;
          session.setEnabled(true);
        } else if (overlayEnabled && !session.detached) {
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
    } finally {
      building = false;
    }
  };

  const onHotkey = event => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (String(event.key).toLowerCase() !== 'c') return;
    const active = document.activeElement;
    if (active && (active.isContentEditable || /^(input|textarea|select)$/i.test(active.tagName))) return;
    if (!session) return;
    event.preventDefault();
    session.setEnabled(!overlayEnabled);
  };

  injectStyle();
  document.addEventListener('keydown', onHotkey, true);
  setInterval(tick, 1000);
  tick();

  log(`v${VERSION} loaded`);
})();
