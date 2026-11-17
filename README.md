# 캐시플로우

부부가 함께 쓰는 가계 자산 장부 웹앱입니다. 부동산·주식·연금계좌·공제회·현금을 기록하고, 월 소득과 목돈 일정으로 현금흐름과 은퇴 후 금융자산을 시뮬레이션합니다.

- 실행: https://rcntiger.github.io/cashflow/
- 폰에서는 브라우저 메뉴의 **홈 화면에 추가**로 앱처럼 설치할 수 있습니다.
- 금액 단위는 **만원**, 시뮬레이션은 물가를 뺀 **실질** 기준입니다.

## 화면

| 탭 | 내용 |
|---|---|
| 대시보드 | 순자산, 자산 비중, 월별 순자산 추이 |
| 자산 | 자산·부채 입력, 리밸런서 계좌별 평가액 불러오기 |
| 배분 | 버킷 3개(① 생활 예비 ② 공백 대비 ③ 성장) 목표·현재·예정액, 이동 계획 |
| 현금흐름 | 연도별 가계 월 소득, 기간별 소득, 목돈 일정 |
| 시뮬레이션 | 수익률·생활비 가정에 따른 연도별 금융자산 |
| 체크리스트 | 확인할 일 |

## 처음 설정 (한 번만)

1. Supabase(personal-apps) → SQL Editor 에 `supabase/cashflow.sql` 을 붙여넣고, 맨 위 이메일 두 개를 실제 주소로 바꿔 Run
2. 앱 ⚙ 설정 → 이메일 입력 → 메일로 온 6자리 코드 입력 (리밸런서와 같은 계정)
3. ⚙ 설정 → 가족 구성원에 두 사람 이름과 로그인 이메일 입력
4. 기존 기록이 있으면 ⚙ 설정 → **가져오기**로 JSON 파일을 불러옴

## 데이터

- 이 저장소에는 **개인 자산 데이터가 없습니다.** 장부는 이 기기(localStorage)와 Supabase 에만 저장됩니다.
- 허용된 두 이메일만 같은 장부(`household = 'home'`)를 읽고 쓸 수 있습니다 (RLS).
- 두 사람이 거의 동시에 고치면 나중에 저장하는 쪽에 어느 장부를 남길지 묻습니다.
- 리밸런서 연동: 로그인한 사람의 리밸런서 최신 기록을 **계좌별로** 읽어, 연결해 둔 자산에 넣습니다 (일반계좌 → 주식, 연금저축 계좌 → 연금저축 등). 같은 자산에 연결한 계좌는 합산합니다. 리밸런서 데이터는 읽기만 합니다.

## 부동산 실거래가 (선택)

아파트 자산에 시군구 코드·단지명·전용면적을 넣으면 국토교통부 실거래가에서 최근 6개월(없으면 12개월) 같은 면적 거래를 찾아 **중간값**을 보여 줍니다. [중간값으로 반영]을 눌러야 장부 금액이 바뀝니다. KB 시세는 단지 주소를 저장해 두고 바로가기로 엽니다.

설정 (한 번만):
1. [공공데이터포털](https://www.data.go.kr)에서 **국토교통부_아파트 매매 실거래가 자료** 활용 신청 → 마이페이지에서 일반 인증키(Decoding) 복사
2. Supabase(personal-apps) → Edge Functions → Secrets 에 `DATA_GO_KR_KEY` = 위 키 추가 (`OWNER_EMAIL` 은 리밸런서 kis-proxy 에서 쓰는 값을 그대로 사용)
3. `supabase/functions/realestate-proxy/index.ts` 를 `realestate-proxy` 이름으로 배포
   - 대시보드: Edge Functions → Deploy a new function → 이름 `realestate-proxy` → 코드 붙여넣기 → Deploy
   - 또는 CLI: `supabase functions deploy realestate-proxy --project-ref rcwneqlwzfplvrihvzyu`

시군구 코드는 [법정동코드 조회](https://www.code.go.kr/stdcode/regCodeL.do)에서 법정동코드 앞 5자리입니다.

## 매월 1일 자동 갱신 (선택)

매월 1일 오전 9시(한국 시간)에 서버가 ① 부동산 실거래가 중간값 ② 리밸런서 최신 기록(계좌 연결대로) 을 장부에 반영하고 ③ 그 달 순자산 기록을 남깁니다. 앱 ⚙ 설정의 **지금 실행**으로 바로 돌려 볼 수 있습니다.

리밸런서 값은 리밸런서에 마지막으로 저장된 기록입니다. 월말에 리밸런서에서 시세 조회를 한 번 해 두면 1일 값이 정확합니다.

설정 (한 번만):
1. Edge Function `cashflow-monthly` 배포 (`supabase/functions/cashflow-monthly/index.ts`)
2. Secrets 에 `CRON_SECRET` 추가 — 임의의 긴 문자열 (`DATA_GO_KR_KEY`, `OWNER_EMAIL` 은 기존 값 사용)
3. SQL Editor 에서 `supabase/cashflow_cron.sql` 의 `CRON_SECRET_값` 을 2번 값으로 바꿔 Run
