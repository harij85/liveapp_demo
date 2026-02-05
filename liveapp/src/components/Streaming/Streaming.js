import React, { useEffect, useReducer, useRef, useState } from 'react';
import Hls from 'hls.js';
import './streaming.css';

// --- Phases & Actions ---
const PHASES = {
  CONNECTING: 'CONNECTING',
  PLAYING: 'PLAYING',
  SWITCHING: 'SWITCHING',
  HOLD: 'HOLD',
};

const ACTIONS = {
  CONNECT: 'CONNECT',
  PLAY_STARTED: 'PLAY_STARTED',
  AUTOPLAY_BLOCKED: 'AUTOPLAY_BLOCKED',
  RETRY: 'RETRY',
  SWITCH_START: 'SWITCH_START',
  SWITCH_READY: 'SWITCH_READY',
  SWITCH_COMPLETE: 'SWITCH_COMPLETE',
  HOLD: 'HOLD',
  PROBE_SUCCESS: 'PROBE_SUCCESS',
  SWITCH_ABORT: 'SWITCH_ABORT',
};

// --- Constants ---
const MAX_RETRIES = 3;
const RETRY_DELAY = 4000;
const STALL_TIMEOUT = 20000;
const BUFFER_ERROR_THRESHOLD = 5;
const BACKGROUND_RETRY_DELAY = 30000;
const STABILITY_WINDOW = 15000;
const STABLE_THRESHOLD = 60000;
const STABLE_MIN_FRAGS = 10;
const SWITCH_TIMEOUT = 15000;
const CROSSFADE_MS = 600;

// --- Reducer ---
const initialState = {
  phase: PHASES.CONNECTING,
  activeSource: 'primary',
  standbySource: null,
  activeSlot: 'A',
  crossfading: false,
  retryCount: 0,
  needsUserInteraction: false,
};

function streamReducer(state, action) {
  switch (action.type) {
    case ACTIONS.CONNECT:
      return {
        ...state,
        phase: PHASES.CONNECTING,
        activeSource: action.source,
        standbySource: null,
        crossfading: false,
        needsUserInteraction: false,
      };

    case ACTIONS.PLAY_STARTED:
      return { ...state, phase: PHASES.PLAYING, needsUserInteraction: false };

    case ACTIONS.AUTOPLAY_BLOCKED:
      return { ...state, phase: PHASES.PLAYING, needsUserInteraction: true };

    case ACTIONS.RETRY:
      return { ...state, phase: PHASES.CONNECTING, retryCount: state.retryCount + 1 };

    case ACTIONS.SWITCH_START:
      return { ...state, phase: PHASES.SWITCHING, standbySource: action.source, crossfading: false };

    case ACTIONS.SWITCH_READY:
      return { ...state, crossfading: true };

    case ACTIONS.SWITCH_COMPLETE:
      return {
        ...state,
        phase: PHASES.PLAYING,
        activeSource: state.standbySource,
        standbySource: null,
        activeSlot: state.activeSlot === 'A' ? 'B' : 'A',
        crossfading: false,
        retryCount: 0,
        needsUserInteraction: false,
      };

    case ACTIONS.SWITCH_ABORT:
      return { ...state, phase: PHASES.PLAYING, standbySource: null, crossfading: false };

    case ACTIONS.HOLD:
      return {
        ...state,
        phase: PHASES.HOLD,
        activeSource: 'hold',
        standbySource: null,
        crossfading: false,
        retryCount: 0,
      };

    case ACTIONS.PROBE_SUCCESS:
      return {
        ...state,
        phase: PHASES.CONNECTING,
        activeSource: action.source,
        standbySource: null,
        crossfading: false,
        retryCount: 0,
      };

    default:
      return state;
  }
}

// --- Pure helpers ---
const selectBestCandidate = (failedSources, stabilityMap, urlMap) => {
  return ['primary', 'secondary', 'tertiary']
    .filter(s => !failedSources.has(s) && urlMap[s])
    .sort((a, b) => {
      const aMs = stabilityMap[a] || 0;
      const bMs = stabilityMap[b] || 0;
      const aStable = aMs >= STABLE_THRESHOLD;
      const bStable = bMs >= STABLE_THRESHOLD;
      if (aStable !== bStable) return bStable - aStable;
      return bMs - aMs;
    });
};

