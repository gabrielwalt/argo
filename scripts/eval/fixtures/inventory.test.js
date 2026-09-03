const test = require('node:test');
const assert = require('node:assert/strict');
const { reserveStock, releaseReservation } = require('../src/inventory.js');

function freshInventory() {
  return { widget: { available: 10, reservations: {} } };
}

test('reserveStock reserves the requested amount when enough is available', () => {
  const inv = freshInventory();
  const r = reserveStock(inv, 'widget', 4);
  assert.equal(r.reserved, 4);
  assert.equal(inv.widget.available, 6);
});

test('reserveStock partially reserves when requested exceeds available, and reports the actual amount', () => {
  const inv = freshInventory();
  const r = reserveStock(inv, 'widget', 15);
  assert.equal(r.requested, 15);
  assert.equal(r.reserved, 10); // only 10 were available
  assert.equal(inv.widget.available, 0);
});

test('releaseReservation restores exactly what was actually reserved for a full reservation', () => {
  const inv = freshInventory();
  const r = reserveStock(inv, 'widget', 4);
  releaseReservation(inv, 'widget', r.reservationId);
  assert.equal(inv.widget.available, 10);
});

test('releaseReservation restores exactly what was actually reserved for a PARTIAL reservation — not the original request', () => {
  const inv = freshInventory();
  const r = reserveStock(inv, 'widget', 15); // only 10 available, partial reservation of 10
  assert.equal(r.reserved, 10);
  releaseReservation(inv, 'widget', r.reservationId);
  // Must restore exactly 10 (what was actually taken), never 15 (what was merely
  // requested) — over-restoring would let inventory exceed its true starting stock.
  assert.equal(inv.widget.available, 10);
});

test('multiple independent reservations and releases net out correctly, including a partial one', () => {
  const inv = freshInventory();
  const r1 = reserveStock(inv, 'widget', 3);   // full: reserved 3, available 7
  const r2 = reserveStock(inv, 'widget', 20);  // partial: reserved 7, available 0
  assert.equal(r2.reserved, 7);
  releaseReservation(inv, 'widget', r1.reservationId); // restores 3 -> available 3
  releaseReservation(inv, 'widget', r2.reservationId); // restores 7 -> available 10
  assert.equal(inv.widget.available, 10); // back to the original starting stock exactly
});

test('releaseReservation throws for an unknown reservation id', () => {
  const inv = freshInventory();
  assert.throws(() => releaseReservation(inv, 'widget', 'nope'));
});
