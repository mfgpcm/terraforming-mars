// Exports every game log available from the configured database into separate JSON files.
// This script continues past corrupted games or corrupted save versions.
// Run after building the project with `npm run build`, or with ts-node for direct execution.

require('dotenv').config();

import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';
import {Database} from '../database/Database';
import {IDatabase} from '../database/IDatabase';
import {GameId} from '../../common/Types';
import {GameOptions} from '../game/GameOptions';

const args = process.argv.slice(2);
const outputDir = args[0] ?? 'logs/json';

const db: IDatabase = Database.getInstance();

type GameSpec = {
  board_name: string;
  player_count: number;
  created_at: string;
  last_save_id: number;
  expansions: Array<string>;
  variants: Record<string, boolean>;
  custom_lists: {
    bannedCards: Array<string>;
    customCorporationsList: Array<string>;
    customColoniesList: Array<string>;
    customPreludes: Array<string>;
    customCeos: Array<string>;
  };
};

type ExportPayload = {
  game_id: string;
  timestamp: string;
  game_spec?: GameSpec;
  saves: Record<string, unknown>;
  errors: Array<string>;
};

function buildGameSpec(gameOptions: GameOptions | undefined, playerCount: number, lastSaveId: number, createdTimeMs: number): GameSpec | undefined {
  if (!gameOptions) {
    return undefined;
  }

  // Extract enabled expansions from individual boolean flags (legacy format)
  const expansions: Array<string> = [];
  if (gameOptions.corporateEra) expansions.push('corpEra');
  if (gameOptions.promoCardsOption) expansions.push('promo');
  if (gameOptions.venusNextExtension) expansions.push('venus');
  if (gameOptions.coloniesExtension) expansions.push('colonies');
  if (gameOptions.preludeExtension) expansions.push('prelude');
  if (gameOptions.prelude2Expansion) expansions.push('prelude2');
  if (gameOptions.turmoilExtension) expansions.push('turmoil');
  if (gameOptions.communityCardsOption) expansions.push('community');
  if (gameOptions.aresExtension) expansions.push('ares');
  if (gameOptions.moonExpansion) expansions.push('moon');
  if (gameOptions.pathfindersExpansion) expansions.push('pathfinders');
  if (gameOptions.ceoExtension) expansions.push('ceo');
  if (gameOptions.starWarsExpansion) expansions.push('starwars');
  if (gameOptions.underworldExpansion) expansions.push('underworld');

  // Build variants record
  const variants: Record<string, boolean> = {
    draftVariant: gameOptions.draftVariant,
    initialDraftVariant: gameOptions.initialDraftVariant,
    preludeDraftVariant: gameOptions.preludeDraftVariant,
    ceosDraftVariant: gameOptions.ceosDraftVariant,
    soloTR: gameOptions.soloTR,
    shuffleMapOption: gameOptions.shuffleMapOption,
    modularMA: gameOptions.modularMA,
    includeFanMA: gameOptions.includeFanMA,
    requiresMoonTrackCompletion: gameOptions.requiresMoonTrackCompletion,
    requiresVenusTrackCompletion: gameOptions.requiresVenusTrackCompletion,
    moonStandardProjectVariant: gameOptions.moonStandardProjectVariant,
    moonStandardProjectVariant1: gameOptions.moonStandardProjectVariant1,
    altVenusBoard: gameOptions.altVenusBoard,
    twoCorpsVariant: gameOptions.twoCorpsVariant,
    undoOption: gameOptions.undoOption,
    fastModeOption: gameOptions.fastModeOption,
    showTimers: gameOptions.showTimers,
    showOtherPlayersVP: gameOptions.showOtherPlayersVP,
  };

  return {
    board_name: gameOptions.boardName,
    player_count: playerCount,
    created_at: new Date(createdTimeMs).toISOString(),
    last_save_id: lastSaveId,
    expansions,
    variants,
    custom_lists: {
      bannedCards: Array.from(gameOptions.bannedCards),
      customCorporationsList: Array.from(gameOptions.customCorporationsList),
      customColoniesList: Array.from(gameOptions.customColoniesList),
      customPreludes: Array.from(gameOptions.customPreludes),
      customCeos: Array.from(gameOptions.customCeos),
    },
  };
}

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

      // Extract game spec from the first version with valid gameOptions
      let gameSpec: GameSpec | undefined;
      for (const saveId of saveIds) {
        try {
          const version = await db.getGameVersion(gameId, saveId);
          exportPayload.saves[saveId.toString()] = version.gameLog;

          // Build game_spec from first successful version with valid gameOptions
          if (!gameSpec && version.gameOptions) {
            gameSpec = buildGameSpec(version.gameOptions, version.players.length, saveIds[saveIds.length - 1], version.createdTimeMs);
            if (gameSpec) {
              break;  // Successfully got game spec, can stop early
            }
          }
        } catch (err) {
          const message = `Failed to read save ${saveId}: ${err instanceof Error ? err.message : err}`;
          console.warn(`${gameId}: ${message}`);
          (exportPayload.errors as Array<string>).push(message);
        }
      }

      if (gameSpec) {
        exportPayload.game_spec = gameSpec;
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