const getSourceLabel = (source) => {
  const labels = {
    primary: 'Primary (Amazon IVS)',
    secondary: 'Backup (MUX)',
    tertiary: 'Backup (MediaPackage)',
    hold: 'None active',
  };
  return labels[source] || source;
};

const getStatusLabel = (phase, needsInteraction) => {
  if (phase === PHASES.CONNECTING) return 'Connecting...';
  if (phase === PHASES.PLAYING) return needsInteraction ? 'Ready' : 'Live';
  if (phase === PHASES.SWITCHING) return 'Live (switching)';
  if (phase === PHASES.HOLD) return 'Standby';
  return 'Unknown';
};

const getStatusClass = (phase) => {
  if (phase === PHASES.CONNECTING) return 'status-connecting';
  if (phase === PHASES.PLAYING || phase === PHASES.SWITCHING) return 'status-connected';
  if (phase === PHASES.HOLD) return 'status-hold';
  return '';
};

// Cache-bust playlist requests so CDN edge nodes serve fresh manifests
// instead of stale cached content when a stream is cut
const bustPlaylistCache = (xhr, url) => {
  if (url.includes('.m3u8')) {
    const sep = url.includes('?') ? '&' : '?';
    xhr.open('GET', `${url}${sep}_cb=${Date.now()}`, true);
  }
};

// --- HLS configs ---
const HLS_CONFIG = {
  enableWorker: true,
  lowLatencyMode: false,
  backBufferLength: 60,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  maxBufferSize: 60 * 1000 * 1000,
  maxBufferHole: 1.0,
  startLevel: -1,
  abrEwmaDefaultEstimate: 500000,
  abrBandWidthFactor: 0.8,
  abrBandWidthUpFactor: 0.4,
  fragLoadingTimeOut: 20000,
  fragLoadingMaxRetry: 6,
  fragLoadingRetryDelay: 2000,
  manifestLoadingTimeOut: 20000,
  manifestLoadingMaxRetry: 4,
  levelLoadingTimeOut: 20000,
  levelLoadingMaxRetry: 4,
  xhrSetup: bustPlaylistCache,
};

const PROBE_HLS_CONFIG = {
  enableWorker: false,
  startLevel: 0,
  manifestLoadingTimeOut: 10000,
  manifestLoadingMaxRetry: 1,
  levelLoadingTimeOut: 10000,
  levelLoadingMaxRetry: 1,
  fragLoadingTimeOut: 15000,
  fragLoadingMaxRetry: 2,
  maxBufferLength: 10,
  maxMaxBufferLength: 15,
  xhrSetup: bustPlaylistCache,
};

