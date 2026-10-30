#!/usr/bin/env node
/**
 * 端到端验证 /buddy 的选链逻辑：**真的用 bash 跑生成的脚本**，
 * 用一个假 CLI 记录「究竟第一个试了谁、什么时候才动付费模型」。
 *
 * 为什么不用字符串断言：上一版就是「注释写着免费优先、代码里链头是付费模型」，
 * 单测全绿也没拦住。这里让脚本跑一遍，看它实际按什么顺序调用 CLI。
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { buildBuddyScript, DEFAULT_PAID_FALLBACK } from "../src/buddy.js";

let pass = 0;
let fail = 0;

function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

/** 造一个沙箱：假 HOME（放价格表缓存）+ 假 CLI（回显被调用的模型）。 */
function sandbox(models) {
  const root = mkdtempSync(join(tmpdir(), "buddy-chain-"));
  const home = join(root, "home");
  const work = join(root, "work");
  const bin = join(root, "bin");
  mkdirSync(join(home, ".codebuddy", "local_storage"), { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (models) {
    writeFileSync(
      join(home, ".codebuddy", "local_storage", "entry_abc.info"),
      JSON.stringify([{ userId: "u1", data: { models } }]),
    );
  }
  writeFileSync(
    join(bin, "codebuddy"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi',
      'm=""; prev=""',
      'for a in "$@"; do [ "$prev" = "--model" ] && m="$a"; prev="$a"; done',
      'echo "RAN:$m"',
      'case " $FAIL " in *" $m "*) exit 1 ;; esac',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "codebuddy"), 0o755);
  return { root, home, work, bin };
}

/** 跑生成的脚本，返回 stdout+stderr（失败也算，脚本本来就可能 exit 1）。 */
function run(box, extra = {}) {
  try {
    return execFileSync("bash", ["-c", buildBuddyScript({ prompt: "hi" })], {
      env: {
        ...process.env,
        HOME: box.home,
        BUDDY_WORKDIR: box.work,
        PATH: `${box.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        ...extra,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

/** 跑任意一段生成的脚本（打开/登录路径没有 prompt，不能复用 run）。 */
function runScript(box, script) {
  try {
    return execFileSync("bash", ["-c", script], {
      env: {
        ...process.env,
        HOME: box.home,
        BUDDY_WORKDIR: box.work,
        PATH: `${box.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

/** 读沙箱里的 settings.json（不存在就给空对象）。 */
function settings(box) {
  try {
    return JSON.parse(readFileSync(join(box.home, ".codebuddy", "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

const FREE = { id: "hy3", credits: "x0.00 credits" };
const PAID = { id: "deepseek-v4.1-flash", credits: "x0.11 credits" };
const PRICEY = { id: "glm-5.3", credits: "x0.69 credits" };

// ---- 1. 有免费模型：只跑免费的，不碰付费 ----
{
  const box = sandbox([FREE, PAID, PRICEY]);
  const out = run(box);
  check("只跑免费模型", out.includes("RAN:hy3"), true);
  check("没碰付费模型", out.includes("RAN:deepseek-v4.1-flash"), false);
  check("免费跑通不喊花钱", out.includes("💸"), false);
  rmSync(box.root, { recursive: true, force: true });
}

// ---- 2. 免费挂了：明确提示，再换付费并说明倍率 ----
{
  const box = sandbox([FREE, PAID, PRICEY]);
  const out = run(box, { FAIL: "hy3" });
  check("免费失败后换付费", out.includes("RAN:deepseek-v4.1-flash"), true);
  check("失败提示说是免费的", out.includes("免费模型 hy3 不可用"), true);
  check("用付费时明说点数", out.includes("💸") && out.includes("×0.11"), true);
  rmSync(box.root, { recursive: true, force: true });
}

// ---- 3. BUDDY_FREE_ONLY：宁可失败也不花钱 ----
{
  const box = sandbox([FREE, PAID, PRICEY]);
  const out = run(box, { FAIL: "hy3", BUDDY_FREE_ONLY: "1" });
  check("free-only 不动付费", out.includes("RAN:deepseek-v4.1-flash"), false);
  check("free-only 报全都试过", out.includes("链上的都试过了"), true);
  rmSync(box.root, { recursive: true, force: true });
}

// ---- 4. 免费清单是现读的：表里换一个免费模型，链就跟着换 ----
{
  const box = sandbox([
    FREE,
    { id: "glm-5.3-flash", credits: "x0.00 credits" },
    PAID,
  ]);
  const out = run(box, { FAIL: "hy3" });
  check("第二个免费模型被用上", out.includes("RAN:glm-5.3-flash"), true);
  check("两个免费之间不喊花钱", out.includes("💸"), false);
  rmSync(box.root, { recursive: true, force: true });
}

// ---- 5. 读不到价格表：退回内置快照并说明 ----
{
  const box = sandbox(null);
  const out = run(box);
  check("读不到表要说出来", out.includes("读不到 CodeBuddy 的价格表"), true);
  check("读不到表仍先试内置免费", out.includes("RAN:hy3"), true);
  rmSync(box.root, { recursive: true, force: true });
}

// ---- 6. 钉死模型：不读表、不走链 ----
{
  const box = sandbox([FREE, PAID]);
  let out = "";
  try {
    out = execFileSync("bash", ["-c", buildBuddyScript({ prompt: "hi", model: "glm-5.3" })], {
      env: {
        ...process.env,
        HOME: box.home,
        BUDDY_WORKDIR: box.work,
        PATH: `${box.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
      encoding: "utf8",
    });
  } catch (e) {
    out = `${e.stdout ?? ""}`;
  }
  check("钉死模型直接跑", out.includes("RAN:glm-5.3"), true);
  check("钉死模型不试免费", out.includes("RAN:hy3"), false);
  rmSync(box.root, { recursive: true, force: true });
}

// ---- 7. 付费兜底默认顺序仍然来自配置 ----
check("付费兜底默认非空", DEFAULT_PAID_FALLBACK.length > 0, true);

// ---- 8. 打开/登录：默认模型 = 当前免费的，权限 = bypassPermissions ----
// 用户 2026-10-30：「登录 buddy 时选默认免费模型」「启动时自动获得全局权限」。
{
  const box = sandbox([FREE, PAID, PRICEY]);
  runScript(box, buildBuddyScript({}));
  const s = settings(box);
  check("默认模型落在免费模型上", s.model, "hy3");
  check("全局权限已开", s.permissions?.defaultMode, "bypassPermissions");
  rmSync(box.root, { recursive: true, force: true });
}

// ---- 9. 表里换免费模型：登录时默认模型跟着换；但普通提问不覆盖人手选的值 ----
{
  const box = sandbox([{ id: "glm-5.3-flash", credits: "x0.00 credits" }, PAID]);
  // 先模拟用户手选过付费模型
  writeFileSync(
    join(box.home, ".codebuddy", "settings.json"),
    JSON.stringify({ model: "deepseek-v4.1-flash" }),
  );
  run(box); // 普通提问（force=false）：不许动
  check("普通提问不覆盖手选模型", settings(box).model, "deepseek-v4.1-flash");
  runScript(box, buildBuddyScript({})); // 打开/登录（force=true）：拉回免费模型
  check("登录时拉回免费模型", settings(box).model, "glm-5.3-flash");
  rmSync(box.root, { recursive: true, force: true });
}

// ---- 10. 钉死模型时只保证权限，不把钉的值写成默认 ----
{
  const box = sandbox([FREE, PAID]);
  runScript(box, buildBuddyScript({ prompt: "hi", model: "glm-5.3" }));
  const s = settings(box);
  check("钉死模型不写默认", s.model, undefined);
  check("钉死模型也开全局权限", s.permissions?.defaultMode, "bypassPermissions");
  rmSync(box.root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
