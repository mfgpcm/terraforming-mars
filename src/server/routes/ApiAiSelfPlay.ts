import * as responses from '../server/responses';
import {Handler} from './Handler';
import {Context} from './IHandler';
import {Game} from '../Game';
import {Player} from '../Player';
import {BoardName} from '../../common/boards/BoardName';
import {Phase} from '../../common/Phase';
import {buildAiRequestState} from '../ai/stateMapping';
import {ApiCreateGame} from './ApiCreateGame';
import {safeCast, isGameId, isSpectatorId, isPlayerId} from '../../common/Types';
import {generateRandomId} from '../utils/server-ids';
import {IPlayer} from '../IPlayer';
import {InputError} from '../inputs/InputError';
import {statusCode} from '../../common/http/statusCode';
import {Request} from '../Request';
import {Response} from '../Response';
import {RandomMAOptionType} from '../../common/ma/RandomMAOptionType';

// Official boards used for self-play diversity
const OFFICIAL_BOARDS = [BoardName.THARSIS, BoardName.HELLAS, BoardName.ELYSIUM];

// Player colours and names in order
const PLAYER_CONFIGS = [
  {color: 'blue',  name: 'AI-Blue'},
  {color: 'red',   name: 'AI-Red'},
  {color: 'green', name: 'AI-Green'},
  {color: 'yellow', name: 'AI-Yellow'},
] as const;

function randomSelfPlayConfig(override?: {boardName?: BoardName; playerCount?: number}): {
  boardName: BoardName;
  playerCount: number;
  withPromo: boolean;
} {
  // 80% chance of 2 players, 10% chance of 3, 10% chance of 4
  let playerCount = override?.playerCount ?? 2;
  if (!override?.playerCount) {
    const r = Math.random();
    playerCount = r < 0.80 ? 2 : r < 0.90 ? 3 : 4;
  }
  const boardName = override?.boardName ?? OFFICIAL_BOARDS[Math.floor(Math.random() * OFFICIAL_BOARDS.length)];
  const withPromo = Math.random() < 0.20;
  return {boardName, playerCount, withPromo};
}

export class ApiAiNewGame extends Handler {
  public static readonly INSTANCE = new ApiAiNewGame();

  public override post(req: Request, res: Response, ctx: Context): Promise<void> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (data: Buffer) => { body += data.toString(); });
      req.once('end', async () => {
        try {
          const config = body ? JSON.parse(body) : {};
          const {boardName, playerCount, withPromo} = randomSelfPlayConfig({
            boardName: config.boardName,
            playerCount: config.playerCount,
          });

          const gameId = safeCast(generateRandomId('g'), isGameId);
          const spectatorId = safeCast(generateRandomId('s'), isSpectatorId);

          const players = PLAYER_CONFIGS.slice(0, playerCount).map(
            ({color, name}) => new Player(name, color as 'blue' | 'red' | 'green' | 'yellow', false, 0,
              safeCast(generateRandomId('p'), isPlayerId), true),
          );

          const game = Game.newInstance(
            gameId, players, players[0],
            {
              boardName,
              corporateEra: true,
              venusNextExtension: true,
              preludeExtension: true,
              prelude2Expansion: true,
              promoCardsOption: withPromo,
              solarPhaseOption: false,
              fastModeOption: true,
              randomMA: RandomMAOptionType.UNLIMITED,
            },
            Math.random(), spectatorId,
            /* isSelfPlay */ true,
          );

          await ctx.gameLoader.add(game);

          // Self-play games persist to the DB; no per-game JSONL is written.
          // Use export_training_data.ts to re-extract training data from DB when needed.
          const gameSpec = {
            board_name: game.gameOptions.boardName,
            player_count: players.length,
            created_at: new Date().toISOString(),
            expansions: ApiCreateGame.enabledExpansions(game.gameOptions),
            variants: ApiCreateGame.enabledVariants(game.gameOptions),
          };

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
          try {
            player.process(input_response);
          } catch (e) {
            if (e instanceof InputError || e instanceof Error) {
              res.writeHead(statusCode.badRequest, {'Content-Type': 'application/json'});
              res.write(JSON.stringify({error: e instanceof Error ? e.message : String(e)}));
              res.end();
              resolve();
              return;
            }
            throw e;
          }

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
