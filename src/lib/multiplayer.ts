import type { SupabaseClient } from "@supabase/supabase-js";
import type Phaser from "phaser";
import type { Database } from "@/integrations/supabase/types";
import { AVATAR_COLORS, getCharacterStyle, type MapDef, type CharacterConfig } from "@/lib/maps";

export type PlayerAnimationState = "idle" | "walking" | "focused";
export type PlayerFocusStatus = "idle" | "focused";

export type SyncMetrics = {
  websocketStatus: string;
  pingMs: number | null;
  syncDelayMs: number | null;
  packetInRate: number;
  packetOutRate: number;
  connectedPlayers: number;
  consistency: "syncing" | "live" | "degraded";
  lastEvent: string;
  lastEventAt: number | null;
  reconnectAttempts: number;
  heartbeatAt: number | null;
  lastRealtimeActivityAt: number | null;
  localX: number | null;
  localY: number | null;
  authoritativeX: number | null;
  authoritativeY: number | null;
  roomStateVersion: number;
  activeTables: number;
};

export type SharedPlayerState = {
  id: string;
  userId: string;
  username: string;
  avatar_id: number;
  avatar_url?: string | null;
  gender?: "male" | "female";
  character_config?: CharacterConfig | null;
  currentMap: string;
  roomId: string;
  x: number;
  y: number;
  animationState: PlayerAnimationState;
  status: PlayerAnimationState;
  table?: string | null;
  tableId?: string | null;
  seatIndex?: number | null;
  focusStatus: PlayerFocusStatus;
  typing?: boolean;
  vx?: number;
  vy?: number;
  sentAt?: number;
  clientSeq?: number;
  lastSeen: number;
};

type RoomPlayerRow = Database["public"]["Tables"]["room_players"]["Row"];
type RoomPlayerUpsert = Database["public"]["Tables"]["room_players"]["Insert"];
type RoomListener = (players: SharedPlayerState[]) => void;

const ACTIVE_PLAYER_WINDOW_MS = 45_000;
const DATABASE_DOMINANCE_WINDOW_MS = 2_500;
const MOVEMENT_BROADCAST_MS = 33;
const DATABASE_WRITE_MS = 400;
const PRESENCE_TRACK_MS = 15_000;
const HEARTBEAT_MS = 6_000;
const WATCHDOG_MS = 4_000;
const STALE_CHANNEL_MS = 25_000;
// How often to do a full DB resync to catch players whose departure wasn't
// announced via a clean PLAYER_LEAVE (closed tab, crash, lost connection).
const PERIODIC_RESYNC_MS = 8_000;
const RECONNECT_BASE_MS = 600;
const RECONNECT_MAX_MS = 6_000;
const GHOST_REMOVAL_DELAY_MS = 4_000;
// A player can be momentarily missing from a snapshot (resync race, brief
// network hiccup) without actually having left. Only start fading them out
// after they've been absent from the player list for this long.
const ABSENCE_GRACE_MS = 3_000;

const defaultMetrics: SyncMetrics = {
  websocketStatus: "connecting",
  pingMs: null,
  syncDelayMs: null,
  packetInRate: 0,
  packetOutRate: 0,
  connectedPlayers: 0,
  consistency: "syncing",
  lastEvent: "boot",
  lastEventAt: null,
  reconnectAttempts: 0,
  heartbeatAt: null,
  lastRealtimeActivityAt: null,
  localX: null,
  localY: null,
  authoritativeX: null,
  authoritativeY: null,
  roomStateVersion: 0,
  activeTables: 0,
};

