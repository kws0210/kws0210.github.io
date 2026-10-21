import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, collection, getDoc, getDocs, setDoc, deleteDoc, writeBatch, serverTimestamp } from 'firebase/firestore';

let environment;
const account = 'a'.repeat(64);
const initial = { counts: { kakao: 0, union: 0 }, version: 0, lastOperation: '' };
before(async () => {
  environment = await initializeTestEnvironment({ projectId: 'demo-japan-payment', firestore: {
    host: '127.0.0.1', port: 8080,
    rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8')
  } });
});
after(async () => { await environment?.cleanup(); });
beforeEach(async () => { await environment.clearFirestore(); });
const authenticated = () => environment.authenticatedContext('anonymous-test', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const reference = db => doc(db, 'paymentAccounts', account);

async function writeOperation(db, counts, version, kind = 'adjust') {
  const id = randomUUID();
  const batch = writeBatch(db);
  batch.set(reference(db), { counts, version, lastOperation: id });
  batch.set(doc(reference(db), 'operations', id), { kind, result: { counts, version }, createdAt: serverTimestamp() });
  return batch.commit();
}

test('인증 없이는 읽거나 쓸 수 없고 익명 인증 뒤에는 개별 기록만 읽을 수 있다', async () => {
  const anonymous = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(reference(anonymous)));
  await assertFails(setDoc(reference(anonymous), initial));
  const db = authenticated();
  await assertSucceeds(setDoc(reference(db), initial));
  await assertSucceeds(getDoc(reference(db)));
  await assertFails(getDocs(collection(db, 'paymentAccounts')));
  await assertFails(deleteDoc(reference(db)));
});

test('새 계정은 0회로 생성하며 원문 전화번호나 임의 필드는 저장할 수 없다', async () => {
  const db = authenticated();
  await assertFails(setDoc(reference(db), { ...initial, phone: '01012345678' }));
  await assertFails(setDoc(reference(db), { ...initial, counts: { kakao: 1, union: 0 } }));
  await assertFails(setDoc(doc(db, 'paymentAccounts', '01012345678'), initial));
  await assertSucceeds(setDoc(reference(db), initial));
});

test('횟수와 중복 방지 기록을 하나의 트랜잭션으로 저장하며 수동 증가 한도를 지킨다', async () => {
  const db = authenticated();
  await setDoc(reference(db), initial);
  await assertFails(setDoc(reference(db), { counts: { kakao: 1, union: 0 }, version: 1, lastOperation: randomUUID() }));
  await assertSucceeds(writeOperation(db, { kakao: 1, union: 3 }, 1));
  await assertFails(writeOperation(db, { kakao: 2, union: 3 }, 2));
  await assertFails(writeOperation(db, { kakao: 1, union: 4 }, 2));
  await assertFails(writeOperation(db, { kakao: -1, union: 3 }, 2));
  await assertFails(writeOperation(db, { kakao: 0, union: 2 }, 3));
  await assertSucceeds(writeOperation(db, { kakao: 0, union: 2 }, 2));
});

test('이전 초과 기록은 빈 계정에만 가져오며 이후에는 감소시킬 수 있다', async () => {
  const db = authenticated();
  await setDoc(reference(db), initial);
  await assertSucceeds(writeOperation(db, { kakao: 3, union: 5 }, 1, 'import'));
  await assertFails(writeOperation(db, { kakao: 4, union: 5 }, 2, 'import'));
  await assertSucceeds(writeOperation(db, { kakao: 2, union: 4 }, 2));
  await assertSucceeds(writeOperation(db, { kakao: 1, union: 3 }, 3));
  await assertFails(writeOperation(db, { kakao: 2, union: 3 }, 4));
});

test('요청 기록은 덮어쓰거나 계정 없이 만들 수 없다', async () => {
  const db = authenticated();
  const operation = doc(reference(db), 'operations', randomUUID());
  await assertFails(setDoc(operation, { kind: 'adjust', result: { counts: { kakao: 1, union: 0 }, version: 1 }, createdAt: serverTimestamp() }));
  await setDoc(reference(db), initial);
  await writeOperation(db, { kakao: 1, union: 0 }, 1);
  const state = (await getDoc(reference(db))).data();
  const existing = doc(reference(db), 'operations', state.lastOperation);
  await assertFails(setDoc(existing, { kind: 'import', result: state, createdAt: serverTimestamp() }));
  await assertFails(getDocs(collection(reference(db), 'operations')));
  await assertFails(deleteDoc(existing));
});

test('기존 계정에 매장 쿠폰을 추가하고 결제·쿠폰 횟수를 원자적으로 반영한다', async () => {
  const db = authenticated();
  await setDoc(reference(db), initial);
  const counts = { kakao: 1, union: 0, donkiCoupon: 1 };
  await assertSucceeds(writeOperation(db, counts, 1, 'calculate'));
  assert.deepEqual((await getDoc(reference(db))).data().counts, counts);
  await assertFails(writeOperation(db, { ...counts, donkiCoupon: 1000001 }, 2));
  await assertFails(writeOperation(db, { ...counts, donkiCoupon: -1 }, 2));
  await assertFails(writeOperation(db, { kakao: 1, union: 1 }, 2));
  await assertSucceeds(writeOperation(db, { ...counts, donkiCoupon: 2 }, 2));
});

test('새 쿠폰 횟수는 0으로만 생성하며 임의 쿠폰 필드와 초과 이관을 거절한다', async () => {
  const db = authenticated();
  await assertFails(setDoc(reference(db), { ...initial, counts: { ...initial.counts, donkiCoupon: 1 } }));
  await assertFails(setDoc(reference(db), { ...initial, counts: { ...initial.counts, donki9: 0 } }));
  await assertSucceeds(setDoc(reference(db), { ...initial, counts: { ...initial.counts, donkiCoupon: 0 } }));
  await assertFails(writeOperation(db, { kakao: 3, union: 5, donkiCoupon: 1000001 }, 1, 'import'));
});
