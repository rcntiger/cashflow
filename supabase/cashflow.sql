-- 캐시플로우(가계 자산 장부) 테이블 + 보안 규칙
-- Supabase(personal-apps) → SQL Editor 에 붙여넣고, 아래 이메일 두 개만 바꿔 Run (한 번만)
-- 허용된 이메일끼리 같은 가계 장부(household = 'home')를 함께 읽고 씀
-- 사람을 추가·삭제할 때는 cf_allowed() 의 목록만 고쳐 이 부분만 다시 실행하면 됨

create or replace function public.cf_allowed() returns boolean
language sql stable as $$
  select lower(coalesce(auth.jwt()->>'email', '')) = any (array[
    '본인_이메일',     -- 본인 (리밸런서 로그인 이메일과 같게)
    '아내_이메일'      -- 아내
  ]);
$$;

-- 1) 장부 본문: 가계당 한 줄 (자산·부채·소득·일정·설정·체크리스트를 JSON 으로)
create table if not exists public.cashflow_data (
  household   text primary key default 'home',
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- 2) 월별 스냅샷: 매달 순자산 기록 (같은 달은 덮어씀)
create table if not exists public.cashflow_snapshots (
  household   text not null default 'home',
  month       text not null,               -- 'YYYY-MM'
  net_worth   numeric not null,            -- 만원
  total_assets numeric,
  total_debts numeric,
  breakdown   jsonb,                       -- 자산군별 합계 (만원)
  created_at  timestamptz not null default now(),
  created_by  text,
  primary key (household, month)
);

alter table public.cashflow_data      enable row level security;
alter table public.cashflow_snapshots enable row level security;

drop policy if exists "cf_data_shared" on public.cashflow_data;
create policy "cf_data_shared" on public.cashflow_data
  for all to authenticated
  using (public.cf_allowed())
  with check (public.cf_allowed());

drop policy if exists "cf_snap_shared" on public.cashflow_snapshots;
create policy "cf_snap_shared" on public.cashflow_snapshots
  for all to authenticated
  using (public.cf_allowed())
  with check (public.cf_allowed());
