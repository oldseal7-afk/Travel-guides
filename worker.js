// Cloudflare Worker: 여행 가이드의 "AI로 바로 채우기" 요청을 대신 Claude(Anthropic)에 보내 주는 작은 서버.
// 설정(Cloudflare 대시보드 → Worker → Settings → Variables and secrets):
//   Secret   ANTHROPIC_KEY    : console.anthropic.com 에서 만든 API 키(sk-ant-...)
//   Variable ALLOWED_ORIGINS  : 가이드 사이트 주소(쉼표로 여러 개), 예) https://아이디.github.io
//   Variable DAILY_LIMIT      : (선택) 사람(IP) 한 명당 하루 최대 횟수, 기본 20
//   Variable MODEL            : (선택) 기본 claude-haiku-5-5
const MAX_PROMPT = 12000;
const DEFAULT_MODEL = "claude-haiku-5-5";
// 이름에 공백이나 대소문자 실수가 있어도 키를 찾아요.
function findKey(env) {
  if (env.ANTHROPIC_KEY) return env.ANTHROPIC_KEY;
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  for (const k of Object.keys(env)) {
    const n = String(k).trim().toUpperCase().replace(/[\s-]+/g, "_");
    if ((n === "ANTHROPIC_KEY" || n === "ANTHROPIC_API_KEY") && typeof env[k] === "string") return env[k];
  }
  return "";
}
const hits = new Map(); // 같은 서버 인스턴스 안에서만 세는 간단한 횟수 제한

function cors(env, origin) {
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
  const ok = !list.length || list.includes("*") || list.includes(origin);
  return { ok, headers: {
    "access-control-allow-origin": ok ? (origin || "*") : "null",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "Origin",
  } };
}
const json = (o, status, h) => new Response(JSON.stringify(o), { status, headers: { ...h, "content-type": "application/json; charset=utf-8" } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Claude에 한 번 물어봐요. 항상 Response를 돌려주고(시간 초과면 504), 던지지 않아요.
async function claude(env, prompt, withEffort) {
  const body = { model: env.MODEL || DEFAULT_MODEL, max_tokens: 4096, messages: [{ role: "user", content: prompt }] };
  if (withEffort) body.output_config = { effort: "low" }; // 생각을 줄여 빠르게
  try {
    return await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(40000),
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
  } catch (e) { return new Response("{}", { status: 504 }); }
}
// 과부하(529)·일시 오류·한도(429)는 잠깐 쉬었다가 한 번 더, 설정이 안 맞으면(400) 설정 없이 다시 보내요.
async function ask(env, prompt) {
  let r = await claude(env, prompt, true);
  if (r.status === 400) { const r2 = await claude(env, prompt, false); if (r2.ok) return r2; }
  if (r.status === 429 || r.status === 529 || r.status === 500 || r.status === 503 || r.status === 504) { await sleep(900); const r3 = await claude(env, prompt, true); if (r3.ok) return r3; r = r3; }
  return r;
}
function why(status, msg) {
  if (status === 401) return "서버의 Claude 키가 맞지 않아요. 키를 다시 확인해 주세요.";
  if (status === 403) return "서버의 Claude 키에 권한이 없어요.";
  if (/credit balance|billing/i.test(msg || "")) return "서버의 Claude 크레딧이 부족해요. 충전이 필요해요.";
  if (status === 429) return "지금 요청이 몰렸어요. 잠시 뒤에 다시 해 주세요.";
  if (status === 529) return "Claude 서비스가 일시적으로 바빠요. 잠시 뒤에 다시 해 주세요.";
  if (status === 504) return "시간이 초과됐어요. 잠시 뒤에 다시 해 주세요.";
  return "AI 서비스 오류 (" + status + ")" + (msg ? ": " + msg : "");
}
const textOf = j => ((j && j.content) || []).filter(b => b && b.type === "text").map(b => b.text || "").join("");

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const c = cors(env, origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c.headers });
    if (req.method === "GET") {
      const key = findKey(env);
      if (new URL(req.url).searchParams.has("test")) { // 점검: 짧은 질문을 보내 상태와 걸린 시간을 알려 줘요.
        if (!key) return json({ ok: false, error: "키 없음" }, 200, c.headers);
        const t0 = Date.now(); const r = await ask({ ...env, ANTHROPIC_KEY: key }, "안녕이라고만 답해 줘.");
        let note = ""; try { const j = await r.json(); note = (j.error && j.error.message ? String(j.error.message) : textOf(j)).slice(0, 80); } catch (e) {}
        return json({ ok: r.ok, model: env.MODEL || DEFAULT_MODEL, status: r.status, ms: Date.now() - t0, note }, 200, c.headers);
      }
      // 상태 확인용: 값은 보여 주지 않고, 키가 있는지와 설정 이름만 알려 줘요.
      return json({ ok: true, hasKey: !!key, bindingNames: Object.keys(env), model: env.MODEL || DEFAULT_MODEL }, 200, c.headers);
    }
    if (req.method !== "POST") return json({ error: "POST만 받아요." }, 405, c.headers);
    if (!c.ok) return json({ error: "허용되지 않은 사이트예요." }, 403, c.headers);
    const key = findKey(env);
    if (!key) return json({ error: "서버에 AI 키가 설정되지 않았어요. (설정된 이름: " + Object.keys(env).join(", ") + ")" }, 500, c.headers);
    env = { ...env, ANTHROPIC_KEY: key };

    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const day = new Date().toISOString().slice(0, 10), hk = day + "|" + ip, limit = parseInt(env.DAILY_LIMIT || "20", 10) || 20;
    if ((hits.get(hk) || 0) >= limit) return json({ error: "오늘 사용 횟수를 넘었어요." }, 429, c.headers);
    if (hits.size > 5000) hits.clear();

    let body; try { body = await req.json(); } catch (e) { return json({ error: "요청을 읽지 못했어요." }, 400, c.headers); }
    const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt || prompt.length > MAX_PROMPT) return json({ error: "요청문이 비었거나 너무 길어요." }, 400, c.headers);
    hits.set(hk, (hits.get(hk) || 0) + 1);

    const r = await ask(env, prompt);
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const m = j && j.error && j.error.message ? String(j.error.message).slice(0, 120) : "";
      return json({ error: why(r.status, m) }, r.status === 429 ? 429 : 502, c.headers);
    }
    if (j && j.stop_reason === "refusal") return json({ error: "AI가 이 요청에는 답하지 않았어요. 내용을 바꿔서 다시 해 주세요." }, 502, c.headers);
    const text = textOf(j);
    if (!text) return json({ error: "AI가 빈 답을 줬어요." }, 502, c.headers);
    return json({ text }, 200, c.headers);
  },
};
