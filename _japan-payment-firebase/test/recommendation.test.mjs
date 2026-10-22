import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../../japan-payment/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('    function selectPayment('), html.indexOf('    function paymentOptions('));
const settingsSource = html.slice(html.indexOf('    const DEFAULT_SETTINGS ='), html.indexOf('    const PLACES ='));
const { selectPayment, DEFAULT_SETTINGS, DONKI_STORES, donkiStoreOptions, japanDate, normalizeSettings, validSettings } = vm.runInNewContext(`
  const LIMITS = { kakao: 1, union: 3, unionDonki500: 3, unionDonki4000: 3, donkiCoupon: 1000000 };
  const normalizeCounts = value => ({ kakao: 0, union: 0, unionDonki500: 0, unionDonki4000: 0, donkiCoupon: 0, ...value });
  ${settingsSource}
  const yenThreshold = rate => Math.ceil(Number((rate.jpy * 50).toFixed(7)));
  ${source}
  ({ selectPayment, DEFAULT_SETTINGS, DONKI_STORES, donkiStoreOptions, japanDate, normalizeSettings, validSettings });
`);
const noSettings = { ...DEFAULT_SETTINGS };
const allSettings = { ...Object.fromEntries(Object.entries(noSettings).map(([key, value]) => [key, typeof value === 'boolean'])), kakaoRateLow: 5, kakaoRateHigh: 7, unionDonkiEligible: false };
const rate = { jpy: 150 };
const available = { kakao: 0, union: 0 };
const spent = { kakao: 1, union: 3, unionDonki500: 3, unionDonki4000: 3 };
const choose = (amount, owned = allSettings, used = available, today = {}, options = {}) => selectPayment('donki', amount, used, rate, options, owned, today);
const atListedStore = (amount, owned = allSettings, used = available, today = {}) => choose(amount, owned, used, today, { donkiStoreGroup: 'osaka-listed' });

test('돈키호테 17,000엔에서 추가 입력 없이 보유한 2,000엔 쿠폰을 비교한다', () => {
  const owned = { ...noSettings, kakaoReady: true, kakaoDonki: true, travelCard: true };
  const choice = choose(17000, owned);
  assert.equal(choice.method, 'kakao');
  assert.equal(choice.totalDiscount, 2000);
  assert.equal(choice.payable, 15000);
  assert.match(choice.eligibility[0], /계산 전 사용 0\/1회/);
  assert.equal(choose(17000, owned, { kakao: 1 }).method, 'travel');
  assert.equal(choose(17000, owned, available).benefit, 'kakao');
});

test('돈키호테 보유 쿠폰의 금액 구간을 자동 계산하고 출처를 구분한다', () => {
  assert.equal(choose(9999, allSettings, spent).coupon, null);
  for (const [amount, discount] of [[10000, 500], [29999, 1499], [30000, 2100], [49999, 3499]]) {
    const choice = choose(amount, { ...allSettings, kakaoReady: false }, spent);
    assert.equal(choice.couponSource, 'union');
    assert.equal(choice.storeDiscount, discount);
  }
  const choice = choose(30000);
  assert.equal(choice.couponSource, 'union');
  assert.equal(choice.benefit, 'union');
  assert.equal(choice.totalDiscount, 4890);
  assert.equal(choice.payable, 25110);
  assert.equal(choice.plans.some(p => p.couponSource === 'kakao' && p.method === 'union'), false);
  assert.equal(choice.plans.some(p => p.couponSource === 'union' && p.method !== 'union'), false);
  const outside = choose(50000, { ...allSettings, kakaoReady: false });
  assert.equal(outside.coupon, null);
  assert.match(outside.warnings.join('\n'), /50,000엔 미만/);
});

