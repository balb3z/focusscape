/**
 * useWatchTogether
 *
 * Real-time synced YouTube playback for a study table.
 *
 * HOST  → writes play/pause/seek state to Supabase → all guests receive via Realtime.
 * GUEST → reads state changes and mirrors them on their player immediately.
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
  videoId: string;
  isPlaying: boolean;
  onPlayerReady: (player: YTPlayer) => void;
  setVideoUrl: (url: string) => Promise<void>;
  /** Host only: broadcast an arbitrary play/pause + position to all guests */
  broadcastState: (playing: boolean, seconds: number) => Promise<void>;
  /** Host only: seek everyone to an absolute position */
  seek: (seconds: number) => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  loading: boolean;
  error: string | null;
};

export type YTPlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  destroy: () => void;
};

const SYNC_TOLERANCE_S = 2.5;

export function extractYouTubeId(url: string): string {
  if (!url) return "";
  const short  = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);  if (short)  return short[1];
  const long   = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);       if (long)   return long[1];
  const embed  = url.match(/embed\/([a-zA-Z0-9_-]{11})/);       if (embed)  return embed[1];
  const shorts = url.match(/shorts\/([a-zA-Z0-9_-]{11})/);      if (shorts) return shorts[1];
  return "";
}

export function useWatchTogether({
  tableId, roomId, isHost, userId,
}: UseWatchTogetherOptions): UseWatchTogetherReturn {

  const [session, setSession]   = useState<WatchSession | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error,   setError]     = useState<string | null>(null);

  const playerRef        = useRef<YTPlayer | null>(null);
  const channelRef       = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const applyingRemote   = useRef(false);

  // Keep a fresh copy of session in a ref so callbacks never close over stale state
  const sessionRef = useRef<WatchSession | null>(null);
  sessionRef.current = session;

  // ── Fetch initial session ──────────────────────────────────────────────────
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
        if (!cancelled) { setSession(data as WatchSession | null); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [tableId]);

  // ── Realtime subscription ──────────────────────────────────────────────────
  useEffect(() => {
    if (!tableId) return;
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }

    const channel = supabase
      .channel(`watch_together:${tableId}`)
      .on("postgres_changes", {
        event: "*", schema: "public",
        table: "watch_together_sessions",
        filter: `table_id=eq.${tableId}`,
      }, (payload) => {
        if (payload.eventType === "DELETE") { setSession(null); return; }
        const incoming = payload.new as WatchSession;
        setSession(incoming);
        // Guests sync immediately when they receive any state change
        if (!isHost && playerRef.current) {
          applyRemoteState(incoming, playerRef.current);
        }
      })
      .subscribe();

    channelRef.current = channel;
    return () => { supabase.removeChannel(channel); channelRef.current = null; };
  }, [tableId, isHost]);

  // ── Guest: also sync when session changes via state update ────────────────
  useEffect(() => {
    if (isHost || !session || !playerRef.current) return;
    applyRemoteState(session, playerRef.current);
  }, [session, isHost]);

  // ── Apply remote state to a player ────────────────────────────────────────
  function applyRemoteState(s: WatchSession, player: YTPlayer) {
    if (applyingRemote.current) return;
    applyingRemote.current = true;
    try {
      // Always seek if drift > tolerance
      const currentTime = player.getCurrentTime();
      if (Math.abs(currentTime - s.current_seconds) > SYNC_TOLERANCE_S) {
        player.seekTo(s.current_seconds, true);
      }
      // Always apply play/pause state
      if (s.is_playing) {
        player.playVideo();
      } else {
        player.pauseVideo();
      }
    } finally {
      setTimeout(() => { applyingRemote.current = false; }, 600);
    }
  }

  // ── Upsert helper ──────────────────────────────────────────────────────────
  async function upsertSession(patch: Partial<WatchSession>) {
    if (!tableId || !userId) return;
    const base: WatchSession = sessionRef.current ?? {
      table_id: tableId, room_id: roomId, host_id: userId,
      video_url: "", video_id: "", is_playing: false,
      current_seconds: 0, updated_at: new Date().toISOString(),
    };
    const next = { ...base, ...patch, updated_at: new Date().toISOString() };
    const { error: err } = await supabase
      .from("watch_together_sessions")
      .upsert(next, { onConflict: "table_id" });
    if (err) setError(err.message);
    else setSession(next);
  }

  // ── Host actions ───────────────────────────────────────────────────────────
  const setVideoUrl = useCallback(async (url: string) => {
    if (!isHost) return;
    const videoId = extractYouTubeId(url);
    await upsertSession({ video_url: url, video_id: videoId, is_playing: false, current_seconds: 0 });
  }, [isHost, tableId, userId]);

  /** Generic broadcast: host sets playing state + position for everyone */
  const broadcastState = useCallback(async (playing: boolean, seconds: number) => {
    if (!isHost) return;
    await upsertSession({ is_playing: playing, current_seconds: seconds });
  }, [isHost, tableId, userId]);

  const play = useCallback(async () => {
    if (!isHost || !playerRef.current) return;
    const t = playerRef.current.getCurrentTime();
    await upsertSession({ is_playing: true, current_seconds: t });
    playerRef.current.playVideo();
  }, [isHost, tableId, userId]);

  const pause = useCallback(async () => {
    if (!isHost || !playerRef.current) return;
    const t = playerRef.current.getCurrentTime();
    await upsertSession({ is_playing: false, current_seconds: t });
    playerRef.current.pauseVideo();
  }, [isHost, tableId, userId]);

  const seek = useCallback(async (seconds: number) => {
    if (!isHost) return;
    await upsertSession({ current_seconds: seconds });
    playerRef.current?.seekTo(seconds, true);
  }, [isHost, tableId, userId]);

  const onPlayerReady = useCallback((player: YTPlayer) => {
    playerRef.current = player;
    if (sessionRef.current) applyRemoteState(sessionRef.current, player);
  }, []);

  return {
    session, videoId: session?.video_id ?? "", isPlaying: session?.is_playing ?? false,
    onPlayerReady, setVideoUrl, broadcastState, seek, play, pause, loading, error,
  };
}
