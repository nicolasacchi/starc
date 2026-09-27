/**
 * Wire protocol types — mirrors docs/PROTOCOL.md v1 exactly.
 * Every server message and client command is typed here; nothing else in the
 * client hand-rolls a message shape.
 */

export const PROTOCOL_VERSION = 1;
export const TICK_MS = 50;
export const SNAPSHOT_HZ = 10;
export const TICK_HZ = 1000 / TICK_MS;
export const WORLD_SIZE = 256;

export type Race = "terran" | "zerg" | "protoss";
export type MatchMode = "melee" | "custom" | "1v1" | "team";
export type MatchStatus = "lobby" | "in_progress" | "finished" | "abandoned";
export type EntityState =
  | "idle"
  | "moving"
  | "attacking"
  | "harvesting"
  | "returning"
  | "building"
  | "training"
  | "casting"
  | "dead";
export type OrderKind = 0 | 1 | 2 | 3 | 4;
export type EndReason = "defeat" | "annihilation" | "timeout" | "forfeit" | "disconnect" | "stalemate";

export interface ResourceCost {
  minerals: number;
  vespene: number;
  supply: number;
  supply_provided?: number;
}

export interface AbilityDef {
  key: string;
  name: string;
  cooldown: number;
  duration?: number;
  cost?: number;
  target?: "self" | "ally_unit" | "enemy_unit" | "point";
  effect:
    | "damage"
    | "heal"
    | "shield"
    | "speed_boost"
    | "attack_boost"
    | "armor_boost"
    | "cloak"
    | "blink"
    | "web"
    | "slow"
    | "reveal"
    | "spawn";
  magnitude?: number;
  radius?: number;
  duration_s?: number;
  spawn?: string;
}

export interface AttackDef {
  damage: number;
  range: number;
  cooldown: number;
  weapon: string;
  projectile_speed: number;
  targets: string[];
  splash?: { radius: number; damage_pct: number } | null;
}

export interface UnitDef {
  key: string;
  name: string;
  kind: "unit";
  hotkey?: string;
  tier?: number;
  cost: ResourceCost;
  build_time: number;
  hp: number;
  armor: number;
  shield?: number;
  shield_regen?: number;
  sight: number;
  speed: number;
  size: { radius: number; height: number };
  movement: "ground" | "air";
  attack: AttackDef | { weapon: "none" };
  harvest?: { capacity: number; rate: number; refund_pct: number } | null;
  abilities: AbilityDef[];
  produces: string[];
  required_buildings?: string[];
  vision?: number;
}

export interface BuildingDef {
  key: string;
  name: string;
  kind: "building";
  hotkey?: string;
  tier?: number;
  cost: ResourceCost;
  build_time: number;
  hp: number;
  armor: number;
  sight: number;
  size: { radius: number; height: number };
  abilities: AbilityDef[];
  produces: string[];
  required_buildings?: string[];
  vision?: number;
  defense?: {
    range: number;
    cooldown: number;
    damage: number;
    weapon?: string;
    targets: string[];
    missile_splash?: number;
  } | null;
}

export type EntityDef = UnitDef | BuildingDef;

export interface RaceData {
  race: Race;
  label: string;
  color: string;
  units: UnitDef[];
  buildings: BuildingDef[];
}

export interface MapMineralCluster {
  x: number;
  y: number;
  rich?: boolean;
  count: number;
}
export interface MapDef {
  id: string;
  name: string;
  size: number;
  max_players: number;
  terrain_seed: number;
  water: boolean;
  elevation: number;
  biome: string;
  description: string;
  start_positions: { x: number; y: number }[];
  mineral_clusters: MapMineralCluster[];
  expansion_candidates: { x: number; y: number }[];
  lighting: { time_of_day: number; sun_color: string; fog_density: number };
}

export interface GameData {
  version: number;
  tick_ms: number;
  snapshot_hz: number;
  world_size: number;
  max_supply: number;
  base_supply: number;
  supply_increment: number;
  starting_resources: { minerals: number; vespene: number };
  starting_units: Record<Race, string>;
  starting_buildings: Record<Race, string>;
  races: RaceData[];
  units: Record<string, EntityDef>;
  race_index: Record<string, string[]>;
  maps: MapDef[];
}

/* ------------------------------------------------------------------ */
/* Client → server commands                                            */
/* ------------------------------------------------------------------ */

export type Command =
  | { c: "move"; ids: number[]; x: number; y: number; queue?: boolean }
  | { c: "attack"; ids: number[]; target_id: number; queue?: boolean }
  | { c: "stop"; ids: number[] }
  | { c: "hold"; ids: number[] }
  | { c: "patrol"; ids: number[]; x: number; y: number; x2: number; y2: number; queue?: boolean }
  | { c: "train"; building_id: number; unit_type: string; count?: number }
  | { c: "build"; worker_id: number; unit_type: string; x: number; y: number }
  | { c: "cancel"; building_id: number }
  | { c: "rally"; building_id: number; x: number; y: number }
  | { c: "harvest"; worker_id: number }
  | { c: "ability"; ids: number[]; ability: string }
  | { c: "select"; ids: number[] }
  | { c: "chat"; text: string };

export type CommandType = Command["c"];

