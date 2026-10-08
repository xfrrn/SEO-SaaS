import assert from "node:assert/strict";
import test from "node:test";
import {
	currencyDigits,
	money,
	parsePrice,
	priceInput,
} from "../lib/format.ts";

test("converts USD, JPY, and KWD prices into exact integer minor units", () => {
	for (const [currency, digits, input, amount] of [
		["USD", 2, "19.99", 1999],
		["USD", 2, "0.09", 9],
		["USD", 2, "9.9", 990],
		["JPY", 0, "1234", 1234],
		["KWD", 3, "1.234", 1234],
		["KWD", 3, "0.001", 1],
		["KWD", 3, "1.2", 1200],
	] as const) {
		assert.equal(currencyDigits(currency), digits);
		assert.equal(parsePrice(input, currency), amount);
		assert.equal(parsePrice(` ${input} `, currency), amount);
	}
});

test("formats catalog minor units for display and editing without changing price", () => {
	for (const [currency, amount, editable, displayed] of [
		["USD", 1999, "19.99", "19.99"],
		["JPY", 1234, "1234", "1,234"],
		["KWD", 1234, "1.234", "1.234"],
		["KWD", 1, "0.001", "0.001"],
	] as const) {
		assert.equal(priceInput(amount, currency), editable);
		assert.equal(parsePrice(priceInput(amount, currency), currency), amount);
		assert.equal(money(amount, currency).replace(/[^\d.,-]/g, ""), displayed);
	}
});

test("accepts zero and the largest safe integer minor-unit amount", () => {
	for (const [currency, maximum] of [
		["USD", "90071992547409.91"],
		["JPY", "9007199254740991"],
		["KWD", "9007199254740.991"],
	] as const) {
		assert.equal(parsePrice("0", currency), 0);
		assert.equal(parsePrice(maximum, currency), Number.MAX_SAFE_INTEGER);
		assert.equal(priceInput(Number.MAX_SAFE_INTEGER, currency), maximum);
		assert.equal(
			money(Number.MAX_SAFE_INTEGER, currency).replace(/[^\d.]/g, ""),
			maximum,
		);
	}
});

test("rejects invalid numeric syntax and fractional minor units", () => {
	for (const input of [
		"",
		" ",
		"NaN",
		"Infinity",
		"-1",
		"+1",
		"1e2",
		"1,000",
		"1/2",
		"0x10",
		"1.",
		".5",
	]) {
		assert.throws(() => parsePrice(input, "USD"), /正确的价格/);
	}
	for (const [currency, input] of [
		["USD", "0.001"],
		["USD", "1.000"],
		["JPY", "1.5"],
		["JPY", "1.0"],
		["KWD", "0.0001"],
		["KWD", "1.2340"],
	] as const) {
		assert.throws(() => parsePrice(input, currency), /正确的价格/);
	}
});

test("rejects amounts whose minor units overflow the safe integer range", () => {
	for (const [currency, input] of [
		["USD", "90071992547409.92"],
		["JPY", "9007199254740992"],
		["KWD", "9007199254740.992"],
		["USD", "9".repeat(400)],
	] as const) {
		assert.throws(() => parsePrice(input, currency), /超出可用范围/);
	}
});

/** @see https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml */
test("uses ISO minor units instead of locale display rounding for checkout amounts", () => {
	for (const currency of [
		"HUF",
		"MGA",
		"AFN",
		"ALL",
		"COP",
		"IDR",
		"ISK",
		"UGX",
	]) {
		const digits = ["ISK", "UGX"].includes(currency) ? 0 : 2;
		const input = digits ? "123.45" : "12345";
		assert.equal(currencyDigits(currency), digits);
		assert.equal(parsePrice(input, currency), 12345);
		assert.equal(priceInput(12345, currency), input);
		assert.equal(money(12345, currency).replace(/[^\d.]/g, ""), input);
	}
});
