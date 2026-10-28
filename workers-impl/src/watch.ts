/**
 * 省额度看门狗（纯逻辑，可单测）。
 *
 * 背景：Codespaces 按机器运行时长计费（免费档 120 core-hours/月，2 核机 ≈ 60 小时），
 * 只要机器在跑就计费，不管你是否在使用。「忘了关」是免费额度的头号杀手。
 * GitHub 自带的 30 分钟空闲超时只覆盖「VS Code 终端/编辑器无活动」的会话；
 * 你通过 Telegram / SSH / 浏览器挂着的会话都可能让机器一直跑。
 *
 * 本模块职责：
 *   evalWatch      —— 核心决策：该提醒 / 该自动关机 / 该何时再查
 *   evalShellAlert —— shell 离线告警：机器在跑但 agent 没连上时主动告知
 *   pushAlarm      —— DO alarm 单槽位软排队（boot 二查与看门狗共用一个 alarm 通道）
 *   fmtDur         —— 时长格式化（Telegram 回包用）
 *
 * 决策规则（三层防护）：
 *   ① 空闲提醒：机器运行中且距上次终端级 Telegram 互动 ≥ REMIND 分钟 → 发提醒
 *     （提醒即续期：再等一个 AUTOSTOP-REMIND 窗口，避免每 5 分钟轰炸）
 *   ② 自动关机：提醒之后仍无互动 ≥ AUTOSTOP 分钟，且 GitHub 侧也空闲
 *     （last_used_at ≥ 10 分钟没刷新；VS Code/网页/SSH 在用会刷新——双信号防误杀）
 *   ③ 活跃上限保险丝（本次新增）：当 GitHub 侧一直报「活跃」导致 ② 被无限推迟时，
 *     仅凭 GH 信号无法区分「人在 VS Code 干活」和「dev server 刷日志续命」——
 *     两者在 API 上完全一样。解法是不再无限推迟，而是转为一个有界的确认流程：
 *       - Telegram 连续空闲达到 GH_CAP 分钟且 GH 仍报活跃 → 判定「疑似刷日志续命」
 *       - 发一次警告并启动 GRACE 分钟倒计时（回我任意一个字即取消并全部复位）
 *       - 倒计时走完仍无互动 → 强制关机（有硬上限，杜绝无限泄漏）
 *     保守场景下可用 CS_GH_CAP_ACTION="notify" 降级为「只提醒、永不自动关」。
 *
 * 互动的判定（什么叫「你在用」）：
 *   - 你给 bot 发了终端级消息（开始/停止/状态/用量等指令；纯聊天不续命）
 *   - 你刚开机 / 刚查过状态（ensureWatch 重置起点）
 *   origin=bot 的操作（你自己触发的开机/状态查询）之后允许自动关机；
 *   origin=observed（巡检发现机器在跑，但你很久没说话）只提醒不自动关 ——
 *   可能你正开着 VS Code / 浏览器干正事，误杀代价高（丢了 tmux 会话、
 *   未提交工作需要重新 git 状态），宁可多烧几分钟也不误关。
 */

/** 看门狗决策输入。 */
export interface WatchInput {
  /** 开发机是否在运行（Available） */
  running: boolean;
  /** 当前时间戳（ms） */
  now: number;
  /** 最近一次「终端级」Telegram 互动时间（开关机/状态查询/终端指令；纯聊天不算） */
  lastActivity: number;
  /** 上次开机时间（本轮运行窗口的起点；无记录 = 0） */
  bootAt: number;
  /** 本轮运行是否由 bot 指令发起（/boot） */
  botStarted: boolean;
  /** 提醒阈值分钟（vars CS_WATCH_REMIND_MIN，默认 25） */
  remindMin: number;
  /** 自动关机阈值分钟（vars CS_WATCH_AUTOSTOP_MIN，默认 55） */
  autostopMin: number;
  /** 是否启用自动关机（vars CS_WATCH_AUTOSTOP=0 可只提醒不动手） */
  autostopEnabled: boolean;
  /** 本轮窗口是否已发过提醒（防轰炸；发过就只等自动关机） */
  reminded: boolean;
  /** GitHub last_used_at 时间戳（ms；null=未知）。VS Code/网页/SSH 在用会刷新——第二信号 */
  ghLastUsedAt: number | null;
  /** GH 连续活跃追踪起点（ms；null=未在追踪）。跨检查持久化于 episode */
  ghFreshSince: number | null;
  /** 本轮窗口是否已发过「GH 持续活跃上限」警告（防轰炸：只发一次） */
  capNotified: boolean;
  /** 上限警告发出的时刻（ms；用于宽限倒计时）。跨检查持久化于 episode */
  capNotifiedAt: number | null;
  /** GH 连续活跃上限（分钟，默认 180）：持续活跃但 Telegram 全程零互动 → 触发确认流程 */
  ghCapMin: number;
  /** 触达上限后的动作："notify"=只提醒（永不自动关） | "stop"=警告+宽限倒计时后强制关机 */
  ghCapAction: "notify" | "stop";
  /** "stop" 模式下的宽限期（分钟，默认 15）：警告后给多久让你回一个字取消 */
  graceMin: number;
}

