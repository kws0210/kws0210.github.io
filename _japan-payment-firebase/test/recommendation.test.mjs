import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../../japan-payment/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('    function selectPayment('), html.indexOf('    function donkiOptions('));
const settingsSource = html.slice(html.indexOf('    const DEFAULT_SETTINGS ='), html.indexOf('    const PLACES ='));
const selectOwned = vm.runInNewContext(`
  const LIMITS = { kakao: 1, union: 3, unionDonki500: 3, unionDonki4000: 3, donkiCoupon: 1000000 };
  const normalizeCounts = value => ({ kakao: 0, union: 0, unionDonki500: 0, unionDonki4000: 0, donkiCoupon: 0, ...value });
  ${settingsSource}
  const yenThreshold = rate => Math.ceil(Number((rate.jpy * 50).toFixed(7)));
  ${source}
  selectPayment;
`);
const noSettings = { kakaoReady: false, kakaoDonki: false, kakaoAirport: false, kakaoStoreCoupon: false, kakaoStackConfirmed: false, unionCard: false, unionRegistered: false, unionStoreCoupon: false, unionDonki4000Registered: false, travelCard: false };
const allSettings = Object.fromEntries(Object.keys(noSettings).map(key => [key, true]));
const select = (place, amount, used, rate, options = {}) => selectOwned(place, amount, used, rate, options, { ...allSettings, kakaoStackConfirmed: options.stackKakao === true });
const rate = { jpy: 150 };
const available = { kakao: 0, union: 0 };
const spent = { kakao: 1, union: 3, unionDonki500: 3, unionDonki4000: 3 };
const kakaoCoupon = discount => ({ eligible: true, discount, stackKakao: true });
const bothCoupons = discount => ({ ...kakaoCoupon(discount), unionCoupon: true, unionDiscount: discount });

test('최대 7%를 정률로 가정하지 않고 실제 할인액을 검증한다', () => {
  for (const options of [{ eligible: true }, { eligible: true, discount: 701 }, { unionCoupon: true, unionDiscount: 701 }]) {
    assert.equal(select('donki', 10000, spent, rate, options).coupon, null);
  }
  assert.equal(select('donki', 9999, spent, rate, kakaoCoupon(500)).coupon, null);
  const choice = select('donki', 10000, spent, rate, kakaoCoupon(500));
  assert.equal(choice.totalDiscount, 500);
  assert.equal(choice.payable, 9500);
});

test('카카오페이 2,000엔 중복은 별도 확인하고 할인 후 최소 금액을 판단한다', () => {
  const unconfirmed = select('donki', 16000, available, rate, { eligible: true, discount: 800 });
  assert.equal(unconfirmed.totalDiscount, 2000);
  assert.equal(unconfirmed.coupon, null);
  assert.equal(unconfirmed.plans.some(p => p.coupon && p.benefit === 'kakao'), false);
  const stacked = select('donki', 16000, available, rate, kakaoCoupon(800));
  assert.equal(stacked.method, 'kakao');
  assert.equal(stacked.totalDiscount, 2800);
  assert.equal(stacked.payable, 13200);
  assert.equal(select('donki', 16000, available, rate, kakaoCoupon(1000)).charge, 15000);
  const lower = select('donki', 15999, available, rate, kakaoCoupon(1000));
  assert.equal(lower.plans.some(p => p.coupon && p.benefit === 'kakao'), false);
});

test('KB 전용 매장 쿠폰과 A+ 쿠폰을 구분해 각 결제 조합을 비교한다', () => {
  const kakaoOnly = select('donki', 30000, available, rate, { ...kakaoCoupon(2100), stackUnion: true });
  assert.equal(kakaoOnly.totalDiscount, 4100);
  assert.equal(kakaoOnly.plans.some(p => p.couponSource === 'kakao' && p.method === 'union'), false);
  const both = select('donki', 30000, available, rate, bothCoupons(2100));
  assert.equal(both.benefit, 'union');
  assert.equal(both.couponSource, 'union');
  assert.equal(both.totalDiscount, 4890);
  assert.equal(both.payable, 25110);
  assert.equal(both.plans.some(p => p.couponSource === 'union' && p.method !== 'union'), false);
  for (const [amount, method] of [[20999, 'kakao'], [21000, 'union'], [21010, 'union']]) {
    assert.equal(select('donki', amount, available, rate, bothCoupons(1000)).method, method);
  }
});

test('50달러 최소·20달러 한도와 기준 환율을 적용한다', () => {
  assert.equal(select('other', 7499, available, rate).method, 'travel');
  assert.equal(select('other', 7500, available, rate).totalDiscount, 750);
  assert.equal(select('other', 7500, available, { jpy: 150.01 }).method, 'travel');
  assert.equal(select('other', 100000, available, { jpy: 157.88 }).totalDiscount, 3157);
  const high = select('donki', 10000, { ...available, kakao: 1 }, { jpy: 198 }, { unionCoupon: true, unionDiscount: 500 });
  assert.equal(high.plans.some(p => p.coupon && p.benefit === 'union'), false);
});

