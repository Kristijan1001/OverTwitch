# OverTwitch — Cinematic Chat Overlay

A single-file userscript that puts Twitch's **real** chat on top of the player.

Mouse away, it's just floating message text over the video — translucent, OLED-friendly,
nothing in the way. Mouse over it and the actual chat comes back, solid, with the input,
badges, viewer cards, mod actions and your third-party emotes. Because it moves Twitch's own
chat node rather than cloning it, **nothing is faked and nothing connects twice**.

This is a userscript port of [Anu Twitch Chat Overlay](https://github.com/akhanubis/anu_twitch_chat_overlay)
by [akhanubis](https://github.com/akhanubis), rebuilt from scratch as one dependency-free file.

---

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`OverTwitch.user.js`](OverTwitch.user.js) and click **Raw** — your manager will offer to install it.
3. Open any Twitch channel. A 💬 button appears in the player controls.

## Using it

| | |
|---|---|
| **💬 in the player controls** | Show / hide the overlay |
| **Alt + C** | Same, from the keyboard |
| **Hover the overlay** | Real chat returns: input, drag bar, resize grips, ⚙ settings |
| **Drag the top bar** | Move it |
| **Pull any edge or corner** | Resize it |
| **⚙ in the drag bar** | Settings, with live preview |

### Settings

Placement, background colour and opacity, font family (including a free-text custom
field), size, colour, outline colour, weight, hiding usernames, hiding timestamps, and
auto-claiming channel points.

Settings are stored **per channel**. Whatever you apply last also becomes the default that
new channels inherit. VODs share their channel's settings.

Hiding usernames or timestamps applies all the time, hovered as well as idle.

Out of the box the overlay is **fully transparent** when idle (just outlined message text over
the video), with **timestamps hidden** and **auto-claim on**. If you have already saved settings
for a channel, those win over the defaults — hit **Reset to defaults** in the ⚙ panel to pick
up the new ones.

## Notes and limits

- **Collapse the chat sidebar if you like — that's the best way to run it.** Twitch keeps
  chat mounted when the right column is collapsed, so you get the full-width video with chat
  floating on top of it. The script never touches Twitch's collapse button.
- Works on live channels and VODs. Clips, the dashboard and popout chat are skipped.
- Third-party emote extensions (7TV, BetterTTV, FrankerFaceZ) work automatically, because
  the overlay shows the same DOM they already decorated.
- Auto-claim clicks the channel-point bonus while the overlay is on.

## What changed from the original extension

The original is a Chrome/Firefox extension built with webpack, MicroModal and iro.js. This
is one file with no build step and no dependencies, and a few things were reworked on the way:

- **No iframe.** The extension's default mode loaded `twitch.tv/popout/<channel>/chat` in an
  iframe and styled it from outside; a hidden option ("avoid iframes") relocated the real
  chat instead, for performance and third-party emote support. That second path is now the
  only path, so live and VODs share one code path and chat never connects twice.
- **Updated selectors.** Twitch's message markup changed since the extension was written —
  a `.chat-line__message` now has a single wrapper child, so the original's username rule
  (`.chat-line__message > *:nth-child(-n+3)`) would hide the whole message. Usernames are
  now matched by `.chat-line__username-container` and its colon separator.
- **No listener leaks.** Drag and resize used six `document.body` listeners each, re-added
  on every SPA navigation and never removed. They now use Pointer Events with pointer
  capture, so nothing is attached outside the element being dragged.
- **Plain JSON settings** instead of underscore-joined strings, which could not survive a
  value containing an underscore and needed a migration hack for stored booleans.
- **Live preview via CSS custom properties** on the overlay, rather than rewriting `<style>`
  nodes on every change.
- MicroModal and iro.js are replaced by a small modal and native colour + alpha inputs.

## Credits

Original design and concept: **Pablo Bianciotto (akhanubis)** —
[anu_twitch_chat_overlay](https://github.com/akhanubis/anu_twitch_chat_overlay).

ISC licensed, keeping the original copyright notice. See [LICENSE](LICENSE).