/** 看门狗决策输出。 */
export interface WatchDecision {
  /** 发 Telegram 提醒（非空字符串） */
  notify: string | null;
  /** 执行 REST 强制停机（notify 同时会有说明） */
  stop: boolean;
  /** 下次看门狗检查的时间戳；null = 无需再排（机器已关/已停机） */
  nextCheck: number | null;
  /** 决策后是否标记「已提醒」（写回 episode 状态用） */
  markReminded: boolean;
  /** 写回 episode 的 GH 追踪起点（null = 清零重置） */
  ghFreshSince: number | null;
  /** 写回 episode 的「上限已提醒」标记 */
  capNotified: boolean;
  /** 写回 episode 的「上限警告时刻」（null = 清零） */
  capNotifiedAt: number | null;
}

const MIN = 60_000;

/**
 * 核心决策。语义要点：
 *   - 机器没跑 → 不打扰、不排程（patrol 周期巡检兜底，无需 alarm 密集轮询）
 *   - 互动新鲜（< remindMin）→ 静默，排到「互动满 remindMin」时再看
 *   - 提醒窗口内（remindMin ≤ idle < autostopMin）→ 发提醒（若未发过），排到 autostop 满点
 *   - 超过 autostopMin：
 *       ① GitHub 侧活跃（last_used_at < 10 分钟）→ 你在 VS Code/网页/SSH 干活，
 *          不打扰，推迟 30 分钟再查（双信号防误杀）
 *       ② origin=bot → 自动关机（你自己开的机，bot 负责善后）
 *       ③ origin=observed → 只提醒一次（2 小时静默期，防刷屏），之后低频复查
 *
 * observed 防刷屏：提醒过（reminded）就不再发，直接排 2 小时后再看；
 * 期间你一旦有终端级互动（touchWatchActivity），reminded 复位、窗口重来。
 */
