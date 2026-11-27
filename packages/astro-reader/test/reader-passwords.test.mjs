import assert from "node:assert/strict";
import test from "node:test";
import { ReaderPasswordError, describeReaderPasswords, pickReaderPasswords } from "../cli-dist/lib/reader-passwords.js";
import {
  formatReaderPasswordSecretNames,
  freeReaderPasswordSlotName,
  isReaderPasswordSecretName,
  isReaderPasswordSlotName,
  nextReaderPasswordSecretName,
  readerPasswordSlotNames,
  parseReaderPasswordSecretNames,
} from "../cli-dist/lib/reader-secret-names.js";

// What `${{ toJSON(secrets) }}` gives a step: every secret of the repository, and the token of the run.
const secrets = JSON.stringify({
  github_token: "ghs_TOKEN_OF_THE_RUN_0123456789",
  READER_PASSWORD_001: "first-secret-value",
  READER_PASSWORD_002: "second secret value",
  READER_PASSWORD_003: "  ",
  DEPLOY_KEY: "unrelated-deploy-key",
});

function assertNoValue(text) {
  for (const value of ["ghs_TOKEN_OF_THE_RUN", "first-secret-value", "second secret value", "unrelated-deploy-key"]) {
    assert.ok(!String(text).includes(value), `a secret value is in «${text}»`);
  }
}

test("the build takes ONLY the listed secrets, whatever else the secrets hold", () => {
  const picked = pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_001, READER_PASSWORD_002", NARRARIUM_READER_SECRETS: secrets });
  assert.deepEqual(picked.passwords, [
    { name: "READER_PASSWORD_001", password: "first-secret-value" },
    { name: "READER_PASSWORD_002", password: "second secret value" },
  ]);
  assert.deepEqual(picked.listed, ["READER_PASSWORD_001", "READER_PASSWORD_002"]);
  assert.deepEqual(picked.missing, []);
  assert.equal(picked.legacy, false);
  assertNoValue(describeReaderPasswords(picked));
  assert.match(describeReaderPasswords(picked), /Protected with 2 passwords \(READER_PASSWORD_001, READER_PASSWORD_002\)/);
});

test("names are matched without regard to case, separated by commas, spaces, semicolons or new lines, and the same name counts once", () => {
  const picked = pickReaderPasswords({ READER_PASSWORD_SECRETS: "reader_password_001;READER_PASSWORD_001\nreader_password_002", NARRARIUM_READER_SECRETS: secrets });
  assert.deepEqual(picked.passwords.map((entry) => entry.name), ["READER_PASSWORD_001", "READER_PASSWORD_002"]);
});

test("no list and no single password: a public book, and nothing is read from the secrets", () => {
  const picked = pickReaderPasswords({ NARRARIUM_READER_SECRETS: secrets });
  assert.deepEqual(picked.passwords, []);
  assert.match(describeReaderPasswords(picked), /without encryption/);
  assert.deepEqual(pickReaderPasswords({ READER_PASSWORD_SECRETS: "  ", NARRARIUM_READER_SECRETS: "" }).passwords, []);
});

test("the single NARRARIUM_READER_PASSWORD of the older books is still one slot, alone or with the list", () => {
  assert.deepEqual(pickReaderPasswords({ NARRARIUM_READER_PASSWORD: "  old single  " }).passwords, [{ name: "NARRARIUM_READER_PASSWORD", password: "old single" }]);
  const both = pickReaderPasswords({ NARRARIUM_READER_PASSWORD: "old single", READER_PASSWORD_SECRETS: "READER_PASSWORD_001", NARRARIUM_READER_SECRETS: secrets });
  assert.deepEqual(both.passwords.map((entry) => entry.name), ["READER_PASSWORD_001", "NARRARIUM_READER_PASSWORD"]);
  assert.equal(both.legacy, true);
});