export const roomChannelName = (mapId: string) => {
  const names: Record<string, string> = {
    cafe: "room_cozy_cafe",
    library: "room_library",
    hub: "room_programming_hub",
    hall: "room_university_hall",
    park: "room_focus_park",
  };
  return names[mapId] ?? `room_${mapId.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
};

export const rowToSharedPlayer = (row: RoomPlayerRow): SharedPlayerState => ({
  id: row.user_id,
  userId: row.user_id,
  username: row.username,
  avatar_id: row.avatar_id,
  avatar_url: row.avatar_url,
  gender: ((row as unknown as { gender?: string }).gender === "female" ? "female" : "male"),
  character_config: (row as unknown as { character_config?: CharacterConfig | null }).character_config ?? null,
  currentMap: row.room_id,
  roomId: row.room_id,
  x: row.x,
  y: row.y,
  animationState: row.animation_state as PlayerAnimationState,
  status: row.animation_state as PlayerAnimationState,
  table: row.table_id,
  tableId: row.table_id,
  seatIndex: row.seat_index ?? null,
  focusStatus: row.focus_status as PlayerFocusStatus,
  typing: false,
  vx: 0,
  vy: 0,
  sentAt: new Date(row.last_seen).getTime(),
  clientSeq: 0,
  lastSeen: new Date(row.last_seen).getTime(),
});

const sharedPlayerToRow = (player: SharedPlayerState, lastSeen = new Date(player.lastSeen || Date.now()).toISOString()): RoomPlayerUpsert => ({
  user_id: player.userId,
  room_id: player.roomId,
  username: player.username,
  avatar_id: player.avatar_id,
  avatar_url: player.avatar_url ?? null,
  x: player.x,
  y: player.y,
  animation_state: player.animationState,
  table_id: player.tableId ?? player.table ?? null,
  seat_index: player.seatIndex ?? null,
  focus_status: player.focusStatus,
  last_seen: lastSeen,
  ...({ gender: player.gender ?? "male" } as Record<string, string>),
  character_config: (player.character_config ?? null) as unknown as Record<string, unknown> | null,
});

export class SharedRoomState {
  private players = new Map<string, SharedPlayerState>();
  private listeners = new Set<RoomListener>();
  private stateVersion = 0;

  constructor(public readonly roomId: string) {}

  subscribe(listener: RoomListener) {
    this.listeners.add(listener);
    listener(this.list());
    return () => this.listeners.delete(listener);
  }

  setSnapshot(players: SharedPlayerState[]) {
    const incomingIds = new Set(players.map((p) => p.userId));

    players.forEach((player) => {
      const existing = this.players.get(player.userId);
      if (!existing) {
        this.players.set(player.userId, player);
        return;
      }
      const existingTime = existing.sentAt ?? existing.lastSeen ?? 0;
      const nextTime = player.sentAt ?? player.lastSeen ?? 0;
      if (nextTime >= existingTime) this.players.set(player.userId, player);
    });

    // The snapshot is the authoritative active-player list from the DB
    // (filtered by ACTIVE_PLAYER_WINDOW_MS). Anyone we're tracking but who
    // is missing from it has gone stale/offline — remove them so they don't
    // linger in the UI until an unrelated update happens to clear them.
    for (const userId of [...this.players.keys()]) {
      if (!incomingIds.has(userId)) this.players.delete(userId);
    }

    this.emit("snapshot");
  }

  upsert(player: SharedPlayerState) {
    if (player.roomId !== this.roomId) return;
    const existing = this.players.get(player.userId);
    if (existing) {
      const existingTime = existing.sentAt ?? existing.lastSeen ?? 0;
      const nextTime = player.sentAt ?? player.lastSeen ?? 0;
      const existingSeq = existing.clientSeq ?? 0;
      const nextSeq = player.clientSeq ?? 0;
      if (nextSeq > 0 && existingSeq > 0 && nextSeq < existingSeq) return;
      if (nextSeq === 0 && existingSeq > 0 && Date.now() - existingTime < DATABASE_DOMINANCE_WINDOW_MS) return;
      if (nextSeq === 0 && existingSeq > 0 && nextTime + 250 < existingTime) return;
      if (nextSeq === existingSeq && nextTime + 250 < existingTime) return;
    }
    this.players.set(player.userId, player);
    this.emit("upsert");
  }

  remove(userId: string) {
    if (!this.players.delete(userId)) return;
    this.emit("remove");
  }

  list() {
    return [...this.players.values()].sort((a, b) => a.username.localeCompare(b.username));
  }

  count() { return this.players.size; }
  get(userId: string) { return this.players.get(userId) ?? null; }
  version() { return this.stateVersion; }
  activeTableCount() {
    return new Set(this.list().map((p) => p.tableId ?? p.table).filter(Boolean)).size;
  }

  private emit(reason: string) {
    this.stateVersion += 1;
    const players = this.list();
    this.listeners.forEach((l) => l(players));
    void reason;
  }
}

export class AuthoritativeRoomManager extends SharedRoomState {}
export class PlayerStateManager extends AuthoritativeRoomManager {}

export class PresenceSyncService {
  private channel: ReturnType<SupabaseClient<Database>["channel"]> | null = null;
  private localPlayer: SharedPlayerState;
  private heartbeat: number | null = null;
  private metricsTimer: number | null = null;
  private watchdog: number | null = null;
  private periodicResync: number | null = null;
  private reconnectTimer: number | null = null;
  private lastWrite = 0;
  private lastBroadcast = 0;
  private lastPresenceTrack = 0;
  private lastRealtimeActivity = Date.now();
  private channelGeneration = 0;
  private clientSeq = 0;
  private leaving = false;
  private connecting = false;
  private subscribed = false;
  private reconnectAttempts = 0;
  private recentPresenceKeys = new Map<string, number>();
  private broadcastListeners: Array<{ event: string; callback: (payload: unknown) => void }> = [];
  private metricListeners = new Set<(metrics: SyncMetrics) => void>();
  private metrics: SyncMetrics = { ...defaultMetrics };
  private packetsIn = 0;
  private packetsOut = 0;
  private pingWaitingSince: number | null = null;

  private readonly handleOnline = () => {
    this.scheduleReconnect("browser online", 0);
  };
  private readonly handleVisibility = () => {
    if (document.visibilityState === "visible") {
      void this.resyncAuthoritativeState("tab visible");
      if (!this.subscribed) this.scheduleReconnect("tab visible", 0);
    }
  };

  constructor(
    private readonly supabase: SupabaseClient<Database>,
    private readonly roomState: SharedRoomState,
    localPlayer: SharedPlayerState,
    private readonly onStatus?: (status: string) => void,
    private readonly onLocalAuthoritativeState?: (player: SharedPlayerState) => void,
  ) {
    this.localPlayer = localPlayer;
  }

  async join() {
    const channelName = roomChannelName(this.localPlayer.roomId);
    this.updateMetrics({ websocketStatus: "connecting", lastEvent: "joining", lastEventAt: Date.now() });

    const staleSeenAt = new Date(Date.now() - ACTIVE_PLAYER_WINDOW_MS - 1_000).toISOString();
    await this.supabase
      .from("room_players")
      .update({ last_seen: staleSeenAt })
      .eq("user_id", this.localPlayer.userId)
      .neq("room_id", this.localPlayer.roomId);

    const { data: savedPlayer, error: savedError } = await this.supabase
      .from("room_players")
      .select("*")
      .eq("user_id", this.localPlayer.userId)
      .eq("room_id", this.localPlayer.roomId)
      .maybeSingle();

    if (savedError) console.warn("[mp] saved room state failed", savedError);
    if (savedPlayer) {
      const restored = rowToSharedPlayer(savedPlayer);
      this.localPlayer = {
        ...this.localPlayer, ...restored,
        username: this.localPlayer.username,
        avatar_id: this.localPlayer.avatar_id,
        avatar_url: this.localPlayer.avatar_url,
        typing: false,
      };
      this.onLocalAuthoritativeState?.(this.localPlayer);
    }

    this.localPlayer = this.withClock(this.localPlayer);
    await this.supabase.from("room_players").upsert(sharedPlayerToRow(this.localPlayer), { onConflict: "user_id,room_id" });

    await this.resyncAuthoritativeState("initial join");
    await this.connectRealtimeChannel("initial join");
    this.startKeepaliveTimers();
    window.addEventListener("online", this.handleOnline);
    document.addEventListener("visibilitychange", this.handleVisibility);
    void channelName;
  }

  private startKeepaliveTimers() {
    if (this.heartbeat) window.clearInterval(this.heartbeat);
    if (this.metricsTimer) window.clearInterval(this.metricsTimer);
    if (this.watchdog) window.clearInterval(this.watchdog);
    if (this.periodicResync) window.clearInterval(this.periodicResync);

    this.heartbeat = window.setInterval(() => {
      if (this.leaving) return;
      this.updateMetrics({ heartbeatAt: Date.now(), lastRealtimeActivityAt: this.lastRealtimeActivity });
      this.syncLocal(this.localPlayer, true);
      void this.trackPresence("heartbeat");
    }, HEARTBEAT_MS);

    this.metricsTimer = window.setInterval(() => {
      this.updateMetrics({
        packetInRate: this.packetsIn,
        packetOutRate: this.packetsOut,
        connectedPlayers: this.roomState.count(),
        consistency: this.metrics.websocketStatus === "live" ? "live" : "degraded",
        roomStateVersion: this.roomState.version(),
        activeTables: this.roomState.activeTableCount(),
      });
      this.packetsIn = 0;
      this.packetsOut = 0;
      if (this.pingWaitingSince && Date.now() - this.pingWaitingSince > 3_000) this.pingWaitingSince = null;
      if (!this.pingWaitingSince && this.subscribed && this.channel) {
        this.pingWaitingSince = Date.now();
        this.sendBroadcast("PING", { from: this.localPlayer.userId, nonce: `${this.localPlayer.userId}-${this.clientSeq}`, sentAt: this.pingWaitingSince });
      }
    }, 1000);

    this.watchdog = window.setInterval(() => {
      if (this.leaving) return;
      const inactiveFor = Date.now() - this.lastRealtimeActivity;
      if (!this.channel || !this.subscribed) {
        this.scheduleReconnect("watchdog unsubscribed");
      } else if (inactiveFor > STALE_CHANNEL_MS) {
        // Don't tear down a working channel just because it's been quiet —
        // do a lightweight resync first. Only escalate to reconnect if it
        // stays stale for much longer.
        console.warn("[mp] channel quiet, soft resync", { inactiveFor });
        void this.resyncAuthoritativeState("watchdog soft resync");
        if (inactiveFor > STALE_CHANNEL_MS * 3) {
          this.scheduleReconnect("watchdog hard stale");
        } else {
          // Treat the resync as activity so we don't immediately re-trigger.
          this.lastRealtimeActivity = Date.now() - STALE_CHANNEL_MS + WATCHDOG_MS;
        }
      }
    }, WATCHDOG_MS);

    // Periodic full resync against the DB. This is the primary mechanism
    // that catches players who disconnected without a clean PLAYER_LEAVE
    // (closed tab, lost connection, crash) — their stale `last_seen` row
    // will be excluded from the snapshot and setSnapshot() will remove them
    // from everyone else's view within one cycle.
    this.periodicResync = window.setInterval(() => {
      if (this.leaving) return;
      void this.resyncAuthoritativeState("periodic");
    }, PERIODIC_RESYNC_MS);
  }

  syncLocal(next: Partial<SharedPlayerState>, force = false) {
    const now = Date.now();
    this.localPlayer = this.withClock({ ...this.localPlayer, ...next, lastSeen: now }, now);
    this.roomState.upsert(this.localPlayer);
    this.updateMetrics({
      localX: Math.round(this.localPlayer.x),
      localY: Math.round(this.localPlayer.y),
      authoritativeX: Math.round(this.localPlayer.x),
      authoritativeY: Math.round(this.localPlayer.y),
    });

    const shouldBroadcast = force || (now - this.lastBroadcast >= MOVEMENT_BROADCAST_MS);
    if (shouldBroadcast) {
      this.lastBroadcast = now;
      void this.sendPlayerEvent(force ? "PLAYER_STATE" : "PLAYER_MOVE", this.localPlayer);
    }

    if (!force && now - this.lastWrite < DATABASE_WRITE_MS) return;
    this.lastWrite = now;
    void this.supabase.from("room_players").upsert(sharedPlayerToRow(this.localPlayer), { onConflict: "user_id,room_id" });
  }

  sendChat(payload: { id: string; user: string; text: string }) {
    this.sendBroadcast("chat", { ...payload, sentAt: Date.now() });
  }

  sendBroadcastEvent(event: string, payload: Record<string, unknown>) {
    this.sendBroadcast(event, { ...payload, sentAt: Date.now() });
  }

  sendTyping(isTyping: boolean) {
    const now = Date.now();
    this.localPlayer = this.withClock({ ...this.localPlayer, typing: isTyping, lastSeen: now }, now);
    this.roomState.upsert(this.localPlayer);
    void this.sendPlayerEvent("PLAYER_STATE", this.localPlayer);
  }

  onMetrics(listener: (metrics: SyncMetrics) => void) {
    this.metricListeners.add(listener);
    listener(this.metrics);
    return () => this.metricListeners.delete(listener);
  }

  getLocalPlayer() { return this.localPlayer; }

  onBroadcast(event: string, callback: (payload: unknown) => void) {
    this.broadcastListeners.push({ event, callback });
    this.channel?.on("broadcast", { event }, ({ payload }) => {
      this.markInbound(event, (payload as { sentAt?: number } | undefined)?.sentAt);
      callback(payload);
    });
  }

  async leave() {
    if (this.leaving) return;
    this.leaving = true;
    if (this.heartbeat) window.clearInterval(this.heartbeat);
    if (this.metricsTimer) window.clearInterval(this.metricsTimer);
    if (this.watchdog) window.clearInterval(this.watchdog);
    if (this.periodicResync) window.clearInterval(this.periodicResync);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    window.removeEventListener("online", this.handleOnline);
    document.removeEventListener("visibilitychange", this.handleVisibility);

    // Send the leave broadcast and write the offline DB row in parallel,
    // then give the realtime socket a brief moment to actually flush the
    // broadcast to other subscribers before we tear the channel down.
    // Without this delay, `removeChannel` can close the socket before the
    // PLAYER_LEAVE message is delivered, leaving remote clients unaware
    // until their next resync.
    const offlineSeenAt = new Date(Date.now() - ACTIVE_PLAYER_WINDOW_MS - 1_000).toISOString();
    await Promise.all([
      this.channel?.send({ type: "broadcast", event: "PLAYER_LEAVE", payload: { userId: this.localPlayer.userId, sentAt: Date.now() } }),
      this.supabase.from("room_players").upsert(sharedPlayerToRow({ ...this.localPlayer, lastSeen: Date.now() }, offlineSeenAt), { onConflict: "user_id,room_id" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await this.channel?.untrack();
    if (this.channel) await this.supabase.removeChannel(this.channel);
    this.channel = null;
    this.subscribed = false;
  }

  private async connectRealtimeChannel(reason: string) {
    if (this.leaving || this.connecting) return;
    this.connecting = true;
    this.subscribed = false;
    const generation = ++this.channelGeneration;
    const channelName = roomChannelName(this.localPlayer.roomId);
    this.updateMetrics({ websocketStatus: "connecting", consistency: "syncing", lastEvent: `connect:${reason}`, lastEventAt: Date.now() });

    if (this.channel) {
      const old = this.channel; this.channel = null;
      try { await this.supabase.removeChannel(old); } catch { /* ignore */ }
    }

    const channel = this.supabase.channel(channelName, {
      config: { broadcast: { self: true, ack: false }, presence: { key: this.localPlayer.userId } },
    });
    this.channel = channel;

    this.broadcastListeners.forEach(({ event, callback }) => {
      channel.on("broadcast", { event }, ({ payload }) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        this.markInbound(event, (payload as { sentAt?: number } | undefined)?.sentAt);
        callback(payload);
      });
    });

    channel
      .on("presence", { event: "sync" }, () => {
        if (!this.isCurrentChannel(channel, generation)) return;
        this.markInbound("presence sync");
        const keys = Object.keys(channel.presenceState());
        keys.forEach((k) => this.recentPresenceKeys.set(k, Date.now()));
        this.updateMetrics({ connectedPlayers: this.roomState.count(), lastEvent: "presence sync", lastEventAt: Date.now() });
      })
      .on("presence", { event: "join" }, ({ key }) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        this.markInbound("presence join");
        this.recentPresenceKeys.set(key, Date.now());
      })
      .on("presence", { event: "leave" }, ({ key }) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        this.markInbound("presence leave");
        if (key === this.localPlayer.userId) return;
        const lastSeen = this.recentPresenceKeys.get(key) ?? 0;
        const timeSincePresence = Date.now() - lastSeen;
        if (timeSincePresence < 1500) return;
        this.roomState.remove(key);
      })
      .on("broadcast", { event: "PLAYER_MOVE" }, ({ payload }) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        const player = payload as SharedPlayerState;
        this.markInbound("movement", player.sentAt);
        if (player.userId !== this.localPlayer.userId) {
          this.roomState.upsert(player);
        }
      })
      .on("broadcast", { event: "PLAYER_STATE" }, ({ payload }) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        const player = payload as SharedPlayerState;
        this.markInbound("state", player.sentAt);
        if (player.userId !== this.localPlayer.userId) this.roomState.upsert(player);
      })
      .on("broadcast", { event: "PLAYER_JOIN" }, ({ payload }) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        this.markInbound("join", (payload as SharedPlayerState).sentAt);
        this.roomState.upsert(payload as SharedPlayerState);
      })
      .on("broadcast", { event: "PLAYER_LEAVE" }, ({ payload }) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        this.markInbound("leave");
        const { userId } = payload as { userId: string };
        if (userId !== this.localPlayer.userId) this.roomState.remove(userId);
      })
      .on("broadcast", { event: "PING" }, ({ payload }) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        const data = payload as { from?: string; nonce?: string; sentAt?: number };
        this.markInbound("ping", data.sentAt);
        if (data.from !== this.localPlayer.userId) {
          this.sendBroadcast("PONG", { from: this.localPlayer.userId, nonce: data.nonce, sentAt: data.sentAt, receivedAt: Date.now() });
        }
      })
      .on("broadcast", { event: "PONG" }, ({ payload }) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        const data = payload as { sentAt?: number };
        this.markInbound("pong", data.sentAt);
        if (this.pingWaitingSince && data.sentAt === this.pingWaitingSince) {
          this.updateMetrics({ pingMs: Date.now() - this.pingWaitingSince, lastEvent: "pong", lastEventAt: Date.now() });
          this.pingWaitingSince = null;
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "room_players", filter: `room_id=eq.${this.localPlayer.roomId}` }, (payload) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        this.markInbound(`db:${payload.eventType}`);
        if (payload.eventType === "DELETE") {
          const oldRow = payload.old as Partial<RoomPlayerRow>;
          if (oldRow.user_id) this.roomState.remove(oldRow.user_id);
          return;
        }
        const newRow = payload.new as RoomPlayerRow;
        if (!newRow?.user_id) return;
        const player = rowToSharedPlayer(newRow);
        if (Date.now() - player.lastSeen > ACTIVE_PLAYER_WINDOW_MS) {
          this.roomState.remove(player.userId);
          return;
        }
        if (player.userId === this.localPlayer.userId) {
          this.updateMetrics({ authoritativeX: Math.round(player.x), authoritativeY: Math.round(player.y) });
          return;
        }
        // Enrich with profile data if character_config is missing from the row
        if (!player.character_config) {
          void this.supabase
            .from("profiles")
            .select("gender, character_config")
            .eq("id", player.userId)
            .maybeSingle()
            .then(({ data: prof }) => {
              if (prof) {
                this.roomState.upsert({
                  ...player,
                  gender: (prof.gender === "female" ? "female" : "male") as "male" | "female",
                  character_config: (prof.character_config as unknown as CharacterConfig | null) ?? null,
                });
              } else {
                this.roomState.upsert(player);
              }
            });
        } else {
          this.roomState.upsert(player);
        }
      })
      .subscribe(async (status) => {
        if (!this.isCurrentChannel(channel, generation)) return;
        this.onStatus?.(status);
        if (status === "SUBSCRIBED") {
          if (this.reconnectTimer) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
          this.connecting = false;
          this.subscribed = true;
          this.reconnectAttempts = 0;
          this.lastRealtimeActivity = Date.now();
          this.updateMetrics({ websocketStatus: "live", consistency: "live", reconnectAttempts: 0, lastRealtimeActivityAt: this.lastRealtimeActivity, lastEvent: "subscribed", lastEventAt: Date.now() });
          this.localPlayer = this.withClock(this.localPlayer);
          await this.trackPresence("subscribed", true);
          await this.sendPlayerEvent("PLAYER_JOIN", this.localPlayer);
          await this.resyncAuthoritativeState("subscribed");
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          this.connecting = false;
          this.subscribed = false;
          this.updateMetrics({ websocketStatus: status.toLowerCase(), consistency: "degraded", lastEvent: status, lastEventAt: Date.now() });
          this.scheduleReconnect(status);
        }
      });
  }

  private async resyncAuthoritativeState(reason: string) {
    const cutoff = new Date(Date.now() - ACTIVE_PLAYER_WINDOW_MS).toISOString();
    const { data, error } = await this.supabase
      .from("room_players")
      .select("*")
      .eq("room_id", this.localPlayer.roomId)
      .gte("last_seen", cutoff);

    if (error) {
      console.error(`[mp] resync failed (${reason})`, error);
      this.updateMetrics({ consistency: "degraded", lastEvent: "resync failed", lastEventAt: Date.now() });
      return;
    }

    const rows = data ?? [];

    // Fetch character_config + gender from profiles for all players in one query.
    // We do this separately because room_players has no FK to public.profiles
    // (it references auth.users), so PostgREST joins don't work here.
    let profileMap = new Map<string, { gender?: string; character_config?: CharacterConfig | null }>();
    if (rows.length > 0) {
      const userIds = rows.map((r) => r.user_id);
      const { data: profiles } = await this.supabase
        .from("profiles")
        .select("id, gender, character_config")
        .in("id", userIds);
      if (profiles) {
        profiles.forEach((p) => {
          profileMap.set(p.id, {
            gender: p.gender ?? undefined,
            character_config: (p.character_config as unknown as CharacterConfig | null) ?? null,
          });
        });
      }
    }

    const enriched = rows.map((row) => {
      const prof = profileMap.get(row.user_id);
      return {
        ...row,
        gender: prof?.gender ?? row.gender ?? "male",
        character_config: prof?.character_config ?? (row as unknown as { character_config?: CharacterConfig | null }).character_config ?? null,
      };
    });

    const snapshot = enriched.map(rowToSharedPlayer).filter((p) => p.userId !== this.localPlayer.userId);
    snapshot.push(this.localPlayer);
    this.roomState.setSnapshot(snapshot);
    this.updateMetrics({ connectedPlayers: this.roomState.count(), roomStateVersion: this.roomState.version(), activeTables: this.roomState.activeTableCount(), lastEvent: `resync:${reason}`, lastEventAt: Date.now() });
  }

  private scheduleReconnect(reason: string, explicitDelay?: number) {
    if (this.leaving || this.reconnectTimer) return;
    this.subscribed = false;
    const delay = explicitDelay ?? Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts) + Math.round(Math.random() * 250);
    this.reconnectAttempts += 1;
    this.updateMetrics({ websocketStatus: "reconnecting", consistency: "degraded", reconnectAttempts: this.reconnectAttempts, lastEvent: `reconnect:${reason}`, lastEventAt: Date.now() });
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.leaving || this.subscribed) return;
      this.connecting = false;
      await this.resyncAuthoritativeState(`before reconnect:${reason}`);
      await this.connectRealtimeChannel(`reconnect:${reason}`);
    }, delay);
  }

  private isCurrentChannel(channel: ReturnType<SupabaseClient<Database>["channel"]>, generation: number) {
    return this.channel === channel && this.channelGeneration === generation && !this.leaving;
  }

  private async trackPresence(reason: string, force = false) {
    const now = Date.now();
    if (!this.channel || !this.subscribed || (!force && now - this.lastPresenceTrack < PRESENCE_TRACK_MS)) return;
    this.lastPresenceTrack = now;
    try {
      const result = await this.channel.track(this.localPlayer);
      // Presence tracking failures are usually transient (rate limit) and
      // self-heal on the next heartbeat — don't tear down the channel.
      if (result !== "ok") console.warn("[mp] presence track non-ok", { reason, result });
    } catch (error) {
      console.warn("[mp] presence track failed (non-fatal)", { reason, error });
    }
  }

  private withClock(player: SharedPlayerState, now = Date.now()): SharedPlayerState {
    this.clientSeq += 1;
    return { ...player, sentAt: now, clientSeq: this.clientSeq, lastSeen: now };
  }

  private async sendPlayerEvent(event: "PLAYER_JOIN" | "PLAYER_MOVE" | "PLAYER_STATE", player: SharedPlayerState) {
    this.updateMetrics({ lastEvent: event, lastEventAt: Date.now() });
    await this.sendBroadcast(event, player);
  }

  private async sendBroadcast(event: string, payload: unknown) {
    this.packetsOut += 1;
    if (!this.channel || !this.subscribed) {
      // Only escalate to a reconnect for non-movement events; movement is
      // sent at high frequency and the channel will recover on its own.
      if (!this.connecting && event !== "PLAYER_MOVE" && event !== "PING" && event !== "PONG") {
        this.scheduleReconnect(`send while disconnected:${event}`, 0);
      }
      return;
    }
    try {
      const result = await this.channel.send({ type: "broadcast", event, payload });
      // A single failed send (e.g. transient rate limit) should not tear down
      // the whole channel — only escalate for important, low-frequency events.
      if (result !== "ok" && event !== "PLAYER_MOVE" && event !== "PING" && event !== "PONG") {
        this.scheduleReconnect(`send ${event} ${result}`);
      }
    } catch (error) {
      if (event !== "PLAYER_MOVE" && event !== "PING" && event !== "PONG") {
        console.error("[mp] outbound event failed", { event, error });
        this.scheduleReconnect(`send ${event} error`);
      }
    }
  }

  private markInbound(lastEvent: string, sentAt?: number) {
    this.packetsIn += 1;
    this.lastRealtimeActivity = Date.now();
    this.updateMetrics({
      syncDelayMs: sentAt ? Math.max(0, Date.now() - sentAt) : this.metrics.syncDelayMs,
      lastRealtimeActivityAt: this.lastRealtimeActivity,
      lastEvent,
      lastEventAt: Date.now(),
      connectedPlayers: this.roomState.count(),
    });
  }

  private updateMetrics(next: Partial<SyncMetrics>) {
    this.metrics = { ...this.metrics, ...next };
    this.metricListeners.forEach((l) => l(this.metrics));
  }
}

export class RealtimeMovementController extends PresenceSyncService {}
export class StateReconciliationManager extends RealtimeMovementController {}
export class PositionPersistenceSystem extends StateReconciliationManager {}
export class RealtimeSyncManager extends PositionPersistenceSystem {}
export class RoomStateSynchronizer extends PositionPersistenceSystem {}

export class MovementInterpolator {
  static step(current: number, target: number, dtMs: number, speed = 18) {
    return current + (target - current) * Math.min(1, (dtMs / 1000) * speed);
  }
}

type RemoteEntry = {
  container: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Rectangle;
  nameText: Phaser.GameObjects.Text;
  avatarUrl?: string | null;
  avatarImg?: Phaser.GameObjects.Image;
  bubble?: Phaser.GameObjects.Container;
  currentX: number;
  currentY: number;
  targetX: number;
  targetY: number;
  vx: number;
  vy: number;
  lastUpdateMs: number;
  sentAtMs: number;
  animationState: PlayerAnimationState;
  focusStatus: PlayerFocusStatus;
  typing: boolean;
  ghostSince: number | null;
  lastSeenInListMs: number;
  /** Serialized character config — used to detect when we need to rebuild the sprite. */
  characterConfigKey: string;
};

export class RemotePlayerManager {
  private others = new Map<string, RemoteEntry>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly PhaserLib: typeof Phaser,
    private readonly map: MapDef,
    private readonly localUserId: string,
    private readonly loadAvatar: (url: string, onReady: (key: string) => void) => void,
  ) {}

  render(players: SharedPlayerState[]) {
    const now = Date.now();
    const activeIds = new Set(
      players.filter((p) => p.userId !== this.localUserId).map((p) => p.userId),
    );

    players.forEach((p) => {
      if (p.userId !== this.localUserId) this.upsert(p);
    });

    for (const [id, entry] of this.others) {
      if (activeIds.has(id)) {
        entry.lastSeenInListMs = now;
        if (entry.ghostSince !== null) {
          entry.ghostSince = null;
          this.scene.tweens.killTweensOf(entry.container);
          this.scene.tweens.add({ targets: entry.container, alpha: 1, duration: 250 });
        }
        continue;
      }
      // Player missing from this snapshot. Only start ghosting after they've
      // been absent for a sustained period (ABSENCE_GRACE_MS) — a single
      // missed snapshot (e.g. during a resync) should not cause a fade.
      const missingFor = now - entry.lastSeenInListMs;
      if (missingFor > ABSENCE_GRACE_MS && entry.ghostSince === null) {
        entry.ghostSince = now;
        this.scene.tweens.add({
          targets: entry.container,
          alpha: 0,
          duration: Math.min(GHOST_REMOVAL_DELAY_MS * 0.7, 1200),
          ease: "Power2",
        });
      }
    }
  }

  update(dtMs: number) {
    const now = Date.now();

    for (const [id, entry] of this.others) {
      if (entry.ghostSince !== null && now - entry.ghostSince > GHOST_REMOVAL_DELAY_MS) {
        entry.container.destroy();
        entry.bubble?.destroy();
        this.others.delete(id);
        continue;
      }

      const isSeated = entry.animationState === "focused" || entry.focusStatus === "focused";

      if (isSeated) {
        // Smooth glide into the seat.
        entry.currentX = MovementInterpolator.step(entry.currentX, entry.targetX, dtMs, 14);
        entry.currentY = MovementInterpolator.step(entry.currentY, entry.targetY, dtMs, 14);
      } else {
        // Dead-reckoning: extrapolate from the last known velocity for up to
        // 180ms (longer than that and velocity is probably stale/zero).
        const ageSec = Math.min((now - entry.sentAtMs) / 1000, 0.18);
        const predictedX = entry.targetX + entry.vx * ageSec;
        const predictedY = entry.targetY + entry.vy * ageSec;

        // Adaptive speed: snap faster when far away (catch up quickly),
        // glide smoothly when close (avoid jitter on tiny corrections).
        const dist = Math.hypot(predictedX - entry.currentX, predictedY - entry.currentY);
        const speed = dist > 60 ? 30 : dist > 12 ? 22 : 14;

        entry.currentX = MovementInterpolator.step(entry.currentX, predictedX, dtMs, speed);
        entry.currentY = MovementInterpolator.step(entry.currentY, predictedY, dtMs, speed);
      }

      entry.container.x = entry.currentX;
      entry.container.y = entry.currentY;
    }
  }

  getContainer(userId: string) { return this.others.get(userId)?.container; }

  showBubble(userId: string, text: string) {
    const t = this.getContainer(userId);
    if (t) this.showBubbleOn(t, text);
  }

  destroy() {
    this.others.forEach((e) => e.container.destroy());
    this.others.clear();
  }

  private upsert(player: SharedPlayerState) {
    const style = getCharacterStyle(player.gender ?? "male", player.character_config ?? null);
    const newConfigKey = `${player.gender ?? "male"}:${JSON.stringify(player.character_config ?? null)}`;
    const nowMs = Date.now();
    let entry = this.others.get(player.userId);

    // If the player already exists but their character config has changed (e.g.
    // config arrived late from the profile join), destroy the old sprite and
    // rebuild it so the correct colours appear.
    if (entry && entry.characterConfigKey !== newConfigKey) {
      const savedX = entry.currentX;
      const savedY = entry.currentY;
      entry.container.destroy();
      entry.bubble?.destroy();
      this.others.delete(player.userId);
      entry = undefined;
      // Re-enter with the correct position so the new sprite appears in place
      player = { ...player, x: savedX, y: savedY };
    }

    if (!entry) {
      const container = this.scene.add.container(player.x, player.y).setDepth(9).setAlpha(0);
      const shadow  = this.scene.add.ellipse(0, 18, 28, 8, 0x000000, 0.35);
      const legL    = this.scene.add.rectangle(-5, 14, 7, 14, style.pants).setStrokeStyle(1, 0x000000, 0.3);
      const legR    = this.scene.add.rectangle(5, 14, 7, 14, style.pants).setStrokeStyle(1, 0x000000, 0.3);
      const body    = this.scene.add.rectangle(0, 0, 22, 26, style.shirt).setStrokeStyle(2, 0x000000, 0.35);
      const armL    = this.scene.add.rectangle(-13, 0, 5, 18, style.shirt).setStrokeStyle(1, 0x000000, 0.3);
      const armR    = this.scene.add.rectangle(13, 0, 5, 18, style.shirt).setStrokeStyle(1, 0x000000, 0.3);
      const head    = this.scene.add.circle(0, -16, 9, style.skin).setStrokeStyle(2, 0x000000, 0.35);
      const hairExtras: Phaser.GameObjects.GameObject[] = [];
      const rhs = style.hairStyle;
      if (rhs !== "bald") {
        hairExtras.push(this.scene.add.ellipse(0, -22, 18, 8, style.hair));
        if (rhs === "long" || rhs === "wavy") {
          hairExtras.push(this.scene.add.ellipse(-8, -13, 6, 13, style.hair));
          hairExtras.push(this.scene.add.ellipse(8, -13, 6, 13, style.hair));
        } else if (rhs === "bun") {
          hairExtras.push(this.scene.add.circle(0, -28, 6, style.hair));
          hairExtras.push(this.scene.add.ellipse(-6, -17, 5, 9, style.hair));
          hairExtras.push(this.scene.add.ellipse(6, -17, 5, 9, style.hair));
        } else if (rhs === "braids") {
          hairExtras.push(this.scene.add.rectangle(-8, -8, 4, 18, style.hair));
          hairExtras.push(this.scene.add.rectangle(8, -8, 4, 18, style.hair));
        } else if (rhs === "curly") {
          for (let ci = -2; ci <= 2; ci++) {
            hairExtras.push(this.scene.add.circle(ci * 4, -24, 4, style.hair));
          }
        } else if (rhs === "fade") {
          hairExtras.push(this.scene.add.ellipse(-7, -19, 4, 8, style.hair, 0.5));
          hairExtras.push(this.scene.add.ellipse(7, -19, 4, 8, style.hair, 0.5));
        } else if (rhs === "long_m") {
          hairExtras.push(this.scene.add.ellipse(-8, -14, 5, 11, style.hair));
          hairExtras.push(this.scene.add.ellipse(8, -14, 5, 11, style.hair));
        }
      }
      const eyeL = this.scene.add.circle(-3, -17, 1.1, 0x111111);
      const eyeR = this.scene.add.circle(3, -17, 1.1, 0x111111);
      const ring = this.scene.add.circle(0, -52, 18, this.map.accent, 0.0).setStrokeStyle(2, this.map.accent, 0.9);
      const nameText = this.scene.add.text(0, -76, player.username, {
        fontFamily: "monospace", fontSize: "12px", color: "#ffffff",
        backgroundColor: "#00000099", padding: { x: 4, y: 2 },
      }).setOrigin(0.5);
      container.add([shadow, legL, legR, body, armL, armR, head, ...hairExtras, eyeL, eyeR, ring, nameText]);
      this.scene.tweens.add({ targets: body, scaleY: 1.04, duration: 1700 + Math.random() * 600, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      this.scene.tweens.add({ targets: container, alpha: 1, duration: 350, ease: "Power2" });

      entry = {
        container, body, nameText,
        avatarUrl: player.avatar_url ?? null,
        currentX: player.x, currentY: player.y,
        targetX: player.x, targetY: player.y,
        vx: player.vx ?? 0, vy: player.vy ?? 0,
        lastUpdateMs: nowMs,
        sentAtMs: player.sentAt ?? nowMs,
        animationState: player.animationState,
        focusStatus: player.focusStatus,
        typing: !!player.typing,
        ghostSince: null,
        lastSeenInListMs: nowMs,
        characterConfigKey: newConfigKey,
      };
      this.others.set(player.userId, entry);
      if (player.avatar_url) this.attachAvatar(player.userId, player.avatar_url);
    } else {
      if (entry.ghostSince !== null) {
        entry.ghostSince = null;
        this.scene.tweens.killTweensOf(entry.container);
        this.scene.tweens.add({ targets: entry.container, alpha: 1, duration: 250 });
      }

      entry.nameText.setText(`${player.username}${player.typing ? " …" : ""}`);

      const isSeated = player.animationState === "focused" || player.focusStatus === "focused";
      entry.targetX = player.x;
      entry.targetY = player.y;
      entry.vx = isSeated ? 0 : (player.vx ?? 0);
      entry.vy = isSeated ? 0 : (player.vy ?? 0);
      entry.lastUpdateMs = nowMs;
      entry.sentAtMs = player.sentAt ?? nowMs;
      entry.animationState = player.animationState;
      entry.focusStatus = player.focusStatus;
      entry.typing = !!player.typing;

      const dist = Math.hypot(entry.currentX - player.x, entry.currentY - player.y);
      if (dist > 400) {
        entry.currentX = player.x;
        entry.currentY = player.y;
      }

      if (player.avatar_url && player.avatar_url !== entry.avatarUrl) {
        entry.avatarUrl = player.avatar_url;
        this.attachAvatar(player.userId, player.avatar_url);
      }
    }

    const seated = entry.animationState === "focused" || entry.focusStatus === "focused";
    entry.container.setAlpha(seated ? 0.9 : 1);
    entry.body.scaleY = entry.animationState === "walking" ? 1.08 : 1;
  }

  private attachAvatar(userId: string, url: string) {
    this.loadAvatar(url, (key) => {
      const entry = this.others.get(userId);
      if (!entry) return;
      if (entry.avatarImg) entry.avatarImg.destroy();
      const img = this.scene.add.image(0, -52, key).setDisplaySize(30, 30);
      const mask = this.scene.add.graphics().fillCircle(0, -52, 14).setVisible(false);
      img.setMask(new this.PhaserLib.Display.Masks.GeometryMask(this.scene, mask));
      entry.container.add([mask, img]);
      entry.avatarImg = img;
    });
  }

  private showBubbleOn(target: Phaser.GameObjects.Container, text: string) {
    const trimmed = text.slice(0, 80);
    const bg  = this.scene.add.rectangle(0, -100, Math.min(160, trimmed.length * 8 + 16), 22, 0xffffff, 0.95).setStrokeStyle(2, 0x000000, 0.2);
    const txt = this.scene.add.text(0, -100, trimmed, { fontFamily: "monospace", fontSize: "11px", color: "#222" }).setOrigin(0.5);
    const bubble = this.scene.add.container(0, 0, [bg, txt]).setDepth(20);
    target.add(bubble);
    this.scene.time.delayedCall(3500, () => bubble.destroy());
  }
}
