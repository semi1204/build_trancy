# YouTube transcript library benchmark

Python, Node, Java, yt-dlp 구현 5종이 **같은 영상 ID와 언어 코드**를 한 번에 요청하도록 만든 비교 환경입니다. 업스트림 소스는 복제하지 않고 각 디렉터리의 고정 버전 패키지를 Docker 이미지에 설치합니다.

| Compose 서비스 | 업스트림 | 고정 버전 |
| --- | --- | --- |
| `jdepoix` | `jdepoix/youtube-transcript-api` | 1.2.4 |
| `kakulukian` | `Kakulukian/youtube-transcript` | 1.3.1 |
| `ericmmartin` | `ericmmartin/youtube-transcript-plus` | 2.0.1 |
| `trldvix` | `trldvix/youtube-transcript-api` | 0.4.0 |
| `yt-dlp` | `yt-dlp/yt-dlp` | 2026.08.19 |

## 준비

Docker Desktop과 `docker compose`가 필요합니다. 이미지 빌드는 Docker Hub, npm, PyPI, Maven Central에 접속하지만 `--smoke` 단계는 YouTube에 접속하지 않습니다.

```bash
# 이미지 빌드 + 패키지 로드 + 공통 JSON 계약 확인 (YouTube 요청 없음)
npm run bench:transcript:smoke

# 기본 예제 3개를 라이브 측정
npm run bench:transcript

# 이미지를 다시 빌드하지 않고 사용자 케이스를 3번 측정
npm run bench:transcript -- \
  --cases=benchmarks/transcript-libraries/cases.example.json \
  --repeat=3 --timeout-ms=90000 --cooldown-ms=3000 --skip-build
```

라이브 측정은 본인 소유이거나 테스트 권한이 있는 공개 영상에만 사용하세요. 반복 횟수를 크게 잡으면 같은 IP에서 동시에 요청하는 특성 때문에 YouTube의 요청 제한을 측정하게 될 수 있습니다.

## 입력

케이스 파일은 배열이며 URL이 아니라 11자리 영상 ID와 정확한 언어 코드 하나를 지정합니다.

```json
[
  { "label": "english-manual", "videoId": "jNQXAC9IVRw", "lang": "en" },
  { "label": "korean-auto", "videoId": "HnvitMTkXro", "lang": "ko" }
]
```

와일드카드, `all`, 복수 언어는 허용하지 않습니다. 같은 트랙을 비교해야 도구별 결과가 섞이지 않기 때문입니다.

## 실행 방식

한 케이스씩 진행하되 그 케이스 안에서는 5개 컨테이너를 동시에 실행합니다. 따라서 두 시간이 함께 기록됩니다.

- `libraryMs`: 어댑터 내부에서 실제 라이브러리 호출을 감싼 시간
- `wallMs`: `docker compose run` 시작부터 결과 수신까지의 전체 시간

JVM·Python·Node 시작 비용은 `wallMs`에는 들어가고 `libraryMs`에는 들어가지 않습니다. 성공 결과는 프로젝트의 `validateSegments()` 계약에 맞춰 `{start, end, text}`로 검증한 뒤 조각 수, 문자 수, 시작/끝 시각, 텍스트 SHA-256만 남깁니다. 전체 자막은 결과 파일에 중복 저장하지 않습니다.

원시 기록은 Git에서 제외된 `.local/bench/transcript-libraries-<timestamp>.json`에 저장됩니다.

## 상태 해석

- `ok`: 비어 있지 않고 시간 순서가 유효한 자막
- `empty`: 호출은 끝났지만 자막 조각이 0개
- `tool-error`: 라이브러리가 반환한 오류
- `timeout`: 지정 시간 초과
- `process-error`: 컨테이너 또는 실행 프로세스 실패
- `protocol-error`: 어댑터 JSON이나 공통 세그먼트 계약 위반

현재 YouTube는 자막 URL에도 Proof-of-Origin Token(POT)을 요구할 수 있습니다. 브라우저 런타임 URL이나 PO Token을 지원하지 않는 라이브러리가 `200 + 빈 본문`, "자막 없음", 파싱 오류를 내는 경우가 있으며, 이는 하네스 실패가 아니라 **현재 직접 수집 가능 여부에 대한 결과**입니다. 이 환경은 프록시, 쿠키, PO Token 주입이나 우회 로직을 추가하지 않습니다.

Docker 컨테이너의 DNS/네트워크는 호스트와 다를 수 있습니다. 호스트의 `/etc/hosts` 차단이 컨테이너에 자동으로 적용된다고 가정하지 마세요.

## 비교 범위

단일 영상·단일 언어의 자막 수집만 비교합니다. 포맷터(txt/VTT/SRT/CSV), 번역, 플레이리스트·채널 벌크 처리, 브라우저 자동화는 범위 밖입니다. yt-dlp는 저장소의 fixture 수집기와 같이 전역 설정, 플러그인, 캐시, 원격 컴포넌트를 끄고 명시적 Node JS runtime을 사용합니다.
