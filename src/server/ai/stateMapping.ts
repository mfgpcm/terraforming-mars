import {PlayerInputModel} from '../../common/models/PlayerInputModel';
import {IPlayer} from '../IPlayer';
import {Player} from '../Player';
import {Game} from '../Game';
import {SpaceType} from '../../common/boards/SpaceType';
import {TileType} from '../../common/TileType';

export type AiMoveRequestState = {
  game: Record<string, unknown>;
  player: Record<string, unknown>;
  opponents: Array<Record<string, unknown>>;
  board: Array<Record<string, unknown>>;
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
    },
    player: {
      ...buildPlayerSnapshot(player),
      boardTiles: selfTiles,
    },
    opponents: opponents.map((opp, i) => {
      const oppColor = oppColors[i] ?? null;
      const tiles = countBoardTiles(board, oppColor);
      return {...opp, boardTiles: tiles};
    }),
    board,
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
