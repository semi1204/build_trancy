# YT Dual

유튜브 이중 자막 + Anki 문장 카드.
자막은 확장이 브라우저에서 직접 가져오고, Worker는 번역과 카드 큐만 담당합니다.
서버가 유튜브에 접속하지 않으므로 봇 차단·프록시 문제가 없습니다.

## 1. Worker 배포

```bash
cd worker
npm install -g wrangler
wrangler login

# 캐시 + 카드 큐용 KV 생성 → 출력된 id를 wrangler.toml 에 붙여넣기
wrangler kv namespace create SUBS

# OpenAI 키 등록 (GPT-5.6 Luna 사용)
wrangler secret put OPENAI_API_KEY

wrangler deploy
```

브라우저로 배포 주소를 열어 `YT Dual worker v2 ok` 가 보이면 정상입니다.

## 2. 확장 설치

`extension/manifest.json` 의 `host_permissions` 에서
`https://sub.example.workers.dev/*` 를 **실제 Worker 주소**로 바꾸세요. (필수)

- **데스크톱 파폭**: `about:debugging#/runtime/this-firefox` → 임시 부가 기능 로드 → `manifest.json`
- **안드로이드 파폭**: [AMO 개발자 허브](https://addons.mozilla.org/developers/)에 `extension` 폴더를 zip으로 올리고 **비공개(unlisted)** 배포 선택 → 서명된 `.xpi` 를 폰에서 열면 설치

설치 후 확장 설정에서 Worker 주소와 번역 언어를 입력합니다.

## 3. 보기

유튜브 영상을 열면 자동 시작. 우하단 `자막` 버튼으로 켜고 끕니다.


| 키        | 기능             |
| ----------- | ------------------ |
| `Alt`+`T` | 켜기 / 끄기      |
| `R`       | 현재 문장 반복   |
| `S`       | 현재 문장 저장   |
| `Z`       | 번역 숨기기      |
| `←` `→` | 이전 / 다음 문장 |
| `+` `−`  | 자막 크기        |

## 4. Anki 카드

**폰에서 수집** — 자막의 단어를 탭하면 그 문장이 통째로 카드 큐에 저장됩니다.
단어, 문장, 번역, 영상 제목, 타임스탬프가 함께 담깁니다.

**PC에서 반영** — Anki를 켜고 확장 설정 → `Anki 내보내기 열기` →
목록 확인 후 `Anki로 보내기`. AnkiWeb 동기화로 폰 AnkiDroid까지 갑니다.

AnkiConnect가 연결되지 않으면 Anki → 도구 → 부가기능 → AnkiConnect → 설정에서
`webCorsOriginList` 에 이 페이지 주소(`moz-extension://...`)를 추가하고 Anki를 재시작하세요.

노트 타입 `YT Dual` 과 덱은 없으면 자동 생성됩니다.
필드는 Word / Sentence / Translation / Source(타임스탬프 링크)입니다.

## 비용

번역만 유료입니다. GPT-5.6 Luna 기준 1시간 영상에 약 40원,
캐시가 히트하면 0원입니다. 같은 영상을 다시 보거나 다른 기기에서 봐도 재사용됩니다.

Cloudflare 무료 티어는 하루 요청 10만 건이라 개인용으로는 넘칠 일이 없습니다.

## 구조

```
확장 (브라우저)                      Worker (Cloudflare)
  watch 페이지 fetch
  → captionTracks 추출
  → json3 자막 수신
  → 세그먼트 ─────────POST────────→  KV 캐시 확인
                                     → miss면 Luna로 재분할·번역
                  ←──────JSON──────   → KV 저장
  <video> 위 오버레이

  단어 탭 ────────POST /api/cards→   카드 큐 (KV)
                                            │
  Anki 페이지 ←───GET /api/cards────────────┘
   → AnkiConnect → 데스크톱 Anki → AnkiWeb → AnkiDroid
```

## 안 될 때

- **"자막 트랙이 없습니다"** — 그 영상에 유튜브 자막 자체가 없습니다. 전사가 필요하고, 별도로 Groq Whisper 경로를 붙여야 합니다.
- **"서버 500"** — `wrangler secret put OPENAI_API_KEY` 를 했는지 확인. `wrangler tail` 로 로그를 볼 수 있습니다.
- **자막이 안 뜸** — `host_permissions` 의 Worker 주소를 실제 주소로 바꿨는지 확인하세요.
- **일부 구간에 번역이 없음** — 그 배치가 실패해 원문만 표시된 경우입니다. 새로고침하면 재시도합니다 (실패한 결과는 캐시하지 않습니다).
- **카드가 안 넘어감** — 폰에서 저장할 때 네트워크가 끊겼으면 확장이 큐에 보관했다가 8초마다 재전송합니다. 유튜브 탭을 잠깐 열어두세요.