export type CommandRejectionCode =
  | "not_owner"
  | "no_such_entity"
  | "dead_entity"
  | "invalid_target"
  | "out_of_range"
  | "insufficient_resources"
  | "queue_full"
  | "production_busy"
  | "cooldown"
  | "not_ready"
  | "invalid_payload"
  | "no_such_unit_type"
  | "no_such_ability";

export interface Rejection {
  index: number;
  code: CommandRejectionCode;
  message: string;
}

/* ------------------------------------------------------------------ */
/* Server → client messages                                            */
/* ------------------------------------------------------------------ */

export interface ProtocolEntity {
  id: number;
  ty: string;
  pl: number;
  x: number;
  y: number;
  z: number;
  hp: number;
  hp_max: number;
  mp: number;
  mp_max: number;
  ang: number;
  st: EntityState;
  w?: number;
  sel?: 0 | 1 | 2 | 3;
  tid?: number;
  ord?: OrderKind;
  ox?: number;
  oy?: number;
  prog?: number;
  cargo?: number;
  res?: number;
  n?: number;
  b?: number;
}

export type GameEvent =
  | { e: "shot"; id: number; x: number; y: number; z: number; tx: number; ty: number; tz: number }
  | { e: "hit"; id: number; tid: number; dmg: number; crit: boolean; shield: boolean }
  | { e: "death"; id: number; ty: string; x: number; y: number; z: number; killer: number }
  | { e: "built"; id: number; ty: string; x: number; y: number; z: number }
  | { e: "proj"; id: number; ty: string; x: number; y: number; z: number; tx: number; ty2: number; tz: number }
  | { e: "ability"; id: number; ab: string; x: number; y: number; z: number }
  | { e: "res"; pl: number; amount: number; x: number; y: number }
  | { e: "alert"; text: string };

export interface PlayerScore {
  player_id: number;
  race: Race;
  result: "win" | "loss" | "draw";
  kills: number;
  deaths: number;
  resources_mined: number;
  units_built: number;
  army_value: number;
}

export interface LobbyMatchSummary {
  id: number;
  name: string;
  mode: MatchMode;
  map_id: string;
  max_players: number;
  player_count: number;
  status: MatchStatus;
  has_password: boolean;
  host: string;
}

export interface LobbyPlayer {
  player_id: number;
  name: string;
  race: Race;
  ready: boolean;
  is_host: boolean;
  slot: number;
  team: number;
}

export interface LobbyChatLine {
  player_id: number;
  name: string;
  text: string;
  ts: number;
}

export interface ErrorCode {
  unauthenticated: "unauthenticated";
  not_found: "not_found";
  lobby_full: "lobby_full";
  already_in_match: "already_in_match";
  wrong_password: "wrong_password";
  not_host: "not_host";
  not_ready: "not_ready";
  invalid_payload: "invalid_payload";
  match_in_progress: "match_in_progress";
  rate_limited: "rate_limited";
  server_error: "server_error";
}

export type ServerErrorCode = ErrorCode[keyof ErrorCode] | CommandRejectionCode;

export interface Envelope {
  v: number;
  t: string;
  id?: string;
  ts?: number;
}

export type ClientMessage =
  | { v: 1; t: "identify"; token: string }
  | { v: 1; t: "lobby:list"; filters?: { mode?: MatchMode; map_id?: string; only_joinable?: boolean } }
  | { v: 1; t: "lobby:create"; name: string; mode: MatchMode; map_id: string; max_players: number; password?: string; race_preference?: Race }
  | { v: 1; t: "lobby:join"; match_id: number; password?: string }
  | { v: 1; t: "lobby:leave"; match_id: number }
  | { v: 1; t: "lobby:ready"; match_id: number; ready: boolean }
  | { v: 1; t: "lobby:settings"; match_id: number; name?: string; map_id?: string; mode?: MatchMode; max_players?: number; password?: string }
  | { v: 1; t: "lobby:start"; match_id: number }
  | { v: 1; t: "lobby:chat"; match_id: number; text: string }
  | { v: 1; t: "game:command"; id: string; from_tick: number; commands: Command[] }
  | { v: 1; t: "game:forfeit"; reason?: string };

export type ServerMessage =
  | { v: 1; t: "lobby:state"; matches: LobbyMatchSummary[]; you: LobbyContext | null }
  | { v: 1; t: "error"; code: ServerErrorCode; message: string; fatal: boolean }
  | {
      v: 1;
      t: "game:start";
      match_id: number;
      seed: number;
      map_id: string;
      tick_rate: number;
      snapshot_rate: number;
      countdown_ms: number;
      players: { player_id: number; slot: number; race: Race; name: string; team: number; start: { x: number; y: number } }[];
    }
  | { v: 1; t: "game:snapshot"; tick: number; server_ms: number; ack: number; entities: ProtocolEntity[]; events: GameEvent[] }
  | { v: 1; t: "game:reject"; rejected: Rejection[] }
  | { v: 1; t: "game:ended"; tick: number; winner: number | null; reason: EndReason; duration_ms: number; scores: PlayerScore[]; replay_url: string };

export interface LobbyContext {
  match_id: number;
  player_id: number;
  slot: number;
  race: Race;
  ready: boolean;
  is_host: boolean;
}

/** Narrows an untyped wire payload to a server message. */
export function isServerMessage(raw: unknown): raw is ServerMessage {
  return typeof raw === "object" && raw !== null && typeof (raw as Envelope).t === "string" && (raw as Envelope).v === PROTOCOL_VERSION;
}
