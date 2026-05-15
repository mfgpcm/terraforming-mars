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

import {mkdirSync, writeFileSync, appendFileSync, existsSync} from 'fs';
import {join} from 'path';
import {globalInitialize} from '../globalInitialize';
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

// Log message data type constants (mirrors LogMessageDataType enum)
const LOG_PLAYER = 2;
const LOG_CARD = 3;
const LOG_AWARD = 4;
const LOG_MILESTONE = 5;

type LogEntry = {
  message: string;
  data?: Array<{type: number; value: string}>;
};

// Extract new log messages added between save N and save N+1.
function diffGameLogs(
  rawN: Record<string, unknown>,
  rawN1: Record<string, unknown>,
): Array<LogEntry> {
  const logsN = (rawN.gameLog as Array<unknown>) ?? [];
  const logsN1 = (rawN1.gameLog as Array<unknown>) ?? [];
  return logsN1.slice(logsN.length) as Array<LogEntry>;
}

// Resolve title from string | Message to a plain string.
function resolveTitle(title: unknown): string {
  if (typeof title === 'string') return title;
  if (title && typeof title === 'object') {
    return (title as {message?: string}).message ?? '';
  }
  return '';
}

// Infer input_response for action-phase (OrOptions) turns using game log messages.
// Returns null if a matching option cannot be found.
function inferResponseFromLogs(
  wfModel: Record<string, unknown>,
  newLogs: Array<LogEntry>,
  activePlayerColor: string,
): Record<string, unknown> | null {
  if (wfModel.type !== 'or') return null;

  const options = (wfModel.options as Array<Record<string, unknown>>) ?? [];

  // Only consider messages attributed to this player.
  const playerLogs = newLogs.filter((entry) =>
    entry.data?.some((d) => d.type === LOG_PLAYER && d.value === activePlayerColor),
  );
  if (playerLogs.length === 0) return null;

  for (const log of playerLogs) {
    const msg = log.message;
    const cardName = log.data?.find((d) => d.type === LOG_CARD)?.value;
    const milestoneName = log.data?.find((d) => d.type === LOG_MILESTONE)?.value;
    const awardName = log.data?.find((d) => d.type === LOG_AWARD)?.value;

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const title = resolveTitle(opt.title).toLowerCase();

      // Played a project card
      if (msg.includes('played') && cardName && opt.type === 'projectCard') {
        return {type: 'or', index: i, response: {type: 'option'}};
      }
      // Used a card action (not a standard project)
      if ((msg === '${0} used ${1} action' || msg === '${0} used ${1} action with ${2}') &&
          cardName && (title.includes('perform an action') || title.includes('action from'))) {
        return {type: 'or', index: i, response: {type: 'option'}};
      }
      // Used a standard project (message says "standard project" or "standard action")
      if ((msg.includes('standard project') || msg.includes('standard action')) &&
          title.includes('standard')) {
        return {type: 'or', index: i, response: {type: 'option'}};
      }
      // Sold patents (special card action with RAW_STRING count, not CARD data)
      if (msg.includes('sold') && msg.includes('patent') && title.includes('patent')) {
        return {type: 'or', index: i, response: {type: 'option'}};
      }
      // Passed for this generation
      if (msg === '${0} passed' && title.includes('pass')) {
        return {type: 'or', index: i, response: {type: 'option'}};
      }
      // Ended turn (multiplayer mid-round)
      if (msg === '${0} ended turn' && title.includes('end')) {
        return {type: 'or', index: i, response: {type: 'option'}};
      }
      // Claimed a milestone
      if (milestoneName && msg.includes('milestone') && title.includes('milestone')) {
        return {type: 'or', index: i, response: {type: 'option'}};
      }
      // Funded an award
      if (awardName && msg.includes('award') && title.includes('award')) {
        return {type: 'or', index: i, response: {type: 'option'}};
      }
      // Converted plants to greenery — no explicit "plants" in log message;
      // detect by greenery tile placement WITHOUT a preceding "standard project" message.
      const isStandardProject = playerLogs.some(
        (l) => l.message.includes('standard project') || l.message.includes('standard action'),
      );
      if (!isStandardProject) {
        const greeneryData = log.data?.some((d) => d.value === 'greenery tile');
        if (greeneryData && title.includes('plant')) {
          return {type: 'or', index: i, response: {type: 'option'}};
        }
      }
      // Converted heat to temperature (no explicit "heat" log; detect by spending heat)
      if (msg === '${0} spent ${1} energy' && title.includes('heat')) {
        return {type: 'or', index: i, response: {type: 'option'}};
      }
    }
  }
  return null;
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

    let inputResponse = inferResponse(wfType, serializedN.phase, rawPlayerN, rawPlayerN1);

    // For action-phase OrOptions, fall back to log-based inference.
    if (!inputResponse && wfType === 'or') {
      const newLogs = diffGameLogs(rawN, rawN1);
      inputResponse = inferResponseFromLogs(
        wfModel as unknown as Record<string, unknown>,
        newLogs,
        activePlayer.color,
      );
    }

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
  globalInitialize();
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
      // Skip games whose JSONL already exists — re-exports are idempotent and slow.
      const outPath = join(outputDir, `${gameId}.jsonl`);
      if (existsSync(outPath)) {
        skipped++;
        continue;
      }

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
