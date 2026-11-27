// Cloudflare Worker: 여행 가이드의 "AI로 바로 채우기" 요청을 대신 Claude(Anthropic)에 보내 주는 작은 서버.
// 설정(Cloudflare 대시보드 → Worker → Settings → Variables and secrets):
//   Secret   ANTHROPIC_KEY    : console.anthropic.com 에서 만든 API 키(sk-ant-...)
//   Variable ALLOWED_ORIGINS  : 가이드 사이트 주소(쉼표로 여러 개), 예) https://아이디.github.io
//   Variable DAILY_LIMIT      : (선택) 사람(IP) 한 명당 하루 최대 횟수, 기본 20
//   Variable MODEL            : (선택) 기본 claude-haiku-5-5
//   Secret   GOOGLE_KEY       : (구글 장소 검색·사진용) Google Cloud 에서 만든 키. Places API (New) 만 허용하도록 제한해 두세요.
//   Variable GOOGLE_DAILY_LIMIT : (선택) 사람(IP) 한 명당 하루 최대 구글 요청 수, 기본 300 (사진은 GOOGLE_PHOTO_LIMIT, 기본 600)
//   Variable CAP_SEARCH / CAP_AUTOCOMPLETE / CAP_DETAILS / CAP_RICH / CAP_PHOTO : (선택) 월 최대 횟수. 기본은 구글 월 무료 사용량의 90%
//   KV 연결 USAGE             : (선택) 월 사용량을 서버가 기억하게 하는 저장소. 없으면 서버가 쉬었다 깨어날 때 횟수가 초기화될 수 있어요
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


