import type { AgentConfigFile, ModelConfig } from '../core/config.js';
import type { LLMClient } from '../core/types.js';
import { createAnthropicLLM } from './anthropic.js';
import { createOpenAILLM } from './openai.js';
import { createOpenAIResponsesLLM } from './openai-responses.js';

export { AnthropicLLM, compileContextForAnthropic, createAnthropicLLM } from './anthropic.js';
export { OpenAILLM, createOpenAILLM } from './openai.js';
export { OpenAIResponsesLLM, compileContextForOpenAIResponses, createOpenAIResponsesLLM } from './openai-responses.js';
export { DEFAULT_MAX_RETRIES, getRetryDelay, parseRetryAfter, shouldRetry, sleep as retrySleep } from './retry.js';
export { ClassifiedAPIError, classifyAPIError, classifyAndWrapError, extractConnectionErrorDetails, getUserFriendlyMessage } from './api-errors.js';
export type { APIErrorType, ConnectionErrorDetails } from './api-errors.js';
export { initHttpClient, getGlobalDispatcher } from './http-client.js';

export function createLLM(config: AgentConfigFile): LLMClient;
export function createLLM(modelConfig: ModelConfig): LLMClient;
export function createLLM(
  apiKey: string,
  modelName: string,
  provider?: string,
  baseUrl?: string,
): LLMClient;
export function createLLM(
  configOrApiKey: AgentConfigFile | ModelConfig | string,
  modelName?: string,
  provider?: string,
  baseUrl?: string,
): LLMClient {
  if (typeof configOrApiKey === 'string') {
    return provider === 'anthropic'
      ? createAnthropicLLM(configOrApiKey, modelName!, baseUrl)
      : createOpenAILLM(configOrApiKey, modelName!, baseUrl);
  }

  if ('defaultModel' in configOrApiKey) {
    switch (configOrApiKey.defaultModel.provider) {
      case 'anthropic':
        return createAnthropicLLM(configOrApiKey);
      case 'openai':
        return configOrApiKey.defaultModel.apiSurface === 'responses'
          ? createOpenAIResponsesLLM(configOrApiKey)
          : createOpenAILLM(configOrApiKey);
      default:
        return createOpenAILLM(configOrApiKey);
    }
  }

  switch (configOrApiKey.provider) {
    case 'anthropic':
      return createAnthropicLLM(configOrApiKey);
    case 'openai':
      return configOrApiKey.apiSurface === 'responses'
        ? createOpenAIResponsesLLM(configOrApiKey)
        : createOpenAILLM(configOrApiKey);
    default:
      return createOpenAILLM(configOrApiKey);
  }
}
