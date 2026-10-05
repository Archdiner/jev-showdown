import { Action, GameState } from '../types/index.js';
import { Format } from '../types/format.js';
import { MaxDamageBot } from '../baselines/max-damage-bot.js';

const fallbackBot = new MaxDamageBot();

export function isWaitRequest(request: any): boolean {
  return !request || request.wait === true || request.requestType === 'wait';
}

export function isTeamPreview(request: any): boolean {
  return request?.teamPreview === true || request?.requestType === 'team';
}

export function sameAction(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'move' && b.type === 'move') {
    return a.moveIndex === b.moveIndex && !!a.terastallize === !!b.terastallize;
  }
  if (a.type === 'switch' && b.type === 'switch') {
    return a.switchIndex === b.switchIndex;
  }
  return false;
}

export function isActionLegal(action: Action, request: any): boolean {
  if (!request || isWaitRequest(request)) return false;
  if (action.type === 'move') return isMoveLegal(request, action.moveIndex, !!action.terastallize);
  if (action.type === 'switch') return isSwitchLegal(request, action.switchIndex);
  return false;
}

function isForceSwitch(request: any): boolean {
  if (Array.isArray(request.forceSwitch)) return request.forceSwitch.some(Boolean);
  return !!request.forceSwitch;
}

function isMoveLegal(request: any, moveIndex: number, terastallize: boolean): boolean {
  if (isForceSwitch(request) || isTeamPreview(request)) return false;
  if (!Number.isInteger(moveIndex) || moveIndex < 1) return false;
  const active = request.active?.[0];
  if (!active?.moves) return false;
  const move = active.moves[moveIndex - 1];
  if (!move) return false;
  if (move.disabled) return false;
  if (move.pp !== undefined && Number(move.pp) <= 0) return false;
  if (terastallize && !active.canTerastallize) return false;
  return true;
}

function isFainted(mon: any): boolean {
  return typeof mon?.condition === 'string' && mon.condition.includes('fnt');
}

/** Revival Blessing's follow-up is a switch request whose only targets are fainted. */
function isReviving(request: any): boolean {
  const mons: any[] | undefined = request?.side?.pokemon;
  return !!mons?.some(mon => mon?.reviving);
}

function isSwitchLegal(request: any, switchIndex: number): boolean {
  if (isTeamPreview(request)) return false;
  if (!Number.isInteger(switchIndex) || switchIndex < 1) return false;
  const mons: any[] | undefined = request.side?.pokemon;
  if (!mons) return false;
  const mon = mons[switchIndex - 1];
  if (!mon || mon.commanding) return false;

  if (isReviving(request)) return isFainted(mon);

  if (isFainted(mon)) return false;
  const force = isForceSwitch(request);
  const active = request.active?.[0];
  const trapped = !!(active && (active.trapped || active.maybeTrapped));
  if (trapped && !force) return false;
  if (mon.active && !force) return false;
  if (force && mon.active) return false;
  return true;
}

/** Every choice the raw request allows, independent of the format helper. */
export function strictLegalActions(request: any, options?: { tera?: boolean }): Action[] {
  if (!request || isWaitRequest(request) || isTeamPreview(request)) return [];
  const actions: Action[] = [];

  if (isForceSwitch(request)) {
    const mons: any[] = request.side?.pokemon || [];
    for (let i = 0; i < mons.length; i++) {
      const action: Action = { type: 'switch', switchIndex: i + 1 };
      if (isSwitchLegal(request, action.switchIndex)) actions.push(action);
    }
    return actions;
  }

  const active = request.active?.[0];
  if (active?.moves) {
    for (let i = 0; i < active.moves.length; i++) {
      const action: Action = { type: 'move', moveIndex: i + 1 };
      if (isMoveLegal(request, action.moveIndex, false)) actions.push(action);
      if (options?.tera && active.canTerastallize && isMoveLegal(request, i + 1, true)) {
        actions.push({ type: 'move', moveIndex: i + 1, terastallize: true });
      }
    }
  }

  const mons: any[] = request.side?.pokemon || [];
  for (let i = 0; i < mons.length; i++) {
    const action: Action = { type: 'switch', switchIndex: i + 1 };
    if (isSwitchLegal(request, action.switchIndex)) actions.push(action);
  }
  return actions;
}

/**
 * Legal actions for the engine. Starts from the format helper, then drops
 * anything the live request would reject.
 */
export function legalActionsForRequest(request: any, format: Format, options?: { tera?: boolean }): Action[] {
  if (isWaitRequest(request) || isTeamPreview(request)) return [];
  const proposed = format.getLegalActions(request).filter(action => isActionLegal(action, request));
  const base = proposed.length > 0 ? proposed : strictLegalActions(request);
  if (!options?.tera) return base;
  const extra = strictLegalActions(request, { tera: true }).filter(action => action.type === 'move' && action.terastallize && isActionLegal(action, request));
  return [...base, ...extra];
}

export function formatChoice(action: Action, rqid?: number): string {
  let choice: string;
  if (action.type === 'move') {
    choice = `move ${action.moveIndex}`;
    if (action.terastallize) choice += ' terastallize';
  } else {
    choice = `switch ${action.switchIndex}`;
  }
  if (typeof rqid === 'number') return `${choice}|${rqid}`;
  return choice;
}

export function teamPreviewChoice(request: any): string | null {
  if (!isTeamPreview(request)) return null;
  const count = request.side?.pokemon?.length || request.maxTeamSize || 6;
  const order = Array.from({ length: count }, (_, i) => String(i + 1)).join('');
  const rqid = typeof request.rqid === 'number' ? `|${request.rqid}` : '';
  return `team ${order}${rqid}`;
}

/**
 * Highest-damage legal move, then any legal switch. Used when the engine
 * throws, times out, or returns a choice the request would reject.
 *
 * This is a real fallback. Search's opponent model calls `maxDamageChoice`
 * and does not come through here. `MaxDamage Debug` on stdout is this path.
 * The battle driver counts that choice on `fallbacks`, including when it
 * replaces a move the server rejected.
 */
export function pickBestLegal(state: GameState, legal: Action[]): Action {
  if (legal.length === 0) {
    throw new Error('No legal actions to fall back to');
  }
  if (legal.length === 1) return legal[0];

  try {
    const choice = fallbackBot.selectAction(state, legal);
    if (legal.some(action => sameAction(action, choice))) return choice;
  } catch {
    // Damage fallback is best-effort. A listed legal choice is still safe.
  }

  return legal.find(action => action.type === 'move') ?? legal[0];
}

/** Strip tera if the request no longer allows it, without changing the move. */
export function sanitizeAction(action: Action, request: any, legal: Action[]): Action | null {
  const listed = legal.some(candidate => sameAction(candidate, action));
  const teraOfListed = action.type === 'move' && action.terastallize
    && legal.some(candidate => sameAction(candidate, { type: 'move', moveIndex: action.moveIndex }));
  if (isActionLegal(action, request) && (listed || teraOfListed)) {
    return action;
  }
  if (action.type === 'move' && action.terastallize) {
    const withoutTera: Action = { type: 'move', moveIndex: action.moveIndex };
    if (isActionLegal(withoutTera, request)) return withoutTera;
  }
  return null;
}
