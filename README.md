# Consistency Guard (Jev)

캐릭터 응답 직후 Jev로 설정오류를 판정하고, 오류가 의심되면 별도 연결 프로필로 수정 지시문을 만든 뒤 메인 API로 수정본을 새 스와이프로 추가합니다.

## 설치

1. 확장: 이 폴더(server-plugin 제외)를 `SillyTavern/data/<사용자>/extensions/third-party/ST-Consistency-Guard/`
   또는 `SillyTavern/public/scripts/extensions/third-party/ST-Consistency-Guard/`에 넣습니다.
2. 서버 플러그인: `server-plugin/index.js`를 `SillyTavern/plugins/consistency-guard/index.js`로 복사합니다.
   제브 리콜 서버 플러그인(`plugins/jev-recall`)이 이미 설치되어 있으면 이 단계를 건너뛰어도 그 플러그인을 자동으로 재사용합니다.
3. `config.yaml`에서 `enableServerPlugins: true`를 확인하고 SillyTavern을 재시작한 뒤 브라우저를 강력 새로고침합니다.

## 연결 프로필

아래 중 하나를 만들어 선택합니다. 키는 확장 설정에 저장되지 않고, 서버 플러그인이 서버 안에서만 읽습니다.

**Vercel AI Gateway**
- API: Custom (OpenAI-compatible)
- URL: `https://ai-gateway.vercel.sh/v1`
- 모델: `typesafe-ai/jev`
- 키: Vercel AI Gateway API 키

**OpenRouter (권장 방식)**
- API: Custom (OpenAI-compatible)
- URL: `https://openrouter.ai/api/v1`
- 모델: `~typesafe/jev-latest` 또는 `typesafe/jev-1.13`
- 키: OpenRouter API 키

ST의 OpenRouter 프로필도 지원하지만, 모델 목록에 Jev가 안 보일 수 있어 Custom 방식이 더 편합니다.

OpenRouter는 동봉한 `consistency-guard` 서버 플러그인에서만 처리됩니다. 제브 리콜 플러그인은 Vercel만 지원합니다.
