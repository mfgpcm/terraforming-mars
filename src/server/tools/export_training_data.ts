// Exports training data from all historical games in the database (Plan A).
//
// For each game, produces a dataset.py-compatible JSONL file with:
//   Line 1:     {type:"meta",   game_id, game_spec, players}
//   Lines 2..N: {type:"turn",   step, playerId, phase, state, waitingFor, input_response, ...}
//   Last line:  {type:"result", endGeneration, playerResults}
//
// input_response is inferred from serialized player state diffs between consecutive saves:
//   research   + card type → diff cardsInHand  → bought cards
//   drafting   + card type → diff draftedCards → drafted card
//   initialCards type      → skipped (complex simultaneous selection)
//   action phase           → not captured (waitingFor undefined after deserialization)
//
// Run: npx tsx src/server/tools/export_training_data.ts [outputDir]

require('dotenv').config();

import {mkdirSync, writeFileSync, appendFileSync} from 'fs';
import {join} from 'path';
import {Database} from '../database/Database';
import {GameId} from '../../common/Types';
import {Game} from '../Game';
import {Player} from '../Player';
import {buildAiRequestState} from '../ai/stateMapping';
import {Phase} from '../../common/Phase';
import {GameOptions} from '../game/GameOptions';

const args = process.argv.slice(2);
const outputDir = args[0] ?? 'training_export';

const db = Database.getInstance();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCardNames(cards: Array<unknown>): Array<string> {
  return (cards ?? [])
    .map((c) => (typeof c === 'string' ? c : (c as Record<string, string>)?.name ?? ''))
    .filter(Boolean);
}

function buildGameSpec(gameOptions: GameOptions, playerCount: number): Record<string, unknown> {
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

  return {
    board_name: gameOptions.boardName,
    player_count: playerCount,
    expansions,
    variants: {
      draftVariant: gameOptions.draftVariant,
      initialDraftVariant: gameOptions.initialDraftVariant,
      soloTR: gameOptions.soloTR,
    },
  };
}

// Infer the input_response from consecutive raw serialized player snapshots.
// Returns null if inference is not possible (will skip that turn).
function inferResponse(
  wfType: string,
  phase: string,
  rawPlayerN: Record<string, unknown>,
  rawPlayerN1: Record<string, unknown>,
): Record<string, unknown> | null {
  if (wfType !== 'card') {
    // Only card-type selections are inferrable from state diffs.
    // action phase (OrOptions), initialCards, etc. are not handled.
    return null;
  }

  if (phase === 'research') {
    // Research phase: player buys some of the 4 dealt cards.
    // Cards that appear in cardsInHand in save N+1 but not N were bought.
    const handN = new Set(getCardNames(rawPlayerN.cardsInHand as Array<unknown>));
    const handN1 = getCardNames(rawPlayerN1.cardsInHand as Array<unknown>);
    const bought = handN1.filter((c) => !handN.has(c));
    return {type: 'card', cards: bought};
  }

  if (phase === 'initial_drafting' || phase === 'drafting') {
    // Draft phase: player picks exactly 1 card from the passed set.
    // The new card appears in draftedCards in save N+1.
    const draftedN = new Set(getCardNames(rawPlayerN.draftedCards as Array<unknown>));
    const draftedN1 = getCardNames(rawPlayerN1.draftedCards as Array<unknown>);
    const newCards = draftedN1.filter((c) => !draftedN.has(c));
    if (newCards.length === 0) return null;
    return {type: 'card', cards: newCards};
  }

  return null;
}

// ---------------------------------------------------------------------------
// Game result from game_results table
// ---------------------------------------------------------------------------

type RawScore = {corporation: string; playerScore: number};

async function buildResult(
  gameId: GameId,
  saveIds: Array<number>,
): Promise<Record<string, unknown> | null> {
  // Get game_results row
  const resultRow = await (db as any).asyncGet(
    'SELECT generations, scores FROM game_results WHERE game_id = ?',
    [gameId],
  );
  if (!resultRow) return null;

  const endGeneration: number = resultRow.generations;
  const scores: Array<RawScore> = JSON.parse(resultRow.scores);

  // Get last save to find playerId → corporation mapping and TR
  const lastSaveId = saveIds[saveIds.length - 1];
  let lastSerialized;
  try {
    lastSerialized = await db.getGameVersion(gameId, lastSaveId);
  } catch {
    return null;
  }

  // Build corp → {playerId, name, tr} map from serialized players
  const playerMap = new Map<string, {playerId: string; name: string; tr: number}>();
  for (const sp of lastSerialized.players) {
    const corps = getCardNames((sp as any).corporations ?? []);
    for (const corp of corps) {
      playerMap.set(corp, {playerId: sp.id, name: sp.name, tr: (sp as any).terraformRating ?? 20});
    }
  }

  // Sort scores descending to compute ranks
  const sorted = [...scores].sort((a, b) => b.playerScore - a.playerScore);
  const playerResults: Array<Record<string, unknown>> = [];
  sorted.forEach((score, idx) => {
    const info = playerMap.get(score.corporation);
    if (!info) return;
    playerResults.push({
      playerId: info.playerId,
      name: info.name,
      tr: info.tr,
      vp_total: score.playerScore,
      rank: idx + 1,
    });
  });

  if (playerResults.length === 0) return null;

  return {endGeneration, playerResults};
}

