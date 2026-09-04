import OpenAI, { AzureOpenAI } from 'openai';
export function makeLLMClient(): { openai: OpenAI; model: string } {
  if (process.env.AZURE_OPENAI_ENDPOINT) {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    if (!deployment || !process.env.AZURE_OPENAI_API_KEY) throw new Error('Azure deployment and API key are required');
    return { openai: new AzureOpenAI({ endpoint: process.env.AZURE_OPENAI_ENDPOINT, apiKey: process.env.AZURE_OPENAI_API_KEY,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21', deployment }), model: deployment };
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('Configure OpenAI or Azure OpenAI credentials');
  return { openai: new OpenAI(), model: process.env.OPENAI_MODEL ?? 'gpt-5.6-luna' };
}
