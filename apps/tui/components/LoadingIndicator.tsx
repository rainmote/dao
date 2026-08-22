import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';

import { qwenTheme } from '../theme.js';

export interface LoadingIndicatorProps {
  busy: boolean;
  mode?: 'working' | 'waiting-for-confirmation';
  phase?: string;
  label?: string;
  elapsedSeconds?: number;
  terminalWidth?: number;
  phrases?: readonly string[];
  random?: () => number;
}

const QWEN_BASE_LOADING_PHRASES = [
  '正在努力搬砖，请稍候...',
  '老板在身后，快加载啊！',
  '头发掉光前，一定能加载完...',
  '服务器正在深呼吸，准备放大招...',
  '正在向服务器投喂咖啡...',
  '正在赋能全链路，寻找关键抓手...',
  '正在降本增效，优化加载路径...',
  '正在打破部门壁垒，沉淀方法论...',
  '正在拥抱变化，迭代核心价值...',
  '正在对齐颗粒度，打磨底层逻辑...',
  '大力出奇迹，正在强行加载...',
  '只要我不写代码，代码就没有 Bug...',
  '正在把 Bug 转化为 Feature...',
  '只要我不尴尬，Bug 就追不上我...',
  '正在试图理解去年的自己写了什么...',
  '正在猿力觉醒中，请耐心等待...',
  '正在询问产品经理：这需求是真的吗？',
  '正在给产品经理画饼，请稍等...',
  '每一行代码，都在努力让世界变得更好一点点...',
  '每一个伟大的想法，都值得这份耐心的等待...',
  '别急，美好的事物总是需要一点时间去酝酿...',
  '愿你的代码永无 Bug，愿你的梦想终将成真...',
  '哪怕只有 0.1% 的进度，也是在向目标靠近...',
  '加载的是字节，承载的是对技术的热爱...',
] as const;

const ADDITIONAL_HUMOROUS_LOADING_PHRASES = [
  '正在召开紧急会议，讨论为什么还没加载完...',
  '程序员正在重启服务，也顺便重启一下人生...',
  '数据库说它没有卡，只是在认真思考...',
  '缓存正在回忆自己到底缓存了什么...',
  '编译器正在逐字审阅，态度比甲方还严谨...',
  '日志太多，线索正在排队进场...',
  'Bug 已进入会议室，拒绝承认自己是 Bug...',
  '正在用二分法定位今天的坏运气...',
  '测试环境一切正常，问题只在需要演示时出现...',
  '正在给超时设置一个更有耐心的超时...',
  '代码正在运行，请勿突然提出新需求...',
  '产品经理说只是小改，服务器听完沉默了...',
  '正在把临时方案精心维护成永久架构...',
  '技术债正在按复利增长，请稍候...',
  '正在清理缓存，希望顺便清理掉历史问题...',
  '依赖正在互相甩锅，稍后公布调查结果...',
  '网络没有断，它只是去远方寻找自己...',
  '正在向橡皮鸭解释，橡皮鸭已经懂了...',
  'CPU 正在加班，风扇负责制造气氛...',
  '内存正在努力忘记不重要的事情...',
  '进程还活着，只是回复消息比较慢...',
  '正在排查薛定谔的 Bug：一看日志就消失...',
  '正在把“不可能”改成“下个版本支持”...',
  '需求正在澄清，只是越澄清越多...',
  '正在同步数据，也同步一下大家的口径...',
  '服务器正在热身，预计很快进入状态...',
  '正在让正则表达式解释它自己的行为...',
  'Git 正在判断这次冲突是谁先动的手...',
  '正在从 Stack Trace 里寻找人生方向...',
  '这不是卡顿，是系统在制造悬念...',
  '正在加载核心能力，边缘能力稍后补票...',
  '代码审核中，每个变量都要交代来历...',
  '正在把错误信息翻译成人类语言...',
  '测试用例正在努力证明开发过于乐观...',
  '正在等待一个承诺会很快返回的 Promise...',
  '队列正在有序拥堵，请耐心排队...',
  '正在为除零错误寻找一个合适的解释...',
  '服务发现了自己，暂时还没发现对方...',
  '正在压缩输出，顺便压缩一点焦虑...',
  '配置文件正在确认今天该听谁的...',
  '正在修复最后一个 Bug，和上一个最后一个不同...',
  '数据正在赶来，路上遇到了序列化...',
  '正在进行无损优化，损失的是下班时间...',
  '容器已经启动，里面的梦想还在初始化...',
  '正在核对权限，连管理员本人也很紧张...',
  '接口正在返回，返回之前先去了一趟网关...',
  '正在建立连接，社恐协议需要一点时间...',
  '任务正在并发执行，问题也开始并发出现...',
  '正在恢复现场，请不要移动那行可疑代码...',
  '马上完成，只差一个无法估时的小问题...',
] as const;

export const QWEN_LOADING_PHRASES = [
  ...QWEN_BASE_LOADING_PHRASES,
  ...ADDITIONAL_HUMOROUS_LOADING_PHRASES,
] as const;

export const DOTS_SPINNER_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;

export const TMUX_SPINNER_FRAMES = ['. ', '..'] as const;
export const TOGGLE_SPINNER_FRAMES = ['⊶', '⊷'] as const;
export const PHRASE_CHANGE_INTERVAL_MS = 15_000;
export const WAITING_FOR_CONFIRMATION_TEXT =
  'Waiting for user confirmation...';

