import { PlayerInputModel } from '../../common/models/PlayerInputModel';
import { Player } from '../Player';
import { Game } from '../Game';

export type AiMoveRequestState = {
  game: Record<string, unknown>;
  player: Record<string, unknown>;
  waitingFor?: PlayerInputModel;
};

export function buildAiRequestState(game: Game, player: Player): AiMoveRequestState {
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
      id: player.id,
      name: player.name,
      color: player.color,
      terraformRating: player.terraformRating,
      megacredits: player.megaCredits,
      steel: player.steel,
      titanium: player.titanium,
      plants: player.plants,
      heat: player.heat,
      energy: player.energy,
      handSize: player.cardsInHand.length,
      production: {
        megacredits: player.production.megacredits,
        steel: player.production.steel,
        titanium: player.production.titanium,
        plants: player.production.plants,
        heat: player.production.heat,
        energy: player.production.energy,
      },
      tags: player.tags.countAllTags(),
      isAI: player.isAI,
    },
    waitingFor: player.getWaitingFor() ? player.getWaitingFor()!.toModel(player) : undefined,
  };
}
