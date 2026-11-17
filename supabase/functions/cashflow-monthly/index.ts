// 캐시플로우 매월 자동 갱신 (Supabase Edge Function)
//
// 매월 1일 pg_cron 이 호출 (supabase/cashflow_cron.sql) — 앱 ⚙ 설정의 [지금 실행] 으로도 호출 가능
//   1) 부동산: 시군구 코드·단지명이 있는 아파트 → 국토부 실거래가 중간값 (최근 6개월, 없으면 12개월)
//   2) 리밸런서: 허용된 사람들의 리밸런서 최신 기록 → 장부의 계좌 연결(rbMap)대로 자산 금액 반영
//   3) 그 달 순자산 기록 (이미 있으면 그대로 둠)
//
// 호출 권한: 헤더 x-cron-secret = CRON_SECRET, 또는 OWNER_EMAIL 에 있는 사람의 로그인 토큰
// 필요한 Secrets: CRON_SECRET, DATA_GO_KR_KEY, OWNER_EMAIL  (SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY 는 자동 제공)
import { createClient } from "jsr:@supabase/supabase-js@2";

const API = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

// ── 실거래가 ──
function tag(xml: string, ...names: string[]): string {
  for (const n of names) {
    const m = xml.match(new RegExp(`<${n}>\\s*([^<]*?)\\s*</${n}>`));
    if (m) return m[1];
  }
  return "";
}
const norm = (s: string) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

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
    if (out.length >= Number(tag(txt, "totalCount") || 0) || items.length === 0) break;
  }
  return out;
}
function monthsBack(n: number): string[] {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
// deno-lint-ignore no-explicit-any
async function trades(key: string, a: any, months: number) {
  const yms = monthsBack(months);
  const raw = (await Promise.all(yms.map((ym) => fetchMonth(key, a.lawd, ym)))).flat();
  const apt = norm(a.apt), dong = norm(a.dong || ""), area = Number(a.area || 0);
  const prices = raw.filter((x) => {
    if (/^o$/i.test(tag(x, "cdealType", "해제여부"))) return false;
    if (!norm(tag(x, "aptNm", "아파트")).includes(apt)) return false;
    if (dong && !norm(tag(x, "umdNm", "법정동")).includes(dong)) return false;
    return !area || Math.abs(Number(tag(x, "excluUseAr", "전용면적") || 0) - area) <= 1.5;
  }).map((x) => Number(tag(x, "dealAmount", "거래금액").replace(/[^\d]/g, "") || 0)).filter((p) => p > 0).sort((p, q) => p - q);
  return { prices, from: yms[yms.length - 1], to: yms[0] };
}
const median = (p: number[]) => p.length % 2 ? p[(p.length - 1) / 2] : Math.round((p[p.length / 2 - 1] + p[p.length / 2]) / 2);
const dot = (ym: string) => `${ym.slice(0, 4)}.${ym.slice(4)}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ message: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, service);
  const owners = (Deno.env.get("OWNER_EMAIL") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

  // ── 호출 권한 ──
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  let by = "auto";
  if (!(secret && req.headers.get("x-cron-secret") === secret)) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ message: "로그인이 필요합니다" }, 401);
    if (!owners.includes((u.user.email ?? "").toLowerCase())) return json({ message: "허용되지 않은 사용자입니다" }, 403);
    by = "auto (" + u.user.email + " 실행)";
  }

  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const month = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}`;
  const mLabel = `${kst.getUTCMonth() + 1}월`;
  const report = { ok: true, month, realestate: [] as unknown[], rebalancer: [] as unknown[], snapshot: false, errors: [] as string[] };

  const { data: row, error } = await admin.from("cashflow_data").select("data").eq("household", "home").maybeSingle();
  if (error) return json({ ok: false, message: error.message });
  if (!row) return json({ ok: false, message: "장부가 아직 없습니다" });
  const S = row.data;
  S.assets = S.assets ?? [];
  S.debts = S.debts ?? [];

  // 1) 부동산 실거래가
  const key = Deno.env.get("DATA_GO_KR_KEY");
  for (const a of S.assets) {
    if (a.cat !== "realestate" || !/^\d{5}$/.test(a.lawd || "") || !a.apt) continue;
    if (!key) { report.errors.push("DATA_GO_KR_KEY 없음 — 부동산 건너뜀"); break; }
    try {
      let t = await trades(key, a, 6);
      if (!t.prices.length) t = await trades(key, a, 12);
      if (!t.prices.length) { report.realestate.push({ name: a.name, skipped: "최근 12개월 거래 없음" }); continue; }
      const old = Number(a.value || 0), v = median(t.prices);
      a.value = v;
      a.src = `실거래가 적용 (${mLabel})`;
      a.srcDetail = `중간값 ${t.prices.length}건 · ${dot(t.from)}~${dot(t.to)} · 자동`;
      report.realestate.push({ name: a.name, old, value: v, n: t.prices.length });
    } catch (e) {
      report.errors.push(`${a.name}: ${(e as Error).message}`);
    }
  }

  // 2) 리밸런서 (허용된 사람들의 최신 기록을 계좌 이름으로 합침)
  const rbMap: Record<string, string> = S.rbMap ?? {};
  if (Object.values(rbMap).some(Boolean)) {
    const { data: rbs, error: e2 } = await admin.from("rebalancer_data").select("user_id,history");
    if (e2) report.errors.push("리밸런서: " + e2.message);
    const acc: Record<string, { value: number; date: string }> = {};
    for (const r of rbs ?? []) {
      const { data: uu } = await admin.auth.admin.getUserById(r.user_id);
      if (!owners.includes((uu?.user?.email ?? "").toLowerCase())) continue;
      const h = r.history ?? {}, keys = Object.keys(h).sort();
      if (!keys.length) continue;
      const last = keys[keys.length - 1];
      for (const [name, v] of Object.entries(h[last].accounts ?? {})) {
        // deno-lint-ignore no-explicit-any
        acc[name] = { value: Number((v as any).value || 0), date: last };
      }
    }
    const sums: Record<string, { won: number; date: string }> = {};
    for (const [name, id] of Object.entries(rbMap)) {
      if (!id || !acc[name]) continue;
      const s = sums[id] ?? { won: 0, date: acc[name].date };
      s.won += acc[name].value;
      if (acc[name].date < s.date) s.date = acc[name].date;
      sums[id] = s;
    }
    for (const [id, s] of Object.entries(sums)) {
      // deno-lint-ignore no-explicit-any
      const a = S.assets.find((x: any) => x.id === id);
      if (!a) continue;
      const old = Number(a.value || 0), v = Math.round(s.won / 10000);
      a.value = v;
      a.src = `리밸런서 적용 (${Number(s.date.slice(5, 7))}월)`;
      a.srcDetail = `리밸런서 ${s.date} 기록 · 자동`;
      report.rebalancer.push({ name: a.name, old, value: v, date: s.date });
    }
  }

  // 장부 저장
  const now = new Date().toISOString();
  const { error: e3 } = await admin.from("cashflow_data").update({ data: S, updated_at: now, updated_by: by }).eq("household", "home");
  if (e3) return json({ ok: false, message: e3.message, report });

  // 3) 그 달 순자산 기록 (이미 있으면 그대로)
  const byCat: Record<string, number> = {};
  let assets = 0, debts = 0;
  // deno-lint-ignore no-explicit-any
  S.assets.forEach((a: any) => { const v = Number(a.value || 0); assets += v; byCat[a.cat] = (byCat[a.cat] || 0) + v; });
  // deno-lint-ignore no-explicit-any
  S.debts.forEach((d: any) => { debts += Number(d.value || 0); });
  const { data: snap } = await admin.from("cashflow_snapshots").select("month").eq("household", "home").eq("month", month).maybeSingle();
  if (!snap) {
    const { error: e4 } = await admin.from("cashflow_snapshots").insert({
      household: "home", month, net_worth: assets - debts, total_assets: assets, total_debts: debts, breakdown: byCat, created_by: by,
    });
    if (e4) report.errors.push("기록: " + e4.message); else report.snapshot = true;
  }
  return json(report);
});
