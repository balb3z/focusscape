-- When a room_tables row is deleted (table closed by host, or auto-removed
-- by cleanup_empty_room_table / cleanup_stale_room_tables), make sure any
-- room_players rows still pointing at that table_id get their seat cleared.
--
-- Without this, players who were near/at a table when it got deleted (but
-- whose own client never ran standUp()) keep a stale table_id/seat_index in
-- the DB. Their local `myTable` may have been cleared client-side, but the
-- desynced DB row can cause them to appear seated to other clients, or to
-- get stuck again on the next resync (`myPlayer.tableId` looks truthy ->
-- client re-enters "seated" mode with no table to stand from).

CREATE OR REPLACE FUNCTION public.clear_seats_for_deleted_table()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.room_players
  SET table_id = NULL,
      seat_index = NULL,
      animation_state = 'idle',
      focus_status = 'idle'
  WHERE table_id = OLD.id::text;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_seats_for_deleted_table ON public.room_tables;
CREATE TRIGGER trg_clear_seats_for_deleted_table
AFTER DELETE ON public.room_tables
FOR EACH ROW
EXECUTE FUNCTION public.clear_seats_for_deleted_table();

-- One-off repair: clear any currently-orphaned seats (table_id pointing at a
-- table that no longer exists) for players that are already stuck right now.
UPDATE public.room_players rp
SET table_id = NULL,
    seat_index = NULL,
    animation_state = 'idle',
    focus_status = 'idle'
WHERE rp.table_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.room_tables rt WHERE rt.id::text = rp.table_id
  );
