import type { DisplayGroupState } from "@tournament-admin/shared";

export interface DisplayRef {
  device_id: number;
  name: string;
  online: boolean;
}

export interface DisplayGroupRead extends DisplayGroupState {
  displays: DisplayRef[];
}

export interface DisplaysRead {
  session_id: number;
  groups: DisplayGroupRead[];
  unassigned: DisplayRef[];
  has_setup: boolean;
}

export interface FieldSetLiveRead {
  id: number;
  session_id: number;
  name: string;
  division_id: number | null;
  queued_match_id: number | null;
  timeout_deadline: string | null;
}

export interface FieldRead {
  id: number;
  field_set_id: number;
  name: string;
}
