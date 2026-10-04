import type { Battle } from '@pkmn/client';
import type { ID } from '@pkmn/data';

export interface PokemonSet {
  species: string;
  level: number;
  moves: string[];
  ability: string;
  item: string;
  teraType: string;
  evs: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  ivs: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  nature: string;
}

export interface RoleData {
  weight: number;
  moves: Record<string, number>;
  items?: Record<string, number>;
  teraTypes?: Record<string, number>;
  evs?: Record<string, number>;
}

export interface SpeciesStats {
  level: number;
  abilities: Record<string, number>;
  items: Record<string, number>;
  roles: Record<string, RoleData>;
}

export interface RandbatsStats {
  [species: string]: SpeciesStats;
}

export interface PokemonBelief {
  species: string;
  level: number;
  possibleSets: Map<string, number>;
  revealedMoves: Set<string>;
  revealedAbility?: string;
  revealedItem?: string;
  revealedTeraType?: string;
  stats?: {
    hp: number;
    atk: number;
    def: number;
    spa: number;
    spd: number;
    spe: number;
  };
  currentHp?: number;
  maxHp?: number;
  status?: string;
  boosts?: {
    atk: number;
    def: number;
    spa: number;
    spd: number;
    spe: number;
    accuracy: number;
    evasion: number;
  };
}

export interface GameState {
  myTeam: PokemonBelief[];
  opponentTeam: PokemonBelief[];
  myActive: number;
  opponentActive: number;
  turn: number;
  myTeraUsed: boolean;
  opponentTeraUsed: boolean;
  field: {
    weather?: string;
    terrain?: string;
    trickRoom: boolean;
    screens: { reflect?: number; lightScreen?: number };
  };
  hazards: {
    my: { stealthRock: boolean; spikes: number; toxicSpikes: number };
    opponent: { stealthRock: boolean; spikes: number; toxicSpikes: number };
  };
}

export type Action = 
  | { type: 'move'; moveIndex: number; terastallize?: boolean; target?: number }
  | { type: 'switch'; switchIndex: number };

export interface EvaluationResult {
  score: number;
  breakdown?: {
    material: number;
    position: number;
    momentum: number;
    heuristics: number;
  };
}

export interface EvaluatorWeights {
  material: number;
  hp: number;
  position: number;
  hazards: number;
  momentum: number;
  information: number;
}

export interface SearchNode {
  state: GameState;
  action?: Action;
  parent?: SearchNode;
  children: SearchNode[];
  visits: number;
  value: number;
  prior: number;
}

export interface BattleRecord {
  id: string;
  timestamp: number;
  outcome: 'win' | 'loss' | 'tie';
  turns: number;
  opponent: string;
  rating?: number;
  log: string;
  decisions: DecisionRecord[];
}

export interface DecisionRecord {
  turn: number;
  state: string;
  action: Action;
  searchStats: {
    nodes: number;
    timeMs: number;
    topActions: Array<{ action: Action; visits: number; value: number }>;
  };
  evaluation: EvaluationResult;
}

export interface BotConfig {
  searchTimeMs: number;
  searchIterations: number;
  explorationConstant: number;
  sampledWorlds: number;
  useTeraHeuristic: boolean;
  useLLMPrior: boolean;
  llmConfig?: {
    endpoint: string;
    apiKey?: string;
    model: string;
  };
}

export interface LLMRequest {
  state: any;
  question: string;
  choices?: string[];
}

export interface LLMResponse {
  choice?: string;
  scores?: Record<string, number>;
  probabilities?: Record<string, number>;
  reasoning?: string;
}