test('최대 7%를 항상 7%로 가정하지 않고 계정에 저장한 구간만 자동 반영한다', () => {
  const unknown = { ...allSettings, unionCard: false, kakaoRateLow: 0, kakaoRateHigh: 0 };
  assert.equal(choose(17000, unknown).totalDiscount, 2000);
  assert.equal(choose(17000, unknown).coupon, null);
  assert.match(choose(17000, unknown).warnings[0], /할인율이 아직 설정되지 않아/);
  const configured = { ...unknown, kakaoRateLow: 5 };
  assert.equal(choose(17000, configured).totalDiscount, 2000);
  assert.equal(choose(30000, configured).totalDiscount, 2000);
  assert.equal(choose(30000, { ...configured, kakaoRateHigh: 7 }).totalDiscount, 2100);
  const legacy = normalizeSettings({ kakaoReady: true, kakaoDonki: true });
  assert.equal(legacy.kakaoRateLow, 0);
  assert.equal(legacy.unionDonkiEligible, false);
  assert.equal(validSettings(legacy), true);
  for (const value of [-1, 7.1, '7', true, NaN, Infinity]) assert.equal(validSettings({ ...noSettings, kakaoRateLow: value }), false);
});

test('카카오 두 쿠폰은 폐기한 확인 설정과 무관하게 각각 비교하고 합산하지 않는다', () => {
  const owned = { ...allSettings, unionCard: false };
  for (const previousFlag of [true, false]) {
    const setting = { ...owned, kakaoStackConfirmed: previousFlag };
    assert.equal(choose(14999, setting).totalDiscount, 749);
    assert.equal(choose(15000, setting).totalDiscount, 2000);
    assert.equal(choose(17000, setting).totalDiscount, 2000);
    assert.equal(choose(30000, setting).totalDiscount, 2100);
    assert.equal(choose(30000, setting).benefit, null);
    assert.equal(choose(30000, setting).plans.some(p => p.coupon && p.benefit === 'kakao'), false);
    assert.match(choose(17000, setting).warnings[0], /각각 따로 비교/);
  }
});

test('이번 거래의 점포 팝업 답변과 등록·최소 금액으로 전용 행사를 판단한다', () => {
  assert.equal(choose(45000).benefit, 'union');
  assert.equal(atListedStore(45000).benefit, 'unionDonki4000');
  assert.equal(atListedStore(45000).totalDiscount, 7150);
  assert.equal(atListedStore(45000).payable, 37850);
  assert.equal(atListedStore(45000, { ...allSettings, unionDonki4000Registered: false }).benefit, 'union');
  const forty = atListedStore(40000);
  assert.equal(forty.plans.some(p => p.coupon && p.benefit === 'unionDonki4000'), false);
  assert.equal(forty.totalDiscount, 5800);
  const noCoupons = { ...noSettings, unionCard: true, unionDonki4000Registered: true, travelCard: true };
  assert.equal(atListedStore(9999, noCoupons, spent).method, 'travel');
  assert.equal(atListedStore(10000, noCoupons).benefit, 'unionDonki500');
  assert.equal(atListedStore(40000, noCoupons).benefit, 'unionDonki4000');
  for (const group of ['other', undefined, true, 'unknown', 'toString']) {
    const choice = choose(45000, { ...allSettings, unionDonkiEligible: true }, available, {}, { donkiStoreGroup: group });
    assert.equal(choice.benefit, 'union');
    assert.equal(choice.totalDiscount, 6150);
    assert.equal(choice.plans.some(p => p.benefit === 'unionDonki500' || p.benefit === 'unionDonki4000'), false);
  }
  assert.equal(choose(45000, { ...noCoupons, unionDonkiEligible: true }).method, 'travel');
});

test('전용 행사는 당일 기록·전체 3회 한도·수동 복원에 따라 후보에서 제외하거나 복원한다', () => {
  const owned = { ...noSettings, unionCard: true, unionDonki4000Registered: true, travelCard: true };
  const onlyFour = { ...spent, unionDonki4000: 2 };
  assert.equal(atListedStore(45000, owned, onlyFour).benefit, 'unionDonki4000');
  assert.equal(atListedStore(45000, owned, onlyFour, { unionDonki4000: 1 }).method, 'travel');
  assert.equal(atListedStore(45000, owned, spent).method, 'travel');
  assert.equal(atListedStore(45000, owned, onlyFour, { unionDonki4000: 0 }).benefit, 'unionDonki4000');
  assert.equal(atListedStore(12000, owned, { ...spent, unionDonki500: 2 }, { unionDonki500: 1 }).method, 'travel');
  assert.equal(atListedStore(12000, owned, { ...spent, unionDonki500: 2 }, {}).benefit, 'unionDonki500');
});