// =============================================================================
// Component
// =============================================================================
function Streaming({ primaryUrl, secondaryUrl, tertiaryUrl, teamsUrl, showDebug = true }) {
  const [state, dispatch] = useReducer(streamReducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [isDebugExpanded, setIsDebugExpanded] = useState(true);
  const [logs, setLogs] = useState([]);
  const [showTeams, setShowTeams] = useState(false);

  // Dual video slots
  const videoSlotARef = useRef(null);
  const videoSlotBRef = useRef(null);
  const hlsSlotARef = useRef(null);
  const hlsSlotBRef = useRef(null);
  const listenersSlotARef = useRef([]);
  const listenersSlotBRef = useRef([]);
  const bufErrSlotARef = useRef(0);
  const bufErrSlotBRef = useRef(0);
  const stallSlotARef = useRef(null);
  const stallSlotBRef = useRef(null);

  // Shared
  const retryTimerRef = useRef(null);
  const heartbeatRef = useRef(null);
  const switchTimerRef = useRef(null);
  const lastFragTimeRef = useRef(Date.now());
  const playStartRef = useRef(null);
  const lastCTRef = useRef(0);
  const maxCTRef = useRef(0);
  const loopCntRef = useRef(0);
  const tabVisRef = useRef(true);
  const mountedRef = useRef(true);

  // Probe
  const probeHlsRef = useRef([]);
  const probeTimerRef = useRef(null);
  const probeVidsRef = useRef([]);

  // Stability
  const stabilityRef = useRef({ primary: 0, secondary: 0, tertiary: 0 });
  const failedRef = useRef(new Set());

  const urlMap = { primary: primaryUrl, secondary: secondaryUrl, tertiary: tertiaryUrl };

  // --- Slot helpers ---
  const slot = (s) => ({
    video: s === 'A' ? videoSlotARef : videoSlotBRef,
    hls: s === 'A' ? hlsSlotARef : hlsSlotBRef,
    listeners: s === 'A' ? listenersSlotARef : listenersSlotBRef,
    bufErr: s === 'A' ? bufErrSlotARef : bufErrSlotBRef,
    stall: s === 'A' ? stallSlotARef : stallSlotBRef,
  });

  const standbySlot = () => stateRef.current.activeSlot === 'A' ? 'B' : 'A';

  // --- Logging ---
  const addLog = (message, type = 'info') => {
    if (!mountedRef.current) return;
    const time = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    setLogs(prev => [...prev.slice(-19), { time, message, type }]);
  };

  // --- Cleanup ---
  const destroySlot = (s) => {
    const r = slot(s);
    if (r.stall.current) { clearTimeout(r.stall.current); r.stall.current = null; }
    r.listeners.current.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    r.listeners.current = [];
    r.bufErr.current = 0;
    if (r.hls.current) { r.hls.current.destroy(); r.hls.current = null; }
    if (r.video.current) { r.video.current.removeAttribute('src'); r.video.current.load(); }
  };

  const clearShared = () => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    if (switchTimerRef.current) { clearTimeout(switchTimerRef.current); switchTimerRef.current = null; }
  };

  const destroyProbe = () => {
    if (probeTimerRef.current) { clearTimeout(probeTimerRef.current); probeTimerRef.current = null; }
    probeHlsRef.current.forEach(p => { try { p.destroy(); } catch (e) { /* */ } });
    probeHlsRef.current = [];
    probeVidsRef.current.forEach(v => { v.removeAttribute('src'); v.load(); });
    probeVidsRef.current = [];
  };

  const destroyAll = () => { clearShared(); destroySlot('A'); destroySlot('B'); destroyProbe(); };

  // --- Heartbeat ---
  const startHeartbeat = () => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    lastCTRef.current = 0;
    maxCTRef.current = 0;
    loopCntRef.current = 0;

    heartbeatRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      const s = stateRef.current;
      if (s.phase !== PHASES.PLAYING && s.phase !== PHASES.SWITCHING) return;
      if (!tabVisRef.current) return;

      const v = slot(s.activeSlot).video.current;
      if (!v) return;
      const ct = v.currentTime;

      if (lastCTRef.current > 0 && ct === lastCTRef.current) {
        addLog('Heartbeat: playback frozen', 'warning');
        const r = slot(s.activeSlot);
        r.bufErr.current += 2;
        if (r.bufErr.current >= BUFFER_ERROR_THRESHOLD) {
          r.bufErr.current = 0;
          handleError(s.activeSlot, 'Stream frozen — video not advancing', true);
        }
      } else if (maxCTRef.current > 0 && ct < maxCTRef.current - 3) {
        loopCntRef.current += 1;
        addLog(`Cache loop detected — time jumped back (${Math.round(ct)}s < ${Math.round(maxCTRef.current)}s, count: ${loopCntRef.current})`, 'warning');
        if (loopCntRef.current >= 2) {
          loopCntRef.current = 0;
          handleError(stateRef.current.activeSlot, 'Stream looping cached content — source likely offline', true);
        }
      } else {
        lastCTRef.current = ct;
        if (ct > maxCTRef.current) { maxCTRef.current = ct; loopCntRef.current = 0; }
      }
    }, 5000);
  };

  // --- Playback ---
  const attemptPlay = async (s) => {
    const v = slot(s).video.current;
    if (!v) return false;

    try {
      await v.play();
      if (!mountedRef.current) return false;
      dispatch({ type: ACTIONS.PLAY_STARTED });
      addLog('Stream playing successfully', 'success');
      startHeartbeat();
      return true;
    } catch (err) {
      if (!mountedRef.current) return false;
      if (err?.name === 'NotAllowedError') {
        dispatch({ type: ACTIONS.AUTOPLAY_BLOCKED });
        addLog('Click required to start playback', 'warning');
        startHeartbeat();
        return true;
      }
      addLog(`Playback failed: ${err.message}`, 'error');
      return false;
    }
  };

  // --- Error handling ---
  const handleError = (errorSlot, msg, isFatal = true) => {
    if (!mountedRef.current) return;
    addLog(msg, 'error');
    if (!isFatal) return;

    const s = stateRef.current;

    // Error on standby during switching → abort switch, try next
    if (s.phase === PHASES.SWITCHING && errorSlot !== s.activeSlot) {
      addLog('Standby source failed — aborting switch', 'warning');
      if (switchTimerRef.current) { clearTimeout(switchTimerRef.current); switchTimerRef.current = null; }
      destroySlot(errorSlot);
      dispatch({ type: ACTIONS.SWITCH_ABORT });

      failedRef.current.add(s.standbySource);
      const next = selectBestCandidate(failedRef.current, stabilityRef.current, urlMap);
      if (next.length > 0) {
        addLog(`Trying ${next[0]} instead...`, 'warning');
        setTimeout(() => {
          if (!mountedRef.current) return;
          initStandby(urlMap[next[0]], next[0]);
        }, RETRY_DELAY);
      }
      return;
    }

    // Error on active slot
    const source = s.activeSource;
    const retries = s.retryCount;

    if (retries < MAX_RETRIES) {
      dispatch({ type: ACTIONS.RETRY });
      addLog(`Retrying ${source} stream (attempt ${retries + 1}/${MAX_RETRIES})...`, 'warning');
      clearShared();
      destroySlot(s.activeSlot);

      retryTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        initStream(urlMap[source], source, stateRef.current.activeSlot);
      }, RETRY_DELAY);
    } else {
      if (playStartRef.current) {
        const elapsed = Date.now() - playStartRef.current;
        stabilityRef.current[source] = Math.max(stabilityRef.current[source] || 0, elapsed);
        addLog(`${source} was stable for ${Math.round(elapsed / 1000)}s`, 'info');
      }
      failedRef.current.add(source);

      const candidates = selectBestCandidate(failedRef.current, stabilityRef.current, urlMap);

      if (candidates.length > 0) {
        const next = candidates[0];
        const stab = stabilityRef.current[next] || 0;
        const label = stab >= STABLE_THRESHOLD
          ? `most stable (${Math.round(stab / 1000)}s uptime)` : 'next available';
        addLog(`Switching to ${next} — ${label}`, 'warning');

        if (s.phase === PHASES.PLAYING || s.phase === PHASES.SWITCHING) {
          initStandby(urlMap[next], next);
        } else {
          destroySlot(s.activeSlot);
          dispatch({ type: ACTIONS.CONNECT, source: next });
          initStream(urlMap[next], next, s.activeSlot);
        }
      } else {
        failedRef.current.clear();
        goHold();
      }
    }
  };

  // --- Hold ---
  const goHold = () => {
    destroyAll();
    addLog('All streams unavailable. Showing hold screen.', 'error');
    dispatch({ type: ACTIONS.HOLD });
    scheduleProbe();
  };

  // --- Background probe ---
  const scheduleProbe = () => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }

    retryTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      const cands = Object.entries(urlMap).filter(([, u]) => u);
      destroyProbe();

      if (cands.length === 0 || !Hls.isSupported()) { scheduleProbe(); return; }

      addLog(`Probing ${cands.length} stream source(s)...`, 'info');
      const frags = {};
      let resolved = false;

      cands.forEach(([src, url]) => {
        frags[src] = 0;
        const probe = new Hls(PROBE_HLS_CONFIG);
        probeHlsRef.current.push(probe);
        const pv = document.createElement('video');
        probeVidsRef.current.push(pv);
        probe.loadSource(url);
        probe.attachMedia(pv);
        probe.on(Hls.Events.FRAG_LOADED, () => { frags[src] += 1; });
        probe.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) frags[src] = -1; });
      });

      probeTimerRef.current = setTimeout(() => {
        if (!mountedRef.current || resolved) return;
        const results = Object.entries(frags)
          .filter(([, c]) => c >= STABLE_MIN_FRAGS)
          .sort(([, a], [, b]) => b - a);

        if (results.length > 0) {
          resolved = true;
          const [best] = results[0];
          addLog(`${best} stream stable (${frags[best]} fragments in ${STABLE_THRESHOLD / 1000}s). Switching...`, 'success');
          destroyProbe();
          failedRef.current.clear();
          dispatch({ type: ACTIONS.PROBE_SUCCESS, source: best });
          initStream(urlMap[best], best, stateRef.current.activeSlot);
        } else {
          addLog('No stable stream found, will retry...', 'warning');
          destroyProbe();
          scheduleProbe();
        }
      }, STABLE_THRESHOLD);
    }, BACKGROUND_RETRY_DELAY);
  };

  // --- Init stream on a specific slot (break-before-make path) ---
  const initStream = (url, source, targetSlot) => {
    destroySlot(targetSlot);
    clearShared();
    lastFragTimeRef.current = Date.now();
    playStartRef.current = null;

    const r = slot(targetSlot);
    const ve = r.video.current;
    if (!ve) return;

    addLog(`Connecting to ${source} stream...`, 'info');

    const onEnded = () => {
      addLog('Stream ended — source stopped broadcasting', 'warning');
      handleError(targetSlot, 'Stream ended', true);
    };
    ve.addEventListener('ended', onEnded);
    r.listeners.current.push({ element: ve, event: 'ended', handler: onEnded });

    if (Hls.isSupported()) {
      const hls = new Hls(HLS_CONFIG);
      r.hls.current = hls;
      hls.loadSource(url);
      hls.attachMedia(ve);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!mountedRef.current) return;
        addLog('Stream manifest loaded', 'success');
        playStartRef.current = Date.now();
        attemptPlay(targetSlot);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => { addLog(`Quality: Level ${d.level}`, 'info'); });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!mountedRef.current) return;
        const isStall = data.details === 'bufferStalledError' || data.details === 'bufferNudgeOnStall';

        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            addLog('Media error - attempting recovery...', 'warning');
            hls.recoverMediaError();
          } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            handleError(targetSlot, `Network error: ${data.details}`, true);
          } else {
            handleError(targetSlot, `Stream error: ${data.details}`, true);
          }
        } else if (isStall) {
          const since = playStartRef.current ? Date.now() - playStartRef.current : 0;
          if (since < STABILITY_WINDOW) {
            addLog(`Buffer stall (stabilising, ${Math.round((STABILITY_WINDOW - since) / 1000)}s grace remaining)`, 'warning');
            return;
          }
          r.bufErr.current += 1;
          const sinceF = Date.now() - lastFragTimeRef.current;
          addLog(`Buffer stall (${r.bufErr.current}/${BUFFER_ERROR_THRESHOLD})`, 'warning');
          if (r.bufErr.current >= BUFFER_ERROR_THRESHOLD || sinceF > STALL_TIMEOUT) {
            r.bufErr.current = 0;
            handleError(targetSlot, 'Stream unresponsive - too many buffer stalls', true);
          }
        } else {
          addLog(`Minor issue: ${data.details}`, 'warning');
        }
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        r.bufErr.current = 0;
        lastFragTimeRef.current = Date.now();
        if (r.stall.current) clearTimeout(r.stall.current);
        r.stall.current = setTimeout(() => {
          if (!mountedRef.current) return;
          const st = stateRef.current;
          if (st.phase !== PHASES.PLAYING && st.phase !== PHASES.SWITCHING) return;
          const since = playStartRef.current ? Date.now() - playStartRef.current : 0;
          if (since < STABILITY_WINDOW) return;
          handleError(targetSlot, 'Stream stalled - no data received', true);
        }, STALL_TIMEOUT);
      });

    } else if (ve.canPlayType('application/vnd.apple.mpegurl')) {
      ve.src = url;
      const onMeta = () => { if (mountedRef.current) { addLog('Stream metadata loaded (native HLS)', 'success'); attemptPlay(targetSlot); } };
      const onErr = () => { handleError(targetSlot, 'Native playback error', true); };
      ve.addEventListener('loadedmetadata', onMeta);
      ve.addEventListener('error', onErr);
      r.listeners.current.push(
        { element: ve, event: 'loadedmetadata', handler: onMeta },
        { element: ve, event: 'error', handler: onErr },
      );
    } else {
      handleError(targetSlot, 'HLS not supported in this browser', true);
    }
  };

  // --- Make-before-break: load on standby slot ---
  const initStandby = (url, source) => {
    const sbSlot = standbySlot();
    destroySlot(sbSlot);
    dispatch({ type: ACTIONS.SWITCH_START, source });

    const r = slot(sbSlot);
    const ve = r.video.current;
    if (!ve) return;

    addLog(`Pre-loading ${source} on standby...`, 'info');
    ve.muted = true;

    let ready = false;
    let gotManifest = false;
    let gotFrag = false;

    const tryReady = () => {
      if (ready || !gotManifest || !gotFrag) return;
      ready = true;
      ve.play().then(() => {
        if (mountedRef.current) beginCrossfade(sbSlot);
      }).catch(() => {
        if (mountedRef.current) beginCrossfade(sbSlot);
      });
    };

    const onEnded = () => { handleError(sbSlot, 'Standby stream ended', true); };
    ve.addEventListener('ended', onEnded);
    r.listeners.current.push({ element: ve, event: 'ended', handler: onEnded });

    if (Hls.isSupported()) {
      const hls = new Hls(HLS_CONFIG);
      r.hls.current = hls;
      hls.loadSource(url);
      hls.attachMedia(ve);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!mountedRef.current) return;
        addLog(`Standby ${source}: manifest loaded`, 'success');
        gotManifest = true;
        tryReady();
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        if (!gotFrag) {
          addLog(`Standby ${source}: first fragment loaded`, 'success');
          gotFrag = true;
          tryReady();
        }
      });

      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!mountedRef.current) return;
        if (d.fatal) handleError(sbSlot, `Standby error: ${d.details}`, true);
      });

    } else if (ve.canPlayType('application/vnd.apple.mpegurl')) {
      ve.src = url;
      const onCanPlay = () => {
        if (!mountedRef.current) return;
        addLog(`Standby ${source}: ready (native HLS)`, 'success');
        gotManifest = true;
        gotFrag = true;
        tryReady();
      };
      const onErr = () => { handleError(sbSlot, 'Standby native playback error', true); };
      ve.addEventListener('canplay', onCanPlay);
      ve.addEventListener('error', onErr);
      r.listeners.current.push(
        { element: ve, event: 'canplay', handler: onCanPlay },
        { element: ve, event: 'error', handler: onErr },
      );
    }

    // Safety valve
    if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
    switchTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (!ready) {
        addLog('Standby source failed to load in time — falling back', 'warning');
        handleError(sbSlot, 'Switch timeout — standby not ready', true);
      }
    }, SWITCH_TIMEOUT);
  };

  // --- Crossfade ---
  const beginCrossfade = (inSlot) => {
    if (!mountedRef.current) return;
    if (stateRef.current.phase !== PHASES.SWITCHING) return;

    if (switchTimerRef.current) { clearTimeout(switchTimerRef.current); switchTimerRef.current = null; }

    const outSlot = stateRef.current.activeSlot;
    const outVid = slot(outSlot).video.current;
    const inVid = slot(inSlot).video.current;

    if (outVid) outVid.muted = true;
    if (inVid) inVid.muted = false;

    addLog('Crossfading to new source...', 'info');
    dispatch({ type: ACTIONS.SWITCH_READY });

    const onEnd = (e) => {
      if (e.propertyName !== 'opacity') return;
      inVid.removeEventListener('transitionend', onEnd);
      finishCrossfade(outSlot);
    };
    if (inVid) inVid.addEventListener('transitionend', onEnd);

    // Safety: complete after CROSSFADE_MS + buffer in case transitionend doesn't fire
    setTimeout(() => {
      if (!mountedRef.current) return;
      const s = stateRef.current;
      if (s.phase === PHASES.SWITCHING && s.crossfading) {
        if (inVid) inVid.removeEventListener('transitionend', onEnd);
        finishCrossfade(outSlot);
      }
    }, CROSSFADE_MS + 200);
  };

  const finishCrossfade = (outSlot) => {
    if (!mountedRef.current) return;
    addLog('Source switch complete', 'success');
    destroySlot(outSlot);
    dispatch({ type: ACTIONS.SWITCH_COMPLETE });
    playStartRef.current = Date.now();
    startHeartbeat();
  };

  // --- Main effect ---
  useEffect(() => {
    mountedRef.current = true;
    addLog('Initializing stream player...', 'info');
    initStream(primaryUrl, 'primary', 'A');

    const onVis = () => {
      tabVisRef.current = !document.hidden;
      if (document.hidden) {
        addLog('Tab hidden — pausing stall detection', 'info');
        if (stallSlotARef.current) { clearTimeout(stallSlotARef.current); stallSlotARef.current = null; }
        if (stallSlotBRef.current) { clearTimeout(stallSlotBRef.current); stallSlotBRef.current = null; }
      } else {
        addLog('Tab visible — resuming monitoring', 'info');
        lastFragTimeRef.current = Date.now();
        const av = stateRef.current.activeSlot === 'A' ? videoSlotARef.current : videoSlotBRef.current;
        lastCTRef.current = av?.currentTime || 0;
        maxCTRef.current = av?.currentTime || 0;
        loopCntRef.current = 0;
        bufErrSlotARef.current = 0;
        bufErrSlotBRef.current = 0;
      }
    };

    const onOnline = () => {
      addLog('Network restored', 'info');
      const s = stateRef.current;
      if (s.phase === PHASES.HOLD || s.phase === PHASES.CONNECTING) {
        addLog('Attempting immediate reconnection...', 'info');
        destroyProbe();
        clearShared();
        failedRef.current.clear();
        const best = selectBestCandidate(new Set(), stabilityRef.current, urlMap);
        if (best.length > 0) {
          dispatch({ type: ACTIONS.CONNECT, source: best[0] });
          initStream(urlMap[best[0]], best[0], s.activeSlot);
        }
      }
    };

    const onOffline = () => { addLog('Network lost', 'error'); };

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      mountedRef.current = false;
      destroyAll();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- User interaction ---
  const handlePlayClick = () => {
    const s = stateRef.current;
    const v = slot(s.activeSlot).video.current;
    if (v) {
      v.play().then(() => { dispatch({ type: ACTIONS.PLAY_STARTED }); }).catch(() => {});
    }
  };

  const toggleTeams = () => {
    setShowTeams(prev => {
      const next = !prev;
      const v = slot(stateRef.current.activeSlot).video.current;
      if (v) v.muted = next;
      addLog(next ? 'Switched to Teams view' : 'Switched to HLS player', 'info');
      return next;
    });
  };

  // --- Render ---
  const { phase, activeSlot, crossfading, activeSource, needsUserInteraction, retryCount } = state;

  const videoClass = (s) => {
    if (crossfading && activeSlot === s) return 'video-slot video-fade-out';
    if (crossfading && activeSlot !== s) return 'video-slot video-fade-in';
    if (activeSlot === s && (phase === PHASES.PLAYING || phase === PHASES.SWITCHING || phase === PHASES.CONNECTING)) return 'video-slot video-active';
    return 'video-slot video-standby';
  };

  return (
    <>
      {teamsUrl && (
        <div className="source-toggle">
          <button
            className={`toggle-btn ${!showTeams ? 'toggle-active' : ''}`}
            onClick={() => showTeams && toggleTeams()}
            type="button"
          >
            HLS Player
          </button>
          <button
            className={`toggle-btn ${showTeams ? 'toggle-active' : ''}`}
            onClick={() => !showTeams && toggleTeams()}
            type="button"
          >
            Teams
          </button>
        </div>
      )}

      <div className="streaming-wrapper">
        <video
          ref={videoSlotARef}
          className={videoClass('A')}
          controls={!showTeams && activeSlot === 'A' && phase === PHASES.PLAYING && !needsUserInteraction}
          playsInline
        />
        <video
          ref={videoSlotBRef}
          className={videoClass('B')}
          controls={!showTeams && activeSlot === 'B' && phase === PHASES.PLAYING && !needsUserInteraction}
          playsInline
        />

        {teamsUrl && (
          <div className={`teams-container ${showTeams ? 'overlay-visible' : 'overlay-hidden'}`}>
            <iframe
              src={teamsUrl}
              title="Teams Live Stream"
              width="1280"
              height="720"
              frameBorder="0"
              scrolling="no"
              allowFullScreen
              allow="autoplay; camera; microphone"
            />
          </div>
        )}

        <div className={`hold-screen ${!showTeams && phase === PHASES.HOLD ? 'overlay-visible' : 'overlay-hidden'}`}>
          <div className="diagonal-lines">
            <div className="diagonal-line line-cyan-1" />
            <div className="diagonal-line line-purple" />
            <div className="diagonal-line line-lime" />
            <div className="diagonal-line line-teal" />
            <div className="diagonal-line line-red" />
            <div className="diagonal-line line-cyan-2" />
          </div>
          <div className="hold-branding">
            <div className="hold-tagline">Innovating to Impact</div>
            <div className="hold-logo">dentsu</div>
          </div>
        </div>

        <div className={`connecting-overlay ${!showTeams && phase === PHASES.CONNECTING ? 'overlay-visible' : 'overlay-hidden'}`}>
          <div className="spinner" />
          <div className="connecting-text">
            {activeSource === 'primary' && 'Connecting to stream...'}
            {activeSource === 'secondary' && 'Switching to backup stream...'}
            {activeSource === 'tertiary' && 'Switching to MediaPackage stream...'}
          </div>
        </div>

        {needsUserInteraction && phase === PHASES.PLAYING && (
          <button className="streaming-play-button" onClick={handlePlayClick} type="button">
            Start Stream
          </button>
        )}
      </div>

      {showDebug && (
        <div className="debug-panel">
          <div className="debug-header">
            <span className="debug-title">Stream Status</span>
            <button className="debug-toggle" onClick={() => setIsDebugExpanded(!isDebugExpanded)} type="button">
              {isDebugExpanded ? 'Hide Details' : 'Show Details'}
            </button>
          </div>

          <div className="debug-content">
            <div className="debug-item">
              <span className="debug-label">Status</span>
              <span className={`debug-value ${getStatusClass(phase)}`}>{getStatusLabel(phase, needsUserInteraction)}</span>
            </div>
            <div className="debug-item">
              <span className="debug-label">Stream Source</span>
              <span className="debug-value">{showTeams ? 'Teams (manual)' : getSourceLabel(activeSource)}</span>
            </div>
            <div className="debug-item">
              <span className="debug-label">Connection Attempts</span>
              <span className="debug-value">{retryCount} / {MAX_RETRIES}</span>
            </div>
          </div>

          {isDebugExpanded && logs.length > 0 && (
            <div className="debug-log">
              <div className="debug-log-title">Activity Log</div>
              {logs.map((log, index) => (
                <div key={index} className={`log-entry ${log.type}`}>
                  <span className="log-time">{log.time}</span>
                  <span className="log-message">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default Streaming;
