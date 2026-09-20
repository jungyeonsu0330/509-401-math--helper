/**
 * 수식 변환기 자동 처리 서버 (Cloudflare Workers)
 *
 * 입력(JSON):  { problemImage?: "<JPEG base64>", problemText?: "...", solutionText: "..." , ping?: true }
 * 출력(JSON):  { problem, solution, alternatives, raw }
 *
 * 필요한 설정 (Cloudflare 대시보드 → Workers → Settings → Variables):
 *   ACCESS_CODE   (Secret)  앱에서 입력하는 접근 코드. 모르는 사람이 서버를 못 쓰게 막는다.
 *   AI_KEY        (Secret)  AI 서비스 API 키. 이 서버에만 보관된다.
 *   AI_PROVIDER   (Text)    "gemini" 또는 "claude"   (기본 gemini)
 *   AI_MODEL      (Text)    모델 이름 (기본: gemini-2.5-flash / claude-sonnet-5)
 *   ALLOW_ORIGIN  (Text)    앱 주소. 예: https://jungyeonsu0330.github.io
 */

const MAX_IMAGE_B64 = 3_000_000;   // 약 2.2MB
const MAX_TEXT = 20_000;

const RULES = [
  '형식 규칙:',
  '1. 풀이마다 "### 풀이 1: 제목" 줄로 시작한다.',
  '2. 그 아래에 "1단계.", "2단계."처럼 번호를 붙여 설명한다. 수식은 $...$ 또는 $$...$$ LaTeX로 쓴다. 한 줄에 한 생각만 짧게 쓴다.',
  '3. 설명의 마지막 줄은 "정답: ..." 으로 끝낸다.',
  '4. 정답 아래에 "@graph" 줄을 쓰고, 그 아래에 그림 정보를 한 줄에 하나씩 쓴다. 코드블록 기호는 쓰지 않는다.',
  '   x: 최소 최대 / y: 최소 최대',
  '   f: 식 (함수 그래프. g:, h:도 가능. 곱하기 생략 가능, 거듭제곱 ^, 사용 가능: sqrt() abs() sin() cos() tan() ln() exp() pi)',
  '   point: 이름 x y / segment: x1 y1 x2 y2 / circle: 중심x 중심y 반지름 / polygon: x1 y1; x2 y2; x3 y3',
  '   vline: a (x=a 세로선) / hline: b (y=b 가로선)',
  '5. 좌표와 반지름은 숫자만 쓴다. 분수는 1/2처럼 쓸 수 있다.',
  '6. 서로 다른 접근이어야 한다. (그래프 해석, 도형의 길이·넓이·작도, 대칭·평행이동 등)',
  '7. 보조선처럼 나중에 나오는 요소는 그림 정보 줄 끝에 @2처럼 붙인다. 그 번호의 단계 설명이 나올 때 그림에 나타난다.',
].join('\n');

function buildPrompt(hasImage, problemText, solutionText) {
  return [
    '너는 한국 수학 교사를 돕는 조수다.',
    '입력: ' + [hasImage ? '(1) 문제 이미지' : '', problemText ? '(2) 문제 글' : '', '(3) 다른 AI가 쓴 풀이 글'].filter(Boolean).join(', ') + '.',
    '아래 세 부분을 정확히 이 순서와 표지로 출력해라. 인사말이나 다른 설명은 쓰지 마라.',
    '',
    '=====문제=====',
    '문제를 그대로 옮겨 적는다. 수식은 LaTeX($...$, 따로 쓰는 식은 $$...$$). 도형이 있으면 점 이름과 주어진 길이·각을 한 줄로 덧붙인다. 요약하거나 풀지 않는다.',
    '',
    '=====풀이=====',
    '(3)의 풀이를 다시 정리한다. 풀이의 논리와 정답을 바꾸지 않는다.',
    '- "1단계.", "2단계."처럼 번호를 붙이고, 한 줄에 한 생각만 짧게 쓴다. 수식은 LaTeX.',
    '- 마지막 줄은 "정답: ..." 으로 끝낸다.',
    '- 계산 실수나 논리 비약이 보이면 고치지 말고 그 단계 끝에 "※ 확인 필요: 이유"를 붙인다.',
    '',
    '=====다른풀이=====',
    '이 문제를 그래프·도형 중심으로, 서로 다른 2가지 방법으로 푼다.',
    RULES,
    '',
    problemText ? '[문제 글]\n' + problemText + '\n' : '',
    '[다른 AI의 풀이 글]\n' + solutionText,
  ].filter(x => x !== '').join('\n');
}

