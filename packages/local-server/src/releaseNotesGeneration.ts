import type { ModelConnectionService } from './modelConnectionService.js';

const releaseNotesModel = 'deepseek-v4-flash';

export interface ReleaseNotesGenerationOutput {
  markdown: string;
  confidence: 'high' | 'medium' | 'low';
  uncertainties: string[];
}

/** 使用 Zeus SecretStore 中的 DeepSeek 连接生成发布说明，API Key 不进入命令环境或响应。 */
export async function generateReleaseNotesWithDeepSeek(modelConnections: ModelConnectionService, input: { model: string; prompt: string }): Promise<{ model: typeof releaseNotesModel; output: ReleaseNotesGenerationOutput }> {
  if (input.model !== releaseNotesModel) {
    throw generationError('ZEUS_RELEASE_NOTES_MODEL_INVALID', `发布说明只允许使用 ${releaseNotesModel}。`, 400);
  }
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 400_000) {
    throw generationError('ZEUS_RELEASE_NOTES_PROMPT_INVALID', '发布说明证据不能为空且不能超过 400,000 字符。', 400);
  }

  const connections = await modelConnections.loadRuntimeConnections();
  const connection = connections.find((candidate) => candidate.enabled && candidate.templateId === 'deepseek' && Boolean(candidate.apiKey) && candidate.models.some((model) => model.enabled && model.id === releaseNotesModel));
  if (!connection?.apiKey) {
    throw generationError('ZEUS_RELEASE_NOTES_MODEL_UNAVAILABLE', `请先在 Zeus 模型连接中启用 DeepSeek ${releaseNotesModel} 并配置 API Key。`, 409);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 80_000);
  try {
    const response = await fetch(new URL('chat/completions', `${connection.baseUrl.replace(/\/+$/u, '')}/`), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${connection.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: releaseNotesModel,
        messages: [
          {
            role: 'system',
            content: '你是 Zeus 发布说明生成器。只根据用户提供的证据生成简体中文 Release notes，并只返回 JSON 对象。JSON 必须包含 markdown、confidence、uncertainties 三个字段。',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        max_tokens: 6_000,
        stream: false,
      }),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const providerMessage = readProviderMessage(payload);
      throw generationError('ZEUS_RELEASE_NOTES_PROVIDER_FAILED', `DeepSeek 发布说明请求失败，HTTP ${response.status}${providerMessage ? `：${providerMessage}` : '。'}`, 502);
    }
    const content = readAssistantContent(payload);
    if (!content) {
      throw generationError('ZEUS_RELEASE_NOTES_RESPONSE_INVALID', 'DeepSeek 没有返回发布说明正文。', 502);
    }
    return { model: releaseNotesModel, output: parseReleaseNotesOutput(content) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw generationError('ZEUS_RELEASE_NOTES_TIMEOUT', 'DeepSeek 发布说明请求在 80 秒内没有完成。', 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseReleaseNotesOutput(content: string): ReleaseNotesGenerationOutput {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw generationError('ZEUS_RELEASE_NOTES_RESPONSE_INVALID', 'DeepSeek 返回的发布说明不是有效 JSON。', 502);
  }
  if (!isRecord(value) || typeof value.markdown !== 'string') {
    throw generationError('ZEUS_RELEASE_NOTES_RESPONSE_INVALID', 'DeepSeek 发布说明缺少 markdown 字段。', 502);
  }
  const confidence = value.confidence;
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
    throw generationError('ZEUS_RELEASE_NOTES_RESPONSE_INVALID', 'DeepSeek 发布说明缺少有效 confidence 字段。', 502);
  }
  if (!Array.isArray(value.uncertainties) || value.uncertainties.some((item) => typeof item !== 'string')) {
    throw generationError('ZEUS_RELEASE_NOTES_RESPONSE_INVALID', 'DeepSeek 发布说明缺少有效 uncertainties 字段。', 502);
  }
  return {
    markdown: value.markdown,
    confidence,
    uncertainties: value.uncertainties.map((item) => String(item).slice(0, 1_000)).slice(0, 20),
  };
}

function readAssistantContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string') return null;
  return first.message.content.trim() || null;
}

function readProviderMessage(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== 'string') return null;
  return value.error.message.slice(0, 1_000);
}

function generationError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
