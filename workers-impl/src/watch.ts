/**
 * 省额度看门狗（纯逻辑，可单测）。
 *
 * 背景：Codespaces 按机器运行时长计费（免费档 120 core-hours/月，2 核机 ≈ 60 小时），
 * 只要机器在跑就计费，不管你是否在使用。「忘了关」是免费额度的头号杀手。
 * GitHub 自带的 30 分钟空闲超时只覆盖「VS Code 终端/编辑器无活动」的会话；
 * 你通过 Telegram / SSH / 浏览器挂着的会话都可能让机器一直跑。
 *
 * 本模块职责：
 *   evalWatch   —— 核心决策：该提醒 / 该自动关机 / 该何时再查
 *   pushAlarm   —— DO alarm 单槽位软排队（boot 二查与看门狗共用一个 alarm 通道）
 *   fmtDur      —— 时长格式化（Telegram 回包用）
 *
 * 决策规则（两层保险）：
 *   ① 空闲提醒：机器运行中且距上次 Telegram 互动 ≥ REMIND 分钟 → 发提醒
 *     （提醒即续期：再等一个 AUTOSTOP-REMIND 窗口，避免每 5 分钟轰炸）
 *   ② 自动关机：提醒之后仍无互动 ≥ AUTOSTOP 分钟 → 直接 stop（强制，任何进程拦不住）
 *
 * 互动的判定（什么叫「你在用」）：
 *   - 你给 bot 发了任何消息（白名单过滤后 touchWatchActivity）
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
  /** 本轮运行是否由 bot 指令发起（开始开发） */
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
  if (!w.running) return { notify: null, stop: false, nextCheck: null, markReminded: false };

  // 运行时长的兜底起点：没记录 bootAt 时用 lastActivity 估（比 0 合理）
  const boot = w.bootAt > 0 ? w.bootAt : w.lastActivity;

  const idleMin = (w.now - w.lastActivity) / MIN; // 距你上次终端级互动
  const runMin = Math.max(0, (w.now - boot) / MIN); // 本轮已运行

  // 1) 互动还新鲜：你正在干活，别打扰
  if (idleMin < w.remindMin) {
    return { notify: null, stop: false, nextCheck: w.lastActivity + w.remindMin * MIN, markReminded: false };
  }

  // 2) 提醒窗口内：提示一次（防轰炸：本轮窗口只发一次）
  if (idleMin < w.autostopMin) {
    if (w.reminded) {
      // 已提醒过：静默等到自动关机点
      return {
        notify: null,
        stop: false,
        nextCheck: w.lastActivity + w.autostopMin * MIN,
        markReminded: false,
      };
    }
    const later = Math.max(0, w.autostopMin - idleMin);
    return {
      notify:
        `⏰ 开发机已运行 ${fmtDur(runMin)}，你已 ${fmtDur(idleMin)} 没和我说过话。\n` +
        (w.botStarted && w.autostopEnabled
          ? `再不理我就自动关机（约 ${fmtDur(later)}后）。在干活就随便回我一个字。`
          : `不用了就发「停止开发」，我帮你关机省额度。`),
      stop: false,
      nextCheck: w.lastActivity + w.autostopMin * MIN,
      markReminded: true,
    };
  }

  // 3) 超过自动关机阈值 —— 先看 GitHub 第二信号
  if (w.ghLastUsedAt !== null) {
    const ghIdleMin = (w.now - w.ghLastUsedAt) / MIN;
    if (ghIdleMin < 10) {
      // 你正在 VS Code / 网页 / SSH 里干活：绝不打扰，推迟 30 分钟再查
      return { notify: null, stop: false, nextCheck: w.now + 30 * MIN, markReminded: false };
    }
  }

  // 4) 双信号都空闲 → 执行关机策略
  if (w.botStarted && w.autostopEnabled) {
    return {
      notify: `🛑 闲置超时：已 ${fmtDur(idleMin)} 无互动，自动关机（本轮共运行 ${fmtDur(runMin)}）。需要时发「开始开发」重新开机。`,
      stop: true,
      nextCheck: null,
      markReminded: false,
    };
  }

  // 5) observed（非 bot 开机）：提醒一次后 2 小时静默，防刷屏
  if (w.reminded) {
    return { notify: null, stop: false, nextCheck: w.now + 120 * MIN, markReminded: false };
  }
  return {
    notify:
      `⏰ 开发机已闲置 ${fmtDur(idleMin)}（本轮运行 ${fmtDur(runMin)}），仍在运行。\n` +
      (w.autostopEnabled
        ? `这轮不是通过我开的机，我不敢自动关。不用了请发「停止开发」。`
        : `自动关机未启用。不用了请发「停止开发」。`),
    stop: false,
    nextCheck: w.now + 120 * MIN, // 2 小时静默期后再提醒
    markReminded: true,
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
  /** 任务种类：boot_check | watch */
  kind: "boot_check" | "watch";
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
