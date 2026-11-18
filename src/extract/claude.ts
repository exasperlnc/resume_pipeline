import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { SYSTEM_PROMPT, userMessage } from "./prompt.js";
import { ExtractError, ExtractOutput, sanitizeExtract, type Extractor } from "./schema.js";

/** Stage 2 is meant to be the cheap step, so it defaults to Haiku. Override with EXTRACT_MODEL. */
export const DEFAULT_EXTRACT_MODEL = "claude-haiku-5-5";

export interface ClaudeExtractorOptions {
  client?: Anthropic;
  model?: string;
}

export function createClaudeExtractor(opts: ClaudeExtractorOptions = {}): Extractor {
  const client = opts.client ?? new Anthropic({ maxRetries: 4 });
  const model = opts.model ?? process.env.EXTRACT_MODEL ?? DEFAULT_EXTRACT_MODEL;

  return async (input) => {
    let response;
    try {
      response = await client.messages.parse({
        model,
        max_tokens: 8000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userMessage(input) }],
        output_config: { effort: "low", format: zodOutputFormat(ExtractOutput) },
      });
    } catch (err) {
      if (
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError ||
        err instanceof Anthropic.APIConnectionError
      ) {
        throw new ExtractError(`API unavailable: ${err.message}`, true);
      }
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new ExtractError(`API credentials rejected: ${err.message}`, true);
      }
      if (err instanceof Anthropic.APIError) {
        // Something about this one request (e.g. a 400); the next posting may be fine.
        throw new ExtractError(`API error ${err.status ?? ""}: ${err.message}`, false);
      }
      // Missing credentials, bad configuration, or a bug: the rest of the queue would fail too.
      throw new ExtractError(`extract failed: ${(err as Error).message}`, true);
    }

    if (response.stop_reason === "refusal") {
      throw new ExtractError(`model declined (${response.stop_details?.category ?? "no category"})`, false);
    }
    if (response.stop_reason === "max_tokens") {
      throw new ExtractError("output hit max_tokens", false);
    }
    if (!response.parsed_output) {
      throw new ExtractError("no structured output in response", false);
    }
    return { output: sanitizeExtract(response.parsed_output), model: response.model };
  };
}
