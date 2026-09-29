import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const urlIndex = process.argv.findIndex(argument => argument === "--url");
const inlineUrl = process.argv.find(argument => argument.startsWith("--url="))?.slice(6);
const baseUrl = (inlineUrl || (urlIndex >= 0 ? process.argv[urlIndex + 1] : "") || process.env.LOWTALK_URL || "").replace(/\/$/, "");

if (!/^https:\/\/[^/]+$/.test(baseUrl)) {
  console.error("公開URLを指定してください: npm run admin:reset -- --url https://example.workers.dev");
  process.exit(1);
}

const characters = randomBytes(12).toString("base64url");
const temporaryPassword = `LT-${characters.match(/.{1,4}/g).join("-")}`;
const sessionSecret = randomBytes(32).toString("base64url");
const resetToken = randomBytes(32).toString("base64url");

function putSecret(name, value) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    cwd: process.cwd(), input: `${value}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

async function resetAdmin() {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/admin/reset`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${resetToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ password: temporaryPassword })
      });
      if (response.ok) return await response.json();
      if (![401, 503].includes(response.status)) throw new Error(await response.text());
    } catch (error) {
      if (attempt === 14) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error("Cloudflareへの設定反映を確認できませんでした");
}

console.log("LOWTALKの管理者用一時パスワードを発行しています…");
putSecret("ADMIN_SESSION_SECRET", sessionSecret);
putSecret("ADMIN_RESET_TOKEN", resetToken);

try {
  const result = await resetAdmin();
  putSecret("ADMIN_RESET_TOKEN", randomBytes(32).toString("base64url"));
  console.log("\n管理者用の一時パスワードを発行しました。\n");
  console.log(`  管理画面: ${baseUrl}/`);
  console.log(`  一時パスワード: ${temporaryPassword}\n`);
  console.log(`有効期限: ${new Date(result.expiresAt).toLocaleString("ja-JP")}`);
  console.log("ログイン後、ブラウザ上で新しいパスワードへ変更してください。");
} catch (error) {
  putSecret("ADMIN_RESET_TOKEN", randomBytes(32).toString("base64url"));
  console.error(`管理者のリセットに失敗しました: ${error.message}`);
  process.exit(1);
}

