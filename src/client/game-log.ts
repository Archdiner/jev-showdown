import * as fs from 'fs';
import * as path from 'path';

export class GameLog {
  private stream: fs.WriteStream;

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  write(event: Record<string, unknown>): void {
    this.stream.write(`${JSON.stringify({ ts: Date.now(), ...event })}\n`);
  }

  close(): Promise<void> {
    return new Promise(resolve => {
      this.stream.end(() => resolve());
    });
  }
}

export function openGameLog(dir: string, battleId: string): GameLog {
  const safe = battleId.replace(/[^a-zA-Z0-9_-]+/g, '_');
  return new GameLog(path.join(dir, `${safe}.jsonl`));
}