// ---------------------------------------------------------------------------
// Per-game processing
// ---------------------------------------------------------------------------

async function processGame(gameId: GameId, saveIds: Array<number>): Promise<number> {
  // Build meta from save 0
  let meta: Record<string, unknown> | null = null;
  let gameSpec: Record<string, unknown> = {};
  let playersList: Array<Record<string, unknown>> = [];

  for (const sid of saveIds) {
    try {
      const s = await db.getGameVersion(gameId, sid);
      if (s.gameOptions) {
        gameSpec = buildGameSpec(s.gameOptions, s.players.length);
        playersList = s.players.map((p) => ({
          playerId: p.id,
          name: p.name,
          isAI: (p as any).isAI ?? false,
        }));
        meta = {type: 'meta', game_id: gameId, game_spec: gameSpec, players: playersList};
        break;
      }
    } catch {
      continue;
    }
  }
  if (!meta) return 0;

  // Build result
  const result = await buildResult(gameId, saveIds);
  if (!result) return 0;

  const filePath = join(outputDir, `${gameId}.jsonl`);
  const lines: Array<string> = [JSON.stringify(meta)];

  let stepCounters: Record<string, number> = {};
  let turnsWritten = 0;

  for (let i = 0; i < saveIds.length; i++) {
    const saveId = saveIds[i];
    const nextSaveId = saveIds[i + 1] ?? null;
    if (nextSaveId === null) continue;

    // Load and deserialize save N
    let serializedN;
    try {
      serializedN = await db.getGameVersion(gameId, saveId);
    } catch {
      continue;
    }

    if (serializedN.phase === Phase.END) continue;

    let gameN: Game;
    try {
      gameN = Game.deserialize(serializedN);
    } catch {
      continue;
    }

    const activePlayer = gameN.activePlayer as Player;
    const wf = activePlayer.getWaitingFor();
    if (!wf) continue;

    const wfModel = wf.toModel(activePlayer);
    const wfType = wfModel.type;

    // Skip initialCards — simultaneous multi-select is not inferrable by simple diff
    if (wfType === 'initialCards') continue;

    // Build AI request state (state + waitingFor fields)
    const aiState = buildAiRequestState(gameN, activePlayer);

    // Load raw serialized save N and N+1 to infer input_response
    let rawN: Record<string, unknown>;
    let rawN1: Record<string, unknown>;
    try {
      rawN = (await db.getGameVersion(gameId, saveId)) as unknown as Record<string, unknown>;
      rawN1 = (await db.getGameVersion(gameId, nextSaveId)) as unknown as Record<string, unknown>;
    } catch {
      continue;
    }

    const rawPlayersN = (rawN.players as Array<Record<string, unknown>>) ?? [];
    const rawPlayersN1 = (rawN1.players as Array<Record<string, unknown>>) ?? [];
    const rawPlayerN = rawPlayersN.find((p) => p.id === activePlayer.id);
    const rawPlayerN1 = rawPlayersN1.find((p) => p.id === activePlayer.id);
    if (!rawPlayerN || !rawPlayerN1) continue;

    const inputResponse = inferResponse(wfType, serializedN.phase, rawPlayerN, rawPlayerN1);
    if (!inputResponse) continue;

    const playerId = activePlayer.id;
    stepCounters[playerId] = (stepCounters[playerId] ?? 0) + 1;

    const turn: Record<string, unknown> = {
      type: 'turn',
      step: stepCounters[playerId],
      playerId,
      generation: gameN.generation,
      phase: String(gameN.phase),
      timestamp: new Date().toISOString(),
      state: aiState,
      waitingFor: aiState.waitingFor ?? null,
      input_response: inputResponse,
      is_human: true,
    };

    lines.push(JSON.stringify(turn));
    turnsWritten++;
  }

  if (turnsWritten === 0) return 0;

  lines.push(JSON.stringify({type: 'result', ...result}));

  writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return turnsWritten;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
  let totalTurns = 0;

  for (const gameId of gameIds) {
    try {
      const saveIds = await db.getSaveIds(gameId);
      if (saveIds.length < 2) {
        skipped++;
        continue;
      }

      const turns = await processGame(gameId, saveIds);
      if (turns === 0) {
        skipped++;
        continue;
      }

      totalTurns += turns;
      completed++;
      process.stdout.write(
        `\rExported ${completed}/${gameIds.length} games (${skipped} skipped, ${totalTurns} turns)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorPath = join(outputDir, 'errors.jsonl');
      appendFileSync(errorPath, JSON.stringify({game_id: gameId, error: message}) + '\n', 'utf8');
      skipped++;
    }
  }

  console.log();
  console.log(`Done. Exported ${completed} games (${totalTurns} turns), skipped ${skipped}.`);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