function parseSections(raw) {
  const grab = (name, next) => {
    const re = new RegExp('=====' + name + '=====\\s*([\\s\\S]*?)(?=\\n?=====(?:' + next + ')=====|$)');
    const m = raw.match(re); return m ? m[1].trim() : '';
  };
  return { problem: grab('문제', '풀이|다른풀이'), solution: grab('풀이', '문제|다른풀이'), alternatives: grab('다른풀이', '문제|풀이') };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function callAI(env, prompt, imageB64) {
  const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
  if (provider === 'claude') {
    const model = env.AI_MODEL || 'claude-sonnet-5';
    const content = [];
    if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } });
    content.push({ type: 'text', text: prompt });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.AI_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: 'user', content }] }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error('AI ' + res.status + ' ' + ((data && data.error && data.error.message) || ''));
    return (data.content || []).map(p => p.text || '').join('');
  }
  const model = env.AI_MODEL || 'gemini-2.5-flash';
  const parts = [{ text: prompt }];
  if (imageB64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageB64 } });
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.AI_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2 } }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('AI ' + res.status + ' ' + ((data && data.error && data.error.message) || ''));
  return ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p => p.text || '').join('');
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || origin || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
      'Vary': 'Origin',
    };
    const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return out({ error: 'POST만 받습니다.' }, 405);
    if (env.ALLOW_ORIGIN && origin !== env.ALLOW_ORIGIN) return out({ error: '허용되지 않은 주소에서 왔습니다.' }, 403);
    if (!env.ACCESS_CODE || !env.AI_KEY) return out({ error: '서버 설정이 끝나지 않았습니다. (ACCESS_CODE, AI_KEY)' }, 500);
    if (!timingSafeEqual(req.headers.get('X-Access-Code') || '', env.ACCESS_CODE)) return out({ error: '접근 코드가 올바르지 않습니다.' }, 401);

    let body; try { body = await req.json(); } catch (e) { return out({ error: 'JSON 형식이 아닙니다.' }, 400); }
    if (body.ping) return out({ ok: true, provider: (env.AI_PROVIDER || 'gemini') });

    const image = typeof body.problemImage === 'string' ? body.problemImage.replace(/^data:image\/\w+;base64,/, '') : '';
    const problemText = String(body.problemText || '').slice(0, MAX_TEXT).trim();
    const solutionText = String(body.solutionText || '').slice(0, MAX_TEXT).trim();
    if (image.length > MAX_IMAGE_B64) return out({ error: '이미지가 너무 큽니다. 더 작게 줄여 보내 주세요.' }, 413);
    if (!solutionText) return out({ error: '풀이 글이 비어 있습니다.' }, 400);
    if (!image && !problemText) return out({ error: '문제 이미지나 문제 글이 필요합니다.' }, 400);

    try {
      const raw = await callAI(env, buildPrompt(!!image, problemText, solutionText), image || null);
      if (!raw.trim()) return out({ error: 'AI가 빈 답을 보냈습니다. 다시 시도해 주세요.' }, 502);
      return out({ ...parseSections(raw), raw });
    } catch (e) {
      return out({ error: 'AI 호출에 실패했습니다: ' + String(e.message).slice(0, 200) }, 502);
    }
  },
};
