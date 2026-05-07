// Exports every game log available from the configured database into separate JSON files.
// This script continues past corrupted games or corrupted save versions.
// Run after building the project with `npm run build`, or with ts-node for direct execution.

require('dotenv').config();

import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';
import {Database} from '../database/Database';
import {IDatabase} from '../database/IDatabase';
import {GameId} from '../../common/Types';

const args = process.argv.slice(2);
const outputDir = args[0] ?? 'logs/json';

const db: IDatabase = Database.getInstance();

type ExportPayload = {
  game_id: string;
  timestamp: string;
  saves: Record<string, unknown>;
  errors: Array<string>;
};

async function main() {
  await db.initialize();
  mkdirSync(outputDir, {recursive: true});

  console.log(`Exporting all game logs to ${outputDir}`);

  let gameIds: Array<GameId>;
  try {
    gameIds = await db.getGameIds();
  } catch (err) {
    console.error('Failed to fetch game ids:', err);
    process.exit(1);
  }

  let completed = 0;
  let skipped = 0;
  for (const gameId of gameIds) {
    const filePath = join(outputDir, `${gameId}.json`);
    const exportPayload: ExportPayload = {
      game_id: gameId,
      timestamp: new Date().toISOString(),
      saves: {},
      errors: [],
    };

    try {
      const saveIds = await db.getSaveIds(gameId);
      if (saveIds.length === 0) {
        exportPayload.errors = ['No save ids found for game'];
      }

      for (const saveId of saveIds) {
        try {
          const version = await db.getGameVersion(gameId, saveId);
          exportPayload.saves[saveId.toString()] = version.gameLog;
        } catch (err) {
          const message = `Failed to read save ${saveId}: ${err instanceof Error ? err.message : err}`;
          console.warn(`${gameId}: ${message}`);
          (exportPayload.errors as Array<string>).push(message);
        }
      }

      try {
        writeFileSync(filePath, JSON.stringify(exportPayload, undefined, 0));
        completed += 1;
        process.stdout.write(`\rExported ${completed} / ${gameIds.length} games`);
      } catch (err) {
        const message = `Failed to write file ${filePath}: ${err instanceof Error ? err.message : err}`;
        console.error(`${gameId}: ${message}`);
        skipped += 1;
      }
    } catch (err) {
      const message = `Skipping game due to error: ${err instanceof Error ? err.message : err}`;
      console.error(`${gameId}: ${message}`);
      skipped += 1;
    }
  }

  console.log();
  console.log(`Finished exporting ${completed} game files. Skipped ${skipped} games with errors.`);
}

main().catch((err) => {
  console.error('Unhandled error during export:', err);
  process.exit(1);
});
