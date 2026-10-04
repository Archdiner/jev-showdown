import { GameState, Action, SearchNode, BotConfig } from '../types/index.js';
import { Evaluator } from './evaluator.js';

export class MCTSEngine {
  private config: BotConfig;
  private evaluator: Evaluator;
  private root?: SearchNode;

  constructor(config: BotConfig, evaluator: Evaluator) {
    this.config = config;
    this.evaluator = evaluator;
  }

  search(state: GameState, legalActions: Action[]): Action {
    const startTime = Date.now();
    
    this.root = {
      state,
      children: [],
      visits: 0,
      value: 0,
      prior: 1.0,
    };

    let iterations = 0;
    const maxIterations = this.config.searchIterations;
    const timeLimit = this.config.searchTimeMs;

    while (
      iterations < maxIterations &&
      Date.now() - startTime < timeLimit
    ) {
      const leaf = this.select(this.root);
      
      if (leaf.visits > 0 && !this.isTerminal(leaf.state)) {
        this.expand(leaf, legalActions);
      }

      const value = this.simulate(leaf.state);
      this.backpropagate(leaf, value);
      
      iterations++;
    }

    const bestAction = this.selectBestAction(this.root);
    return bestAction;
  }

  private select(node: SearchNode): SearchNode {
    while (node.children.length > 0) {
      node = this.selectChild(node);
    }
    return node;
  }

  private selectChild(node: SearchNode): SearchNode {
    let bestScore = -Infinity;
    let bestChild: SearchNode | null = null;

    for (const child of node.children) {
      const score = this.ucb1(child, node.visits);
      if (score > bestScore) {
        bestScore = score;
        bestChild = child;
      }
    }

    return bestChild || node.children[0];
  }

  private ucb1(node: SearchNode, parentVisits: number): number {
    if (node.visits === 0) {
      return Infinity;
    }

    const exploitation = node.value / node.visits;
    const exploration = this.config.explorationConstant * 
      Math.sqrt(Math.log(parentVisits) / node.visits);
    
    return exploitation + exploration;
  }

  private expand(node: SearchNode, actions: Action[]): void {
    for (const action of actions) {
      const childState = this.applyAction(node.state, action);
      const child: SearchNode = {
        state: childState,
        action,
        parent: node,
        children: [],
        visits: 0,
        value: 0,
        prior: 1.0 / actions.length,
      };
      node.children.push(child);
    }
  }

  private simulate(state: GameState): number {
    const evaluation = this.evaluator.evaluate(state);
    return this.normalizeScore(evaluation.score);
  }

  private backpropagate(node: SearchNode | undefined, value: number): void {
    while (node) {
      node.visits++;
      node.value += value;
      node = node.parent;
      value = -value;
    }
  }

  private selectBestAction(root: SearchNode): Action {
    let bestVisits = -1;
    let bestChild: SearchNode | null = null;

    for (const child of root.children) {
      if (child.visits > bestVisits) {
        bestVisits = child.visits;
        bestChild = child;
      }
    }

    if (!bestChild || !bestChild.action) {
      return { type: 'move', moveIndex: 0 };
    }

    return bestChild.action;
  }

  private applyAction(state: GameState, action: Action): GameState {
    const newState: GameState = JSON.parse(JSON.stringify(state));
    
    newState.turn++;

    return newState;
  }

  private isTerminal(state: GameState): boolean {
    const myAlive = state.myTeam.filter(p => p.stats !== undefined).length;
    const oppAlive = state.opponentTeam.filter(p => p.stats !== undefined).length;
    return myAlive === 0 || oppAlive === 0;
  }

  private normalizeScore(score: number): number {
    return Math.tanh(score / 100);
  }

  getSearchStats() {
    if (!this.root) {
      return { nodes: 0, topActions: [] };
    }

    const topActions = this.root.children
      .map(child => ({
        action: child.action!,
        visits: child.visits,
        value: child.visits > 0 ? child.value / child.visits : 0,
      }))
      .sort((a, b) => b.visits - a.visits)
      .slice(0, 5);

    return {
      nodes: this.countNodes(this.root),
      topActions,
    };
  }

  private countNodes(node: SearchNode): number {
    let count = 1;
    for (const child of node.children) {
      count += this.countNodes(child);
    }
    return count;
  }
}