export function evalWatch(w: WatchInput): WatchDecision {
  // 0) 机器没跑：无事可做
  if (!w.running) {
    return {
      notify: null,
      stop: false,
      nextCheck: null,
      markReminded: false,
      ghFreshSince: null,
      capNotified: false,
      capNotifiedAt: null,
    };
  }

  // 运行时长的兜底起点：没记录 bootAt 时用 lastActivity 估（比 0 合理）
  const boot = w.bootAt > 0 ? w.bootAt : w.lastActivity;

  const idleMin = (w.now - w.lastActivity) / MIN; // 距你上次终端级互动
  const runMin = Math.max(0, (w.now - boot) / MIN); // 本轮已运行

  // 1) 互动还新鲜：你正在干活，别打扰（同时把第三信号追踪清零）
  if (idleMin < w.remindMin) {
    return {
      notify: null,
      stop: false,
      nextCheck: w.lastActivity + w.remindMin * MIN,
      markReminded: false,
      ghFreshSince: null, // 你刚互动过：GH 追踪重置
      capNotified: false,
      capNotifiedAt: null,
    };
  }

  // GitHub 第二信号：last_used_at 是否在 10 分钟内刷新过
  // （VS Code 打字、网页操作、SSH 连接、以及终端输出都会刷新它）
  const ghFresh = w.ghLastUsedAt !== null && (w.now - w.ghLastUsedAt) / MIN < 10;

  // 2) 提醒窗口内：提示一次（防轰炸：本轮窗口只发一次）
  if (idleMin < w.autostopMin) {
    if (w.reminded) {
      // 已提醒过：静默等到自动关机点
      return {
        notify: null,
        stop: false,
        nextCheck: w.lastActivity + w.autostopMin * MIN,
        markReminded: false,
        ghFreshSince: w.ghFreshSince,
        capNotified: w.capNotified,
        capNotifiedAt: w.capNotifiedAt,
      };
    }
    const later = Math.max(0, w.autostopMin - idleMin);
    // GH 侧活跃时不承诺自动关机会不会执行——它会被无限推迟，说了不算
    const tail = ghFresh
      ? `看起来你还在别处（VS Code／网页／SSH）干活，先不打扰。不用了记得发 /halt 省额度。`
      : w.botStarted && w.autostopEnabled
        ? `再不理我就自动关机（约 ${fmtDur(later)}后）。在干活就随便回我一个字。`
        : `不用了就发 /halt，我帮你关机省额度。`;
    return {
      notify: `⏰ 开发机已运行 ${fmtDur(runMin)}，你已 ${fmtDur(idleMin)} 没和我说过话。\n` + tail,
      stop: false,
      nextCheck: w.lastActivity + w.autostopMin * MIN,
      markReminded: true,
      ghFreshSince: w.ghFreshSince,
      capNotified: w.capNotified,
      capNotifiedAt: w.capNotifiedAt,
    };
  }

  // 3) 超过自动关机阈值 —— 先看 GitHub 第二信号
  if (ghFresh) {
    // GH 说「有人在用」。可能性有二，API 上完全无法区分：
    //   (a) 你在 VS Code / 网页 / SSH 里正经干活
    //   (b) dev server 刷日志，被动刷新 last_used_at，人早走了
    // (a) 不能误杀，所以先推迟；但推迟必须有上限，否则 (b) 会无限续命烧掉整晚额度。
    const freshSince = w.ghFreshSince ?? w.now; // 首次发现活跃：从此刻开始计时
    const freshMin = (w.now - freshSince) / MIN;
    const capHit = w.ghCapMin > 0 && idleMin >= w.ghCapMin;

    // 触达上限 → 进入「有界确认」：警告一次 + 宽限倒计时，到期才动手
    if (capHit && w.autostopEnabled && w.ghCapAction === "stop") {
      if (!w.capNotified) {
        return {
          notify:
            `⚠️ 开发机显示「持续活跃」已 ${fmtDur(freshMin)}，但你 ${fmtDur(idleMin)} 没和我说过话。\n` +
            `这很像 dev server 在刷日志给 GitHub 的活跃信号续命（人已离开但机器一直计费）。\n` +
            `${fmtDur(w.graceMin)}后我会强制关机；在干活就随便回我一个字，立刻取消。`,
          stop: false,
          nextCheck: w.now + Math.max(1, w.graceMin) * MIN,
          markReminded: true,
          ghFreshSince: freshSince,
          capNotified: true,
          capNotifiedAt: w.now,
        };
      }
      const since = w.capNotifiedAt ?? w.now;
      const waited = (w.now - since) / MIN;
      if (waited >= w.graceMin) {
        return {
          notify:
            `🛑 疑似闲置：GH 显示活跃但你 ${fmtDur(idleMin)} 无互动，已过 ${fmtDur(w.graceMin)} 宽限期，强制关机` +
            `（本轮共运行 ${fmtDur(runMin)}）。需要时发 /boot 重新开机。`,
          stop: true,
          nextCheck: null,
          markReminded: false,
          ghFreshSince: null,
          capNotified: false,
          capNotifiedAt: null,
        };
      }
      // 宽限期未走完：等到宽限点再判
      return {
        notify: null,
        stop: false,
        nextCheck: since + w.graceMin * MIN,
        markReminded: false,
        ghFreshSince: freshSince,
        capNotified: true,
        capNotifiedAt: since,
      };
    }

    // 触达上限但自动关机被关闭（或 action=notify）：只提醒一次，绝不动手
    if (capHit && !w.capNotified) {
      return {
        notify:
          `⚠️ 开发机显示「持续活跃」已 ${fmtDur(freshMin)}，但你 ${fmtDur(idleMin)} 没和我说过话` +
          `（疑似 dev server 刷日志在给 GitHub 的活跃信号续命）。\n` +
          `当前为「只提醒、不自动关机」模式，我不会动手；不用了请发 /halt 省额度。`,
        stop: false,
        nextCheck: w.now + 60 * MIN,
        markReminded: true,
        ghFreshSince: freshSince,
        capNotified: true,
        capNotifiedAt: w.now,
      };
    }

    // 未触达上限：常规推迟 30 分钟（保留 GH 追踪起点）
    return {
      notify: null,
      stop: false,
      nextCheck: w.now + 30 * MIN,
      markReminded: false,
      ghFreshSince: freshSince,
      capNotified: w.capNotified,
      capNotifiedAt: w.capNotifiedAt,
    };
  }

  // 4) 双信号都空闲 → 重置 GH 追踪，执行关机策略
  if (w.botStarted && w.autostopEnabled) {
    return {
      notify: `🛑 闲置超时：已 ${fmtDur(idleMin)} 无互动，自动关机（本轮共运行 ${fmtDur(runMin)}）。需要时发 /boot 重新开机。`,
      stop: true,
      nextCheck: null,
      markReminded: false,
      ghFreshSince: null,
      capNotified: false,
      capNotifiedAt: null,
    };
  }

  // 5) observed（非 bot 开机）：提醒一次后 2 小时静默，防刷屏
  if (w.reminded) {
    return {
      notify: null,
      stop: false,
      nextCheck: w.now + 120 * MIN,
      markReminded: false,
      ghFreshSince: null,
      capNotified: w.capNotified,
      capNotifiedAt: w.capNotifiedAt,
    };
  }
  return {
    notify:
      `⏰ 开发机已闲置 ${fmtDur(idleMin)}（本轮运行 ${fmtDur(runMin)}），仍在运行。\n` +
      (w.autostopEnabled
        ? `这轮不是通过我开的机，我不敢自动关。不用了请发 /halt。`
        : `自动关机未启用。不用了请发 /halt。`),
    stop: false,
    nextCheck: w.now + 120 * MIN, // 2 小时静默期后再提醒
    markReminded: true,
    ghFreshSince: null,
    capNotified: false,
    capNotifiedAt: null,
  };
}

