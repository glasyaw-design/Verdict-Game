# 판결의 무게 · Vercel 배포판

이 폴더를 그대로 Vercel 프로젝트로 올리면 게임과 온라인 랭킹이 함께 동작합니다.

```
index.html          게임 본체
data.js             사건 데이터 (처음 한 번 내려받고 브라우저에 저장)
art/                시나리오 표지·결말 그림
api/rank.js         랭킹 서버 (Vercel 서버리스 함수, 추가 설치 없음)
package.json        함수 설정 (ESM)
vercel.json         캐시 설정
favicon.png · apple-touch-icon.png · og-image.jpg
```

## 1. 처음 배포 (한 번만)
1. GitHub에 새 저장소를 만들고 이 폴더의 파일을 모두 올립니다. (또는 터미널에서 이 폴더로 이동해 `npx vercel` 실행)
2. vercel.com → **Add New… → Project** → 그 저장소를 **Import** → Framework Preset은 **Other** 그대로 → **Deploy**.
3. 배포가 끝나면 `프로젝트이름.vercel.app` 주소가 생깁니다. 이 주소는 이후 업데이트해도 바뀌지 않습니다.

## 2. 랭킹 저장소 연결 (한 번만)
1. Vercel 프로젝트 → **Storage** 탭 → **Create Database** → **Upstash for Redis**(Marketplace) 선택 → 무료 요금제로 생성.
2. 이 프로젝트에 연결(Connect)하면 환경 변수 `KV_REST_API_URL`, `KV_REST_API_TOKEN`(또는 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)이 자동으로 들어갑니다.
3. **Deployments → 최신 배포 → Redeploy** 한 번.
4. 게임의 **랭킹** 창 오른쪽 위에 "온라인 랭킹"이 보이면 연결된 것입니다. 저장소를 연결하지 않으면 "이 기기 기록만"으로 동작합니다(게임은 정상).

## 3. 업데이트할 때
- 새 zip의 `index.html`, `data.js`, `art/` 폴더를 모두 바꿔 올리세요(필요하면 `api/rank.js`도). 같은 주소로 자동 재배포됩니다.
- `index.html`만 바꾸고 `data.js`를 그대로 두면 사건이 맞지 않아 게임이 열리지 않으니, 세 가지를 꼭 함께 올리세요.
- CLI를 쓴다면 이 폴더에서 `npx vercel --prod`.

## 랭킹 규칙
- 경력: 징계 없이 경력을 끝까지 마치면 자동 등록, 경력 길이별 순위. 같은 기기는 최고 기록 하나만.
- 오늘의 사건: 그날 첫 도전 점수만.
- 주간 챌린지: 그 주 최고 점수. 매주 월요일 새 사건.
- 증거 퀴즈: 맞힌 개수, 같으면 빨리 끝낸 순.
- 서버는 점수 범위·날짜를 검사하고 기기당 1분 10회로 제한합니다. 이름은 6자까지, 특수문자는 지웁니다.
