import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withServer } from "./helpers.mjs";

const site = new URL("../../../src/narrarium-site/public/", import.meta.url);

test("the admin panel links its icon and serves the site's own icon, byte for byte, without a session", async () => {
  await withServer(async (server) => {
    const page = await (await fetch(`${server.adminUrl}/`)).text();
    assert.match(page, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
    const svg = await fetch(`${server.adminUrl}/favicon.svg`);
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    // A checkout on Windows may turn the line endings of the text file into CRLF: the text is the same.
    assert.equal(await svg.text(), readFileSync(new URL("favicon.svg", site), "utf8").replace(/\r\n/g, "\n"));
    const ico = await fetch(`${server.adminUrl}/favicon.ico`);
    assert.equal(ico.status, 200);
    assert.equal(ico.headers.get("content-type"), "image/x-icon");
    assert.equal(Buffer.from(await ico.arrayBuffer()).equals(readFileSync(new URL("favicon.ico", site))), true);
  });
});
