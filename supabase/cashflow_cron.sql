-- 캐시플로우 매월 1일 자동 갱신 예약 (pg_cron)
-- Supabase(personal-apps) → SQL Editor 에 붙여넣고, 'CRON_SECRET_값' 을 Edge Function Secret 에 넣은 값과 똑같이 바꿔 Run (한 번만)
-- 실행 시각: 매월 1일 00:00 UTC = 한국 시간 오전 9시
-- 확인: select * from cron.job;   실행 기록: select * from cron.job_run_details order by start_time desc limit 5;
-- 끄기: select cron.unschedule('cashflow-monthly');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('cashflow-monthly') where exists (select 1 from cron.job where jobname = 'cashflow-monthly');

select cron.schedule('cashflow-monthly', '0 0 1 * *', $$
  select net.http_post(
    url := 'https://rcwneqlwzfplvrihvzyu.supabase.co/functions/v1/cashflow-monthly',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjd25lcWx3emZwbHZyaWh2enl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyNjg4ODAsImV4cCI6MjEwNjg0NDg4MH0.StdImJfoPxzTQ2-Ys2_U9BG8mf71n1NVfMr8WKVa8zI',
      'x-cron-secret', 'CRON_SECRET_값'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
