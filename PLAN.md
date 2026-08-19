# build_trancy — Session Plan

Trancy 클론(영상 위 이중 자막 언어학습 확장)을 세션 단위로 작게 쌓아 올린다.
**대상 브라우저: Firefox** (MV3, Firefox 109+).

## Session 1 — "YouTube 영상 위에 우리 자막 오버레이가 뜬다"

번역 없음, 백엔드 없음, 빌드 도구 없음. Firefox 확장(MV3) content script가
YouTube 플레이어를 찾아 오버레이를 붙이고, YouTube 네이티브 자막(CC) 텍스트를
MutationObserver로 미러링해서 우리 오버레이에 표시한다.

### 파일 구성 (vanilla JS, 번들러/TS 없음)

```
build_trancy/
├── manifest.json   # MV3, browser_specific_settings.gecko.id, strict_min_version 109+
├── content.js      # 전부 여기. 레이어 없음.
└── overlay.css     # 오버레이 스타일
```

### 데이터 구조 (Phase 1)

- `content.js`의 `overlayEl` — 마운트된 오버레이 요소 참조. 이것뿐.

### 함수 (Phase 2)

- `findPlayer()` → 플레이어 컨테이너 또는 null
- `mountOverlay(player)` → 오버레이 생성·부착 (이미 있으면 기존 것 반환)
- `observeCaptions(onText)` → 네이티브 자막 DOM 감시, 변경 시 콜백
- `render(text)` → 오버레이에 텍스트 표시 (빈 문자열이면 숨김)

### 검증 (Phase 4) — Firefox

1. `about:debugging#/runtime/this-firefox` → "임시 부가 기능 로드" → `manifest.json` 선택
2. CC 켠 YouTube 영상 재생
3. 기대 관찰: ① 플레이어 위 오버레이 div 존재 ② 오버레이 텍스트가 네이티브 CC와
   실시간 일치 ③ 콘솔에 확장발 에러 0건 ④ SPA 내 다음 영상 이동 후에도 오버레이 1개

### 불변식 (Phase 5)

1. 오버레이는 항상 최대 1개 (재주입·SPA 네비게이션에도)
2. YouTube DOM은 읽기만; 쓰는 곳은 우리 오버레이뿐
3. Session 1에서 네트워크 요청 0건, 저장소 사용 0건
4. 확장 오류가 페이지를 깨뜨리지 않음

### 구현 순서 (Phase 6)

1. `manifest.json` → 확장이 에러 없이 로드
2. `findPlayer`/`mountOverlay` → 오버레이 div 육안 확인
3. `observeCaptions` + `render` → CC 미러링 일치
4. SPA idempotency → 영상 이동 후에도 오버레이 1개

## Session 2+ (미정, 예고만)

- Session 2: 자막 번역(언어쌍 결정 필요) — 이때 `CaptionCue` 등 구조 도입 검토
- 이후: 자막 트랙 직접 fetch, 단어장, Netflix 지원 등
