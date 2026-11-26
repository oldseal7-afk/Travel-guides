// Cloudflare Worker: 여행 가이드의 "AI로 바로 채우기" 요청을 대신 Gemini에 보내 주는 작은 서버.
// 설정(Cloudflare 대시보드 → Worker → Settings):
//   Secret   GEMINI_KEY       : aistudio.google.com/apikey 에서 만든 키(AIza...)
//   Variable ALLOWED_ORIGINS  : 가이드 사이트 주소(쉼표로 여러 개), 예) https://아이디.github.io
//   Variable DAILY_LIMIT      : (선택) 사람(IP) 한 명당 하루 최대 횟수, 기본 20
//   Variable MODEL            : (선택) 기본 gemini-2.5-flash
const MAX_PROMPT = 12000;
const hits = new Map(); // 같은 서버 인스턴스 안에서만 세는 간단한 횟수 제한

function cors(env, origin) {
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
  const ok = !list.length || list.includes("*") || list.includes(origin);
  return { ok, headers: {
    "access-control-allow-origin": ok ? (origin || "*") : "null",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "Origin",
  } };
}
const json = (o, status, h) => new Response(JSON.stringify(o), { status, headers: { ...h, "content-type": "application/json; charset=utf-8" } });

async function ask(env, model, prompt) {
  return fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 4096 } }),
  });
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const c = cors(env, origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c.headers });
    if (req.method !== "POST") return json({ error: "POST만 받아요." }, 405, c.headers);
    if (!c.ok) return json({ error: "허용되지 않은 사이트예요." }, 403, c.headers);
    if (!env.GEMINI_KEY) return json({ error: "서버에 AI 키가 설정되지 않았어요." }, 500, c.headers);

    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const day = new Date().toISOString().slice(0, 10), key = day + "|" + ip, limit = parseInt(env.DAILY_LIMIT || "20", 10) || 20;
    if ((hits.get(key) || 0) >= limit) return json({ error: "오늘 사용 횟수를 넘었어요." }, 429, c.headers);
    if (hits.size > 5000) hits.clear();

    let body; try { body = await req.json(); } catch (e) { return json({ error: "요청을 읽지 못했어요." }, 400, c.headers); }
    const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt || prompt.length > MAX_PROMPT) return json({ error: "요청문이 비었거나 너무 길어요." }, 400, c.headers);
    hits.set(key, (hits.get(key) || 0) + 1);

    const model = env.MODEL || "gemini-2.5-flash";
    let r = await ask(env, model, prompt);
    if ((r.status === 429 || r.status === 404) && model !== "gemini-2.5-flash-lite") r = await ask(env, "gemini-2.5-flash-lite", prompt);
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const m = j && j.error && j.error.message ? String(j.error.message).slice(0, 120) : "";
      return json({ error: "AI 서비스 오류 (" + r.status + ")" + (m ? ": " + m : "") }, r.status === 429 ? 429 : 502, c.headers);
    }
    const text = (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || "").join("");
    if (!text) return json({ error: "AI가 빈 답을 줬어요." }, 502, c.headers);
    return json({ text }, 200, c.headers);
  },
};
