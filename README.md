# LiveApp

Testing environment for a resilient live stream player with multi-source fallback, built for the Dentsu platform.

## Architecture

The player uses a state-machine-driven fallback system with make-before-break source switching to maximise uptime:

```
Primary (Amazon IVS) → Secondary (MUX) → Tertiary (MediaPackage) → Hold Screen
```

State machine phases: `CONNECTING` → `PLAYING` ⇄ `SWITCHING` → `HOLD`

Each HLS source gets 3 retry attempts before the player moves to the next source. Source switches use **make-before-break**: the new stream loads on a hidden standby video element while the current stream keeps playing, then a 600ms CSS crossfade transitions between them — no spinner, no gap.

When all sources fail, the player shows a branded hold screen and probes all streams in the background every 30 seconds — switching to whichever source proves stable first.

Fallback order is **dynamic**: the system tracks how long each source has played successfully and prefers sources with >60 seconds of proven uptime. On first load (no history), sources are tried in priority order.

## Stream Sources

| Priority | Source | Type |
|----------|--------|------|
| Primary | Amazon IVS | HLS via hls.js |
| Secondary | MUX | HLS via hls.js |
| Tertiary | AWS MediaPackage | HLS via hls.js |
| Manual | Microsoft Teams Town Hall | iframe (toggle) |
| Fallback | Hold screen | Static branded screen |

## Key Features

- **useReducer state machine**: Single source of truth with explicit phases (`CONNECTING`, `PLAYING`, `SWITCHING`, `HOLD`) and actions — replaces scattered useState/useRef pairs
- **Dual video elements (make-before-break)**: Two `<video>` elements stacked via CSS. New source loads on the hidden standby slot while the active slot keeps playing. Once the standby is ready (manifest parsed + first fragment loaded), a 600ms crossfade swaps them — no visible gap
- **CSS crossfade transitions**: All visibility changes use opacity transitions instead of `display:none` toggling — 600ms for video swaps, 400ms for overlays
- **CDN cache busting**: Appends `?_cb=<timestamp>` to all `.m3u8` playlist requests via `xhrSetup`, forcing CDN to serve fresh manifests instead of stale cached content
- **Cache loop detection**: Tracks `currentTime` high water mark — if video jumps backward >3s (CDN serving cached segments after stream cut), triggers fallback after 2 backward jumps
- **Teams manual toggle**: Microsoft Teams Town Hall available as a manual toggle button — not part of the automatic fallback chain. HLS audio is muted when Teams is active
- **Stability-based fallback**: System tracks per-source uptime and prefers streams with >60s proven stability when switching
- **Parallel background probing**: When on hold, all HLS sources are probed simultaneously — the most stable one (10+ fragments in 60s) wins
- **15-second grace period**: New streams get breathing room before stall detection kicks in
- **Buffer stall detection**: 5 consecutive stalls or 20s without data triggers fallback
- **Heartbeat monitor**: Every 5s verifies `currentTime` is advancing — catches frozen video even when the buffer looks healthy
- **Tab visibility awareness**: Pauses stall detection when browser tab is hidden, resets counters on return — prevents false fallback from timer throttling
- **Network recovery**: Listens for `online`/`offline` events — immediately reconnects to the most stable source when network comes back
- **Dentsu-branded hold screen**: Diagonal colour lines matching brand guidelines
- **Debug panel**: Live phase, source info, active slot, retry count, stability data, and activity log

## Bug Fixes

- **CDN cache loop (MediaPackage)**: When stream is cut, CDN serves cached segments — video loops same ~10s of content while HLS.js reports healthy playback. Fixed by tracking `currentTime` high water mark and detecting backward jumps >3s. After 2 backward jumps, triggers fallback
- **Source switch visible gap**: Old code destroyed HLS before new source was ready (break-before-make), causing 1-15s spinner. Fixed with dual video elements — new stream loads on hidden standby, crossfades only when ready
- **Stale CDN playlists**: CDN edge nodes served cached `.m3u8` manifests even after stream was cut. Fixed with `xhrSetup` callback that appends cache-busting timestamp to playlist requests
- **Audio looping**: Fixed HLS instance not being properly destroyed on source change, causing duplicate playback (`80f6fbc`)
- **Buffer stalls not triggering fallback**: `bufferStalledError` and `bufferNudgeOnStall` were non-fatal HLS events — added counter-based detection to treat repeated stalls as fatal
- **Too aggressive on 3G**: Initial HLS.js timeouts and buffer settings were too tight for slow networks. Increased `fragLoadingTimeOut` to 20s, `maxBufferLength` to 30s, retries to 6
- **Teams iframe jumping in/out**: Background retry was unmounting Teams every 30s to test primary. Replaced with silent probe using a disposable HLS instance and hidden video element
- **Premature fallback on stream start**: Added 15-second grace period after playback begins — buffer stalls during stabilisation are logged but don't trigger fallback
- **Teams fallback when no meeting live**: Removed Teams from automatic fallback chain — can't reliably detect if a Town Hall is active, so it showed a blank page. Now available as manual toggle only
- **MediaPackage black screen on stream cut**: Video element stayed visible showing black when stream was cut. Added `ended` event handler to detect when source stops broadcasting and immediately trigger fallback
- **Event listener leak on retries**: Native event listeners (`loadedmetadata`, `error`, `ended`) accumulated on the video element across retry cycles. Now tracked and properly removed per-slot on each `destroySlot()` call
- **Probe video element leak**: Background probe created disposable `<video>` elements that were never cleaned up. Now tracked and explicitly released on each probe cycle

