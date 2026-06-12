/**
 * useWatchTogether
 *
 * Manages a real-time synced YouTube watch session for a study table.
 *
 * - The HOST (table creator) controls playback: play/pause/seek/change video.
 * - GUESTS receive state updates and sync their player to match the host within
 *   a configurable tolerance (~2 s).
 * - State is persisted in `watch_together_sessions` and broadcast via Supabase
 *   Realtime so late-joiners immediately get the current video position.
 *
 * Usage:
 *   const wt = useWatchTogether({ tableId, roomId, isHost, userId });
 *   // mount <YouTube videoId={wt.videoId} onReady={wt.onPlayerReady} ... />
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type WatchSession = {
  table_id: string;
  room_id: string;
  host_id: string;
  video_url: string;
  video_id: string;
  is_playing: boolean;
  current_seconds: number;
  updated_at: string;
};

export type UseWatchTogetherOptions = {
  tableId: string | null;
  roomId: string;
  isHost: boolean;
  userId: string | null;
};

export type UseWatchTogetherReturn = {
  session: WatchSession | null;
  /** Extracted YouTube video ID, ready for the iframe embed URL */
  videoId: string;
  isPlaying: boolean;
  /** Call when the YouTube IFrame API player is ready */
  onPlayerReady: (player: YTPlayer) => void;
  /** Host only: set a new YouTube URL */
  setVideoUrl: (url: string) => Promise<void>;
  /** Host only: play */
  play: () => Promise<void>;
  /** Host only: pause */
  pause: () => Promise<void>;
  /** Host only: seek to seconds */
  seek: (seconds: number) => Promise<void>;
  loading: boolean;
  error: string | null;
};

// Minimal YT player interface so we don't need @types/youtube
export type YTPlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  destroy: () => void;
};

const SYNC_TOLERANCE_S = 2.5; // seconds before we force-seek a guest

export function extractYouTubeId(url: string): string {
  if (!url) return "";
  // Handle youtu.be/ID
  const short = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (short) return short[1];
  // Handle ?v=ID or &v=ID
  const long = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (long) return long[1];
  // Handle youtube.com/embed/ID
  const embed = url.match(/embed\/([a-zA-Z0-9_-]{11})/);
  if (embed) return embed[1];
  // Handle youtube.com/shorts/ID
  const shorts = url.match(/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shorts) return shorts[1];
  return "";
}

export function useWatchTogether({
  tableId,
  roomId,
  isHost,
  userId,
}: UseWatchTogetherOptions): UseWatchTogetherReturn {
  const [session, setSession] = useState<WatchSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // Prevent re-entrancy when applying a remote state update
  const applyingRemote = useRef(false);

  // ── Fetch initial session ─────────────────────────────────────────────────
  useEffect(() => {
    if (!tableId) { setSession(null); return; }

    let cancelled = false;
    setLoading(true);

    supabase
      .from("watch_together_sessions")
      .select("*")
      .eq("table_id", tableId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setSession(data as WatchSession | null);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [tableId]);

  // ── Realtime subscription ─────────────────────────────────────────────────
  useEffect(() => {
    if (!tableId) return;

    // Clean up previous channel
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const channel = supabase
      .channel(`watch_together:${tableId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "watch_together_sessions",
          filter: `table_id=eq.${tableId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setSession(null);
            return;
          }
          const incoming = payload.new as WatchSession;
          setSession(incoming);

          // Guests: sync their player to the incoming state
          if (!isHost && playerRef.current) {
            applyRemoteState(incoming, playerRef.current);
          }
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [tableId, isHost]);

  // ── Sync guest player when session changes ────────────────────────────────
  useEffect(() => {
    if (isHost || !session || !playerRef.current) return;
    applyRemoteState(session, playerRef.current);
  }, [session, isHost]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function applyRemoteState(s: WatchSession, player: YTPlayer) {
    if (applyingRemote.current) return;
    applyingRemote.current = true;
    try {
      const currentTime = player.getCurrentTime();
      if (Math.abs(currentTime - s.current_seconds) > SYNC_TOLERANCE_S) {
        player.seekTo(s.current_seconds, true);
      }
      if (s.is_playing) {
        player.playVideo();
      } else {
        player.pauseVideo();
      }
    } finally {
      setTimeout(() => { applyingRemote.current = false; }, 500);
    }
  }

  async function upsertSession(patch: Partial<WatchSession>) {
    if (!tableId || !userId) return;
    const base: WatchSession = session ?? {
      table_id: tableId,
      room_id: roomId,
      host_id: userId,
      video_url: "",
      video_id: "",
      is_playing: false,
      current_seconds: 0,
      updated_at: new Date().toISOString(),
    };
    const next = { ...base, ...patch, updated_at: new Date().toISOString() };
    const { error: err } = await supabase
      .from("watch_together_sessions")
      .upsert(next, { onConflict: "table_id" });
    if (err) setError(err.message);
    else setSession(next);
  }

  // ── Host actions ──────────────────────────────────────────────────────────
  const setVideoUrl = useCallback(async (url: string) => {
    if (!isHost) return;
    const videoId = extractYouTubeId(url);
    await upsertSession({ video_url: url, video_id: videoId, is_playing: false, current_seconds: 0 });
  }, [isHost, tableId, userId, session]);

  const play = useCallback(async () => {
    if (!isHost || !playerRef.current) return;
    const currentTime = playerRef.current.getCurrentTime();
    await upsertSession({ is_playing: true, current_seconds: currentTime });
    playerRef.current.playVideo();
  }, [isHost, tableId, userId, session]);

  const pause = useCallback(async () => {
    if (!isHost || !playerRef.current) return;
    const currentTime = playerRef.current.getCurrentTime();
    await upsertSession({ is_playing: false, current_seconds: currentTime });
    playerRef.current.pauseVideo();
  }, [isHost, tableId, userId, session]);

  const seek = useCallback(async (seconds: number) => {
    if (!isHost || !playerRef.current) return;
    await upsertSession({ current_seconds: seconds });
    playerRef.current.seekTo(seconds, true);
  }, [isHost, tableId, userId, session]);

  const onPlayerReady = useCallback((player: YTPlayer) => {
    playerRef.current = player;
    // Immediately sync to whatever the current session state is
    if (session) {
      applyRemoteState(session, player);
    }
  }, [session, isHost]);

  return {
    session,
    videoId: session?.video_id ?? "",
    isPlaying: session?.is_playing ?? false,
    onPlayerReady,
    setVideoUrl,
    play,
    pause,
    seek,
    loading,
    error,
  };
}
