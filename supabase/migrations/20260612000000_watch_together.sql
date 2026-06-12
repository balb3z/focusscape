-- watch_together_sessions
-- Stores the YouTube video state for a table session.
-- Only the table creator (host) can update; all seated members can read.

CREATE TABLE public.watch_together_sessions (
  table_id    TEXT        NOT NULL PRIMARY KEY,
  room_id     TEXT        NOT NULL,
  host_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  video_url   TEXT        NOT NULL DEFAULT '',
  video_id    TEXT        NOT NULL DEFAULT '',
  is_playing  BOOLEAN     NOT NULL DEFAULT false,
  current_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.watch_together_sessions TO authenticated;
GRANT ALL ON public.watch_together_sessions TO service_role;

ALTER TABLE public.watch_together_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone authenticated can view watch sessions"
  ON public.watch_together_sessions FOR SELECT TO authenticated USING (true);

CREATE POLICY "Only host can insert watch session"
  ON public.watch_together_sessions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = host_id);

CREATE POLICY "Only host can update watch session"
  ON public.watch_together_sessions FOR UPDATE TO authenticated
  USING (auth.uid() = host_id)
  WITH CHECK (auth.uid() = host_id);

CREATE POLICY "Only host can delete watch session"
  ON public.watch_together_sessions FOR DELETE TO authenticated
  USING (auth.uid() = host_id);

CREATE INDEX watch_together_room_idx ON public.watch_together_sessions (room_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.watch_together_sessions;
ALTER TABLE public.watch_together_sessions REPLICA IDENTITY FULL;