test('돈키호테 4,000엔은 별도 확인 후 할인 후 금액으로 판단하고 10%와 더하지 않는다', () => {
  assert.equal(select('donki', 40000, available, rate).benefit, 'union');
  assert.equal(select('donki', 39999, available, rate, { unionDonki4000: true }).plans.some(p => p.benefit === 'unionDonki4000'), false);
  assert.equal(select('donki', 40000, available, rate, { unionDonki4000: true }).totalDiscount, 4000);
  const below = select('donki', 40000, available, rate, { ...bothCoupons(2800), unionDonki4000: true });
  assert.equal(below.plans.some(p => p.coupon && p.benefit === 'unionDonki4000'), false);
  const choice = select('donki', 45000, available, rate, { ...bothCoupons(3150), unionDonki4000: true });
  assert.equal(choice.benefit, 'unionDonki4000');
  assert.equal(choice.paymentDiscount, 4000);
  assert.equal(choice.totalDiscount, 7150);
  assert.equal(choice.payable, 37850);
  assert.equal(choice.plans.find(p => p.couponSource === 'kakao' && p.method === 'kakao').totalDiscount, 5150);
});

test('돈키호테 전용 횟수를 KB 10%와 구분하고 소진·수동 복원에 대응한다', () => {
  assert.equal(select('donki', 40000, { ...spent, unionDonki4000: 2 }, rate, { unionDonki4000: true }).benefit, 'unionDonki4000');
  assert.equal(select('donki', 40000, spent, rate, { unionDonki4000: true }).method, 'travel');
  assert.equal(select('donki', 10000, { ...spent, unionDonki500: 2 }, rate, { unionDonki500: true }).benefit, 'unionDonki500');
  assert.equal(select('donki', 9999, spent, rate, { unionDonki500: true }).method, 'travel');
  assert.equal(select('donki', 40000, { ...spent, union: 2 }, rate, { unionDonki4000: true }).benefit, 'union');
});

test('결제 할인 소진 후에도 전용 매장 쿠폰만 쓸 수 있으며 누적 기록은 한도가 아니다', () => {
  const choice = select('donki', 30000, { ...spent, donkiCoupon: 5 }, rate, { unionCoupon: true, unionDiscount: 2100 });
  assert.equal(choice.method, 'union');
  assert.equal(choice.benefit, null);
  assert.equal(choice.coupon, 'donkiCoupon');
  assert.equal(choice.totalDiscount, 2100);
  assert.equal(select('donki', 30000, spent, rate, kakaoCoupon(2100)).method, 'travel');
});

test('공항·그 외에는 돈키호테 혜택을 적용하지 않고 환율 실패를 처리한다', () => {
  assert.equal(select('airport', 9999, available, rate).method, 'travel');
  assert.equal(select('airport', 10000, available, rate).method, 'kakao');
  assert.equal(select('airport', 12000, available, rate).method, 'union');
  assert.equal(select('airport', 15000, { ...available, union: 3 }, rate).method, 'kakao');
  assert.equal(select('other', 45000, available, rate, { ...bothCoupons(3150), unionDonki4000: true }).totalDiscount, 3000);
  assert.equal(select('donki', 16000, available, null).method, null);
  assert.equal(select('donki', 16000, spent, null, kakaoCoupon(800)).coupon, 'donkiCoupon');
});

test('보유 결제수단·쿠폰과 사전 등록만 추천에 포함한다', () => {
  const options = { ...bothCoupons(2100), unionDonki500: true, unionDonki4000: true };
  assert.equal(selectOwned('donki', 30000, available, rate, options, noSettings).method, null);
  const travel = selectOwned('donki', 30000, available, null, options, { ...noSettings, travelCard: true });
  assert.equal(travel.method, 'travel');
  assert.equal(travel.totalDiscount, 0);
  const noCard = selectOwned('donki', 30000, available, rate, options, { ...allSettings, unionCard: false });
  assert.equal(noCard.method, 'kakao');
  assert.equal(noCard.totalDiscount, 4100);
  assert.equal(noCard.plans.some(p => p.method === 'union'), false);
  const noPaymentCoupon = selectOwned('donki', 16000, available, rate, bothCoupons(800), { ...allSettings, kakaoDonki: false });
  assert.equal(noPaymentCoupon.benefit, 'union');
  const noStoreCoupon = selectOwned('donki', 30000, available, rate, options, { ...allSettings, unionStoreCoupon: false });
  assert.equal(noStoreCoupon.couponSource, 'kakao');
  assert.equal(noStoreCoupon.totalDiscount, 4100);
  const noRegistration = selectOwned('donki', 45000, available, rate, { unionDonki4000: true }, { ...noSettings, unionCard: true, travelCard: true });
  assert.equal(noRegistration.method, 'travel');
  assert.equal(noRegistration.totalDiscount, 0);
  const cardOnly = selectOwned('donki', 45000, spent, null, {}, { ...noSettings, unionCard: true });
  assert.equal(cardOnly.method, 'union');
  assert.equal(cardOnly.benefit, null);
  assert.equal(cardOnly.totalDiscount, 0);
  const airport = selectOwned('airport', 10000, available, rate, {}, { ...allSettings, kakaoAirport: false });
  assert.equal(airport.benefit, 'union');
});
