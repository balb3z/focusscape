import { useEffect, useRef, useState } from "react";
import { LogOut, Send, Users, Timer, ChevronUp, MessageCircle, Mic, MicOff, Radio, ShieldAlert, Activity } from "lucide-react";
import type { MapDef } from "@/lib/maps";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { SyncMetrics } from "@/lib/multiplayer";
import { AmbientAudio } from "./AmbientAudio";
import { GamificationPanel } from "./GamificationPanel";
import { WatchTogetherPanel } from "./WatchTogetherPanel";
import type { ActiveTableInfo } from "./PhaserGame";
import { useVoiceChat } from "@/hooks/useVoiceChat";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const DURATIONS = [15, 25, 50, 90];

type ChatMsg = { id: string; user: string; text: string; ts: number };

export function GameHud({
  map,
  onLeave,
  onChat,
  onTyping,
  onLeaveTable,
  onCloseTable,
  chatLog,
  tableInfo,
  onlineCount,
  debugMetrics,
  myUserId,
}: {
  map: MapDef;
  onLeave: () => void;
  onChat: (text: string) => void;
  onTyping: (isTyping: boolean) => void;
  onLeaveTable: () => void;
  onCloseTable: () => Promise<void> | void;
  chatLog: ChatMsg[];
  tableInfo: ActiveTableInfo | null;
  onlineCount: number;
  debugMetrics: SyncMetrics | null;
  myUserId: string | null;
}) {
  const [text, setText] = useState("");
  const [duration, setDuration] = useState(tableInfo?.duration ?? 50);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [profile, setProfile] = useState<{ total_focus_minutes: number; current_streak: number } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const startedRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const voice = useVoiceChat({
    tableId: tableInfo?.tableId ?? null,
    userId: myUserId,
    enabled: !!tableInfo && !!myUserId,
  });

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from("profiles").select("total_focus_minutes,current_streak").eq("id", user.id).maybeSingle();
      if (data) setProfile(data as typeof profile);
    })();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [chatLog.length]);

  useEffect(() => {
    onTyping(text.trim().length > 0);
    const id = window.setTimeout(() => onTyping(false), 1200);
    return () => window.clearTimeout(id);
  }, [text, onTyping]);

  useEffect(() => {
    if (!tableInfo) {
      setRemaining(null);
      startedRef.current = null;
      sessionIdRef.current = null;
    } else {
      setDuration(tableInfo.duration);
    }
  }, [tableInfo]);

  useEffect(() => {
    if (remaining === null) return;
    if (remaining <= 0) { completeSession(true); return; }
    const id = setTimeout(() => setRemaining((r) => (r === null ? null : r - 1)), 1000);
    return () => clearTimeout(id);
  }, [remaining]);

  async function startFocus() {
    if (!tableInfo) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase.from("focus_sessions").insert({
      user_id: user.id, map_id: map.id, subject: tableInfo.subject, duration_minutes: duration,
    }).select("id").maybeSingle();
    if (error) { toast.error(error.message); return; }
    sessionIdRef.current = data?.id ?? null;
    startedRef.current = Date.now();
    setRemaining(duration * 60);
    toast.success(`🎯 Focusing on ${tableInfo.subject} for ${duration}m`);
  }

  async function completeSession(completed: boolean) {
    if (!sessionIdRef.current) { setRemaining(null); return; }
    const minutes = startedRef.current ? Math.round((Date.now() - startedRef.current) / 60000) : 0;
    await supabase.from("focus_sessions").update({ completed, ended_at: new Date().toISOString() }).eq("id", sessionIdRef.current);
    if (completed && minutes > 0) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: p } = await supabase.from("profiles").select("total_focus_minutes").eq("id", user.id).maybeSingle();
        const newTotal = (p?.total_focus_minutes ?? 0) + minutes;
        await supabase.from("profiles").update({ total_focus_minutes: newTotal }).eq("id", user.id);
        setProfile((prev) => prev ? { ...prev, total_focus_minutes: newTotal } : null);
        const xpGained = minutes * 10;
        toast.success(`✨ Session complete! +${xpGained} XP earned`);
      }
    }
    setRemaining(null);
    sessionIdRef.current = null;
    startedRef.current = null;
  }

  const mm = remaining !== null ? Math.floor(remaining / 60).toString().padStart(2, "0") : null;
  const ss = remaining !== null ? (remaining % 60).toString().padStart(2, "0") : null;
  const progressPct = remaining !== null ? ((duration * 60 - remaining) / (duration * 60)) * 100 : 0;

  return (
    <>
      {/* ── TOP BAR ── */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between p-4">
        {/* Left: Map Info */}
        <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-white/15 bg-black/50 px-4 py-2.5 backdrop-blur-xl shadow-xl">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400/20 ring-1 ring-amber-400/40">
            <Radio className="h-4 w-4 text-amber-300" />
          </div>
          <div>
            <div className="text-sm font-bold text-white leading-tight">{map.name}</div>
            <div className="flex items-center gap-1.5 text-xs text-white/50">
              <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <Users className="h-3 w-3" />
              {onlineCount} online
            </div>
          </div>
        </div>

        {/* Right: Actions bar */}
        <div className="pointer-events-auto flex items-center gap-2">
          {profile && (
            <GamificationPanel
              totalMinutes={profile.total_focus_minutes}
              streak={profile.current_streak}
            />
          )}
          <AmbientAudio suggestions={map.soundSuggestions} />
          <button
            onClick={() => { if (remaining !== null) completeSession(false); onLeave(); }}
            className="flex h-10 items-center gap-2 rounded-full border border-white/20 bg-black/50 px-3 text-white/70 backdrop-blur-xl transition hover:border-red-400/50 hover:text-red-400"
          >
            <LogOut className="h-4 w-4" />
            <span className="text-xs">Leave</span>
          </button>
        </div>
      </div>

      {/* ── MOVEMENT HINT ── */}
      <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2">
        <div className="rounded-full border border-white/10 bg-black/40 px-4 py-1.5 text-[11px] text-white/40 backdrop-blur">
          WASD · arrows to move &nbsp;·&nbsp; Click empty floor to create a table &nbsp;·&nbsp; Click a seat to join &nbsp;·&nbsp; Hold Space to talk
        </div>
      </div>

      {/* ── TABLE / SESSION CONTROLS ── */}
      {tableInfo && (
        <div className="pointer-events-auto absolute left-4 top-20 z-20 w-80">
          <div className="rounded-2xl border border-white/15 bg-black/70 backdrop-blur-xl shadow-2xl overflow-hidden">
            {remaining !== null && (
              <div className="h-1 bg-white/10">
                <div
                  className="h-1 bg-gradient-to-r from-amber-400 to-orange-500 transition-all duration-1000"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            )}
            <div className="px-4 py-3">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-white/40">
                <span>By {tableInfo.creator}</span>
                <span className="flex items-center gap-1 text-white/60"><Users className="h-3 w-3" />{tableInfo.occupants}/{tableInfo.maxSeats}</span>
              </div>
              <div className="mt-0.5 text-base font-bold text-white">{tableInfo.name}</div>
              <div className="text-xs text-amber-300/90">{tableInfo.subject}</div>
              {tableInfo.goal && (
                <div className="mt-1 text-[11px] leading-snug text-white/55 italic">"{tableInfo.goal}"</div>
              )}

              {remaining === null ? (
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-1.5">
                    {DURATIONS.map((d) => (
                      <button
                        key={d}
                        onClick={() => setDuration(d)}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${
                          duration === d
                            ? "bg-amber-400/20 ring-1 ring-amber-400/60 text-amber-300"
                            : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80"
                        }`}
                      >
                        {d}m
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={startFocus}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-amber-500/30 transition hover:shadow-amber-500/50 hover:scale-105"
                    >
                      <Timer className="h-3.5 w-3.5" /> Start Focus
                    </button>
                    <button
                      onClick={onLeaveTable}
                      className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] text-white/50 transition hover:text-white/80"
                    >
                      Stand up
                    </button>
                  </div>
                  {tableInfo.isOwner && (
                    <button
                      onClick={() => setConfirmClose(true)}
                      className="flex w-full items-center justify-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300 transition hover:bg-red-500/20"
                    >
                      <ShieldAlert className="h-3 w-3" /> Close table
                    </button>
                  )}
                </div>
              ) : (
                <div className="mt-2">
                  <div className="font-mono text-4xl tabular-nums font-bold text-center">
                    <span className="text-amber-400">{mm}</span>
                    <span className="text-white/30">:</span>
                    <span className="text-amber-400">{ss}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-center gap-2">
                    <button
                      onClick={() => completeSession(true)}
                      className="rounded-full bg-emerald-500/20 ring-1 ring-emerald-500/50 px-3 py-1 text-[11px] text-emerald-400 transition hover:bg-emerald-500/30"
                    >
                      ✓ Complete
                    </button>
                    <button
                      onClick={() => completeSession(false)}
                      className="rounded-full bg-white/5 px-3 py-1 text-[11px] text-white/40 transition hover:text-white/70"
                    >
                      Stop
                    </button>
                    {tableInfo.isOwner && (
                      <button
                        onClick={() => setConfirmClose(true)}
                        className="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-300 transition hover:bg-red-500/20"
                      >
                        Close
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ── PUSH-TO-TALK VOICE ── */}
              <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-2.5">
                <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-white/40">
                  <span className="flex items-center gap-1">
                    <Radio className="h-3 w-3" />
                    Voice
                  </span>
                  <span className={
                    voice.status === "live" ? (voice.peers > 0 ? "text-emerald-400" : "text-emerald-300/70")
                    : voice.status === "error" ? "text-red-400"
                    : "text-white/40"
                  }>
                    {voice.status === "live" ? (voice.peers > 0 ? `${voice.peers} peer${voice.peers === 1 ? "" : "s"}` : "ready")
                      : voice.status === "error" ? "error"
                      : voice.status === "requesting-mic" ? "asking…"
                      : voice.status === "connecting" ? "connecting…"
                      : "idle"}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    onPointerDown={(e) => { e.preventDefault(); voice.pressStart(); }}
                    onPointerUp={(e) => { e.preventDefault(); voice.pressEnd(); }}
                    onPointerLeave={() => voice.pressEnd()}
                    onPointerCancel={() => voice.pressEnd()}
                    disabled={voice.status === "error" || voice.muted}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[11px] font-semibold transition select-none ${
                      voice.transmitting && !voice.muted
                        ? "bg-emerald-500/30 ring-1 ring-emerald-400/70 text-emerald-200 shadow-[0_0_14px_rgba(74,222,128,0.4)]"
                        : "bg-white/5 text-white/70 hover:bg-white/10 disabled:opacity-40"
                    }`}
                    title="Hold to talk (Space)"
                  >
                    <Mic className="h-3.5 w-3.5" />
                    {voice.transmitting && !voice.muted ? "Talking" : "Hold (Space)"}
                  </button>
                  <button
                    onClick={() => voice.setMuted(!voice.muted)}
                    className={`rounded-lg px-2 py-1.5 text-[11px] transition ${
                      voice.muted ? "bg-red-500/20 text-red-300 ring-1 ring-red-400/40" : "bg-white/5 text-white/60 hover:bg-white/10"
                    }`}
                    title={voice.muted ? "Unmute" : "Mute"}
                  >
                    {voice.muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                  </button>
                </div>
                {voice.error && (
                  <div className="mt-1.5 text-[10px] text-red-300/80">{voice.error}</div>
                )}
                {(voice.transmitting && !voice.muted) || voice.speakers.size > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
                    {voice.transmitting && !voice.muted && (
                      <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-emerald-300 ring-1 ring-emerald-400/40">You</span>
                    )}
                    {[...voice.speakers].map((id) => (
                      <span key={id} className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300/80 ring-1 ring-emerald-400/30">
                        {id.slice(0, 6)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1.5 text-[10px] text-white/30">Only seated peers hear you.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── WATCH TOGETHER ── */}
      {tableInfo && myUserId && (
        <div className="pointer-events-auto absolute left-4 z-20" style={{ top: "calc(5rem + 14rem)" }}>
          <WatchTogetherPanel
            tableId={tableInfo.tableId}
            roomId={map.id}
            isHost={tableInfo.isOwner}
            userId={myUserId}
          />
        </div>
      )}

      {/* ── DIAGNOSTICS WIDGET ── */}
      {debugMetrics && (
        <div className="pointer-events-auto absolute bottom-4 left-4 z-20">
          <button
            onClick={() => setDiagOpen((o) => !o)}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-mono backdrop-blur-xl transition shadow-lg ${
              diagOpen
                ? "border-white/15 bg-black/70 text-white/70"
                : "border-white/10 bg-black/50 text-white/40 hover:text-white/60"
            }`}
          >
            <Activity className="h-3 w-3" />
            <span className={debugMetrics.consistency === "live" ? "text-emerald-400" : "text-red-400"}>
              {debugMetrics.pingMs ?? "—"}ms
            </span>
            <span className="text-white/30">|</span>
            <span>{debugMetrics.connectedPlayers} pl</span>
            <ChevronUp className={`h-3 w-3 transition-transform ${diagOpen ? "" : "rotate-180"}`} />
          </button>

          {diagOpen && (
            <div className="mt-2 w-56 rounded-2xl border border-white/10 bg-black/70 p-3 font-mono text-[10px] leading-relaxed text-white/40 backdrop-blur-xl shadow-xl">
              <div className="mb-1 flex items-center justify-between text-white/70">
                <span>Realtime</span>
                <span className={debugMetrics.consistency === "live" ? "text-emerald-400" : "text-red-400"}>{debugMetrics.websocketStatus}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3">
                <span>ping</span><span>{debugMetrics.pingMs ?? "—"}ms</span>
                <span>delay</span><span>{debugMetrics.syncDelayMs ?? "—"}ms</span>
                <span>in/out</span><span>{debugMetrics.packetInRate}/{debugMetrics.packetOutRate}s</span>
                <span>players</span><span>{debugMetrics.connectedPlayers}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CHAT PANEL ── */}
      <div className="pointer-events-auto absolute bottom-4 right-4 z-20 flex w-[22rem] max-w-[92vw] flex-col overflow-hidden rounded-3xl border border-white/15 bg-black/65 backdrop-blur-xl shadow-2xl">
        {/* Chat header */}
        <button
          onClick={() => setChatOpen((o) => !o)}
          className="flex items-center justify-between px-4 py-2.5 text-white/60 hover:text-white/80 transition"
        >
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
            <MessageCircle className="h-3.5 w-3.5" />
            Room Chat
            {chatLog.length > 0 && (
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-400/20 text-[9px] text-amber-400">
                {Math.min(chatLog.length, 99)}
              </span>
            )}
          </div>
          <ChevronUp className={`h-3.5 w-3.5 transition-transform ${chatOpen ? "" : "rotate-180"}`} />
        </button>

        {chatOpen && (
          <>
            <div ref={logRef} className="h-44 overflow-y-auto px-4 py-2 text-sm">
              {chatLog.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-white/25">
                  Messages float over your character ✨
                </div>
              ) : chatLog.map((m) => (
                <div key={m.id} className="mb-1 leading-snug">
                  <span className="font-semibold text-amber-400">{m.user}</span>{" "}
                  <span className="text-white/80">{m.text}</span>
                </div>
              ))}
            </div>
            <form
              className="flex border-t border-white/10"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) { onChat(text.trim().slice(0, 120)); onTyping(false); setText(""); }
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Say something…"
                maxLength={120}
                className="flex-1 bg-transparent px-4 py-2.5 text-sm text-white placeholder-white/25 outline-none"
              />
              <button type="submit" className="px-3 text-white/40 transition hover:text-amber-400">
                <Send className="h-4 w-4" />
              </button>
            </form>
          </>
        )}
      </div>

      {/* ── CLOSE TABLE CONFIRMATION ── */}
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure you want to close this study table?</AlertDialogTitle>
            <AlertDialogDescription>
              All participants will be removed from the table and the session will end.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                setConfirmClose(false);
                if (remaining !== null) await completeSession(false);
                await onCloseTable();
              }}
              className="bg-red-500 text-white hover:bg-red-600"
            >
              Close table
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
