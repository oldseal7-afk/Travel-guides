// Cloudflare Worker: 여행 가이드의 "AI로 바로 채우기" 요청을 대신 Gemini에 보내 주는 작은 서버.
// 설정(Cloudflare 대시보드 → Worker → Settings):
//   Secret   GEMINI_KEY       : aistudio.google.com/apikey 에서 만든 키(AIza...)
//   Variable ALLOWED_ORIGINS  : 가이드 사이트 주소(쉼표로 여러 개), 예) https://아이디.github.io
//   Variable DAILY_LIMIT      : (선택) 사람(IP) 한 명당 하루 최대 횟수, 기본 20
//   Variable MODEL            : (선택) 기본 gemini-2.5-flash
const MAX_PROMPT = 12000;
// 이름에 공백이나 대소문자 실수가 있어도 GEMINI_KEY를 찾아요.
function findKey(env) {
  if (env.GEMINI_KEY) return env.GEMINI_KEY;
  for (const k of Object.keys(env)) { if (String(k).trim().toUpperCase().replace(/[\s-]+/g, "_") === "GEMINI_KEY" && typeof env[k] === "string") return env[k]; }
  return "";
}
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

let modelCache = { at: 0, list: [] };
async function pickModels(env) {
  const now = Date.now();
  if (modelCache.list.length && now - modelCache.at < 3600e3) return modelCache.list;
  const fallback = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": env.GEMINI_KEY } });
    if (!r.ok) return fallback;
    const j = await r.json();
    const ver = n => { const m = String(n).match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
    const bad = /lite|preview|exp|image|tts|audio|live|embed|thinking|vision|robotics|computer|customtools|\d{4}-\d{2}-\d{2}|-\d{3}$/i;
    const names = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => String(m.name || "").replace(/^models\//, ""));
    const flash = names.filter(n => /^gemini-/.test(n) && /flash/.test(n) && !bad.test(n)).sort((a, b) => ver(b) - ver(a) || a.length - b.length);
    const lite = names.filter(n => /^gemini-/.test(n) && /flash-lite/.test(n) && !/preview|exp/.test(n)).sort((a, b) => ver(b) - ver(a));
    const list = [...flash, ...lite];
    if (!list.length) return fallback;
    modelCache = { at: now, list };
    return list;
  } catch (e) { return fallback; }
}
async function ask(env, model, prompt, vertex) {
  try { return await ask0(env, model, prompt, vertex); } catch (e) { return new Response("{}", { status: 504 }); }
}
// 생각(thinking)을 줄이면 답이 훨씬 빨라져요. 모델이 지원하지 않으면 400이 오고, 그때는 설정 없이 다시 보내요.
function thinkingFor(model) {
  if (/gemini-3/.test(model)) return { thinkingLevel: "low" };
  if (/gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  return null;
}
async function ask0(env, model, prompt, vertex, noThink) {
  const base = vertex ? "https://aiplatform.googleapis.com/v1/publishers/google/models/" : "https://generativelanguage.googleapis.com/v1beta/models/";
  const th = noThink ? null : thinkingFor(model);
  const generationConfig = { maxOutputTokens: 4096 };
  if (th) generationConfig.thinkingConfig = th;
  const r = await fetch(base + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    signal: AbortSignal.timeout(22000),
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig }),
  });
  if (r.status === 400 && th) return ask0(env, model, prompt, vertex, true);
  return r;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const c = cors(env, origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c.headers });
    if (req.method === "GET" && new URL(req.url).searchParams.has("test")) { // 속도 점검: 짧은 질문을 보내고 모델별 결과와 걸린 시간을 알려 줘요.
      if (!findKey(env)) return json({ ok: false, error: "키 없음" }, 200, c.headers);
      env = { ...env, GEMINI_KEY: findKey(env) };
      const out = []; const cands = env.MODEL ? [env.MODEL] : await pickModels(env);
      for (const model of cands.slice(0, 3)) {
        const t0 = Date.now(); const r = await ask(env, model, "안녕이라고만 답해 줘.", String(env.GEMINI_KEY).startsWith("AQ.") && false);
        let m = ""; try { const j = await r.json(); m = (j.error && j.error.message ? String(j.error.message) : (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(x => x.text || "").join("")).slice(0, 80); } catch (e) {}
        out.push({ model, status: r.status, ms: Date.now() - t0, note: m }); if (r.ok) break;
      }
      return json({ ok: true, attempts: out }, 200, c.headers);
    }
    if (req.method === "GET") { // 상태 확인용: 값은 보여 주지 않고, 키가 있는지와 설정 이름만 알려 줘요.
      return json({ ok: true, hasGeminiKey: !!findKey(env), bindingNames: Object.keys(env), model: env.MODEL || "gemini-2.5-flash" }, 200, { ...c.headers });
    }
    if (req.method !== "POST") return json({ error: "POST만 받아요." }, 405, c.headers);
    if (!c.ok) return json({ error: "허용되지 않은 사이트예요." }, 403, c.headers);
    if (!findKey(env)) return json({ error: "서버에 AI 키가 설정되지 않았어요. (설정된 이름: " + Object.keys(env).join(", ") + ")" }, 500, c.headers);
    env = { ...env, GEMINI_KEY: findKey(env) };

    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const day = new Date().toISOString().slice(0, 10), key = day + "|" + ip, limit = parseInt(env.DAILY_LIMIT || "20", 10) || 20;
    if ((hits.get(key) || 0) >= limit) return json({ error: "오늘 사용 횟수를 넘었어요." }, 429, c.headers);
    if (hits.size > 5000) hits.clear();

    let body; try { body = await req.json(); } catch (e) { return json({ error: "요청을 읽지 못했어요." }, 400, c.headers); }
    const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt || prompt.length > MAX_PROMPT) return json({ error: "요청문이 비었거나 너무 길어요." }, 400, c.headers);
    hits.set(key, (hits.get(key) || 0) + 1);

    // 모델 이름은 Google이 자주 바꿔서, 지금 쓸 수 있는 모델 목록에서 알아서 골라요. (환경 변수 MODEL로 직접 정할 수도 있어요)
    const maybeVertex = String(env.GEMINI_KEY).startsWith("AQ.");
    let vertex = false;
    const cands = env.MODEL ? [env.MODEL] : await pickModels(env);
    let r = null;
    for (const model of cands.slice(0, 3)) {
      r = await ask(env, model, prompt, vertex);
      if (r.status === 503) { await new Promise(res => setTimeout(res, 800)); r = await ask(env, model, prompt, vertex); } // 과부하면 한 번 더
      if (!r.ok && maybeVertex && !vertex && (r.status === 400 || r.status === 401 || r.status === 403)) {
        const r2 = await ask(env, model, prompt, true);
        if (r2.ok || r2.status === 429) { r = r2; vertex = true; }
      }
      if (r.ok || ![400, 404, 429, 500, 503, 504].includes(r.status)) break; // 모델 문제나 일시적 과부하일 때만 다음 모델로 넘어가요
    }
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
