import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import './streaming.css';

const STREAM_STATES = {
  CONNECTING: 'connecting',
  PLAYING: 'playing',
  TEAMS: 'teams',
  HOLD: 'hold',
};

const MAX_RETRIES = 3;
const RETRY_DELAY = 4000;
const STALL_TIMEOUT = 20000;
const BUFFER_ERROR_THRESHOLD = 5;
const BACKGROUND_RETRY_DELAY = 30000;
const STABILITY_WINDOW = 15000;
const STABLE_THRESHOLD = 60000;
const STABLE_MIN_FRAGS = 10;

function Streaming({ primaryUrl, secondaryUrl, tertiaryUrl, teamsUrl, showDebug = true }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const retryCountRef = useRef(0);
  const currentSourceRef = useRef('primary');
  const stallTimerRef = useRef(null);
  const retryTimerRef = useRef(null);
  const streamStateRef = useRef(STREAM_STATES.CONNECTING);
  const bufferErrorCountRef = useRef(0);
  const lastFragLoadTimeRef = useRef(Date.now());
  const probeHlsRef = useRef([]);
  const playbackStartTimeRef = useRef(null);
  const probeTimerRef = useRef(null);
  const sourceStabilityRef = useRef({ primary: 0, secondary: 0, tertiary: 0 });
  const failedSourcesRef = useRef(new Set());
  const nativeListenersRef = useRef([]);
  const probeVideosRef = useRef([]);
  const heartbeatTimerRef = useRef(null);
  const lastCurrentTimeRef = useRef(0);
  const tabVisibleRef = useRef(true);

  const [streamState, setStreamState] = useState(STREAM_STATES.CONNECTING);
  const [currentSource, setCurrentSource] = useState('primary');
  const [needsUserInteraction, setNeedsUserInteraction] = useState(false);
  const [isDebugExpanded, setIsDebugExpanded] = useState(true);
  const [logs, setLogs] = useState([]);
  const [retryDisplay, setRetryDisplay] = useState(0);

  const updateStreamState = (state) => {
    streamStateRef.current = state;
    setStreamState(state);
  };

  const updateSource = (source) => {
    currentSourceRef.current = source;
    setCurrentSource(source);
  };

  const addLog = (message, type = 'info') => {
    const time = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    setLogs(prev => [...prev.slice(-19), { time, message, type }]);
  };

  const clearTimers = () => {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  };

  const destroyHls = () => {
    clearTimers();
    destroyProbe();
    nativeListenersRef.current.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    nativeListenersRef.current = [];
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  };

  const attemptPlayback = async () => {
    if (!videoRef.current) return false;

    try {
      await videoRef.current.play();
      setNeedsUserInteraction(false);
      updateStreamState(STREAM_STATES.PLAYING);
      addLog('Stream playing successfully', 'success');
      return true;
    } catch (error) {
      if (error?.name === 'NotAllowedError') {
        setNeedsUserInteraction(true);
        updateStreamState(STREAM_STATES.PLAYING);
        addLog('Click required to start playback', 'warning');
        return true;
      }
      addLog(`Playback failed: ${error.message}`, 'error');
      return false;
    }
  };

  const destroyProbe = () => {
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current);
      probeTimerRef.current = null;
    }
    probeHlsRef.current.forEach(p => {
      try { p.destroy(); } catch (e) { /* ignore */ }
    });
    probeHlsRef.current = [];
    probeVideosRef.current.forEach(v => {
      v.removeAttribute('src');
      v.load();
    });
    probeVideosRef.current = [];
  };

  const scheduleBackgroundRetry = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    retryTimerRef.current = setTimeout(() => {
      const urlMap = { primary: primaryUrl, secondary: secondaryUrl, tertiary: tertiaryUrl };
      const candidates = Object.entries(urlMap).filter(([, url]) => url);

      destroyProbe();

      if (candidates.length === 0 || !Hls.isSupported()) {
        scheduleBackgroundRetry();
        return;
      }

      addLog(`Probing ${candidates.length} stream source(s)...`, 'info');
      const fragCounts = {};
      let resolved = false;

      candidates.forEach(([source, url]) => {
        fragCounts[source] = 0;
        const probe = new Hls({
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
        });
        probeHlsRef.current.push(probe);

        const probeVideo = document.createElement('video');
        probeVideosRef.current.push(probeVideo);
        probe.loadSource(url);
        probe.attachMedia(probeVideo);

        probe.on(Hls.Events.FRAG_LOADED, () => {
          fragCounts[source] += 1;
        });

        probe.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            fragCounts[source] = -1;
          }
        });
      });

      // After STABLE_THRESHOLD (60s), pick the source with the most fragments
      probeTimerRef.current = setTimeout(() => {
        if (resolved) return;

        const results = Object.entries(fragCounts)
          .filter(([, count]) => count >= STABLE_MIN_FRAGS)
          .sort(([, a], [, b]) => b - a);

        if (results.length > 0) {
          resolved = true;
          const [bestSource] = results[0];
          addLog(`${bestSource} stream stable (${fragCounts[bestSource]} fragments in ${STABLE_THRESHOLD / 1000}s). Switching...`, 'success');
          destroyProbe();
          failedSourcesRef.current.clear();
          retryCountRef.current = 0;
          setRetryDisplay(0);
          updateSource(bestSource);
          updateStreamState(STREAM_STATES.CONNECTING);
          initStream(urlMap[bestSource], bestSource);
        } else {
          addLog('No stable stream found, will retry...', 'warning');
          destroyProbe();
          scheduleBackgroundRetry();
        }
      }, STABLE_THRESHOLD);
    }, BACKGROUND_RETRY_DELAY);
  };

  const switchToHold = () => {
    destroyHls();
    addLog('All streams unavailable. Showing hold screen.', 'error');
    updateSource('hold');
    updateStreamState(STREAM_STATES.HOLD);
    scheduleBackgroundRetry();
  };

  const handleStreamError = (errorMessage, isFatal = true) => {
    addLog(errorMessage, 'error');

    if (!isFatal) return;

    const source = currentSourceRef.current;
    const retries = retryCountRef.current;

    if (retries < MAX_RETRIES) {
      retryCountRef.current += 1;
      setRetryDisplay(retryCountRef.current);
      addLog(`Retrying ${source} stream (attempt ${retries + 1}/${MAX_RETRIES})...`, 'warning');
      updateStreamState(STREAM_STATES.CONNECTING);

      clearTimers();
      retryTimerRef.current = setTimeout(() => {
        const urlMap = { primary: primaryUrl, secondary: secondaryUrl, tertiary: tertiaryUrl };
        initStream(urlMap[source], source);
      }, RETRY_DELAY);
    } else {
      // Record how long this source played before failing
      if (playbackStartTimeRef.current) {
        const elapsed = Date.now() - playbackStartTimeRef.current;
        sourceStabilityRef.current[source] = Math.max(
          sourceStabilityRef.current[source] || 0,
          elapsed
        );
        addLog(`${source} was stable for ${Math.round(elapsed / 1000)}s`, 'info');
      }
      failedSourcesRef.current.add(source);

      // Find best unfailed source, sorted by stability (prefer >60s proven uptime)
      const urlMap = { primary: primaryUrl, secondary: secondaryUrl, tertiary: tertiaryUrl };
      const candidates = ['primary', 'secondary', 'tertiary']
        .filter(s => !failedSourcesRef.current.has(s) && urlMap[s])
        .sort((a, b) => {
          const aMs = sourceStabilityRef.current[a] || 0;
          const bMs = sourceStabilityRef.current[b] || 0;
          const aStable = aMs >= STABLE_THRESHOLD;
          const bStable = bMs >= STABLE_THRESHOLD;
          if (aStable !== bStable) return bStable - aStable;
          return bMs - aMs;
        });

      if (candidates.length > 0) {
        const next = candidates[0];
        const stability = sourceStabilityRef.current[next] || 0;
        const label = stability >= STABLE_THRESHOLD
          ? `most stable (${Math.round(stability / 1000)}s uptime)`
          : 'next available';
        addLog(`Switching to ${next} — ${label}`, 'warning');
        retryCountRef.current = 0;
        setRetryDisplay(0);
        updateSource(next);
        updateStreamState(STREAM_STATES.CONNECTING);
        initStream(urlMap[next], next);
      } else {
        failedSourcesRef.current.clear();
        switchToHold();
      }
    }
  };

  const initStream = (url, source) => {
    destroyHls();
    bufferErrorCountRef.current = 0;
    lastFragLoadTimeRef.current = Date.now();
    playbackStartTimeRef.current = null;

    const videoElement = videoRef.current;
    if (!videoElement) return;

    addLog(`Connecting to ${source} stream...`, 'info');

    // Detect stream ending (e.g. source stops broadcasting — fixes black screen)
    const handleEnded = () => {
      addLog('Stream ended — source stopped broadcasting', 'warning');
      handleStreamError('Stream ended', true);
    };
    videoElement.addEventListener('ended', handleEnded);
    nativeListenersRef.current.push({ element: videoElement, event: 'ended', handler: handleEnded });

    if (Hls.isSupported()) {
      const hls = new Hls({
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
      });
      hlsRef.current = hls;

      hls.loadSource(url);
      hls.attachMedia(videoElement);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        addLog('Stream manifest loaded', 'success');
        playbackStartTimeRef.current = Date.now();
        lastCurrentTimeRef.current = 0;

        // Heartbeat: detect frozen video even when buffer looks healthy
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = setInterval(() => {
          if (!videoRef.current || streamStateRef.current !== STREAM_STATES.PLAYING) return;
          if (!tabVisibleRef.current) return;
          const ct = videoRef.current.currentTime;
          if (lastCurrentTimeRef.current > 0 && ct === lastCurrentTimeRef.current) {
            addLog('Heartbeat: playback frozen', 'warning');
            bufferErrorCountRef.current += 2;
            if (bufferErrorCountRef.current >= BUFFER_ERROR_THRESHOLD) {
              bufferErrorCountRef.current = 0;
              handleStreamError('Stream frozen — video not advancing', true);
            }
          } else {
            lastCurrentTimeRef.current = ct;
          }
        }, 5000);

        attemptPlayback();
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        addLog(`Quality: Level ${data.level}`, 'info');
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        const isBufferStall = data.details === 'bufferStalledError' ||
                              data.details === 'bufferNudgeOnStall';

        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              handleStreamError(`Network error: ${data.details}`, true);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              addLog('Media error - attempting recovery...', 'warning');
              hls.recoverMediaError();
              break;
            default:
              handleStreamError(`Stream error: ${data.details}`, true);
          }
        } else if (isBufferStall) {
          const timeSinceStart = playbackStartTimeRef.current
            ? Date.now() - playbackStartTimeRef.current
            : 0;

          // Grace period: don't trigger fallback during the first STABILITY_WINDOW
          if (timeSinceStart < STABILITY_WINDOW) {
            addLog(`Buffer stall (stabilising, ${Math.round((STABILITY_WINDOW - timeSinceStart) / 1000)}s grace remaining)`, 'warning');
            return;
          }

          bufferErrorCountRef.current += 1;
          const timeSinceLastFrag = Date.now() - lastFragLoadTimeRef.current;

          addLog(`Buffer stall (${bufferErrorCountRef.current}/${BUFFER_ERROR_THRESHOLD})`, 'warning');

          if (bufferErrorCountRef.current >= BUFFER_ERROR_THRESHOLD || timeSinceLastFrag > STALL_TIMEOUT) {
            bufferErrorCountRef.current = 0;
            handleStreamError('Stream unresponsive - too many buffer stalls', true);
          }
        } else {
          addLog(`Minor issue: ${data.details}`, 'warning');
        }
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        bufferErrorCountRef.current = 0;
        lastFragLoadTimeRef.current = Date.now();

        if (stallTimerRef.current) {
          clearTimeout(stallTimerRef.current);
        }
        stallTimerRef.current = setTimeout(() => {
          if (streamStateRef.current !== STREAM_STATES.PLAYING) return;

          const timeSinceStart = playbackStartTimeRef.current
            ? Date.now() - playbackStartTimeRef.current
            : 0;
          if (timeSinceStart < STABILITY_WINDOW) return;

          handleStreamError('Stream stalled - no data received', true);
        }, STALL_TIMEOUT);
      });

    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
      videoElement.src = url;

      const handleMetadata = () => {
        addLog('Stream metadata loaded (native HLS)', 'success');
        attemptPlayback();
      };

      const handleError = () => {
        handleStreamError('Native playback error', true);
      };

      videoElement.addEventListener('loadedmetadata', handleMetadata);
      videoElement.addEventListener('error', handleError);
      nativeListenersRef.current.push(
        { element: videoElement, event: 'loadedmetadata', handler: handleMetadata },
        { element: videoElement, event: 'error', handler: handleError }
      );
    } else {
      handleStreamError('HLS not supported in this browser', true);
    }
  };

  useEffect(() => {
    addLog('Initializing stream player...', 'info');
    initStream(primaryUrl, 'primary');

    // Pause stall detection when tab is hidden to prevent false positives
    const handleVisibility = () => {
      tabVisibleRef.current = !document.hidden;
      if (document.hidden) {
        addLog('Tab hidden — pausing stall detection', 'info');
        if (stallTimerRef.current) {
          clearTimeout(stallTimerRef.current);
          stallTimerRef.current = null;
        }
      } else {
        addLog('Tab visible — resuming monitoring', 'info');
        lastFragLoadTimeRef.current = Date.now();
        lastCurrentTimeRef.current = videoRef.current?.currentTime || 0;
        bufferErrorCountRef.current = 0;
      }
    };

    // Recover faster when network comes back
    const handleOnline = () => {
      addLog('Network restored', 'info');
      if (streamStateRef.current === STREAM_STATES.HOLD ||
          streamStateRef.current === STREAM_STATES.CONNECTING) {
        addLog('Attempting immediate reconnection...', 'info');
        destroyProbe();
        clearTimers();
        failedSourcesRef.current.clear();
        retryCountRef.current = 0;
        setRetryDisplay(0);
        const urlMap = { primary: primaryUrl, secondary: secondaryUrl, tertiary: tertiaryUrl };
        const best = ['primary', 'secondary', 'tertiary']
          .filter(s => urlMap[s])
          .sort((a, b) => (sourceStabilityRef.current[b] || 0) - (sourceStabilityRef.current[a] || 0));
        if (best.length > 0) {
          updateSource(best[0]);
          updateStreamState(STREAM_STATES.CONNECTING);
          initStream(urlMap[best[0]], best[0]);
        }
      }
    };

    const handleOffline = () => {
      addLog('Network lost', 'error');
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      destroyHls();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePlayClick = () => {
    attemptPlayback();
  };

  const getStatusLabel = () => {
    switch (streamState) {
      case STREAM_STATES.CONNECTING:
        return 'Connecting...';
      case STREAM_STATES.PLAYING:
        return needsUserInteraction ? 'Ready' : 'Live';
      case STREAM_STATES.TEAMS:
        return 'Live (Teams)';
      case STREAM_STATES.HOLD:
        return 'Standby';
      default:
        return 'Unknown';
    }
  };

  const getStatusClass = () => {
    switch (streamState) {
      case STREAM_STATES.CONNECTING:
        return 'status-connecting';
      case STREAM_STATES.PLAYING:
        return 'status-connected';
      case STREAM_STATES.TEAMS:
        return 'status-teams';
      case STREAM_STATES.HOLD:
        return 'status-hold';
      default:
        return '';
    }
  };

  const getSourceLabel = () => {
    switch (currentSource) {
      case 'primary':
        return 'Primary (Amazon IVS)';
      case 'secondary':
        return 'Backup (MUX)';
      case 'tertiary':
        return 'Backup (MediaPackage)';
      case 'teams':
        return 'Fallback (Teams)';
      case 'hold':
        return 'None active';
      default:
        return currentSource;
    }
  };

  const showPlayer = streamState === STREAM_STATES.PLAYING;
  const showTeams = streamState === STREAM_STATES.TEAMS;
  const showHold = streamState === STREAM_STATES.HOLD;
  const showConnecting = streamState === STREAM_STATES.CONNECTING;

  return (
    <>
      <div className="streaming-wrapper">
        <video
          ref={videoRef}
          controls
          playsInline
          className={showPlayer ? '' : 'hidden'}
        />

        {showTeams && teamsUrl && (
          <div className="teams-container">
            <iframe
              src={teamsUrl}
              title="Teams Live Stream"
              width="100%"
              height="100%"
              frameBorder="0"
              scrolling="no"
              allowFullScreen
              allow="autoplay; camera; microphone"
            />
          </div>
        )}

        <div className={`hold-screen ${showHold ? '' : 'hidden'}`}>
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

        <div className={`connecting-overlay ${showConnecting ? '' : 'hidden'}`}>
          <div className="spinner" />
          <div className="connecting-text">
            {currentSource === 'primary' && 'Connecting to stream...'}
            {currentSource === 'secondary' && 'Switching to backup stream...'}
            {currentSource === 'tertiary' && 'Switching to MediaPackage stream...'}
          </div>
        </div>

        {needsUserInteraction && streamState === STREAM_STATES.PLAYING && (
          <button
            className="streaming-play-button"
            onClick={handlePlayClick}
            type="button"
          >
            Start Stream
          </button>
        )}
      </div>

      {showDebug && (
        <div className="debug-panel">
          <div className="debug-header">
            <span className="debug-title">Stream Status</span>
            <button
              className="debug-toggle"
              onClick={() => setIsDebugExpanded(!isDebugExpanded)}
              type="button"
            >
              {isDebugExpanded ? 'Hide Details' : 'Show Details'}
            </button>
          </div>

          <div className="debug-content">
            <div className="debug-item">
              <span className="debug-label">Status</span>
              <span className={`debug-value ${getStatusClass()}`}>
                {getStatusLabel()}
              </span>
            </div>
            <div className="debug-item">
              <span className="debug-label">Stream Source</span>
              <span className="debug-value">{getSourceLabel()}</span>
            </div>
            <div className="debug-item">
              <span className="debug-label">Connection Attempts</span>
              <span className="debug-value">
                {retryDisplay} / {MAX_RETRIES}
              </span>
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
