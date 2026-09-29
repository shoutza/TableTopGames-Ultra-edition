/** Wire types shared by the server and the web client. */
export interface HealthResponse {
  ok: true;
  engineVersion: string;
  rulesLanguageVersion: number;
  contestantProvider: 'openai' | 'offline';
  contestantModel: string;
}
