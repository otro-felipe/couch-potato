import { connect } from "../dist/client/index.js";

const browser = await connect();

try {
  const page = await browser.openPage("https://example.com/");
  const heading = page.locator("h1");
  await heading.waitFor({ state: "visible" });
  process.stdout.write(`${await heading.textContent()}\n`);
  await page.detach();
} finally {
  browser.close();
}