test("a list without the secrets stops the build instead of publishing the book in clear, naming only the secrets", () => {
  assert.throws(
    () => pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_001" }),
    (error) => error instanceof ReaderPasswordError && /READER_PASSWORD_001/.test(error.message) && /not built/.test(error.message),
  );
  assert.throws(
    () => pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_009,READER_PASSWORD_003", NARRARIUM_READER_SECRETS: secrets }),
    (error) => error instanceof ReaderPasswordError && /READER_PASSWORD_009, READER_PASSWORD_003/.test(error.message),
  );
});

test("a listed secret that is missing or empty is left out and said by name when others remain", () => {
  const picked = pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_001,READER_PASSWORD_003,READER_PASSWORD_004", NARRARIUM_READER_SECRETS: secrets });
  assert.deepEqual(picked.passwords.map((entry) => entry.name), ["READER_PASSWORD_001"]);
  assert.deepEqual(picked.missing, ["READER_PASSWORD_003", "READER_PASSWORD_004"]);
  const line = describeReaderPasswords(picked);
  assert.match(line, /READER_PASSWORD_003, READER_PASSWORD_004/);
  assertNoValue(line);
});

test("malformed secrets JSON fails without quoting it (V8 would quote the start of the text in its own message)", () => {
  const broken = "first-secret-value, not JSON";
  try {
    JSON.parse(broken);
  } catch (error) {
    assert.match(error.message, /first-secr/, "this V8 quotes the start of the text: the guard below matters");
  }
  for (const value of [broken, `{"READER_PASSWORD_001": "first-secret-value", oops}`, "[1,2]", "\"first-secret-value\"", "null"]) {
    assert.throws(
      () => pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_001", NARRARIUM_READER_SECRETS: value }),
      (error) => {
        assert.ok(error instanceof ReaderPasswordError);
        assertNoValue(error.message);
        assert.doesNotMatch(error.message, /first-secr|oops/);
        return true;
      },
    );
  }
});

test("entries of the list that are not secret names stop the build, said by position, not echoed", () => {
  assert.throws(
    () => pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_001,first-secret-value,GITHUB_TOKEN,9LIVES", NARRARIUM_READER_SECRETS: secrets }),
    (error) => {
      assert.ok(error instanceof ReaderPasswordError);
      assert.match(error.message, /entry 2, 3, 4/);
      assertNoValue(error.message);
      return true;
    },
  );
});

test("the list helpers agree with the build on what a list is", () => {
  assert.equal(isReaderPasswordSecretName("READER_PASSWORD_001"), true);
  assert.equal(isReaderPasswordSecretName("github_token"), false);
  assert.equal(isReaderPasswordSecretName("1ABC"), false);
  assert.equal(isReaderPasswordSecretName("A-B"), false);
  assert.deepEqual(parseReaderPasswordSecretNames(" a_1 , B_2;;a_1 "), { names: ["A_1", "B_2"], invalid: [] });
  assert.equal(formatReaderPasswordSecretNames(["reader_password_002", "READER_PASSWORD_001", "reader_password_002"]), "READER_PASSWORD_002,READER_PASSWORD_001");
  assert.equal(formatReaderPasswordSecretNames([]), "");
  assert.throws(() => formatReaderPasswordSecretNames(["not-a-name"]));
  assert.equal(nextReaderPasswordSecretName([]), "READER_PASSWORD_001");
  assert.equal(nextReaderPasswordSecretName(["READER_PASSWORD_001", "READER_PASSWORD_007", "OTHER"]), "READER_PASSWORD_008");
  const roundTrip = pickReaderPasswords({ READER_PASSWORD_SECRETS: formatReaderPasswordSecretNames(["READER_PASSWORD_002"]), NARRARIUM_READER_SECRETS: secrets });
  assert.deepEqual(roundTrip.passwords.map((entry) => entry.name), ["READER_PASSWORD_002"]);
});

