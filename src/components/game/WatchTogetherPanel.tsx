/**
 * WatchTogetherPanel
 *
 * HOST:
 *   - Paste a YouTube URL to load a video
 *   - Play / Pause / ±10s seek buttons — all synced to every guest in real time
 *   - Expand button opens a cinematic fullscreen overlay
 *
 * GUEST:
 *   - Player mirrors host exactly (play, pause, seek position)
 *   - Same expand button for fullscreen comfort
 */

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Tv2, Play, Pause, Link, X, Loader2, AlertCircle,
  Maximize2, Minimize2, SkipBack, SkipForward,
} from "lucide-react";
import { useWatchTogether, extractYouTubeId, type YTPlayer } from "@/hooks/useWatchTogether";

// ── YouTube IFrame API types ──────────────────────────────────────────────────
declare global {
  interface Window {
    YT: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          videoId?: string;
          playerVars?: Record<string, unknown>;
          events?: {
            onReady?: (e: { target: YTPlayer }) => void;
            onStateChange?: (e: { data: number }) => void;
          };
        },
      ) => YTPlayer;
      PlayerState: { PLAYING: number; PAUSED: number; ENDED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<void> | null = null;
function loadYTApi(): Promise<void> {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT?.Player) { resolve(); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

// ── Shared player builder ─────────────────────────────────────────────────────
function buildPlayer(
  el: HTMLDivElement,
  videoId: string,
  isHost: boolean,
  onReady: (p: YTPlayer) => void,
  onStateChange: (state: number) => void,
): YTPlayer {
  return new window.YT.Player(el, {
    videoId,
    playerVars: {
      autoplay: 0,
      controls: 0,        // we render our own controls for both host & guest
      disablekb: 1,
      rel: 0,
      modestbranding: 1,
      iv_load_policy: 3,
    },
    events: {
      onReady: (e) => onReady(e.target),
      onStateChange: (e) => onStateChange(e.data),
    },
  });
}

// ── Main component ────────────────────────────────────────────────────────────
export function WatchTogetherPanel({
  tableId, roomId, isHost, userId,
}: {
  tableId: string;
  roomId: string;
  isHost: boolean;
  userId: string;
}) {
  const wt = useWatchTogether({ tableId, roomId, isHost, userId });

  const [urlInput, setUrlInput]     = useState("");
  const [urlError, setUrlError]     = useState("");
  const [apiReady, setApiReady]     = useState(false);
  const [mounted, setMounted]       = useState(false);   // small player ready
  const [fsMounted, setFsMounted]   = useState(false);   // fullscreen player ready
  const [open, setOpen]             = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Refs for the two player containers (panel + fullscreen overlay)
  const panelDivRef = useRef<HTMLDivElement>(null);
  const fsDivRef    = useRef<HTMLDivElement>(null);

  const panelPlayerRef = useRef<YTPlayer | null>(null);
  const fsPlayerRef    = useRef<YTPlayer | null>(null);
  const currentVidRef  = useRef("");

  // ── Load YT API once ───────────────────────────────────────────────────────
  useEffect(() => { loadYTApi().then(() => setApiReady(true)); }, []);

  // ── Helper: destroy a player safely ───────────────────────────────────────
  function destroyPlayer(ref: React.MutableRefObject<YTPlayer | null>) {
    if (ref.current) { try { ref.current.destroy(); } catch {} ref.current = null; }
  }

  // ── Build / rebuild PANEL player ──────────────────────────────────────────
  useEffect(() => {
    const vid = wt.videoId;
    if (!apiReady || !open || !vid) return;
    if (currentVidRef.current === vid && panelPlayerRef.current) return;

    currentVidRef.current = vid;
    destroyPlayer(panelPlayerRef);
    setMounted(false);

    const t = setTimeout(() => {
      if (!panelDivRef.current) return;
      buildPlayer(
        panelDivRef.current, vid, isHost,
        (p) => { panelPlayerRef.current = p; wt.onPlayerReady(p); setMounted(true); },
        (state) => { if (isHost) handleHostStateChange(state, p => panelPlayerRef.current === p); },
      );
    }, 100);
    return () => clearTimeout(t);
  }, [apiReady, open, wt.videoId]);

  // ── Build / rebuild FULLSCREEN player ─────────────────────────────────────
  useEffect(() => {
    const vid = wt.videoId;
    if (!apiReady || !fullscreen || !vid) return;

    destroyPlayer(fsPlayerRef);
    setFsMounted(false);

    const t = setTimeout(() => {
      if (!fsDivRef.current) return;
      buildPlayer(
        fsDivRef.current, vid, isHost,
        (p) => {
          fsPlayerRef.current = p;
          // Sync position immediately on open
          if (wt.session) {
            p.seekTo(wt.session.current_seconds, true);
            if (wt.session.is_playing) p.playVideo(); else p.pauseVideo();
          }
          setFsMounted(true);
        },
        (state) => { if (isHost) handleHostStateChange(state, p => fsPlayerRef.current === p); },
      );
    }, 100);
    return () => clearTimeout(t);
  }, [apiReady, fullscreen, wt.videoId]);

  // ── When fullscreen closes, re-sync panel player to current session state ─
  useEffect(() => {
    if (!fullscreen && panelPlayerRef.current && wt.session) {
      const p = panelPlayerRef.current;
      p.seekTo(wt.session.current_seconds, true);
      if (wt.session.is_playing) p.playVideo(); else p.pauseVideo();
    }
  }, [fullscreen]);

  // ── Sync panel player when re-opened ──────────────────────────────────────
  useEffect(() => {
    if (mounted && panelPlayerRef.current) wt.onPlayerReady(panelPlayerRef.current);
  }, [mounted]);

  // ── Host: intercept native YT play/pause events and broadcast them ─────────
  // This makes the native YT controls in fullscreen work for everyone too.
  function handleHostStateChange(state: number, isSelf: (p: YTPlayer) => boolean) {
    // YT.PlayerState: 1 = PLAYING, 2 = PAUSED
    if (state === 1) {
      // Playing — broadcast
      const player = isSelf(panelPlayerRef.current!) ? panelPlayerRef.current : fsPlayerRef.current;
      const t = player?.getCurrentTime() ?? 0;
      wt.broadcastState(true, t);
    } else if (state === 2) {
      const player = isSelf(panelPlayerRef.current!) ? panelPlayerRef.current : fsPlayerRef.current;
      const t = player?.getCurrentTime() ?? 0;
      wt.broadcastState(false, t);
    }
  }

  // ── URL handler ───────────────────────────────────────────────────────────
  const handleSetUrl = useCallback(async () => {
    const id = extractYouTubeId(urlInput.trim());
    if (!id) { setUrlError("Couldn't find a YouTube video ID in that URL."); return; }
    setUrlError("");
    await wt.setVideoUrl(urlInput.trim());
    setUrlInput("");
  }, [urlInput, wt.setVideoUrl]);

  // ── Host seek helpers ─────────────────────────────────────────────────────
  const activePlayer = () => fullscreen ? fsPlayerRef.current : panelPlayerRef.current;

  const handlePlay  = useCallback(async () => {
    const p = activePlayer(); if (!p) return;
    const t = p.getCurrentTime();
    await wt.broadcastState(true, t);
    p.playVideo();
  }, [wt, fullscreen]);

  const handlePause = useCallback(async () => {
    const p = activePlayer(); if (!p) return;
    const t = p.getCurrentTime();
    await wt.broadcastState(false, t);
    p.pauseVideo();
  }, [wt, fullscreen]);

  const handleSeek = useCallback(async (delta: number) => {
    const p = activePlayer(); if (!p) return;
    const t = Math.max(0, p.getCurrentTime() + delta);
    await wt.seek(t);
    p.seekTo(t, true);
  }, [wt, fullscreen]);

  // ── Controls bar (shared between panel and fullscreen) ───────────────────
  function ControlsBar({ compact = false }: { compact?: boolean }) {
    if (!isHost || !wt.videoId) return null;
    return (
      <div className={`flex items-center justify-center gap-2 ${compact ? "px-3 py-2" : "px-4 py-2.5"} border-t border-white/10 bg-black/60`}>
        <button
          onClick={() => handleSeek(-10)}
          title="Back 10s for everyone"
          className="flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          <SkipBack className="h-3.5 w-3.5" /> 10s
        </button>

        {wt.isPlaying ? (
          <button
            onClick={handlePause}
            className="flex items-center gap-1.5 rounded-full bg-white/10 border border-white/20 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
          >
            <Pause className="h-3.5 w-3.5" /> Pause for everyone
          </button>
        ) : (
          <button
            onClick={handlePlay}
            disabled={!mounted && !fsMounted}
            className="flex items-center gap-1.5 rounded-full bg-purple-500/25 border border-purple-400/40 px-4 py-1.5 text-xs font-medium text-purple-200 transition hover:bg-purple-500/40 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" /> Play for everyone
          </button>
        )}

        <button
          onClick={() => handleSeek(10)}
          title="Forward 10s for everyone"
          className="flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          10s <SkipForward className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // ── Collapsed button ──────────────────────────────────────────────────────
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full border border-white/15 bg-black/50 px-3 py-1.5 text-[11px] text-white/60 transition hover:border-purple-400/40 hover:text-purple-300 hover:bg-purple-500/10 backdrop-blur-md"
      >
        <Tv2 className="h-3.5 w-3.5" />
        Watch Together
        {wt.videoId && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-purple-400 animate-pulse" />}
      </button>
    );
  }

  // ── Fullscreen overlay ────────────────────────────────────────────────────
  const FullscreenOverlay = fullscreen && (
    <div className="fixed inset-0 z-[200] flex flex-col bg-black/95 backdrop-blur-xl">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 bg-black/60">
        <div className="flex items-center gap-2">
          <Tv2 className="h-4 w-4 text-purple-400" />
          <span className="text-sm font-semibold text-white">Watch Together</span>
          {!isHost && (
            <span className="rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-purple-400">
              Synced
            </span>
          )}
        </div>
        <button
          onClick={() => setFullscreen(false)}
          className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/60 transition hover:text-white hover:bg-white/10"
        >
          <Minimize2 className="h-3.5 w-3.5" /> Exit fullscreen
        </button>
      </div>

      {/* Video */}
      <div className="relative flex-1 flex items-center justify-center bg-black">
        {wt.videoId ? (
          <>
            <div ref={fsDivRef} className="w-full h-full max-h-[calc(100vh-120px)]" />
            {!fsMounted && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <Tv2 className="h-12 w-12 text-white/20" />
            <p className="text-sm text-white/40">No video loaded yet</p>
          </div>
        )}
      </div>

      {/* Controls */}
      <ControlsBar />
    </div>
  );

  // ── Panel ─────────────────────────────────────────────────────────────────
  return (
    <>
      {FullscreenOverlay}

      <div className="rounded-2xl border border-white/15 bg-black/80 backdrop-blur-xl shadow-2xl overflow-hidden w-80">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Tv2 className="h-4 w-4 text-purple-400" />
            <span className="text-sm font-semibold text-white">Watch Together</span>
            {!isHost && (
              <span className="rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-purple-400">
                Guest
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {wt.videoId && (
              <button
                onClick={() => setFullscreen(true)}
                title="Expand to fullscreen"
                className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/40 transition hover:text-white hover:bg-white/10"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/40 transition hover:text-white hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Host URL input */}
        {isHost && (
          <div className="px-4 py-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Link className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/30" />
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => { setUrlInput(e.target.value); setUrlError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleSetUrl()}
                  placeholder="Paste YouTube URL…"
                  className="w-full rounded-lg border border-white/15 bg-white/5 pl-8 pr-3 py-1.5 text-xs text-white placeholder-white/30 outline-none focus:border-purple-400/50 transition"
                />
              </div>
              <button
                onClick={handleSetUrl}
                disabled={!urlInput.trim()}
                className="rounded-lg bg-purple-500/20 border border-purple-400/30 px-3 py-1.5 text-xs text-purple-300 transition hover:bg-purple-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Load
              </button>
            </div>
            {urlError && (
              <div className="mt-1.5 flex items-center gap-1 text-[10px] text-red-400">
                <AlertCircle className="h-3 w-3 flex-shrink-0" /> {urlError}
              </div>
            )}
          </div>
        )}

        {/* Player */}
        <div className="relative bg-black aspect-video w-full">
          {wt.videoId ? (
            <>
              <div ref={panelDivRef} className="w-full h-full" />
              {!mounted && (
                <div className="absolute inset-0 flex items-center justify-center bg-black">
                  <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <Tv2 className="h-8 w-8 text-white/20" />
              <p className="text-xs text-white/40">
                {isHost ? "Paste a YouTube link above to start watching together" : "Waiting for the host to start a video…"}
              </p>
            </div>
          )}
        </div>

        {/* Controls */}
        <ControlsBar compact />

        {/* Guest sync indicator */}
        {!isHost && wt.videoId && (
          <div className="flex items-center justify-center gap-1.5 px-4 py-2 border-t border-white/10 text-[10px] text-white/40">
            <span className="h-1.5 w-1.5 rounded-full bg-purple-400 animate-pulse" />
            Synced with host
          </div>
        )}

        {wt.error && (
          <div className="px-4 py-2 text-[10px] text-red-400 border-t border-white/10">{wt.error}</div>
        )}
      </div>
    </>
  );
}
