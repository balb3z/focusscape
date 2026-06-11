import { cpSync, existsSync } from "fs";
if (existsSync("public")) {
  cpSync("public", ".vercel/output/static", { recursive: true });
  console.log("Copied public/ to .vercel/output/static/");
}
