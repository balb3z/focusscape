-- Automatically delete a room_tables row once nobody is seated at it.
-- This fixes "ghost tables" that stay visible after the host (or all guests)
-- leave/close their browser without explicitly clicking "leave table".
--
-- Trigger fires on room_players UPDATE/DELETE. Whenever a player's
-- table_id changes away from a table (or the row is deleted), we check if
-- that table still has any occupants (seat_index IS NOT NULL). If not, the
-- table row is deleted, which also cascades the table_closed broadcast via
-- the existing room_tables realtime subscription (DELETE event).

CREATE OR REPLACE FUNCTION public.cleanup_empty_room_table()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected_table_id text;
  remaining_occupants integer;
BEGIN
  -- Determine which table_id (if any) might have just lost its last occupant.
  IF TG_OP = 'DELETE' THEN
    affected_table_id := OLD.table_id;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Relevant if: the table_id changed, seat was cleared, or this player
    -- just went stale (e.g. leave() marks last_seen in the past) while still
    -- seated at a table.
    IF OLD.table_id IS NOT NULL AND (
         NEW.table_id IS DISTINCT FROM OLD.table_id
         OR NEW.seat_index IS NULL
         OR NEW.last_seen <= now() - interval '45 seconds'
       ) THEN
      affected_table_id := OLD.table_id;
    ELSE
      affected_table_id := NULL;
    END IF;
  END IF;

  IF affected_table_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Count remaining occupants (active seats) at that table.
  SELECT count(*) INTO remaining_occupants
  FROM public.room_players
  WHERE table_id = affected_table_id
    AND seat_index IS NOT NULL
    AND last_seen > now() - interval '45 seconds';

  IF remaining_occupants = 0 THEN
    DELETE FROM public.room_tables WHERE id::text = affected_table_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_empty_room_table ON public.room_players;
CREATE TRIGGER trg_cleanup_empty_room_table
AFTER UPDATE OR DELETE ON public.room_players
FOR EACH ROW
EXECUTE FUNCTION public.cleanup_empty_room_table();

-- Periodic safety net: also delete tables whose occupants have all gone
-- stale (last_seen older than 45s) even if no UPDATE/DELETE fires (e.g. the
-- browser was killed and no "stand up" or disconnect write ever happened).
-- This function can be called opportunistically (e.g. on room join).
CREATE OR REPLACE FUNCTION public.cleanup_stale_room_tables(p_room_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.room_tables rt
  WHERE rt.room_id = p_room_id
    AND NOT EXISTS (
      SELECT 1 FROM public.room_players rp
      WHERE rp.table_id = rt.id::text
        AND rp.seat_index IS NOT NULL
        AND rp.last_seen > now() - interval '45 seconds'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_stale_room_tables(text) TO authenticated;