/** 分钟 → 「2小时35分」式中文时长（Telegram 回包用）。 */
export function fmtDur(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}分钟`;
  if (r === 0) return `${h}小时`;
  return `${h}小时${r}分`;
}

// ---------------------------------------------------------------------------
// shell 离线告警
// ---------------------------------------------------------------------------

/**
 * shell 离线告警（纯逻辑，可单测）。
 *
 * 痛点：机器在跑（GitHub state=Available），但 codespace 里的 agent 没连上 SSE，
 * 于是「发命令给 bot，它不回」——而你在 Telegram 侧完全看不到原因，只能自己发现。
 * 巡检（cron 半小时）已经存在，这里补的是「离线时主动告诉你」。
 *
 * 三个必须处理的判据，否则要么漏报要么误报刷屏：
 *   ① 机器没在跑 → shell 离线是预期的（关机了），不算故障，且状态一律复位；
 *      否则下一次开机后会用「关机期间累积的离线时长」误告警一次。
 *   ② 刚断线 ≠ 真故障：DO 重载 / 机器休眠恢复 / agent 重启都会瞬断，
 *      给 graceMin 宽限期（默认 5 分钟）躲开，别一断就喊。
 *   ③ 离线起点要用「最后一次心跳」而不是「本次巡检时刻」：巡检半小时一次，
 *      用巡检时刻会把「agent 早已断线 40 分钟」算成「刚断线」，宽限期永远走不完 → 永远不告警。
 *
 * 防刷屏：一段离线只告一次；持续离线按 repeatMin（默认 120 分钟）重发，0 = 只告一次。
 */
export interface ShellAlertInput {
  /** 机器是否在运行（GitHub state === "Available"） */
  machineRunning: boolean;
  /** shell 是否在线（SSE 连接 + 心跳未超时） */
  shellOnline: boolean;
  /** 当前时间戳（ms） */
  now: number;
  /** 最近一次 shell 心跳（ms；0 = 本实例从未见过 agent） */
  lastSeen: number;
  /** 上一次判定离线的起点（ms；null = 在线或未追踪）。跨巡检持久化 */
  offlineSince: number | null;
  /** 本段离线是否已告警过（防轰炸） */
  alerted: boolean;
  /** 上次告警时刻（ms；null = 没告过）。用于重复告警间隔 */
  alertedAt: number | null;
  /** 断线多久才认定「真离线」（分钟，默认 5） */
  graceMin: number;
  /** 持续离线时的重复告警间隔（分钟，默认 120；0 = 只告一次） */
  repeatMin: number;
}

export interface ShellAlertDecision {
  /** 发 Telegram 告警（null = 不打扰） */
  notify: string | null;
  /** 写回：离线起点（null = 复位） */
  offlineSince: number | null;
  /** 写回：本段离线是否已告警 */
  alerted: boolean;
  /** 写回：上次告警时刻 */
  alertedAt: number | null;
}

export function evalShellAlert(s: ShellAlertInput): ShellAlertDecision {
  // ① 机器没跑 / shell 在线 → 离线是预期的，状态全部复位
  //    （漏了复位会攒出一次「开机即告警」的误报）
  if (!s.machineRunning || s.shellOnline) {
    return { notify: null, offlineSince: null, alerted: false, alertedAt: null };
  }

  // ③ 起点优先取最后心跳时刻；本实例从没见过 agent（DO 刚重载）才退化为 now
  const since = s.offlineSince ?? (s.lastSeen > 0 ? s.lastSeen : s.now);
  const offMin = Math.max(0, (s.now - since) / MIN);

  // ② 宽限期内：可能只是瞬断，先记着起点，不打扰
  if (offMin < s.graceMin) {
    return { notify: null, offlineSince: since, alerted: false, alertedAt: null };
  }

  if (!s.alerted) {
    return { notify: shellAlertText(offMin, false), offlineSince: since, alerted: true, alertedAt: s.now };
  }
  // 已告过：按间隔重发（0 = 永不重发），否则静默保持状态
  if (s.repeatMin > 0 && s.alertedAt !== null && (s.now - s.alertedAt) / MIN >= s.repeatMin) {
    return { notify: shellAlertText(offMin, true), offlineSince: since, alerted: true, alertedAt: s.now };
  }
  return { notify: null, offlineSince: since, alerted: true, alertedAt: s.alertedAt };
}

function shellAlertText(offMin: number, repeat: boolean): string {
  const head = repeat
    ? `🔁 shell 仍未连上（已断开 ${fmtDur(offMin)}）`
    : `⚠️ shell 通道断开：开发机在运行，但里面的 agent 已 ${fmtDur(offMin)} 没心跳`;
  return (
    `${head}\n` +
    `这个状态下我收不到命令回包，表现就是「发命令没反应」。\n` +
    `常见原因：agent 进程崩了、机器刚从休眠恢复、或 Worker 刚重载（重载后会自动重连）。\n` +
    `先发 /cs 看状态；确认一直连不上就 /halt 再 /boot 重启一轮（未提交的工作会丢，先确认）。`
  );
}

// ---------------------------------------------------------------------------
// DO alarm 单槽位软排队
// ---------------------------------------------------------------------------

/**
 * DO 只有一个 alarm 槽位，但 boot 二查（30s）与看门狗（分钟级）会竞争它。
 * 方案：DO storage 里维护一个 {due, kind, payload} 任务队列：
 *   pushAlarm  —— 插入任务（同 kind 去重覆盖，保持队首最小）
 *   drainAlarms —— 队首到期时依次执行（alarm() 回调里调用）
 * 纯逻辑部分只做数据操作，执行通过回调注入，便于单测。
 */

export interface AlarmTask {
  /** 到期时间戳（ms） */
  due: number;
  /** 任务种类：boot_check | watch | gemini_prep | buddy_prep（等 shell 连上后准备/启动对应 CLI） */
  kind: "boot_check" | "watch" | "gemini_prep" | "buddy_prep";
  /** 附带数据（如 boot_check 的 chat_id） */
  payload?: Record<string, unknown>;
}

/** 任务队列存储接口（DO ctx.storage 的最小子集，单测可 mock）。 */
export interface AlarmStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  setAlarm(time: number | null): Promise<void>;
}

const QUEUE_KEY = "alarmq";

/** 插入一个任务：同 kind 覆盖旧的；重排 alarm 到最早到期点。返回队首任务。 */
export async function pushAlarm(
  store: AlarmStore,
  task: AlarmTask,
): Promise<AlarmTask | undefined> {
  const q = (await store.get<AlarmTask[]>(QUEUE_KEY)) ?? [];
  const idx = q.findIndex((t) => t.kind === task.kind);
  if (idx >= 0) q[idx] = task;
  else q.push(task);
  q.sort((a, b) => a.due - b.due);
  await store.put(QUEUE_KEY, q);
  if (q[0].due <= Date.now()) {
    // 已过期：立即触发（alarm 传 0/过去时间即刻唤醒）
    await store.setAlarm(Date.now() + 1);
  } else {
    await store.setAlarm(q[0].due);
  }
  return q[0];
}

/** 取出到期的队首任务（可能多个连续到期）；无任务时清掉 alarm。 */
export async function drainAlarms(store: AlarmStore): Promise<AlarmTask[]> {
  const q = (await store.get<AlarmTask[]>(QUEUE_KEY)) ?? [];
  const now = Date.now();
  const due: AlarmTask[] = [];
  while (q.length > 0 && q[0].due <= now) due.push(q.shift()!);
  if (q.length > 0) await store.setAlarm(q[0].due);
  else await store.setAlarm(null);
  if (due.length > 0 || (await store.get<AlarmTask[]>(QUEUE_KEY)) !== undefined) {
    await store.put(QUEUE_KEY, q);
  }
  return due;
}
