import {PlayerInputModel} from '../../common/models/PlayerInputModel';
import {IPlayer} from '../IPlayer';
import {Player} from '../Player';
import {Game} from '../Game';
import {SpaceType} from '../../common/boards/SpaceType';
import {TileType} from '../../common/TileType';
import {GameOptions} from '../game/GameOptions';
import {LogMessage} from '../../common/logs/LogMessage';
import {LogMessageDataType} from '../../common/logs/LogMessageDataType';
import {LogMessageType} from '../../common/logs/LogMessageType';

// Human-readable names for tile types (numeric enum values)
const TILE_TYPE_NAMES: Record<number, string> = {
  0: 'greenery', 1: 'ocean', 2: 'city', 3: 'Capital', 4: 'Commercial District',
  5: 'Ecological Zone', 6: 'Industrial Center', 7: 'Lava Flows', 8: 'Mining Area',
  9: 'Mining Rights', 10: 'Mohole Area', 11: 'Natural Preserve', 12: 'Nuclear Zone',
  13: 'Restricted Area', 14: 'Deimos Down', 15: 'Great Dam', 16: 'Magnetic Field Gen.',
  17: 'Biofertilizer', 18: 'Metallic Asteroid', 19: 'Solar Farm',
  20: 'Ocean City', 21: 'Ocean Farm', 22: 'Ocean Sanctuary',
};

const SPACE_BONUS_NAMES: Record<number, string> = {
  0: 'titanium', 1: 'steel', 2: 'plant', 3: 'card', 4: 'heat',
  5: 'ocean', 6: 'MC', 7: 'animal', 8: 'microbe', 9: 'energy',
  10: 'data', 11: 'science', 12: 'energy production', 13: 'temperature',
};

function serializeLogMessage(msg: LogMessage, players: readonly IPlayer[]): string {
  let text = msg.message;
  for (let i = 0; i < msg.data.length; i++) {
    const d = msg.data[i];
    let val: string;
    switch (d.type) {
      case LogMessageDataType.PLAYER: {
        const p = players.find((p) => p.color === String(d.value));
        val = p?.name ?? String(d.value);
        break;
      }
      case LogMessageDataType.TILE_TYPE:
        val = TILE_TYPE_NAMES[Number(d.value)] ?? `tile-${d.value}`;
        break;
      case LogMessageDataType.SPACE_BONUS:
        val = SPACE_BONUS_NAMES[Number(d.value)] ?? String(d.value);
        break;
      case LogMessageDataType.SPACE:
        val = `hex-${d.value}`;
        break;
      case LogMessageDataType.CARDS:
        val = Array.isArray(d.value) ? (d.value as string[]).join(', ') : String(d.value);
        break;
      default:
        val = String(d.value);
    }
    text = text.replace(`\${${i}}`, val);
  }
  return text;
}

function getRecentLog(game: Game, player: Player): string[] {
  const messages = game.gameLog;
  // Find the start of the current generation
  let genStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === LogMessageType.NEW_GENERATION) {
      genStart = i + 1;
      break;
    }
  }
  // Take from current generation start, but cap at last 60 messages.
  // Filter to opponents' moves + system messages — the AI already knows its own moves
  // from session memory; showing them again wastes tokens and confuses tableau attention.
  const startIdx = Math.max(genStart, messages.length - 60);
  return messages
    .slice(startIdx)
    .filter((msg) => msg.playerId === undefined || msg.playerId !== player.id)
    .map((msg) => serializeLogMessage(msg, game.players));
}

function getActiveExpansions(opts: Readonly<GameOptions>): string[] {
  const active: string[] = [];
  if (opts.venusNextExtension) active.push('venus');
  if (opts.coloniesExtension) active.push('colonies');
  if (opts.preludeExtension) active.push('prelude');
  if (opts.prelude2Expansion) active.push('prelude2');
  if (opts.turmoilExtension) active.push('turmoil');
  if (opts.moonExpansion) active.push('moon');
  if (opts.pathfindersExpansion) active.push('pathfinders');
  if (opts.underworldExpansion) active.push('underworld');
  if (opts.aresExtension) active.push('ares');
  return active;
}

function getGameVariants(opts: Readonly<GameOptions>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (opts.draftVariant) v['draftVariant'] = true;
  if (opts.initialDraftVariant) v['initialDraftVariant'] = true;
  if (opts.preludeDraftVariant) v['preludeDraftVariant'] = true;
  if (opts.ceosDraftVariant) v['ceosDraftVariant'] = true;
  if (opts.twoCorpsVariant) v['twoCorpsVariant'] = true;
  if (opts.solarPhaseOption) v['solarPhaseOption'] = true;
  if (opts.soloTR) v['soloTR'] = true;
  if (opts.randomMA !== 'No randomization') v['randomMA'] = opts.randomMA;
  if (opts.requiresVenusTrackCompletion) v['requiresVenusTrackCompletion'] = true;
  if (opts.requiresMoonTrackCompletion) v['requiresMoonTrackCompletion'] = true;
  if (opts.politicalAgendasExtension !== 'Standard') v['politicalAgendasExtension'] = opts.politicalAgendasExtension;
  if (opts.removeNegativeGlobalEventsOption) v['removeNegativeGlobalEventsOption'] = true;
  if (opts.startingCorporations !== 2) v['startingCorporations'] = opts.startingCorporations;
  if (opts.startingPreludes !== 4) v['startingPreludes'] = opts.startingPreludes;
  if (opts.startingCeos !== 3) v['startingCeos'] = opts.startingCeos;
  if (opts.altVenusBoard) v['altVenusBoard'] = true;
  if (opts.modularMA) v['modularMA'] = true;
  return v;
}

