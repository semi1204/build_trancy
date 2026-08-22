# YT Dual

유튜브 이중 자막 + Anki 문장 카드.
자막은 확장이 브라우저에서 직접 가져오고, Worker는 번역과 카드 큐만 담당합니다.
서버가 유튜브에 접속하지 않으므로 봇 차단·프록시 문제가 없습니다.

## 0. 로컬 YouTube fixture

실제 영상의 전체 자막만 먼저 저장하거나, 자막과 처음 45초 음성을 함께 로컬
fixture로 저장해 반복 테스트할 수 있습니다. 본인 소유이거나 테스트 사용 권한이
있는 공개 영상만 사용하세요.

저장소 루트에서 실행하며, 자막 전용 수집에는 최신 `yt-dlp`가 필요합니다. 음성까지
수집할 때는 `ffmpeg`/`ffprobe`도 필요합니다.
Deno가 있으면 YouTube의 현재 플레이어 스크립트 해석에 사용합니다. macOS에서 오래된
`yt-dlp`가 403을 내면 먼저 `brew upgrade yt-dlp`로 갱신하세요. 별도 실행 파일을
쓸 때는 `YT_DLP_BIN=/path/to/yt-dlp`를 지정할 수 있습니다. 수집기는 전역 yt-dlp
설정·쿠키·플러그인·원격 컴포넌트를 사용하지 않습니다.

```bash
# 전체 영어 자막만 수집 (오디오 다운로드 없음)
npm run fixture:transcript -- \
  'https://www.youtube.com/watch?v=M7lc1UVf-VE' \
  --lang en

# 자막 전용 fixture 검증
npm run fixture:check -- .local/youtube-transcripts/M7lc1UVf-VE

# 영어 자막 + WebM/Opus 음성 45초 수집
npm run fixture:capture -- \
  'https://www.youtube.com/watch?v=M7lc1UVf-VE' \
  --lang en --seconds 45

# SHA-256, JSON3→세그먼트 변환, 오디오 형식/길이 재검증
npm run fixture:check -- .local/youtube/M7lc1UVf-VE
```

자막 전용 산출물은 `.local/youtube-transcripts/<video-id>/`, 음성 포함 산출물은
`.local/youtube/<video-id>/`에 생기며 둘 다 Git에서 제외됩니다.
`--seconds` 구간 안에 실제 자막이 하나도 없으면 불완전한 fixture를 남기지 않고
실패합니다.

- `audio.webm`: 음성 포함 모드에서만 생성되는 WebM/Opus 오디오
- `captions.<lang>.json3`: YouTube 원본 자막
- `transcript.json`: `/api/subtitle`에 바로 보낼 수 있는 요청 본문
- `transcript.txt`, `transcript.vtt`: 사람이 읽거나 로컬 플레이어에서 확인할 파일
- `manifest.json`: 출처, 수집 도구 버전, 파일 크기와 SHA-256

로컬 Worker까지 테스트하려면 Wrangler(`npm install -g wrangler`)가 필요합니다.
`ytdual/worker/.dev.vars`에 필요한 키를 설정하고 터미널 두 개에서 다음처럼
실행합니다. `/api/transcribe`와 `/api/subtitle`은 각각 음성/자막을 Groq/OpenAI로
전송해 실제 API를 호출하므로 비용이 발생할 수 있습니다. 개발 서버는 인증 없이
localhost API를 열므로 테스트가 끝나면 종료하고, 실행 중에는 신뢰하지 않는 웹
페이지를 열어 두지 마세요.

```bash
npm run dev

curl -sS -F file=@.local/youtube/M7lc1UVf-VE/audio.webm \
  -F language=en http://127.0.0.1:8787/api/transcribe

curl -sS -H 'content-type: application/json' \
  --data-binary @.local/youtube/M7lc1UVf-VE/transcript.json \
  http://127.0.0.1:8787/api/subtitle
```

## 1. Worker 배포

```bash
cd ytdual/worker
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


| 키                 | 기능                                            |
| -------------------- | ------------------------------------------------- |
| `Alt`+`Y`          | 영상 자막 켜기 / 끄기                           |
| `Alt`+`A`          | 번역 토글 (유튜브: 번역 줄 / 일반: 페이지 번역) |
| `Ctrl`+`R`         | 현재 문장 반복                                  |
| `Ctrl`+`S`         | 현재 문장 저장                                  |
| `Ctrl`+`←` `→`   | 이전 / 다음 문장                                |
| `Ctrl`+`+` `−`    | 자막 크기                                       |
| 단어 더블클릭       | 어느 페이지서든 문맥 뜻 팝업                    |

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

## 6. 브라우저 테스트 하네스

자막 파이프라인을 브라우저에서 눈으로 확인하고 지연을 재는 도구입니다.
터미널 두 개에서 실행합니다.

```bash
npm run dev        # 워커 (:8787)
npm run harness    # 테스트 페이지 (:8788) → http://127.0.0.1:8788
```

페이지는 `ytdual/extension/content.js` **원본을 그대로 로드해** 그 안의
`normalizeSegments` · `fastWindow` · `pickTrack` · `seedRawLines` ·
`mergeTranslated` · `applyFast` · `findLine` · `requestTranslation` 을 직접
호출합니다. 사본을 두지 않으므로 여기서 본 동작이 곧 확장의 동작입니다.
상단 배지가 연결 상태를 보여줍니다.

볼 수 있는 것:

1. **자막과 재생 지점** — 로컬 fixture 13개 중 선택. 시간 정규화를 껐다 켜면
   자동생성 자막의 rolling 겹침이 사라지는 것이 수치로 보입니다.
2. **fast 창 비교** — 옛 방식(청크 머리 8조각)과 현재 방식(재생 지점 앵커)이
   각각 어떤 조각을 고르는지 나란히 표시. 빨간 줄이 "이미 지나간 조각"입니다.
3. **fast vs full 실행** — 같은 지점에서 둘을 동시에 쏘고 초 단위로 카운트합니다.
   누적 표에 지연·토큰·reasoning·빈 번역·구멍·최장줄이 쌓이고 중앙값과
   `full ÷ fast` 배수가 나옵니다.
4. **번역 결과** — 빈 번역은 빨간 테두리, 85자 초과는 노란 테두리.
5. **오버레이 미리보기** — 실제 `overlay.css` 와 실제 `findLine()` 으로 그립니다.
   슬라이더를 끌어 자막이 비는 순간이 있는지 확인할 수 있습니다.

`full 격자 전체 번역` 은 동시성 8로 영상 전체를 번역합니다 — 실제 비용이
발생하므로 짧은 fixture(`jNQXAC9IVRw`, 6조각)로 먼저 시험하세요.
`캐시 우회` 를 끄면 같은 구간을 다시 눌러도 KV 캐시가 히트해 0초에 돌아옵니다.
