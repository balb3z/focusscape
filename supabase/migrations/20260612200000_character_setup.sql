-- Add gender + character_config to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT 'male' CHECK (gender IN ('male', 'female')),
  ADD COLUMN IF NOT EXISTS character_config JSONB;

-- Add gender + character_config to room_players
ALTER TABLE public.room_players
  ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT 'male' CHECK (gender IN ('male', 'female')),
  ADD COLUMN IF NOT EXISTS character_config JSONB;

-- Back-fill room_players from profiles for any existing rows
UPDATE public.room_players rp
SET
  gender        = p.gender,
  character_config = p.character_config
FROM public.profiles p
WHERE rp.user_id = p.id
  AND (rp.character_config IS NULL OR rp.gender != p.gender);

-- Update handle_new_user to persist gender from OAuth metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.profiles (id, username, avatar_id, avatar_url, gender)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'username',
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1),
      'student'
    ),
    COALESCE((NEW.raw_user_meta_data->>'avatar_id')::int, floor(random() * 6)::int),
    COALESCE(
      NEW.raw_user_meta_data->>'avatar_url',
      NEW.raw_user_meta_data->>'picture'
    ),
    COALESCE(NEW.raw_user_meta_data->>'gender', 'male')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