test('공식 오사카 46개 지점과 전용 행사 대상 15곳을 조사 대조표와 일치시킨다', async () => {
  const evidence = await readFile(new URL('../OSAKA_STORES.md', import.meta.url), 'utf8');
  const rows = [...evidence.matchAll(/^\| \[([^\]]+)\]\(https:\/\/www\.donki\.com\/store\/shop_detail\.php\?shop_id=(\d+)\).*\| (참여 확인|미등재) \|$/gm)];
  assert.equal(rows.length, 46);
  assert.equal(DONKI_STORES.length, 46);
  assert.equal(new Set(DONKI_STORES.map(store => store.id)).size, 46);
  assert.equal(DONKI_STORES.filter(store => store.eligible).length, 15);
  for (const [, japanese, id, status] of rows) {
    const store = DONKI_STORES.find(value => value.id === id);
    assert.ok(store, id);
    assert.equal(store.japanese.replace(/\s/g, ''), japanese.replace(/\s/g, ''));
    assert.equal(store.eligible, status === '참여 확인', store.name);
  }
  assert.equal(html.includes('data-setting="kakaoStackConfirmed"'), false);
  assert.equal(html.includes('data-setting="unionDonkiEligible"'), false);
});

test('선택한 지점 ID로 전용 혜택을 판정하고 틀린 그룹 옵션보다 우선한다', () => {
  for (const store of DONKI_STORES) {
    const choice = choose(45000, allSettings, available, {}, { donkiStoreId: store.id, donkiStoreGroup: store.eligible ? 'other' : 'osaka-listed' });
    assert.equal(choice.benefit, store.eligible ? 'unionDonki4000' : 'union', store.name);
    assert.equal(choice.totalDiscount, store.eligible ? 7150 : 6150, store.name);
  }
  for (const id of ['other', 'unknown', 'toString', '__proto__', null, 110]) {
    assert.equal(donkiStoreOptions(id).donkiStoreGroup, 'other');
    const choice = choose(45000, allSettings, available, {}, { donkiStoreId: id, donkiStoreGroup: 'osaka-listed' });
    assert.equal(choice.benefit, 'union');
    assert.equal(choice.totalDiscount, 6150);
  }
});

test('일본 자정에 날짜가 바뀌어도 다른 시간대에서 같은 일일 키를 사용한다', () => {
  assert.equal(japanDate(new Date('2026-10-22T14:59:59Z')), '2026-10-22');
  assert.equal(japanDate(new Date('2026-10-22T15:00:00Z')), '2026-10-23');
});

test('간사이공항은 금액·보유 쿠폰·잔여 횟수만으로 자동 추천한다', () => {
  const select = (amount, used = available, owned = allSettings) => selectPayment('airport', amount, used, rate, {}, owned);
  assert.equal(select(9999).method, 'travel');
  assert.equal(select(10000).benefit, 'kakao');
  assert.equal(select(12000).benefit, 'kakao', 'KB 이용료 차감 후 카카오 1,200엔 할인이 더 크다');
  assert.equal(select(13300).benefit, 'union');
  assert.equal(select(15000, { ...available, union: 3 }).benefit, 'kakao');
  assert.equal(select(10000, available, { ...allSettings, kakaoAirport: false }).benefit, 'union');
  assert.equal(select(45000).coupon, null);
  assert.equal(selectPayment('airport', 45000, available, rate, { donkiStoreGroup: 'osaka-listed' }, allSettings).plans.some(p => p.benefit === 'unionDonki4000'), false);
});

test('그 외에서만 유니온페이 결제 가능 확인을 받고 50달러·20달러 한도를 적용한다', () => {
  const select = (amount, accepted, fx = rate) => selectPayment('other', amount, available, fx, { unionAccepted: accepted }, allSettings);
  assert.equal(select(20000, false).method, 'travel');
  assert.equal(select(7499, true).method, 'travel');
  assert.equal(select(7500, true).totalDiscount, 750);
  assert.equal(select(7500, true, { jpy: 150.01 }).method, 'travel');
  assert.equal(select(100000, true, { jpy: 157.88 }).totalDiscount, 3157);
  assert.equal(select(30000, true).coupon, null);
  const cardOnly = { ...noSettings, unionCard: true };
  assert.equal(selectPayment('other', 10000, available, rate, {}, cardOnly).reason, 'acceptance-required');
  assert.equal(selectPayment('other', 10000, available, rate, { unionAccepted: true }, cardOnly).method, 'union');
});

