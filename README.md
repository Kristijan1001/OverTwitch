# OverTwitch — Cinematic Chat Overlay

A single-file userscript that puts Twitch's **real** chat on top of the player.

Mouse away, it's just floating message text over the video — translucent, OLED-friendly,
nothing in the way. Mouse over it and the actual chat comes back, solid, with the input,
badges, viewer cards, mod actions and everything else. It shows Twitch's own chat rather than a
clone, so **nothing is faked** — see *How it works* for how live and VODs differ.

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

**Settings are global.** One set for every channel and VOD — there are no per-channel
overrides, so anything you change applies everywhere, including the position you drag the
overlay to. Hiding usernames or timestamps applies all the time, hovered as well as idle.

**The overlay opens on its own.** Its on/off state is remembered, so if you leave it on it
comes straight back on the next page and the next browser session, with no click. Turn it off
and it stays off. Only your own toggling counts — if the script has to shut the overlay down
by itself, that never changes what happens next time.

Out of the box it is **fully transparent** when idle (just outlined message text over the
video), with **timestamps hidden** and **auto-claim on**.

## Notes and limits

- **Collapse the chat sidebar if you like — that's the best way to run it.** Twitch keeps
  chat mounted when the right column is collapsed, so you get the full-width video with chat
  floating on top of it. The script never touches Twitch's collapse button.
- Works on live channels and VODs. Clips, the dashboard and popout chat are skipped.
- Third-party emote add-ons (7TV, BetterTTV, FrankerFaceZ) appear on live chat only if they
  also run on `twitch.tv/popout/*/chat`, since that is the page the overlay embeds. Most do.
- Auto-claim clicks the channel-point bonus while the overlay is on.

## How it works

Same architecture as the original, because the original's works:

- **Live** — an `<iframe>` pointing at `twitch.tv/popout/<channel>/chat`, floated over the
  player and restyled from the outside. Same origin, so its document is fully reachable.
  Twitch's chat page owns its whole document there: it lays out normally and scrolls itself.
- **VODs** — the real `.video-chat` node is moved into the overlay, since a VOD has no popout
  chat to point an iframe at.

Version 1.x moved the live chat node too, on the theory that it was strictly better — one code
path, no second connection, third-party emotes guaranteed. It isn't. Twitch's live chat drives
its own auto-scroll against the box it was mounted in, so hosting it in a small repositioned
container left it appending messages the viewport never scrolled to, which reads as chat being
frozen. VODs were unaffected — exactly the live/VOD split the original's own code implies.

The cost of the iframe is a second chat connection, and third-party emote add-ons only show up
if they also run on popout chat. That's the trade the original makes by default.

Other differences from the extension: one file with no build step and no dependencies
(MicroModal and iro.js are replaced by a small modal and native colour inputs), plain JSON
settings instead of underscore-joined strings, Pointer Events with pointer capture for
drag/resize so nothing leaks across navigations, and selectors updated for Twitch's current DOM.

## Credits

Original design and concept: **Pablo Bianciotto (akhanubis)** —
[anu_twitch_chat_overlay](https://github.com/akhanubis/anu_twitch_chat_overlay).

ISC licensed, keeping the original copyright notice. See [LICENSE](LICENSE).
