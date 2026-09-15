export interface EventRead {
  id: number;
  name: string;
  active_session_id: number | null;
  game_plugin_name: string | null;
  created_at: string;
}

export interface PluginSummary {
  name: string;
  version: string;
  display_name: string;
}

export interface ServerInfo {
  port: number;
  addresses: string[];
}

export interface Division {
  id: number;
  event_id: number;
  name: string;
  target_team_count: number | null;
}
