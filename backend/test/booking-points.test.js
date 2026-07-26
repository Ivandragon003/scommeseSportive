'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bookingPoints } = require('../dist/utils/dataHelpers');

// Regola bookmaker (Eurobet/Goldbet/888): giallo=1, rosso=2, doppia
// ammonizione=2. Nel dataset Understat (unica fonte cartellini) sia il rosso
// diretto sia la doppia ammonizione sono codificati come 0 gialli + 1 rosso,
// quindi yellows + 2*reds coincide col settlement in tutti i casi.
// NON cambiare la formula in "solo rossi diretti": vedi analisi A6.
test('booking points: solo giallo (1y, 0r) => 1', () => {
  assert.equal(bookingPoints(1, 0), 1);
});

test('booking points: rosso diretto (0y, 1r) => 2', () => {
  assert.equal(bookingPoints(0, 1), 2);
});

test('booking points: giallo + rosso diretto (1y, 1r) => 3', () => {
  assert.equal(bookingPoints(1, 1), 3);
});

test('booking points: doppia ammonizione (codifica Understat 0y, 1r) => 2', () => {
  // Il referto ufficiale direbbe 2 gialli + 1 rosso, ma Understat registra la
  // doppia ammonizione come 0 gialli + 1 rosso: la formula la conta come 2.
  assert.equal(bookingPoints(0, 1), 2);
});

test('booking points: match reale con piu cartellini (4y, 1r) => 6', () => {
  assert.equal(bookingPoints(4, 1), 6);
});

test('booking points: input non finiti trattati come 0', () => {
  assert.equal(bookingPoints(NaN, 2), 4);
  assert.equal(bookingPoints(3, undefined), 3);
});