// ---------- 구글 장소 중계 (Places API New). 키는 서버에만 있고, 페이지는 이 서버에만 요청해요 ----------
const GBASE = "https://places.googleapis.com/v1";
const ID_RE = /^[A-Za-z0-9_-]{10,200}$/, PHOTO_RE = /^places\/[A-Za-z0-9_-]{10,200}\/photos\/[A-Za-z0-9_-]{10,500}$/;
function gkey(env) {
  if (env.GOOGLE_KEY) return env.GOOGLE_KEY;
  for (const k of Object.keys(env)) { const n = String(k).trim().toUpperCase().replace(/[\s-]+/g, "_"); if ((n === "GOOGLE_KEY" || n === "GOOGLE_MAPS_KEY" || n === "GOOGLE_API_KEY") && typeof env[k] === "string") return env[k]; }
  return "";
}
function overLimit(env, ip, kind) {
  const day = new Date().toISOString().slice(0, 10), hk = kind + "|" + day + "|" + ip;
  const lim = parseInt(kind === "gp" ? (env.GOOGLE_PHOTO_LIMIT || "600") : (env.GOOGLE_DAILY_LIMIT || "300"), 10) || 300;
  if ((hits.get(hk) || 0) >= lim) return true;
  if (hits.size > 5000) hits.clear();
  hits.set(hk, (hits.get(hk) || 0) + 1); return false;
}
// ---------- 구글 월 무료 사용량 지키기 ----------
// 구글의 월 무료 사용량(검색 5천, 자동완성 1만, 상세 5천, 평점·시간 포함 상세 1천, 사진 1천)의 90%까지만 쓰고 멈춰요.
// 하루에는 한 달 평균의 3배까지만 쓰게 해서, 하루에 한 달치를 다 쓰는 일을 막아요.
const FREE_CAP = { search: 4500, autocomplete: 9000, details: 4500, rich: 900, photo: 900 };
const memUse = {};
function capOf(env, sku) { const v = parseInt(env["CAP_" + sku.toUpperCase()], 10); return v >= 0 ? v : FREE_CAP[sku]; }
async function loadUse(env, month) {
  let st = null;
  if (env.USAGE) { try { st = await env.USAGE.get("u|" + month, "json"); } catch (e) {} }
  return st || memUse[month] || { m: {}, day: "", d: {} };
}
// 허용되면 null, 막히면 안내 문구를 돌려줘요 (허용될 때 횟수를 1 올려요).
async function useQuota(env, sku) {
  const now = new Date(), month = now.toISOString().slice(0, 7), day = now.toISOString().slice(0, 10);
  const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const cap = capOf(env, sku), dayCap = Math.max(1, Math.ceil(cap / dim * 3));
  const st = await loadUse(env, month);
  if (st.day !== day) { st.day = day; st.d = {}; }
  if ((st.m[sku] || 0) >= cap) return "이번 달 구글 무료 사용량을 다 썼어요. 다음 달에 다시 쓸 수 있어요.";
  if ((st.d[sku] || 0) >= dayCap) return "오늘 구글 무료 사용량을 다 썼어요. 내일 다시 해 주세요.";
  st.m[sku] = (st.m[sku] || 0) + 1; st.d[sku] = (st.d[sku] || 0) + 1;
  memUse[month] = st;
  if (env.USAGE) { try { await env.USAGE.put("u|" + month, JSON.stringify(st), { expirationTtl: 3456000 }); } catch (e) {} }
  return null;
}
async function usageReport(env) {
  const month = new Date().toISOString().slice(0, 7), st = await loadUse(env, month), out = {};
  for (const k of Object.keys(FREE_CAP)) out[k] = { used: st.m[k] || 0, cap: capOf(env, k) };
  return { month, kv: !!env.USAGE, usage: out };
}
async function gfetch(url, key, mask, body) {
  try {
    const h = { "x-goog-api-key": key, "x-goog-fieldmask": mask };
    if (body) h["content-type"] = "application/json";
    const r = await fetch(url, { method: body ? "POST" : "GET", headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, j };
  } catch (e) { return { ok: false, status: 504, j: null }; }
}
function gwhy(r) {
  const m = r.j && r.j.error && r.j.error.message ? String(r.j.error.message).slice(0, 140) : "";
  if (r.status === 403 || r.status === 401) return "구글 키 설정을 확인해 주세요 (Places API (New) 사용 설정, 결제 등록, 키 제한). " + m;
  if (r.status === 429) return "구글 요청이 몰렸어요. 잠시 뒤에 다시 해 주세요.";
  if (r.status === 504) return "구글 응답이 늦어요. 잠시 뒤에 다시 해 주세요.";
  return "구글 오류 (" + r.status + ")" + (m ? ": " + m : "");
}
const llOf = p => p && p.location && isFinite(p.location.latitude) ? [Math.round(p.location.latitude * 1e6) / 1e6, Math.round(p.location.longitude * 1e6) / 1e6] : null;
const bias = b => (b && isFinite(b.lat) && isFinite(b.lng)) ? { circle: { center: { latitude: +b.lat, longitude: +b.lng }, radius: Math.min(50000, Math.max(500, +b.radius || 20000)) } } : undefined;
const clip = (s, n) => String(s || "").slice(0, n);
async function google(op, body, env) {
  const key = gkey(env); if (!key) return { status: 500, out: { error: "서버에 구글 키(GOOGLE_KEY)가 설정되지 않았어요." } };
  if (op === "search") {
    const q = clip(body.q, 160); if (!q) return { status: 400, out: { error: "검색어가 비었어요." } };
    const qe = await useQuota(env, "search"); if (qe) return { status: 429, out: { error: qe } };
    const req = { textQuery: q, languageCode: "ko", maxResultCount: Math.min(10, Math.max(1, parseInt(body.n, 10) || 5)) };
    const lb = bias(body.bias); if (lb) req.locationBias = lb;
    const r = await gfetch(GBASE + "/places:searchText", key, "places.id,places.displayName,places.formattedAddress,places.location,places.types", req);
    if (!r.ok) return { status: 502, out: { error: gwhy(r) } };
    return { status: 200, out: { places: ((r.j && r.j.places) || []).map(p => ({ id: p.id, name: (p.displayName && p.displayName.text) || "", address: p.formattedAddress || "", ll: llOf(p), types: (p.types || []).slice(0, 4) })) } };
  }
  if (op === "autocomplete") {
    const input = clip(body.input, 120); if (input.length < 2) return { status: 200, out: { items: [] } };
    const qe = await useQuota(env, "autocomplete"); if (qe) return { status: 429, out: { error: qe } };
    const req = { input, languageCode: "ko" }; const lb = bias(body.bias); if (lb) req.locationBias = lb;
    if (typeof body.session === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(body.session)) req.sessionToken = body.session;
    const r = await gfetch(GBASE + "/places:autocomplete", key, "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat", req);
    if (!r.ok) return { status: 502, out: { error: gwhy(r) } };
    return { status: 200, out: { items: ((r.j && r.j.suggestions) || []).filter(x => x.placePrediction).slice(0, 6).map(x => { const pp = x.placePrediction, sf = pp.structuredFormat || {}; return { id: pp.placeId, name: (sf.mainText && sf.mainText.text) || "", sub: (sf.secondaryText && sf.secondaryText.text) || "" }; }) } };
  }
  if (op === "details") {
    const id = String(body.id || ""); if (!ID_RE.test(id)) return { status: 400, out: { error: "장소 ID가 올바르지 않아요." } };
    const rich = !!body.rich;
    const qe = await useQuota(env, rich ? "rich" : "details"); if (qe) return { status: 429, out: { error: qe } };
    const mask = "id,displayName,formattedAddress,location,googleMapsUri" + (rich ? ",rating,userRatingCount,regularOpeningHours.weekdayDescriptions,photos.name,photos.authorAttributions" : "");
    const r = await gfetch(GBASE + "/places/" + id + "?languageCode=ko", key, mask);
    if (!r.ok) return { status: 502, out: { error: gwhy(r) } };
    const p = r.j || {};
    return { status: 200, out: { id: p.id || id, name: (p.displayName && p.displayName.text) || "", address: p.formattedAddress || "", ll: llOf(p), url: p.googleMapsUri || "",
      rating: p.rating || null, reviews: p.userRatingCount || null, hours: (p.regularOpeningHours && p.regularOpeningHours.weekdayDescriptions) || null,
      photos: (p.photos || []).slice(0, 3).map(ph => ({ name: ph.name, by: ((ph.authorAttributions || [])[0] || {}).displayName || "" })) } };
  }
  return { status: 400, out: { error: "알 수 없는 요청이에요." } };
}
// 사진: <img src=".../?photo=places/…/photos/…&w=400"> 로 쓰면 키 없이 구글 사진 주소로 넘겨 줘요.
async function gphoto(url, env, hdr, ip) {
  const name = url.searchParams.get("photo") || "", w = Math.min(1200, Math.max(80, parseInt(url.searchParams.get("w"), 10) || 400));
  if (!PHOTO_RE.test(name)) return new Response("bad photo", { status: 400, headers: hdr });
  const key = gkey(env); if (!key) return new Response("no key", { status: 500, headers: hdr });
  if (overLimit(env, ip, "gp")) return new Response("limit", { status: 429, headers: hdr });
  if (await useQuota(env, "photo")) return new Response("monthly limit", { status: 429, headers: hdr });
  try {
    const r = await fetch(GBASE + "/" + name + "/media?maxWidthPx=" + w + "&skipHttpRedirect=true", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.photoUri) return new Response("photo error " + r.status, { status: 502, headers: hdr });
    return new Response(null, { status: 302, headers: { ...hdr, location: j.photoUri, "cache-control": "private, max-age=3600" } });
  } catch (e) { return new Response("timeout", { status: 504, headers: hdr }); }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const c = cors(env, origin);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c.headers });
    if (req.method === "GET") {
      const u0 = new URL(req.url);
      if (u0.searchParams.has("photo")) { // 구글 사진은 허용된 사이트에서만
        const ref = req.headers.get("Referer") || ""; let ro = ""; try { ro = ref ? new URL(ref).origin : ""; } catch (e) {}
        if (ro && !cors(env, ro).ok) return new Response("forbidden", { status: 403 });
        return gphoto(u0, env, { "access-control-allow-origin": "*" }, req.headers.get("CF-Connecting-IP") || "?");
      }
      if (u0.searchParams.has("usage")) return json(await usageReport(env), 200, c.headers); // 이번 달 구글 사용량 확인
      if (u0.searchParams.has("gtest")) { // 점검: 구글 키가 있는지, 장소 검색이 되는지 (키 값은 보여 주지 않아요)
        const gk = gkey(env); if (!gk) return json({ ok: false, error: "GOOGLE_KEY 없음" }, 200, c.headers);
        const g = await google("search", { q: "Sagrada Familia Barcelona", n: 1 }, env);
        return json({ ok: g.status === 200, status: g.status, first: g.out.places ? g.out.places[0] : null, error: g.out.error || "" }, 200, c.headers);
      }
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
    let body; try { body = await req.json(); } catch (e) { return json({ error: "요청을 읽지 못했어요." }, 400, c.headers); }
    if (body && typeof body.op === "string") { // 구글 장소 검색·상세·자동완성
      const ip0 = req.headers.get("CF-Connecting-IP") || "?";
      if (overLimit(env, ip0, "g")) return json({ error: "오늘 구글 검색 횟수를 넘었어요." }, 429, c.headers);
      const g = await google(body.op, body, env);
      return json(g.out, g.status, c.headers);
    }
    const key = findKey(env);
    if (!key) return json({ error: "서버에 AI 키가 설정되지 않았어요. (설정된 이름: " + Object.keys(env).join(", ") + ")" }, 500, c.headers);
    env = { ...env, ANTHROPIC_KEY: key };

    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const day = new Date().toISOString().slice(0, 10), hk = day + "|" + ip, limit = parseInt(env.DAILY_LIMIT || "20", 10) || 20;
    if ((hits.get(hk) || 0) >= limit) return json({ error: "오늘 사용 횟수를 넘었어요." }, 429, c.headers);
    if (hits.size > 5000) hits.clear();

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