// Version 3 of the workflow: no JSON of all the secrets, one environment variable for each password slot.
test("the slots of workflow version 3 are read by name, and nothing else of the environment is", () => {
  const env = {
    READER_PASSWORD_SECRETS: "READER_PASSWORD_001, READER_PASSWORD_002",
    READER_PASSWORD_001: "first-secret-value",
    READER_PASSWORD_002: "second secret value",
    READER_PASSWORD_003: "a slot that is not listed",
    GITHUB_TOKEN: "ghs_TOKEN_OF_THE_RUN_0123456789",
    DEPLOY_KEY: "unrelated-deploy-key",
  };
  const picked = pickReaderPasswords(env);
  assert.deepEqual(picked.passwords, [
    { name: "READER_PASSWORD_001", password: "first-secret-value" },
    { name: "READER_PASSWORD_002", password: "second secret value" },
  ]);
  assert.deepEqual(picked.missing, []);
  assertNoValue(JSON.stringify(picked.listed));
  assertNoValue(describeReaderPasswords(picked));
});

test("a slot that is listed but empty is left out by name, and the build stops when no slot has a value", () => {
  const picked = pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_001,READER_PASSWORD_002", READER_PASSWORD_001: "first-secret-value", READER_PASSWORD_002: "  " });
  assert.deepEqual(picked.passwords.map((entry) => entry.name), ["READER_PASSWORD_001"]);
  assert.deepEqual(picked.missing, ["READER_PASSWORD_002"]);
  assert.throws(
    () => pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_001", READER_PASSWORD_001: "" }),
    (error) => error instanceof ReaderPasswordError && /READER_PASSWORD_001/.test(error.message) && /not built/.test(error.message) && /workflow version 3/.test(error.message),
  );
});

test("a workflow of version 2 still works: the JSON of the secrets is read for the names that are not found in their own variable, and a slot variable wins", () => {
  const picked = pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_001,READER_PASSWORD_002", NARRARIUM_READER_SECRETS: secrets });
  assert.deepEqual(picked.passwords.map((entry) => entry.password), ["first-secret-value", "second secret value"]);
  const mixed = pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_001,READER_PASSWORD_002", READER_PASSWORD_001: "from the slot", NARRARIUM_READER_SECRETS: secrets });
  assert.deepEqual(mixed.passwords, [{ name: "READER_PASSWORD_001", password: "from the slot" }, { name: "READER_PASSWORD_002", password: "second secret value" }]);
});

test("only the slots are read from their own variable: a listed name that is not a slot never reads the environment", () => {
  assert.throws(
    () => pickReaderPasswords({ READER_PASSWORD_SECRETS: "PATH,READER_PASSWORD_025", PATH: "/usr/bin", READER_PASSWORD_025: "beyond the slots" }),
    (error) => error instanceof ReaderPasswordError && /PATH, READER_PASSWORD_025/.test(error.message) && !/usr\/bin|beyond the slots/.test(error.message),
  );
  const fromJson = pickReaderPasswords({ READER_PASSWORD_SECRETS: "READER_PASSWORD_025", NARRARIUM_READER_SECRETS: JSON.stringify({ READER_PASSWORD_025: "beyond the slots" }) });
  assert.deepEqual(fromJson.passwords, [{ name: "READER_PASSWORD_025", password: "beyond the slots" }]);
});

test("the slot names: 24 fixed names, the first free one for a new password, none when all are used", () => {
  const slots = readerPasswordSlotNames();
  assert.equal(slots.length, 24);
  assert.ok(slots.every((name) => isReaderPasswordSlotName(name)));
  for (const name of ["READER_PASSWORD_000", "READER_PASSWORD_025", "READER_PASSWORD_1", "READER_PASSWORD_0001", "NARRARIUM_READER_PASSWORD"]) assert.equal(isReaderPasswordSlotName(name), false, name);
  assert.equal(freeReaderPasswordSlotName([]), "READER_PASSWORD_001");
  assert.equal(freeReaderPasswordSlotName(["READER_PASSWORD_001", "reader_password_002", "READER_PASSWORD_004"]), "READER_PASSWORD_003");
  assert.equal(freeReaderPasswordSlotName(slots), null);
  assert.equal(freeReaderPasswordSlotName([...slots.slice(0, 23)]), "READER_PASSWORD_024");
});
