import * as responses from '../server/responses';
import {Handler} from './Handler';
import {Context} from './IHandler';
import {Game} from '../Game';
import {Player} from '../Player';
import {buildAiRequestState} from '../ai/stateMapping';
import {AiClient} from '../ai/AiClient';
import {InputError} from '../inputs/InputError';
import {statusCode} from '../../common/http/statusCode';
import {Request} from '../Request';
import {Response} from '../Response';

const _aiClient = new AiClient();

export class ApiAiAdvice extends Handler {
  public static readonly INSTANCE = new ApiAiAdvice();

  public override post(req: Request, res: Response, ctx: Context): Promise<void> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (data: Buffer) => { body += data.toString(); });
      req.once('end', async () => {
        try {
          const {game_id, player_id, user_question} = JSON.parse(body);

          const game = await ctx.gameLoader.getGame(game_id);
          if (game === undefined) {
            responses.notFound(req, res);
            resolve();
            return;
          }

          if (!game.aiTrainerEnabled) {
            res.writeHead(statusCode.badRequest, {'Content-Type': 'application/json'});
            res.write(JSON.stringify({error: 'AI Trainer is not enabled for this game'}));
            res.end();
            resolve();
            return;
          }

          const player = game.getPlayerById(player_id) as Player;
          const state = buildAiRequestState(game as Game, player);
          const waitingFor = player.getWaitingFor();

          const adviceResp = await _aiClient.requestAdvice({
            game_id,
            player_id,
            state: state as Record<string, unknown>,
            legal_actions: [{
              action_id: 'provide_input',
              type: waitingFor?.type ?? 'or',
              title: 'Take action',
              payload: {input: waitingFor?.toModel(player) ?? {}},
            }],
            metadata: {schema_version: 1},
            user_question: user_question ?? undefined,
          });

          responses.writeJson(res, ctx, adviceResp);
        } catch (e) {
          responses.internalServerError(req, res, e);
        }
        resolve();
      });
    });
  }
}

export class ApiAiPlayRecommendation extends Handler {
  public static readonly INSTANCE = new ApiAiPlayRecommendation();

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

          if (!game.aiTrainerEnabled) {
            res.writeHead(statusCode.badRequest, {'Content-Type': 'application/json'});
            res.write(JSON.stringify({error: 'AI Trainer is not enabled for this game'}));
            res.end();
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

          responses.writeJson(res, ctx, {success: true});
        } catch (e) {
          responses.internalServerError(req, res, e);
        }
        resolve();
      });
    });
  }
}
