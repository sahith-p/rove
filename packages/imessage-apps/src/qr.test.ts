import { test } from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { codeQrPng, qrPng, stickerPng } from "./qr";

const PAY_URL = "https://rove-demo.vercel.app/pay/K7Q2MX";
const SHOP_URL = "https://rove-demo.vercel.app/m/ahseng";
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
