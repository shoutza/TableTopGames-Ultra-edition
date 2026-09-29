import { z } from 'zod';

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  TTG_CONTESTANT_PROVIDER: z.enum(['auto', 'openai', 'mock', 'offline']).default('auto'),
  TTG_CONTESTANT_MODEL: z.string().default('gpt-6-luna'),
  TTG_CONTESTANT_REASONING_EFFORT: z.string().optional(),
  TTG_AUTHORING_MODEL: z.string().optional(),
  TTG_PORT: z.coerce.number().int().min(1).max(65535).default(5173),
  TTG_DATA_DIR: z.string().default('data'),
});

export interface ServerConfig {
  openaiApiKey: string | null;
  /** auto = OpenAI when a key is set, otherwise the offline controller. mock = scripted offline provider. */
  contestantProvider: 'auto' | 'openai' | 'mock' | 'offline';
  contestantModel: string;
  contestantReasoningEffort: string | null;
  authoringModel: string | null;
  port: number;
  dataDir: string;
}

/** Reads configuration from the environment. Empty strings count as unset. */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('TTG_') || key === 'OPENAI_API_KEY') {
      if (value !== undefined && value.trim() !== '') cleaned[key] = value.trim();
    }
  }
  const parsed = EnvSchema.parse(cleaned);
  return {
    openaiApiKey: parsed.OPENAI_API_KEY ?? null,
    contestantProvider: parsed.TTG_CONTESTANT_PROVIDER,
    contestantModel: parsed.TTG_CONTESTANT_MODEL,
    contestantReasoningEffort: parsed.TTG_CONTESTANT_REASONING_EFFORT ?? null,
    authoringModel: parsed.TTG_AUTHORING_MODEL ?? null,
    port: parsed.TTG_PORT,
    dataDir: parsed.TTG_DATA_DIR,
  };
}
