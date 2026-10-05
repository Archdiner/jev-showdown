import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Export battle logs to standalone Pokemon Showdown replay HTML files.
 * Uses the standard replay template that loads play.pokemonshowdown.com/js/replay-embed.js
 */
export class ReplayExporter {
  /**
   * Generate a standalone HTML replay file from a battle log.
   * 
   * @param log - The battle protocol log (pipe-separated messages)
   * @param metadata - Battle metadata (players, outcome, etc.)
   * @param outputPath - Where to save the HTML file
   */
  async exportReplay(
    log: string,
    metadata: {
      p1: string;
      p2: string;
      format: string;
      outcome?: string;
      timestamp?: number;
    },
    outputPath: string
  ): Promise<void> {
    const html = this.generateReplayHTML(log, metadata);
    
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outputPath, html, 'utf-8');
  }
  
  /**
   * Generate the HTML content for a replay.
   */
  private generateReplayHTML(
    log: string,
    metadata: {
      p1: string;
      p2: string;
      format: string;
      outcome?: string;
      timestamp?: number;
    }
  ): string {
    // Escape the log for inclusion in JavaScript
    const escapedLog = log
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$');
    
    const title = `${metadata.p1} vs ${metadata.p2} - ${metadata.format}`;
    const date = metadata.timestamp 
      ? new Date(metadata.timestamp).toISOString() 
      : new Date().toISOString();
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${this.escapeHTML(title)}</title>
  
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: Verdana, sans-serif;
      background: #f0f0f0;
    }
    
    .replay-wrapper {
      max-width: 1200px;
      margin: 20px auto;
      background: white;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      border-radius: 8px;
      overflow: hidden;
    }
    
    .replay-header {
      background: #6688cc;
      color: white;
      padding: 15px 20px;
    }
    
    .replay-header h1 {
      margin: 0;
      font-size: 20px;
    }
    
    .replay-meta {
      font-size: 12px;
      opacity: 0.9;
      margin-top: 5px;
    }
    
    .ps-replay {
      min-height: 500px;
    }
  </style>
</head>
<body>
  <div class="replay-wrapper">
    <div class="replay-header">
      <h1>${this.escapeHTML(title)}</h1>
      <div class="replay-meta">
        ${metadata.outcome ? `Result: ${this.escapeHTML(metadata.outcome)} | ` : ''}
        ${date}
      </div>
    </div>
    
    <div class="ps-replay">
      <div class="battle"></div>
      <div class="battle-log"></div>
      
      <script class="battle-log-data" type="text/plain">
${escapedLog}
      </script>
    </div>
  </div>
  
  <script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>
</body>
</html>`;
  }
  
  private escapeHTML(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

export const replayExporter = new ReplayExporter();
