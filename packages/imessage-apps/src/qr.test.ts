import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { codeQrPng, qrPng, stickerPng } from "./qr";

const PAY_URL = "https://rove-demo.vercel.app/pay/K7Q2MX";
const SHOP_URL = "https://rove-demo.vercel.app/m/ahseng";
const SHORT_URL = "https://rove.to/p/K7";
const LONG_URL =
  "https://rove-demo.vercel.app/pay/K7Q2MX?merchant=ahseng-hainanese-chicken-rice&amount=6.50&currency=XSGD&ref=inv_01JABCDEF0123456789XYZ";
const NAME_60 = "Ah Seng Hainanese Chicken Rice & Roasted Meats Stall #01-23A";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function decode(png: Uint8Array): { data: string; width: number; height: number } {
  assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE, "PNG signature");
  const img = PNG.sync.read(Buffer.from(png));
  const pixels = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length);
  const result = jsQR(pixels, img.width, img.height);
  assert.ok(result, "QR code should decode");
  return { data: result.data, width: img.width, height: img.height };
}

test("qrPng: plain QR decodes back to the URL", async () => {
  const out = decode(await qrPng(PAY_URL));
  assert.equal(out.data, PAY_URL);
  assert.equal(out.width, 1024);
  assert.equal(out.height, 1024);
});

test("qrPng: custom size", async () => {
  const out = decode(await qrPng(SHOP_URL, { size: 512 }));
  assert.equal(out.data, SHOP_URL);
  assert.equal(out.width, 512);
});

test("qrPng: small render still decodes (dots + custom eyes survive downscaling)", async () => {
  assert.equal(decode(await qrPng(PAY_URL, { size: 240 })).data, PAY_URL);
});

test("qrPng: short and long URLs", async () => {
  for (const url of [SHORT_URL, LONG_URL]) {
    assert.equal(decode(await qrPng(url)).data, url);
  }
});

test("qrPng: deterministic output", async () => {
  assert.deepEqual(await qrPng(PAY_URL, { size: 400 }), await qrPng(PAY_URL, { size: 400 }));
});

test("codeQrPng: one-time QR with the typed code decodes back to the URL", async () => {
  const out = decode(
    await codeQrPng({
      url: PAY_URL,
      code: "K7Q2MX",
      title: "Ah Seng Chicken Rice",
      amountText: "S$6.50",
      expiresText: "Single use · expires 3:42pm",
    }),
  );
  assert.equal(out.data, PAY_URL);
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1400);
});

test("codeQrPng: minimal input and hostile text", async () => {
  assert.equal(decode(await codeQrPng({ url: PAY_URL, code: "K7Q2MX" })).data, PAY_URL);
  const out = decode(
    await codeQrPng({
      url: PAY_URL,
      code: "<&>",
      title: `Tom & Jerry's <script>"x"</script> ${"Long ".repeat(12)}`,
      amountText: "S$<1&2>",
    }),
  );
  assert.equal(out.data, PAY_URL);
});

test("stickerPng: sticker decodes back to the shop URL", async () => {
  const out = decode(
    await stickerPng({
      name: "Ah Seng Chicken Rice",
      url: SHOP_URL,
      shopCode: "ahseng",
      roveNumber: "+1 555 010 2030",
      verified: true,
    }),
  );
  assert.equal(out.data, SHOP_URL);
  assert.equal(out.width, 1200);
  assert.equal(out.height, 1600);
});

test("codeQrPng: short and long URLs", async () => {
  for (const url of [SHORT_URL, LONG_URL]) {
    const out = decode(await codeQrPng({ url, code: "K7Q2MX", title: "Ah Seng", amountText: "S$6.50" }));
    assert.equal(out.data, url);
    assert.equal(out.width, 1080);
    assert.equal(out.height, 1400);
  }
});

test("stickerPng: 60-char name with short and long URLs", async () => {
  assert.equal([...NAME_60].length, 60);
  for (const url of [SHOP_URL, SHORT_URL, LONG_URL]) {
    const out = decode(
      await stickerPng({ name: NAME_60, url, shopCode: "ahsenghainanese", roveNumber: "+65 8123 4567", verified: true }),
    );
    assert.equal(out.data, url);
    assert.equal(out.width, 1200);
    assert.equal(out.height, 1600);
  }
});

test("stickerPng: text renders from the bundled Geist fonts (system fonts are off)", async () => {
  const png = await stickerPng({ name: "Ah Seng", url: SHOP_URL, shopCode: "ahseng", verified: true });
  const img = PNG.sync.read(Buffer.from(png));
  // Count dark pixels in the shop-name band; with no font loaded the band would be blank.
  let dark = 0;
  for (let y = 90; y < 330; y++) {
    for (let x = 100; x < img.width - 100; x++) {
      if (img.data[(y * img.width + x) * 4]! < 100) dark++;
    }
  }
  assert.ok(dark > 5000, `expected rendered name text, got ${dark} dark px`);
});

test("stickerPng: long names, special characters, unverified", async () => {
  const names = [
    "Ah Seng Hainanese Chicken Rice & Roasted Meats Stall #01-23 AMK",
    "Supercalifragilisticexpialidociousfoodstallwithaverylongnamethatneverends",
    `Tom & Jerry's <Kopi> "Bar"`,
    "   ",
  ];
  for (const name of names) {
    const out = decode(await stickerPng({ name, url: SHOP_URL, shopCode: "ahseng", verified: false }));
    assert.equal(out.data, SHOP_URL);
  }
});
