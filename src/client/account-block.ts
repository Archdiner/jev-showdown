/**
 * Showdown refuses some logins after the socket is already open.
 * A proxy/datacenter IP gets `|popup||html|Your IP (...) is currently locked...`,
 * and the name in `|updateuser|` is prefixed with ‽ (locked) or ! (muted / semilocked).
 * The server then closes the socket with code 1000. Those closes must not reconnect.
 */

export type AccountBlockKind = 'locked' | 'banned' | 'proxy' | 'muted';

export interface AccountBlock {
  kind: AccountBlockKind;
  message: string;
}

const LOCK_PREFIX = '\u203D';
const MUTE_PREFIX = '!';
const NAMELOCK_PREFIX = '\u2716';

export class AccountBlockedError extends Error {
  readonly block: AccountBlock;

  constructor(block: AccountBlock) {
    super(block.message);
    this.name = 'AccountBlockedError';
    this.block = block;
  }
}

function explain(kind: AccountBlockKind, detail: string): string {
  const why = kind === 'proxy'
    ? 'Showdown locked this IP as a proxy'
    : kind === 'banned'
      ? 'Showdown banned this account from battling'
      : kind === 'muted'
        ? 'Showdown muted or semilocked this account (! prefix)'
        : 'Showdown locked this account (‽ prefix)';
  return `${why}. ${detail} Exiting with no reconnect.`;
}

/** Popup bodies keep a leading `|html|` and may include buttons. */
export function visiblePopupText(message: string): string {
  return message
    .replace(/^\|html\|/i, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\|+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function accountBlockFromPopup(message: string): AccountBlock | null {
  const text = visiblePopupText(message);
  if (!text) return null;
  if (/due to being a proxy|using a proxy|which is a proxy/i.test(text)) {
    return { kind: 'proxy', message: explain('proxy', text) };
  }
  if (/\bbanned\b/i.test(text) || /barred from starting/i.test(text)) {
    return { kind: 'banned', message: explain('banned', text) };
  }
  if (/\block(?:ed|s)?\b/i.test(text) || /namelock/i.test(text)) {
    return { kind: 'locked', message: explain('locked', text) };
  }
  return null;
}

export function splitIdentity(identity: string): { symbol: string; username: string } {
  const cleaned = identity.replace(/@!$/, '');
  return {
    symbol: cleaned.slice(0, 1),
    username: cleaned.slice(1),
  };
}

export function accountBlockFromIdentity(identity: string): AccountBlock | null {
  const { symbol, username } = splitIdentity(identity);
  if (!symbol || !username) return null;
  if (symbol === LOCK_PREFIX || symbol === NAMELOCK_PREFIX) {
    return {
      kind: 'locked',
      message: explain('locked', `The server named this connection ${symbol}${username}.`),
    };
  }
  if (symbol === MUTE_PREFIX) {
    return {
      kind: 'muted',
      message: explain('muted', `The server named this connection ${symbol}${username}.`),
    };
  }
  return null;
}

export interface ParsedUpdateUser {
  symbol: string;
  username: string;
  named: boolean;
  block: AccountBlock | null;
}

export function parseUpdateUser(line: string): ParsedUpdateUser | null {
  if (!line.startsWith('|updateuser|')) return null;
  const parts = line.split('|');
  const identity = parts[2] ?? '';
  if (!identity) return null;
  const { symbol, username } = splitIdentity(identity);
  if (!username) return null;
  return {
    symbol,
    username,
    named: parts[3] === '1',
    block: accountBlockFromIdentity(identity),
  };
}

/**
 * `/rank` replies with an HTML ladder table.
 * `undefined` means this line is not that table.
 * `null` means the user has no rating in the format.
 */
export function parseFormatRating(text: string, format: string): number | null | undefined {
  if (!/class="ladder"|has not played any ladder games yet|Elo rating/i.test(text)) return undefined;
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  if (/has not played any ladder games yet/i.test(plain)) return null;
  const match = plain.match(new RegExp(`\\b${format}\\b\\s+(\\d+)`, 'i'));
  if (!match) return null;
  return Number(match[1]);
}
