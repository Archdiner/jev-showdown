/**
 * Search profile. A later config layer can load this shape from a file.
 * The champion profile stays in code so a config edit cannot silently
 * replace the promoted bot.
 */
export interface SearchProfile {
  id: string;
  depth: number;
  opponentModel: 'max-damage' | 'uniform' | 'switch';
  evalMode: 'hp' | 'full' | 'team' | 'nn';
  errorAsLoss: boolean;
  samples: number;
  /** Highest-probability opponent replies kept after the switch model. */
  maxReplies: number;
  /** Replies under this probability are dropped before the cap. */
  minReplyProb: number;
  /**
   * Own actions considered below the root. 0 keeps every legal choice.
   * The root always scores every legal move and every legal switch.
   * This cap exists so depth 2 stays inside the 2s p99 guardrail.
   */
  deeperChoices: number;
}
