import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../../japan-payment/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('    function selectPayment('), html.indexOf('    function paymentOptions('));
const settingsSource = html.slice(html.indexOf('    const DEFAULT_SETTINGS ='), html.indexOf('    const PLACES ='));
const { selectPayment, DEFAULT_SETTINGS, japanDate, normalizeSettings, validSettings } = vm.runInNewContext(`
  const LIMITS = { kakao: 1, union: 3, unionDonki500: 3, unionDonki4000: 3, donkiCoupon: 1000000 };
  const normalizeCounts = value => ({ kakao: 0, union: 0, unionDonki500: 0, unionDonki4000: 0, donkiCoupon: 0, ...value });
  ${settingsSource}
  const yenThreshold = rate => Math.ceil(Number((rate.jpy * 50).toFixed(7)));
  ${source}
  ({ selectPayment, DEFAULT_SETTINGS, japanDate, normalizeSettings, validSettings });
`);
const noSettings = { ...DEFAULT_SETTINGS };
const allSettings = { ...Object.fromEntries(Object.entries(noSettings).map(([key, value]) => [key, typeof value === 'boolean'])), kakaoRateLow: 5, kakaoRateHigh: 7, unionDonkiEligible: false };
const rate = { jpy: 150 };
const available = { kakao: 0, union: 0 };
const spent = { kakao: 1, union: 3, unionDonki500: 3, unionDonki4000: 3 };
const choose = (amount, owned = allSettings, used = available, today = {}) => selectPayment('donki', amount, used, rate, {}, owned, today);

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
  assert.match(outside.warnings[0], /50,000엔 미만/);
});

test('최대 7%를 항상 7%로 가정하지 않고 계정에 저장한 구간만 자동 반영한다', () => {
  const unknown = { ...allSettings, unionCard: false, kakaoRateLow: 0, kakaoRateHigh: 0 };
  assert.equal(choose(17000, unknown).totalDiscount, 2000);
  assert.equal(choose(17000, unknown).coupon, null);
  assert.match(choose(17000, unknown).warnings[0], /할인율이 아직 설정되지 않아/);
  const configured = { ...unknown, kakaoRateLow: 5 };
  assert.equal(choose(17000, configured).totalDiscount, 2850);
  assert.equal(choose(30000, configured).totalDiscount, 2000);
  assert.equal(choose(30000, { ...configured, kakaoRateHigh: 7 }).totalDiscount, 4100);
  const legacy = normalizeSettings({ kakaoReady: true, kakaoDonki: true });
  assert.equal(legacy.kakaoRateLow, 0);
  assert.equal(legacy.unionDonkiEligible, false);
  assert.equal(validSettings(legacy), true);
  for (const value of [-1, 7.1, '7', true, NaN, Infinity]) assert.equal(validSettings({ ...noSettings, kakaoRateLow: value }), false);
});

test('카카오 중복 확인과 쿠폰 할인 후 최소 15,000엔 조건을 자동 판단한다', () => {
  const owned = { ...allSettings, unionCard: false };
  assert.equal(choose(17000, { ...owned, kakaoStackConfirmed: false }).totalDiscount, 2000);
  assert.equal(choose(17000, owned).totalDiscount, 2850);
  const below = choose(15788, owned);
  assert.equal(below.plans.some(p => p.coupon && p.benefit === 'kakao'), false);
  const boundary = choose(15789, owned);
  assert.equal(boundary.charge, 15000);
  assert.equal(boundary.totalDiscount, 2789);
});

test('돈키호테 등록·대상 점포 설정과 최소 금액에 따라 전용 행사를 자동 비교한다', () => {
  assert.equal(choose(45000).benefit, 'union');
  const target = { ...allSettings, unionDonkiEligible: true };
  assert.equal(choose(45000, target).benefit, 'unionDonki4000');
  assert.equal(choose(45000, target).totalDiscount, 7150);
  assert.equal(choose(45000, target).payable, 37850);
  assert.equal(choose(45000, { ...target, unionDonki4000Registered: false }).benefit, 'union');
  const forty = choose(40000, target);
  assert.equal(forty.plans.some(p => p.coupon && p.benefit === 'unionDonki4000'), false);
  assert.equal(forty.totalDiscount, 5800);
  const noCoupons = { ...noSettings, unionCard: true, unionDonkiEligible: true, unionDonki4000Registered: true, travelCard: true };
  assert.equal(choose(9999, noCoupons, spent).method, 'travel');
  assert.equal(choose(10000, noCoupons).benefit, 'unionDonki500');
  assert.equal(choose(40000, noCoupons).benefit, 'unionDonki4000');
});

test('전용 행사는 당일 기록·전체 3회 한도·수동 복원에 따라 후보에서 제외하거나 복원한다', () => {
  const owned = { ...noSettings, unionCard: true, unionDonkiEligible: true, unionDonki4000Registered: true, travelCard: true };
  const onlyFour = { ...spent, unionDonki4000: 2 };
  assert.equal(choose(45000, owned, onlyFour).benefit, 'unionDonki4000');
  assert.equal(choose(45000, owned, onlyFour, { unionDonki4000: 1 }).method, 'travel');
  assert.equal(choose(45000, owned, spent).method, 'travel');
  assert.equal(choose(45000, owned, onlyFour, { unionDonki4000: 0 }).benefit, 'unionDonki4000');
  assert.equal(choose(12000, owned, { ...spent, unionDonki500: 2 }, { unionDonki500: 1 }).method, 'travel');
  assert.equal(choose(12000, owned, { ...spent, unionDonki500: 2 }, {}).benefit, 'unionDonki500');
});

test('일본 자정에 날짜가 바뀌어도 다른 시간대에서 같은 일일 키를 사용한다', () => {
  assert.equal(japanDate(new Date('2026-10-22T14:59:59Z')), '2026-10-22');
  assert.equal(japanDate(new Date('2026-10-22T15:00:00Z')), '2026-10-23');
});

test('간사이공항은 금액·보유 쿠폰·잔여 횟수만으로 자동 추천한다', () => {
  const select = (amount, used = available, owned = allSettings) => selectPayment('airport', amount, used, rate, {}, owned);
  assert.equal(select(9999).method, 'travel');
  assert.equal(select(10000).benefit, 'kakao');
  assert.equal(select(12000).benefit, 'union');
  assert.equal(select(15000, { ...available, union: 3 }).benefit, 'kakao');
  assert.equal(select(10000, available, { ...allSettings, kakaoAirport: false }).benefit, 'union');
  assert.equal(select(45000).coupon, null);
  assert.equal(select(45000).plans.some(p => p.benefit === 'unionDonki4000'), false);
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
