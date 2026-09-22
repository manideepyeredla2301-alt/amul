'use strict';

class AppError extends Error {
  constructor(message, status = 400, code = 'VALIDATION_ERROR') {
    super(message); this.status = status; this.code = code;
  }
}
const clean = (value) => String(value ?? '').trim();
function nonNegativeWhole(value, label = 'Value') {
  if (value === null || value === '' || typeof value === 'boolean') throw new AppError(`${label} must be a whole number of zero or more.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AppError(`${label} must be a safe whole number of zero or more.`);
  return parsed;
}
function whole(value, label = 'Quantity') {
  const parsed = nonNegativeWhole(value, label);
  if (!parsed) throw new AppError(`${label} must be a whole number greater than zero.`);
  return parsed;
}
function safeAmount(value, label = 'Amount') {
  const integer = typeof value === 'bigint' ? value : BigInt(nonNegativeWhole(value, label));
  if (integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError(`${label} is too large.`);
  return Number(integer);
}
function paise(value, label = 'Amount') {
  const raw = clean(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new AppError(`${label} must be a non-negative amount with at most two decimal places.`);
  const [units, decimals = ''] = raw.split('.');
  return safeAmount(BigInt(units) * 100n + BigInt(decimals.padEnd(2, '0')), label);
}
function businessToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function dateOnly(value, label = 'Date') {
  const result = clean(value) || businessToday();
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new AppError(`${label} must be a real calendar date in YYYY-MM-DD format.`);
  return result;
}
function addDays(isoDate, days) {
  const date = new Date(`${dateOnly(isoDate)}T00:00:00Z`);
  const count = nonNegativeWhole(days, 'Credit days');
  if (count > 36500) throw new AppError('Credit days cannot exceed 36500.');
  date.setUTCDate(date.getUTCDate() + count);
  const result = date.toISOString().slice(0, 10);
  return dateOnly(result);
}
function rate(value) {
  const result = nonNegativeWhole(value, 'GST rate');
  if (result > 10000) throw new AppError('GST rate cannot exceed 100%.');
  return result;
}
function multiply(a, b, label = 'Line amount') { return safeAmount(BigInt(a) * BigInt(b), label); }
function sum(values, label = 'Total') { return safeAmount(values.reduce((total, value) => total + BigInt(value), 0n), label); }
function proportional(total, numerator, denominator) { return safeAmount((BigInt(total) * BigInt(numerator) * 2n + BigInt(denominator)) / (BigInt(denominator) * 2n)); }
function paymentMethod(value = 'CASH') {
  const result = clean(value).toUpperCase();
  if (!['CASH', 'UPI', 'CARD', 'BANK', 'OTHER'].includes(result)) throw new AppError('Payment method must be CASH, UPI, CARD, BANK or OTHER; credit is an unpaid balance, not money collected.');
  return result;
}
module.exports = { AppError, clean, whole, nonNegativeWhole, safeAmount, paise, dateOnly, addDays, businessToday, rate, multiply, sum, proportional, paymentMethod };
