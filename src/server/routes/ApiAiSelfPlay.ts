import * as responses from '../server/responses';
import {Handler} from './Handler';
import {Context} from './IHandler';
import {Game} from '../Game';
import {Player} from '../Player';
import {BoardName} from '../../common/boards/BoardName';
import {Phase} from '../../common/Phase';
import {buildAiRequestState} from '../ai/stateMapping';
import {TrainingLogger} from '../ai/TrainingLogger';
import {ApiCreateGame} from './ApiCreateGame';
import {safeCast, isGameId, isSpectatorId, isPlayerId} from '../../common/Types';
import {generateRandomId} from '../utils/server-ids';
import {IPlayer} from '../IPlayer';
import {Request} from '../Request';
import {Response} from '../Response';

export class ApiAiNewGame extends Handler {
  public static readonly INSTANCE = new ApiAiNewGame();

  public override post(req: Request, res: Response, ctx: Context): Promise<void> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (data: Buffer) => { body += data.toString(); });
      req.once('end', async () => {
        try {
          const config = body ? JSON.parse(body) : {};
          const boardName: BoardName = config.boardName ?? BoardName.THARSIS;
          const logDir: string | undefined = config.logDir;

          const gameId = safeCast(generateRandomId('g'), isGameId);
          const spectatorId = safeCast(generateRandomId('s'), isSpectatorId);

          const players = [
            new Player('AI-Blue', 'blue', false, 0, safeCast(generateRandomId('p'), isPlayerId), true),
            new Player('AI-Red', 'red', false, 0, safeCast(generateRandomId('p'), isPlayerId), true),
          ];

          const game = Game.newInstance(
            gameId, players, players[0],
            {boardName, corporateEra: true},
            Math.random(), spectatorId,
            /* isSelfPlay */ true,
          );

          await ctx.gameLoader.add(game);

          const gameSpec = {
            board_name: game.gameOptions.boardName,
            player_count: players.length,
            created_at: new Date().toISOString(),
            expansions: ApiCreateGame.enabledExpansions(game.gameOptions),
            variants: ApiCreateGame.enabledVariants(game.gameOptions),
          };

          const logger = new TrainingLogger(logDir);
          void logger.writeMeta({
            game_id: game.id,
            game_spec: gameSpec,
            players: players.map((p) => ({playerId: p.id, name: p.name, isAI: p.isAI})),
          });

          const activePlayer = game.players.find((p: IPlayer) => p.getWaitingFor() !== undefined);
          if (!activePlayer) {
            responses.badRequest(req, res, 'No player waiting for input after game creation');
            resolve();
            return;
          }

          responses.writeJson(res, ctx, {
            game_id: game.id,
            player_id: activePlayer.id,
            state: buildAiRequestState(game as Game, activePlayer as Player),
            waitingFor: activePlayer.getWaitingFor()?.toModel(activePlayer),
            game_spec: gameSpec,
          });
        } catch (e) {
          responses.internalServerError(req, res, e);
        }
        resolve();
      });
    });
  }
}

export class ApiAiStep extends Handler {
  public static readonly INSTANCE = new ApiAiStep();

  public override post(req: Request, res: Response, ctx: Context): Promise<void> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (data: Buffer) => { body += data.toString(); });
      req.once('end', async () => {
        try {
          const {game_id, player_id, input_response} = JSON.parse(body);

          const game = await ctx.gameLoader.getGame(game_id);
          if (game === undefined) {
            responses.notFound(req, res);
            resolve();
            return;
          }

          const player = game.getPlayerById(player_id) as Player;
          player.process(input_response);

          if (game.phase === Phase.END) {
            const sortedByVP = [...game.players]
              .map((p) => ({player: p, vp: p.getVictoryPoints().total}))
              .sort((a, b) => b.vp - a.vp);

            responses.writeJson(res, ctx, {
              done: true,
              player_id: null,
              state: null,
              waitingFor: null,
              result: {
                endGeneration: game.generation,
                playerResults: sortedByVP.map((entry, idx) => ({
                  playerId: entry.player.id,
                  name: entry.player.name,
                  tr: entry.player.terraformRating,
                  vp_total: entry.vp,
                  rank: idx + 1,
                })),
              },
            });
            resolve();
            return;
          }

          const nextPlayer = game.players.find((p: IPlayer) => p.getWaitingFor() !== undefined);
          if (!nextPlayer) {
            responses.badRequest(req, res, 'No player waiting for input and game not ended');
            resolve();
            return;
          }

          responses.writeJson(res, ctx, {
            done: false,
            player_id: nextPlayer.id,
            state: buildAiRequestState(game as Game, nextPlayer as Player),
            waitingFor: nextPlayer.getWaitingFor()?.toModel(nextPlayer),
            result: null,
          });
        } catch (e) {
          responses.internalServerError(req, res, e);
        }
        resolve();
      });
    });
  }
}
