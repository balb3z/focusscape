export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      focus_sessions: {
        Row: {
          completed: boolean
          duration_minutes: number
          ended_at: string | null
          id: string
          map_id: string
          started_at: string
          subject: string
          user_id: string
        }
        Insert: {
          completed?: boolean
          duration_minutes: number
          ended_at?: string | null
          id?: string
          map_id: string
          started_at?: string
          subject: string
          user_id: string
        }
        Update: {
          completed?: boolean
          duration_minutes?: number
          ended_at?: string | null
          id?: string
          map_id?: string
          started_at?: string
          subject?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_id: number
          avatar_url: string | null
          created_at: string
          current_streak: number
          gender: string
          id: string
          total_focus_minutes: number
          updated_at: string
          username: string
        }
        Insert: {
          avatar_id?: number
          avatar_url?: string | null
          created_at?: string
          current_streak?: number
          gender?: string
          id: string
          total_focus_minutes?: number
          updated_at?: string
          username: string
        }
        Update: {
          avatar_id?: number
          avatar_url?: string | null
          created_at?: string
          current_streak?: number
          gender?: string
          id?: string
          total_focus_minutes?: number
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      room_players: {
        Row: {
          animation_state: string
          avatar_id: number
          avatar_url: string | null
          connected_at: string
          focus_status: string
          gender: string
          last_seen: string
          room_id: string
          seat_index: number | null
          table_id: string | null
          user_id: string
          username: string
          x: number
          y: number
        }
        Insert: {
          animation_state?: string
          avatar_id?: number
          avatar_url?: string | null
          connected_at?: string
          focus_status?: string
          gender?: string
          last_seen?: string
          room_id: string
          seat_index?: number | null
          table_id?: string | null
          user_id: string
          username: string
          x?: number
          y?: number
        }
        Update: {
          animation_state?: string
          avatar_id?: number
          avatar_url?: string | null
          connected_at?: string
          focus_status?: string
          gender?: string
          last_seen?: string
          room_id?: string
          seat_index?: number | null
          table_id?: string | null
          user_id?: string
          username?: string
          x?: number
          y?: number
        }
        Relationships: []
      }
      watch_together_sessions: {
        Row: {
          table_id: string
          room_id: string
          host_id: string
          video_url: string
          video_id: string
          is_playing: boolean
          current_seconds: number
          updated_at: string
        }
        Insert: {
          table_id: string
          room_id: string
          host_id: string
          video_url?: string
          video_id?: string
          is_playing?: boolean
          current_seconds?: number
          updated_at?: string
        }
        Update: {
          table_id?: string
          room_id?: string
          host_id?: string
          video_url?: string
          video_id?: string
          is_playing?: boolean
          current_seconds?: number
          updated_at?: string
        }
        Relationships: []
      }
      room_tables: {
        Row: {
          created_at: string
          creator_id: string
          creator_username: string
          duration_minutes: number
          expires_at: string
          goal: string | null
          id: string
          max_seats: number
          name: string
          room_id: string
          subject: string
          x: number
          y: number
        }
        Insert: {
          created_at?: string
          creator_id: string
          creator_username: string
          duration_minutes?: number
          expires_at?: string
          goal?: string | null
          id?: string
          max_seats?: number
          name: string
          room_id: string
          subject: string
          x: number
          y: number
        }
        Update: {
          created_at?: string
          creator_id?: string
          creator_username?: string
          duration_minutes?: number
          expires_at?: string
          goal?: string | null
          id?: string
          max_seats?: number
          name?: string
          room_id?: string
          subject?: string
          x?: number
          y?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
