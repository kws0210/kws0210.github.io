# 일본 결제 도우미 Firebase 설정

화면은 `japan-payment/index.html` 단일 파일이며 GitHub Pages에서 제공한다.
Firebase 웹 SDK 12.19.0의 Authentication과 Firestore Lite를 브라우저에서 사용한다.
전용 프로젝트 ID는 `kws0210-japan-payment`이며 Firestore 기본 데이터베이스는 서울(`asia-northeast3`)의 무료 등급이다.
웹앱 연결 설정은 HTML의 `firebase-config` JSON에 있다.
웹앱의 공개 API 키는 서버 관리자 인증정보가 아니다.
CLI 로그인 정보와 서비스 계정 키는 저장소에 추가하지 않는다.

## 저장 및 로그인

사용자 선택에 따라 문자 인증이나 비밀번호 없이 전화번호만 입력한다.
번호를 아는 사람은 같은 기록을 조회·조정할 수 있다.
국내 번호와 `+82` 표기를 정규화한 뒤 SHA-256으로 계정 문서 ID를 만든다.
Firebase에는 원문 전화번호를 저장하지 않는다.
이 해시는 전화번호 소유를 인증하거나 번호 추측을 막는 비밀번호가 아니다.

`paymentAccounts/{번호 해시}`에 카카오페이·KB 사용 횟수와 버전을 저장한다.
하위 `operations/{요청 ID}`는 횟수와 함께 트랜잭션으로 기록해 통신 오류 후 같은 요청을 다시 보내도 중복 계산하지 않는다.
Firestore Lite는 카운트를 디스크에 캐시하지 않는다.
브라우저에는 Firebase 익명 인증 정보와 계정 해시·마스킹한 번호만 자동 로그인용으로 남긴다.
로그아웃은 이 브라우저의 로그인 정보와 표시 상태만 해제한다.
서버 기록은 삭제하지 않으며 같은 번호로 다시 로그인하거나 다른 기기에서 접속하면 다시 조회한다.

기존 로컬 카운트는 사용자가 확인한 경우에만 아직 사용 기록이 없는 번호로 가져온다.
가져오기 또는 가져오지 않기를 결정하기 전까지 기존 로컬 기록을 보존한다.
기존 환율 캐시는 제거하며 새 버전은 페이지 시작·복귀 시 환율을 조회한다.
카카오페이 1회·KB 3회에서 증가 버튼, 0회에서 감소 버튼을 비활성화한다.
기존 한도 초과 기록은 감소시킬 수 있다.

## 설정 및 배포

Firebase Authentication에서 기본 서비스를 시작하고 익명 로그인 제공자를 활성화한다.
인증 허용 도메인에 `kws0210.github.io`를 등록한다.
유료 Identity Platform 전환이나 문자 발송 기능은 사용하지 않는다.

규칙은 이 디렉터리에서 배포한다.

```sh
npm install
npx firebase deploy --only firestore:rules --project kws0210-japan-payment
```

규칙은 인증 없는 접근, 전체 목록 조회, 계정 삭제, 한도 초과 증가, 요청 기록 덮어쓰기를 막는다.
번호를 입력한 사람이 기록을 여는 서비스 정책에 따라 익명 인증한 이용자는 알고 있는 계정 문서에 접근할 수 있다.
이 디렉터리는 밑줄로 시작하므로 GitHub Pages의 기본 Jekyll 게시 대상에서 제외된다.
기존 홈과 다른 리포트는 변경하지 않는다.

## 검증

Node.js 22와 Java 21 이상에서 로컬 에뮬레이터를 실행한다.

```sh
npx firebase emulators:start --only auth,firestore --project demo-japan-payment
```

다른 터미널에서 저장 규칙 검증을 실행한다.

```sh
npm run test:rules
```

브라우저 검증 시에만 localhost HTML에 `firebase-emulator` 메타 태그를 `true`로 주입하고 프로젝트 ID를 `demo-japan-payment`로 설정한다.
공개 페이지는 에뮬레이터에 연결하지 않는다.
