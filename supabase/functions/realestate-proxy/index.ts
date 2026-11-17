// 캐시플로우 부동산 실거래가 프록시 (Supabase Edge Function)
//
// - 국토교통부 아파트 매매 실거래가 (공공데이터포털 RTMSDataSvcAptTrade) 를 대신 조회
// - OWNER_EMAIL 에 적힌 이메일로 로그인한 사람만 사용 가능 (리밸런서 kis-proxy 와 같은 Secret, 쉼표로 여러 명)
// - 필요한 Secrets: DATA_GO_KR_KEY (공공데이터포털 일반 인증키 — Decoding 키), OWNER_EMAIL
//
// 요청 (POST JSON)
//   { lawd: "41194", apt: "범박힐스테이트", area: 84.9, months: 6, dong?: "범박동" }
//   → { ok, items: [{ date, price(만원), area, floor, apt, dong }], from, to, scanned }
//     area 는 ±1.5㎡ 안의 거래만, 해제(취소)된 거래는 뺌
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

// XML 한 건에서 태그 값 꺼내기 (영문 태그 우선, 예전 한글 태그도 허용)
function tag(xml: string, ...names: string[]): string {
  for (const n of names) {
    const m = xml.match(new RegExp(`<${n}>\\s*([^<]*?)\\s*</${n}>`));
    if (m) return m[1];
  }
  return "";
}
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

async function fetchMonth(key: string, lawd: string, ym: string): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const q = new URLSearchParams({ serviceKey: key, LAWD_CD: lawd, DEAL_YMD: ym, numOfRows: "1000", pageNo: String(page) });
    const r = await fetch(`${API}?${q}`, { signal: AbortSignal.timeout(15000) });
    const txt = await r.text();
    if (!r.ok) throw new Error(`실거래가 API 오류 (${r.status})`);
    const code = tag(txt, "resultCode", "returnReasonCode");
    if (code && !/^0+$/.test(code)) throw new Error(`실거래가 API: ${tag(txt, "resultMsg", "returnAuthMsg") || code}`);
    const items = txt.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    out.push(...items);
    const total = Number(tag(txt, "totalCount") || 0);
    if (out.length >= total || items.length === 0) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ message: "POST only" }, 405);

  // ── 본인 확인 ──
  const auth = req.headers.get("Authorization") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, anon, { global: { headers: { Authorization: auth } } });
  const { data: u } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  const owners = (Deno.env.get("OWNER_EMAIL") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (!u?.user) return json({ message: "로그인이 필요합니다" }, 401);
  if (!owners.includes((u.user.email ?? "").toLowerCase())) return json({ message: "허용되지 않은 사용자입니다" }, 403);

  const key = Deno.env.get("DATA_GO_KR_KEY");
  if (!key) return json({ ok: false, message: "DATA_GO_KR_KEY Secret 이 없습니다" });

  let body: { lawd?: string; apt?: string; area?: number; months?: number; dong?: string };
  try { body = await req.json(); } catch { return json({ ok: false, message: "요청 형식 오류" }, 400); }
  const lawd = String(body.lawd ?? "").trim();
  const apt = norm(String(body.apt ?? ""));
  const dong = norm(String(body.dong ?? ""));
  const area = Number(body.area ?? 0);
  const months = Math.min(24, Math.max(1, Number(body.months ?? 6)));
  if (!/^\d{5}$/.test(lawd)) return json({ ok: false, message: "시군구 코드는 숫자 5자리입니다" });
  if (!apt) return json({ ok: false, message: "단지명을 입력하세요" });

  // 이번 달부터 거꾸로 months 개월
  const now = new Date(Date.now() + 9 * 3600 * 1000);   // 한국 시간
  const yms: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    yms.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  try {
    const raw = (await Promise.all(yms.map((ym) => fetchMonth(key, lawd, ym)))).flat();
    const items = raw.map((x) => {
      const y = tag(x, "dealYear", "년"), m = tag(x, "dealMonth", "월"), d = tag(x, "dealDay", "일");
      return {
        apt: tag(x, "aptNm", "아파트"),
        dong: tag(x, "umdNm", "법정동"),
        area: Number(tag(x, "excluUseAr", "전용면적") || 0),
        floor: tag(x, "floor", "층"),
        price: Number(tag(x, "dealAmount", "거래금액").replace(/[^\d]/g, "") || 0),
        date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        cancelled: /^o$/i.test(tag(x, "cdealType", "해제여부")),
      };
    }).filter((t) =>
      !t.cancelled && t.price > 0 &&
      norm(t.apt).includes(apt) &&
      (!dong || norm(t.dong).includes(dong)) &&
      (!area || Math.abs(t.area - area) <= 1.5)
    ).map(({ cancelled: _c, ...t }) => t)
     .sort((a, b) => b.date.localeCompare(a.date));
    return json({ ok: true, items, from: yms[yms.length - 1], to: yms[0], scanned: raw.length });
  } catch (e) {
    return json({ ok: false, message: (e as Error).message });
  }
});