function formatElapsed(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function pickPhrase(phrases: readonly string[], random: () => number): string {
  const value = random();
  const normalized = Number.isFinite(value)
    ? Math.min(Math.max(value, 0), 1 - Number.EPSILON)
    : 0;
  return phrases[Math.floor(normalized * phrases.length)] ?? phrases[0] ?? '';
}

export interface AnimatedSpinnerProps {
  type?: 'dots' | 'toggle';
}

export function AnimatedSpinner({ type = 'dots' }: AnimatedSpinnerProps) {
  const isTmux = Boolean(process.env.TMUX);
  const frames = isTmux
    ? TMUX_SPINNER_FRAMES
    : type === 'toggle'
      ? TOGGLE_SPINNER_FRAMES
      : DOTS_SPINNER_FRAMES;
  const intervalMs = isTmux ? 750 : type === 'toggle' ? 250 : 80;
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    setFrameIndex(0);
    const interval = setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, intervalMs);
    return () => clearInterval(interval);
  }, [frames, intervalMs]);

  return <Text color={qwenTheme.text.primary}>{frames[frameIndex]}</Text>;
}

function useLoadingPhrase(
  busy: boolean,
  label: string | undefined,
  phrases: readonly string[],
  random: () => number,
): string {
  const [currentPhrase, setCurrentPhrase] = useState(() =>
    pickPhrase(phrases, random),
  );
  const wasBusy = useRef(busy);

  useEffect(() => {
    if (!busy || label !== undefined) {
      wasBusy.current = busy;
      return undefined;
    }

    if (!wasBusy.current) setCurrentPhrase(pickPhrase(phrases, random));
    wasBusy.current = true;
    const interval = setInterval(() => {
      setCurrentPhrase(pickPhrase(phrases, random));
    }, PHRASE_CHANGE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [busy, label, phrases, random]);

  return label ?? currentPhrase;
}

function useElapsedSeconds(
  busy: boolean,
  elapsedSeconds: number | undefined,
  paused: boolean,
): number {
  const [localElapsed, setLocalElapsed] = useState(0);
  const activeSince = useRef<number | null>(null);
  const accumulatedMs = useRef(0);
  const wasBusy = useRef(busy);

  useEffect(() => {
    if (!busy || elapsedSeconds !== undefined) {
      activeSince.current = null;
      accumulatedMs.current = 0;
      wasBusy.current = busy;
      if (!busy) setLocalElapsed(0);
      return undefined;
    }

    if (!wasBusy.current) {
      activeSince.current = null;
      accumulatedMs.current = 0;
      setLocalElapsed(0);
    }
    wasBusy.current = true;

    if (paused) {
      setLocalElapsed(accumulatedMs.current / 1000);
      return undefined;
    }

    if (activeSince.current === null) activeSince.current = performance.now();

    const update = () => {
      const runningMs = activeSince.current === null
        ? 0
        : Math.max(0, performance.now() - activeSince.current);
      setLocalElapsed((accumulatedMs.current + runningMs) / 1000);
    };
    const interval = setInterval(() => {
      update();
    }, 500);
    update();

    return () => {
      clearInterval(interval);
      if (activeSince.current !== null) {
        accumulatedMs.current += Math.max(
          0,
          performance.now() - activeSince.current,
        );
        activeSince.current = null;
      }
    };
  }, [busy, elapsedSeconds, paused]);

  return elapsedSeconds ?? localElapsed;
}

/** Qwen-style status row for an active model/tool phase. */
export function LoadingIndicator({
  busy,
  mode = 'working',
  phase,
  label,
  elapsedSeconds,
  terminalWidth = 80,
  phrases,
  random = Math.random,
}: LoadingIndicatorProps) {
  const waitingForConfirmation = mode === 'waiting-for-confirmation';
  const activelyWorking = busy && !waitingForConfirmation;
  const availablePhrases = useMemo(
    () => (phrases && phrases.length > 0 ? phrases : QWEN_LOADING_PHRASES),
    [phrases],
  );
  const status = useLoadingPhrase(
    activelyWorking,
    label,
    availablePhrases,
    random,
  );
  const elapsed = useElapsedSeconds(
    activelyWorking,
    elapsedSeconds,
    phase === 'tool',
  );

  if (waitingForConfirmation) {
    return (
      <Box paddingLeft={2}>
        <Text color={qwenTheme.text.primary}>⠏</Text>
        <Text> </Text>
        <Text color={qwenTheme.text.accent} wrap="truncate-end">
          {WAITING_FOR_CONFIRMATION_TEXT}
        </Text>
      </Box>
    );
  }

  if (!busy) return null;

  if (terminalWidth <= 30) {
    return (
      <Box paddingLeft={2}>
        <Text color={qwenTheme.text.secondary}>(Esc to cancel)</Text>
      </Box>
    );
  }

  const statusContent = (
    <Box>
      <Box marginRight={1}>
        <AnimatedSpinner />
      </Box>
      <Text color={qwenTheme.text.accent} wrap="truncate-end">
        {status}
      </Text>
    </Box>
  );
  const timerContent = (
    <Text color={qwenTheme.text.secondary}>
      ({formatElapsed(elapsed)} · esc to cancel)
    </Text>
  );

  if (terminalWidth < 80) {
    return (
      <Box paddingLeft={2} flexDirection="column">
        {statusContent}
        <Box>{timerContent}</Box>
      </Box>
    );
  }

  return (
    <Box paddingLeft={2}>
      {statusContent}
      <Text> </Text>
      {timerContent}
    </Box>
  );
}

export default LoadingIndicator;
