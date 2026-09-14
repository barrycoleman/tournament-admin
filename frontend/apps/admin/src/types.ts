export interface EventRead {
  id: number;
  name: string;
  active_session_id: number | null;
  game_plugin_name: string | null;
  created_at: string;
}
