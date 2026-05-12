import {PlayerInputModel} from '../../common/models/PlayerInputModel';
import {IPlayer} from '../IPlayer';
import {Player} from '../Player';
import {Game} from '../Game';
import {SpaceType} from '../../common/boards/SpaceType';

export type AiMoveRequestState = {
  game: Record<string, unknown>;
  player: Record<string, unknown>;
  opponents: Array<Record<string, unknown>>;
  board: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  awards: Array<Record<string, unknown>>;
  waitingFor?: PlayerInputModel;
};

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
    corporations: p.playedCards.corporations().map((c) => c.name),
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

export function buildAiRequestState(game: Game, player: Player): AiMoveRequestState {
  const opponents = game.players
    .filter((p) => p.id !== player.id)
    .map(buildPlayerSnapshot);

  return {
    game: {
      id: game.id,
      phase: game.phase,
      generation: game.generation,
      oxygen: game.getOxygenLevel(),
      temperature: game.getTemperature(),
      oceanCount: game.board.getOceanSpaces().length,
    },
    player: buildPlayerSnapshot(player),
    opponents,
    board: buildBoardState(game),
    milestones: game.claimedMilestones.map((cm) => ({
      name: cm.milestone.name,
      playerId: cm.player.id,
    })),
    awards: game.fundedAwards.map((fa) => ({
      name: fa.award.name,
      playerId: fa.player.id,
    })),
    waitingFor: player.getWaitingFor()?.toModel(player),
  };
}
