import fs from 'node:fs';
import path from 'node:path';

const LOG_DIRECTORY = process.env.AI_TRAINING_LOG_DIR ?? 'ai_training_logs';

export type TrainingTurn = {
  step: number;
  playerId: string;
  generation: number;
  phase: string;
  timestamp: string;
  state: Record<string, unknown>;
  waitingFor: unknown;
  input_response: unknown;
  is_human: boolean;
};

export type GameMeta = {
  game_id: string;
  game_spec: {
    board_name: string;
    player_count: number;
    created_at: string;
    expansions: Array<string>;
    variants: Record<string, boolean>;
  };
  players: Array<{playerId: string; name: string; isAI: boolean}>;
};

export type PlayerResult = {
  playerId: string;
  name: string;
  tr: number;
  vp_total: number;
  rank: number;
};

export type GameResult = {
  endGeneration: number;
  playerResults: Array<PlayerResult>;
};

export class TrainingLogger {
  private readonly dir: string;

  constructor(logDir: string = LOG_DIRECTORY) {
    this.dir = path.resolve(process.cwd(), logDir);
  }

  private filePath(gameId: string): string {
    return path.join(this.dir, `${gameId}.jsonl`);
  }

  private async writeLine(gameId: string, record: Record<string, unknown>, append: boolean): Promise<void> {
    await fs.promises.mkdir(this.dir, {recursive: true});
    const line = JSON.stringify(record) + '\n';
    if (append) {
      await fs.promises.appendFile(this.filePath(gameId), line, 'utf8');
    } else {
      await fs.promises.writeFile(this.filePath(gameId), line, 'utf8');
    }
  }

  public async writeMeta(meta: GameMeta): Promise<void> {
    await this.writeLine(meta.game_id, {type: 'meta', ...meta}, false);
  }

  public async appendTurn(gameId: string, turn: TrainingTurn): Promise<void> {
    await this.writeLine(gameId, {type: 'turn', ...turn}, true);
  }

  public async writeResult(gameId: string, result: GameResult): Promise<void> {
    await this.writeLine(gameId, {type: 'result', ...result}, true);
  }
}
