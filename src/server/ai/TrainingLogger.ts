import fs from 'node:fs';
import path from 'node:path';

const LOG_DIRECTORY = process.env.AI_TRAINING_LOG_DIR ?? 'ai_training_logs';

export class TrainingLogger {
  public async append(record: unknown): Promise<void> {
    const payload = JSON.stringify(record, undefined, 0);
    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 10)}.json`;
    const dir = path.resolve(process.cwd(), LOG_DIRECTORY);

    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, fileName), payload, 'utf8');
  }
}
