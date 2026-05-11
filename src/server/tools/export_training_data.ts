// Exports training data from all games in the database using Plan A (re-run engine).
// For each save, deserializes the game state and captures (state, waitingFor) tuples.
// Note: input_response is not captured — it must be inferred from save N+1 by post-processing.
//
// Run: npx ts-node --require dotenv/config src/server/tools/export_training_data.ts [outputDir]

require('dotenv').config();

import {mkdirSync, appendFileSync} from 'fs';
import {join} from 'path';
import {Database} from '../database/Database';
import {IDatabase} from '../database/IDatabase';
import {GameId} from '../../common/Types';
import {Game} from '../Game';
import {Player} from '../Player';
import {buildAiRequestState} from '../ai/stateMapping';
import {Phase} from '../../common/Phase';

const args = process.argv.slice(2);
const outputDir = args[0] ?? 'training_export';

const db: IDatabase = Database.getInstance();

type TrainingRecord = {
  save_id: number;
  next_save_id: number | null;
  player_id: string;
  generation: number;
  phase: string;
  state: Record<string, unknown>;
  waitingFor: unknown;
  input_response: null; // not available for historical data
};

type GameExport = {
  game_id: string;
  timestamp: string;
  records: Array<TrainingRecord>;
  error?: string;
};

async function processGame(gameId: GameId, saveIds: Array<number>): Promise<GameExport> {
  const result: GameExport = {
    game_id: gameId,
    timestamp: new Date().toISOString(),
    records: [],
  };

  for (let i = 0; i < saveIds.length; i++) {
    const saveId = saveIds[i];
    const nextSaveId = saveIds[i + 1] ?? null;

    let serialized;
    try {
      serialized = await db.getGameVersion(gameId, saveId);
    } catch (err) {
      continue;
    }

    // Skip end-of-game saves — no decisions to capture
    if (serialized.phase === Phase.END) {
      continue;
    }

    let game: Game;
    try {
      // Deserialization re-runs takeAction(false), which calls setWaitingFor
      // on the active player without triggering a DB save.
      game = Game.deserialize(serialized);
    } catch (err) {
      continue;
    }

    const activePlayer = game.activePlayer;
    if (activePlayer.getWaitingFor() === undefined) {
      // Mid-deferred-action save; no clean decision point
      continue;
    }

    const player = activePlayer as Player;
    const state = buildAiRequestState(game, player);

    result.records.push({
      save_id: saveId,
      next_save_id: nextSaveId,
      player_id: player.id,
      generation: game.generation,
      phase: String(game.phase),
      state,
      waitingFor: state.waitingFor ?? null,
      input_response: null,
    });
  }

  return result;
}

async function main() {
  await db.initialize();
  mkdirSync(outputDir, {recursive: true});

  console.log(`Exporting training data to ${outputDir}`);

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
    try {
      const saveIds = await db.getSaveIds(gameId);
      if (saveIds.length === 0) {
        skipped++;
        continue;
      }

      const gameExport = await processGame(gameId, saveIds);

      if (gameExport.records.length === 0) {
        skipped++;
        continue;
      }

      const filePath = join(outputDir, `${gameId}.jsonl`);
      for (const record of gameExport.records) {
        appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
      }

      completed++;
      process.stdout.write(`\rExported ${completed} / ${gameIds.length} games (${skipped} skipped)`);
    } catch (err) {
      const message = `Skipping game ${gameId}: ${err instanceof Error ? err.message : err}`;
      console.error('\n' + message);
      // Write error record
      const errorPath = join(outputDir, 'errors.jsonl');
      appendFileSync(errorPath, JSON.stringify({game_id: gameId, error: message}) + '\n', 'utf8');
      skipped++;
    }
  }

  console.log();
  console.log(`Done. Exported ${completed} games, skipped ${skipped}.`);
  console.log('Note: input_response fields are null and must be inferred from save pairs.');
}

main().catch((err) => {
  console.error('Unhandled error during export:', err);
  process.exit(1);
});