## 8-Hour Event Hardening

The player has been hardened for extended live events (8+ hours):

- **Heartbeat monitor** — checks every 5s that `currentTime` is advancing; triggers fallback after ~15s of frozen video
- **Cache loop detection** — tracks high water mark for `currentTime`; catches CDN serving cached segments after stream cut
- **Tab visibility handling** — pauses stall timers when tab is hidden, resets counters on return; prevents false positives from browser timer throttling
- **Network recovery** — listens for `online`/`offline` events; immediately reconnects to the most stable source instead of waiting for the next 30s probe cycle
- **Per-slot resource cleanup** — each video slot has its own HLS instance, listeners, buffer counters, and stall timers — all tracked and removed on destroy, preventing memory leaks over long sessions
- **Probe video cleanup** — disposable video elements are explicitly released after each probe cycle
- **Back buffer eviction** — `backBufferLength: 60` ensures old segments are evicted, preventing unbounded memory growth
- **CDN cache busting** — timestamp query parameter on playlist requests prevents stale manifest accumulation

## State Machine

The player is driven by a `useReducer` state machine:

```
CONNECTING ──▶ PLAYING ──▶ SWITCHING ──▶ PLAYING
     │            │            │
     ▼            ▼            ▼
   HOLD ◀────── HOLD ◀───── HOLD
     │
     ▼ (probe success)
 CONNECTING
```

| Phase | Description |
|-------|-------------|
| `CONNECTING` | Loading HLS on active slot, spinner visible |
| `PLAYING` | Stream playing on active slot |
| `SWITCHING` | Make-before-break in progress — old stream on active slot, new stream loading on standby slot |
| `HOLD` | All sources failed, branded hold screen shown, background probe running |

## Known Issues / Current Bugs

- HLS streams struggle under very poor network conditions (3G profile via Network Link Conditioner) — server-side adaptive delivery (e.g. Teams) handles this better by design
- On initial page load, browser autoplay policy may require a user click to start playback (expected behaviour, "Start Stream" button is shown)
- First fallback cycle has no stability history, so sources are tried in fixed priority order — stability-based ranking only kicks in after sources have been tested
- Background probe runs 3 parallel HLS instances for 60s — modest bandwidth usage on poor networks
- Teams toggle relies on an iframe — browser/corporate policies may block embedding

## Tech Stack

- React (Create React App)
- [hls.js](https://github.com/video-dev/hls.js/) for HLS playback
- Amazon IVS for primary stream ingest
- MUX for secondary stream ingest
- AWS MediaPackage for tertiary stream ingest
- AWS Amplify for hosting

## Testing with Network Link Conditioner

1. Open **System Preferences → Network Link Conditioner** (macOS)
2. Select a profile (3G, Edge, Wi-Fi, etc.)
3. Toggle on and observe the debug panel activity log
4. Verify fallback chain: Primary → Secondary → Tertiary → Hold
5. Disable the conditioner and verify the probe recovers to the most stable source
6. Toggle between HLS Player and Teams to verify manual switch

## Changelog

### Latest — State machine refactor + make-before-break + cache busting
- Refactored to `useReducer` state machine with explicit phases (`CONNECTING`, `PLAYING`, `SWITCHING`, `HOLD`)
- Added dual video elements with make-before-break source switching — no visible gap on fallback
- Added 600ms CSS crossfade transitions replacing `display:none` toggling
- Added CDN cache busting via `xhrSetup` — appends timestamp to `.m3u8` requests
- Added cache loop detection — tracks `currentTime` high water mark, detects CDN serving cached segments
- Added Teams as manual toggle (not part of automatic fallback chain)
- Per-slot resource management (HLS instances, listeners, counters, timers)
- 15s safety valve timeout on standby loading — falls back to break-before-make if standby fails

### 8-hour hardening + MediaPackage black screen fix
- Fixed MediaPackage black screen when stream is cut (added `ended` event handler)
- Added heartbeat monitor (5s interval checking `currentTime` advances)
- Added tab visibility awareness (pauses stall detection when hidden)
- Added network `online`/`offline` recovery (immediate reconnect on network restore)
- Fixed event listener leak on retry cycles (native listeners now tracked and cleaned up)
- Fixed probe video element leak (disposable elements now explicitly released)
- Removed dead `switchToTeams` code

### `ae00fc9` — Stability-based fallback + MediaPackage
- Added AWS MediaPackage as tertiary HLS source
- Removed Teams from automatic fallback chain (can't detect if meeting is live)
- Replaced fixed cascade with stability-ranked fallback — prefers sources with >60s proven uptime
- Background probe now tests all HLS sources in parallel with 60s stability window (10+ fragments required)
- Tracks per-source stability history across failures for smarter recovery

### `ca40462` — Resilient multi-source player
- Rebuilt `Streaming.js` with multi-tier fallback (Primary → Secondary → Teams → Hold)
- Added silent background probe with 15-second stability verification
- Added 15-second grace period for new stream connections
- Tuned HLS.js config for poor network tolerance
- Added debug panel with status, source, retry count, and activity log
- Dentsu-branded hold screen with diagonal colour lines
- Responsive layout with dark header

### Earlier commits
- `80f6fbc` — Fixed audio looping bug on HLS source change
- `0520ed4` — Initial HLS.js integration with Amazon IVS
- `1948c9c` — Initial page and API setup