export type AiMoveRequestState = {
  game: Record<string, unknown>;
  player: Record<string, unknown>;
  opponents: Array<Record<string, unknown>>;
  board: Array<Record<string, unknown>>;
  boardSpaces: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  awards: Array<Record<string, unknown>>;
  boardTilesSelf?: Record<string, number>;
  boardTilesOpp?: Record<string, number>;
  waitingFor?: PlayerInputModel;
};

function getCardResourcesByCard(p: IPlayer): Record<string, number> {
  const result: Record<string, number> = {};
  for (const card of p.tableau) {
    if (card.resourceType !== undefined && card.resourceCount > 0) {
      result[card.name] = card.resourceCount;
    }
  }
  return result;
}

function buildPlayerSnapshot(p: IPlayer): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    terraformRating: p.terraformRating,
    victoryPoints: p.getVictoryPoints().total,
    megacredits: p.megaCredits,
    steel: p.steel,
    titanium: p.titanium,
    plants: p.plants,
    heat: p.heat,
    energy: p.energy,
    handSize: p.cardsInHand.length,
    production: {
      megacredits: p.production.megacredits,
      steel: p.production.steel,
      titanium: p.production.titanium,
      plants: p.production.plants,
      heat: p.production.heat,
      energy: p.production.energy,
    },
    tags: Object.fromEntries(Object.entries(p.tags.countAllTags()).map(([k, v]) => [k, v ?? 0])),
    isAI: p.isAI,
    playedCards: Array.from(p.playedCards).map((c) => c.name),
    playedCardCount: p.playedCards.length,
    corporations: p.playedCards.corporations().map((c) => c.name),
    cardResources: getCardResourcesByCard(p),
  };
}

function buildBoardState(game: Game): Array<Record<string, unknown>> {
  return game.board.spaces
    .filter((space) => space.spaceType !== SpaceType.COLONY && space.tile !== undefined)
    .map((space) => ({
      id: space.id,
      x: space.x,
      y: space.y,
      tileType: space.tile?.tileType ?? null,
      playerColor: space.player?.color ?? null,
    }));
}

function buildAllBoardSpaces(game: Game): Array<Record<string, unknown>> {
  return game.board.spaces
    .filter((space) => space.spaceType !== SpaceType.COLONY && space.x >= 0)
    .map((space) => {
      const entry: Record<string, unknown> = {
        id: space.id,
        x: space.x,
        y: space.y,
        t: space.spaceType,
        b: space.bonus.map((b) => SPACE_BONUS_NAMES[b as number] ?? `bonus-${b}`),
      };
      if (space.volcanic) entry.v = true;
      if (space.tile !== undefined) {
        entry.tile = space.tile.tileType;
        entry.pc = space.player?.color ?? null;
      }
      return entry;
    });
}

function countBoardTiles(
  board: Array<Record<string, unknown>>,
  playerColor: string | null,
): {greenery: number; city: number; special: number} {
  let greenery = 0;
  let city = 0;
  let special = 0;
  for (const space of board) {
    if (playerColor !== null && space.playerColor !== playerColor) continue;
    const t = space.tileType as number | null;
    if (t === null) continue;
    if (t === TileType.GREENERY) greenery++;
    else if (t === TileType.CITY || t === TileType.CAPITAL) city++;
    else if (t !== TileType.OCEAN) special++;
  }
  return {greenery, city, special};
}

export function buildAiRequestState(game: Game, player: Player): AiMoveRequestState {
  const opponents = game.players
    .filter((p) => p.id !== player.id)
    .map(buildPlayerSnapshot);

  const board = buildBoardState(game);

  const selfTiles = countBoardTiles(board, player.color);
  const oppColors = game.players
    .filter((p) => p.id !== player.id)
    .map((p) => p.color);
  const oppTiles = oppColors.reduce(
    (acc, color) => {
      const t = countBoardTiles(board, color);
      return {
        greenery: acc.greenery + t.greenery,
        city: acc.city + t.city,
        special: acc.special + t.special,
      };
    },
    {greenery: 0, city: 0, special: 0},
  );

  return {
    game: {
      id: game.id,
      phase: game.phase,
      generation: game.generation,
      oxygen: game.getOxygenLevel(),
      temperature: game.getTemperature(),
      oceanCount: game.board.getOceanSpaces().length,
      boardName: game.gameOptions.boardName,
      expansions: getActiveExpansions(game.gameOptions),
      availableMilestones: game.milestones.map((m) => ({name: m.name, description: m.description})),
      availableAwards: game.awards.map((a) => ({name: a.name, description: a.description})),
      gameVariants: getGameVariants(game.gameOptions),
      recentLog: getRecentLog(game, player),
    },
    player: {
      ...buildPlayerSnapshot(player),
      boardTiles: selfTiles,
      cardsInHand: player.cardsInHand.map((c) => c.name),
    },
    opponents: opponents.map((opp, i) => {
      const oppColor = oppColors[i] ?? null;
      const tiles = countBoardTiles(board, oppColor);
      return {...opp, boardTiles: tiles};
    }),
    board,
    boardSpaces: buildAllBoardSpaces(game),
    milestones: game.claimedMilestones.map((cm) => ({
      name: cm.milestone.name,
      playerId: cm.player.id,
    })),
    awards: game.fundedAwards.map((fa) => ({
      name: fa.award.name,
      playerId: fa.player.id,
    })),
    boardTilesSelf: selfTiles,
    boardTilesOpp: oppTiles,
    waitingFor: player.getWaitingFor()?.toModel(player),
  };
}