test('요청 옵션으로 미보유 혜택·미등록 행사나 미확인 중복을 활성화할 수 없다', () => {
  const spoofed = { eligible: true, discount: 2100, unionCoupon: true, unionDiscount: 2100, stackKakao: true, unionDonki4000: true };
  assert.equal(selectPayment('donki', 30000, available, rate, spoofed, noSettings).method, null);
  const travel = selectPayment('donki', 45000, available, null, spoofed, { ...noSettings, travelCard: true });
  assert.equal(travel.method, 'travel');
  assert.equal(travel.totalDiscount, 0);
  const unconfirmed = selectPayment('donki', 30000, available, rate, spoofed, { ...allSettings, kakaoStackConfirmed: false, unionCard: false });
  assert.equal(unconfirmed.totalDiscount, 2100);
  assert.equal(unconfirmed.plans.some(p => p.coupon && p.benefit === 'kakao'), false);
  assert.equal(selectPayment('donki', 17000, available, null, {}, allSettings).reason, 'rate-required');
});

test('노리 UPI 비용 범위·트래블월렛 면제를 반영하고 카카오 미확인 수수료는 null로 유지한다', () => {
  const choice = choose(17000);
  const union = choice.plans.find(plan => plan.benefit === 'union' && plan.couponSource === 'union');
  assert.equal(union.feeMinYen, union.payable * .0025);
  assert.equal(union.feeMaxYen, union.payable * .0105);
  const kakao = choice.plans.find(plan => plan.method === 'kakao');
  assert.equal(kakao.feeMinYen, null);
  assert.equal(kakao.feeMaxYen, null);
  assert.equal(kakao.totalWon, null);
  assert.equal(choice.costMode, 'partial');
  assert.equal(choice.plans.find(plan => plan.method === 'travel').feeMaxYen, 0);
  const noKakao = { ...noSettings, unionCard: true, unionRegistered: true, travelCard: true };
  const huge = selectPayment('other', 999999999, available, rate, { unionAccepted: true }, noKakao);
  assert.equal(huge.method, 'travel', '할인 한도보다 이용료가 크면 같은 환율 가정에서 트래블월렛을 추천한다');
  assert.equal(huge.costMode, 'same-fx');
});

test('수수료 입력 없이 KB 이용료를 차감해 카카오·트래블월렛과 자동 비교한다', () => {
  const owned = { ...noSettings, kakaoReady: true, kakaoDonki: true, unionCard: true, unionRegistered: true, travelCard: true };
  const choice = choose(22000, owned);
  assert.equal(choice.method, 'kakao');
  assert.equal(choice.totalDiscount, 2000);
  const kb = choice.plans.find(plan => plan.benefit === 'union');
  assert.equal(kb.totalDiscount, 2200);
  assert.equal(kb.feeMaxYen, 207.9);
  assert.equal(kb.totalDiscount - kb.feeMaxYen, 1992.1);
  assert.equal(choose(22100, owned).method, 'union');
  assert.equal(choice.costMode, 'partial');
  const huge = selectPayment('other', 999999999, available, rate, { unionAccepted: true }, owned);
  assert.equal(huge.method, 'travel', '카카오 후보가 있어도 KB 이용료가 할인보다 크면 트래블월렛을 우선한다');
});

test('폐기한 수동 환율 옵션은 무시하고 미확인 원화 총지출을 만들어내지 않는다', () => {
  const now = Date.now();
  const expected = choose(17000);
  for (const value of [1, 900, 100000, 0, -1, 100001, '900', NaN, Infinity]) {
    const choice = choose(17000, allSettings, available, {}, { costQuotes: Object.fromEntries(['kakao', 'union', 'travel'].map(method => [method, { wonPer100: method === 'travel' ? 1 : value, capturedAt: now }])) });
    assert.equal(choice.costMode, 'partial');
    assert.equal(choice.method, expected.method);
    assert.equal(choice.totalDiscount, expected.totalDiscount);
    assert.equal(choice.plans.every(plan => plan.totalWon === null), true);
    assert.equal(choice.plans.find(plan => plan.method === 'kakao').totalWon, null);
  }
  assert.equal(/data-cost=|id="cost-(kakao|union|travel)"/.test(html), false);
  assert.equal(html.includes('normalizeCostQuotes'), false);
});
