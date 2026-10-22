import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../../japan-payment/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('    function validRate('), html.indexOf('    // 보유 설정·금액·일본 날짜'));
const date = new Date().toISOString().slice(0, 10);
const primary = { base: 'USD', date, rates: { JPY: 157.88, KRW: 1325.57 } };
const backup = { result: 'success', base_code: 'USD', time_last_update_unix: Math.floor(Date.now() / 1000), rates: { JPY: 158.1, KRW: 1326.14 } };
const response = data => ({ ok: true, json: async () => data });

function harness(fetch, fastTimeout = false) {
  const elements = {};
  const context = vm.createContext({
    fetch, AbortController, clearTimeout,
    setTimeout: fastTimeout ? callback => setTimeout(callback, 5) : setTimeout,
    $: id => elements[id] ??= { style: {} },
    format: String,
    updateCalculate() {}
  });
  vm.runInContext(`
    const CACHE_TTL = 24 * 60 * 60 * 1000;
    let exchangeRate = null, ratePromise = null, rateController = null;
    let rateLoading = false, rateRequestId = 0, rateNotice = '';
    ${source}
  `, context);
  return { run: code => vm.runInContext(code, context), elements };
}

test('계산·첫 화면이 겹치면 진행 중인 한 자동 조회를 함께 기다린다', async () => {
  let resolve, calls = 0;
  const h = harness(() => { calls++; return new Promise(done => { resolve = done; }); });
  const initial = h.run('refreshRate()');
  const calculating = h.run('refreshRate()');
  assert.equal(initial, calculating);
  assert.equal(calls, 1);
  assert.equal(h.run('rateLoading'), true);
  resolve(response(primary));
  await calculating;
  assert.equal(h.run('yenThreshold(exchangeRate)'), 7894);
  assert.equal(h.run('exchangeRate.provider'), 'Frankfurter');
  assert.equal(h.run('rateLoading'), false);
  assert.equal(h.run('ratePromise'), null);
});

test('통신 실패·HTTP 오류·잘못된 데이터·오래된 기준일은 보조 제공처로 재시도한다', async () => {
  for (const first of [
    () => { throw new Error('network'); },
    () => ({ ok: false }),
    () => response({ ...primary, rates: { JPY: NaN } }),
    () => response({ ...primary, date: '2020-01-01' }),
    () => response({ ...primary, base: 'EUR' }),
    () => response({ ...primary, date: '2099-01-01' })
  ]) {
    const urls = [];
    const h = harness(async url => { urls.push(url); return urls.length === 1 ? first() : response(backup); });
    await h.run('refreshRate()');
    assert.equal(urls.length, 2);
    assert.match(urls[1], /open\.er-api\.com/);
    assert.equal(h.run('exchangeRate.provider'), 'ExchangeRate-API');
    assert.equal(h.run('exchangeRate.jpy'), 158.1);
    assert.equal(h.run('exchangeRate.krw'), 1326.14);
    assert.match(h.elements['rate-status'].textContent, /ExchangeRate-API/);
  }
});

test('주 제공처가 지연돼도 시간 제한 뒤 보조 제공처로 자동 전환한다', async () => {
  const urls = [];
  const h = harness((url, { signal }) => {
    urls.push(url);
    if (urls.length > 1) return Promise.resolve(response(backup));
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))));
  }, true);
  await h.run('refreshRate()');
  assert.equal(urls.length, 2);
  assert.equal(h.run('exchangeRate.provider'), 'ExchangeRate-API');
});

test('두 제공처 실패 시 유효한 기존 환율을 보존하며 다음 시도는 다시 조회한다', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw new Error('offline'); });
  h.run(`exchangeRate = { jpy: 150, fetchedAt: Date.now(), source: 'manual' }`);
  await h.run('refreshRate()');
  assert.equal(h.run('exchangeRate.jpy'), 150);
  assert.match(h.run('rateNotice'), /최신 조회 실패/);
  assert.equal(h.run('ratePromise'), null);
  h.run('exchangeRate = null');
  await h.run('refreshRate()');
  assert.equal(calls, 4);
  assert.equal(h.run('exchangeRate'), null);
  assert.equal(h.run('rateLoading'), false);
});

test('늦게 온 자동 응답은 사용자가 직접 입력한 환율을 덮어쓰지 않는다', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const pending = h.run('refreshRate()');
  h.run(`rateRequestId++; rateController.abort(); rateController = null; ratePromise = null; rateLoading = false; exchangeRate = { jpy: 160, source: 'manual', fetchedAt: Date.now() }`);
  resolve(response(primary));
  await pending;
  assert.equal(h.run('exchangeRate.source'), 'manual');
  assert.equal(h.run('exchangeRate.jpy'), 160);
  assert.equal(h.run('rateLoading'), false);
});
