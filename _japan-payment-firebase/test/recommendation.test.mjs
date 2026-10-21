import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../../japan-payment/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('    function selectPayment('), html.indexOf('    function donkiOptions('));
const select = vm.runInNewContext(`
  const LIMITS = { kakao: 1, union: 3, donkiCoupon: 1000000 };
  const normalizeCounts = value => ({ kakao: 0, union: 0, donkiCoupon: 0, ...value });
  const yenThreshold = rate => Math.ceil(Number((rate.jpy * 50).toFixed(7)));
  ${source}
  selectPayment;
`);
const rate = { jpy: 150 };
const available = { kakao: 0, union: 0 };
const spent = { kakao: 1, union: 3 };

test('최대 7%를 정률로 가정하지 않고 확인한 할인액만 반영한다', () => {
  assert.equal(select('donki', 10000, spent, rate, { eligible: true }).coupon, null);
  assert.equal(select('donki', 10000, spent, rate, { eligible: true, discount: 701 }).coupon, null);
  assert.equal(select('donki', 9999, spent, rate, { eligible: true, discount: 500 }).coupon, null);
  const choice = select('donki', 10000, spent, rate, { eligible: true, discount: 500 });
  assert.equal(choice.coupon, 'donkiCoupon');
  assert.equal(choice.totalDiscount, 500);
  assert.equal(choice.payable, 9500);
});

test('카카오페이 프로모션과 중복하고 할인 후 최소 금액을 판단한다', () => {
  const choice = select('donki', 16000, available, rate, { eligible: true, discount: 800 });
  assert.equal(choice.method, 'kakao');
  assert.equal(choice.coupon, 'donkiCoupon');
  assert.equal(choice.totalDiscount, 2800);
  assert.equal(choice.payable, 13200);
  const lower = select('donki', 15000, available, rate, { eligible: true, discount: 750 });
  assert.equal(lower.method, 'kakao');
  assert.equal(lower.coupon, null);
  assert.equal(lower.totalDiscount, 2000);
  assert.equal(lower.plans.some(plan => plan.coupon && plan.method === 'kakao'), false);
});

test('KB 중복은 별도로 확인하고 할인 후 50달러 조건과 20달러 한도를 적용한다', () => {
  const options = { eligible: true, discount: 2100 };
  const plain = select('donki', 30000, available, rate, options);
  assert.equal(plain.method, 'kakao');
  assert.equal(plain.totalDiscount, 4100);
  assert.equal(plain.plans.some(plan => plan.coupon && plan.method === 'union'), false);
  const stacked = select('donki', 30000, available, rate, { ...options, stackUnion: true });
  assert.equal(stacked.method, 'union');
  assert.equal(stacked.totalDiscount, 4890);
  assert.equal(stacked.payable, 25110);
  assert.equal(select('other', 7499, available, rate).method, 'travel');
  assert.equal(select('other', 7500, available, rate).totalDiscount, 750);
  assert.equal(select('other', 7500, available, { jpy: 150.01 }).method, 'travel');
  assert.equal(select('other', 100000, available, rate).totalDiscount, 3000);
  const highRate = select('donki', 10000, { ...available, kakao: 1 }, { jpy: 198 }, { eligible: true, discount: 500, stackUnion: true });
  assert.equal(highRate.plans.some(plan => plan.coupon && plan.method === 'union'), false);
});

test('매장 쿠폰 누적 횟수로 전체 소진을 가정하지 않는다', () => {
  const choice = select('donki', 30000, { ...spent, donkiCoupon: 5 }, rate, { eligible: true, discount: 2100 });
  assert.equal(choice.coupon, 'donkiCoupon');
  assert.equal(choice.method, 'travel');
  assert.equal(select('donki', 30000, spent, rate).coupon, null);
  assert.equal(select('donki', 25000, { ...available, union: 3 }, rate).method, 'kakao');
  assert.equal(select('donki', 20000, available, rate).method, 'union');
});

test('공항 최소 기준과 소진 후 대안, 환율 실패를 처리한다', () => {
  assert.equal(select('airport', 9999, available, rate).method, 'travel');
  assert.equal(select('airport', 10000, available, rate).method, 'kakao');
  assert.equal(select('airport', 12000, available, rate).method, 'union');
  assert.equal(select('airport', 15000, { ...available, union: 3 }, rate).method, 'kakao');
  assert.equal(select('donki', 16000, available, null).method, null);
  assert.equal(select('donki', 16000, spent, null, { eligible: true, discount: 800 }).coupon, 'donkiCoupon');
});
