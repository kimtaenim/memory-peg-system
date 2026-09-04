# memory-peg-system

숫자를 그림으로 외우는 **0–99 페그 시스템**. 아래는 전자계산기 같은 키패드, 위는 카드 창.
숫자를 누르면 그 숫자에 예약된 **상징주의 타로카드**가 키워드와 함께 열린다.

```
8396  →  [83 빨간 삼각팬티]  [96 구루]
 542  →  [5 갈고리]  [42 싸이]
```

- 홀수 자리는 **맨 앞 한 자리**부터 끊는다 (`542` → `5` + `42`).
- 최대 여섯 자리 = 카드 세 장.
- 폰 화면 한 판에 다 들어간다. 스크롤 없음.
- **즉시 / 퀴즈** 모드 — 퀴즈에서는 숫자를 다 누르고 `⏎` 를 눌러야 카드가 열린다.
  (카드를 하나씩 눌러 한 장만 먼저 열어볼 수도 있다.)

## 그림이 아직 없다면

카드 자리에 숫자만 뜬다. 아래 순서로 110장을 한 번 구우면 된다.

### 1. OpenAI API 키 넣는 곳

**GitHub Actions로 돌릴 때 (권장 — 노트북 안 켜도 됨)**

1. 이 레포 → **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret**
   - Name: `OPENAI_API_KEY`
   - Secret: `sk-...`
3. **Actions** 탭 → **peg-images** → **Run workflow**

생성된 카드는 워크플로가 알아서 `docs/img/` 에 커밋한다.

**내 컴퓨터에서 돌릴 때**

```bash
# macOS / Linux
OPENAI_API_KEY=sk-... node tools/gen-peg-images.mjs

# Windows PowerShell
$env:OPENAI_API_KEY="sk-..."; node tools/gen-peg-images.mjs
```

키는 환경변수로만 넘긴다. **레포 안 파일에 키를 적지 말 것** — 공개 레포라 그대로 노출된다.

### 2. 생성 스크립트

```bash
node tools/gen-peg-images.mjs [옵션]

  --only 5,42,83     지정한 키만 생성
  --force            이미 있는 파일도 다시 생성
  --model <이름>     기본 gpt-image-2 (없는 모델이면 gpt-image-1 로 자동 대체)
  --size <WxH>       기본 1024x1536 (세로 타로카드 2:3)
  --quality <등급>   low | medium | high  (기본 medium)
  --format <형식>    webp | png  (기본 webp)
  --concurrency <n>  동시 요청 수 (기본 3)
  --dry-run          호출 없이 최종 프롬프트만 출력
  --list-missing     아직 없는 키만 나열
```

- 이미 만들어진 파일은 **건너뛴다.** 중간에 끊겨도 그냥 다시 실행하면 이어서 만든다.
- 429/5xx 는 지수 백오프로 재시도하고, 계정이 지원하지 않는 파라미터는 빼고 다시 던진다.
- 마음에 안 드는 카드 한 장만 다시: `--only 42 --force`
- 먼저 `--dry-run` 으로 프롬프트를 훑고, `--quality low` 로 몇 장 시험해 본 뒤 전체를 돌리는 편이 싸다.

안전 필터에 걸린 항목은 `SAFETY:` 로 표시된다. `docs/data/prompts.json` 의 해당 `prompt` 를
조금 순화한 뒤 `--only <키> --force` 로 다시 구우면 된다.

## 폰에서 열기

**Settings → Pages** → Source `Deploy from a branch` → Branch `main`, 폴더 `/docs` → Save.
주소는 `https://kimtaenim.github.io/memory-peg-system/` — 홈 화면에 추가하면 앱처럼 뜬다.

## 구조

데이터는 전부 JSON 이다. 코드에 페그도 프롬프트도 하드코딩되어 있지 않다.

```
docs/data/pegs.json       숫자 → 키워드          {"42": "싸이", ...}
docs/data/prompts.json    화풍(style) + 장면(items)
docs/index.html           웹앱. pegs.json 을 fetch 해서 그린다
docs/img/1/<0-9>.webp     한 자리 카드
docs/img/2/<00-99>.webp   두 자리 카드
tools/gen-peg-images.mjs  일괄 생성기 — 위 두 JSON 만 읽는다 (Node 22, 의존성 없음)
.github/workflows/peg-images.yml
```

`prompts.json` 생김새:

```jsonc
{
  "style": {
    "base":       "A symbolist tarot card illustration ...",  // 110장 공통 화풍
    "noText":     "No text, no lettering, ...",               // 글자 금지
    "withDigits": "The only lettering anywhere is ..."        // 숫자만 허용
  },
  "items": {
    "42": { "prompt": "A plump reveler in a black tuxedo ..." },
    "07": { "prompt": "A tuxedoed spy ...", "digits": true }   // digits: 숫자 표기 허용
  }
}
```

최종 프롬프트 = `items[키].prompt` + `style.base` + (`digits` 면 `withDigits`, 아니면 `noText`).
두 JSON 의 키가 어긋나면 생성기가 실행할 때 경고로 알려준다.

## 고치기

- **키워드**: `docs/data/pegs.json` — 고치면 웹앱에 바로 반영된다 (그림 재생성 불필요)
- **그림 내용**: `docs/data/prompts.json` 의 `items` → `--only <키> --force`
- **덱 전체의 화풍**: `docs/data/prompts.json` 의 `style.base` 한 곳 — 여기만 고치면 110장 인상이 통째로 바뀐다
- **자릿수 상한**: `docs/index.html` 의 `MAX_DIGITS`
- **색**: `docs/index.html` 맨 위 `:root` 변수

웹앱이 JSON 을 `fetch` 하므로 `index.html` 을 더블클릭해서 열면 브라우저가 막는다.
로컬에서 볼 때는 `npx http-server docs` 처럼 간단한 서버로 열 것. Pages 에서는 그냥 된다.

## 페그 규칙

한 자리는 **모양**, 두 자리는 **소리**를 따른다.

| | | | | |
|---|---|---|---|---|
| 0 도넛 | 1 촛불 | 2 백조 | 3 엉덩이 | 4 요트 |
| 5 갈고리 | 6 체리 | 7 부메랑 | 8 눈사람 | 9 콩나물 |

두 자리 100개는 `docs/data/pegs.json` 에 전부 들어 있다 (00 빵빵 · 42 싸이 · 63 63빌딩 · 96 구루 …).

기억은 기이할수록 오래 남으므로, 프롬프트는 일부러 낯설고 상징적인 장면으로 썼다.
