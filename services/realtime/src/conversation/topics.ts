import type { TranscriptSegment } from "@listen/shared";

import { buildConversationTurns, type ConversationTurn } from "./turns";

export interface ConversationTopic {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string;
  turns: ConversationTurn[];
  keywords: string[];
}

const MIN_TOKEN_LENGTH = 3;
const MIN_TOPIC_TURNS = 3;
const MAX_TOPIC_TURNS = 8;
const MAX_TOPIC_GAP_MS = 45_000;
const TOPIC_SHIFT_PREFIXES = [
  "anyway",
  "before we wrap",
  "circling back",
  "moving on",
  "next topic",
  "one more thing",
  "on that note",
  "quick question",
  "shifting gears",
  "switching gears",
];
const STOP_WORDS = new Set([
  "and",
  "about",
  "after",
  "again",
  "also",
  "can",
  "because",
  "been",
  "being",
  "call",
  "for",
  "first",
  "from",
  "good",
  "have",
  "into",
  "just",
  "lets",
  "like",
  "maybe",
  "more",
  "need",
  "okay",
  "our",
  "really",
  "should",
  "some",
  "thanks",
  "the",
  "than",
  "that",
  "them",
  "then",
  "they",
  "this",
  "those",
  "thing",
  "think",
  "timing",
  "today",
  "want",
  "well",
  "what",
  "yeah",
  "want",
  "with",
  "would",
  "you",
]);

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH)
    .filter((token) => !STOP_WORDS.has(token));
}

function getGapMs(previousEndedAt: string, nextStartedAt: string): number {
  const previousTime = Date.parse(previousEndedAt);
  const nextTime = Date.parse(nextStartedAt);
  if (!Number.isFinite(previousTime) || !Number.isFinite(nextTime)) {
    return 0;
  }

  return Math.max(0, nextTime - previousTime);
}

function startsWithTopicShiftCue(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return TOPIC_SHIFT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function collectKeywords(turns: ConversationTurn[]): string[] {
  const counts = new Map<string, number>();

  for (const turn of turns) {
    for (const token of tokenize(turn.text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([token]) => token);
}

function createTopic(id: number, turns: ConversationTurn[]): ConversationTopic {
  const keywords = collectKeywords(turns);
  return {
    id: `topic-${id}`,
    title: keywords.length ? keywords.join(", ") : "general discussion",
    startedAt: turns[0]?.startedAt ?? new Date().toISOString(),
    endedAt: turns.at(-1)?.endedAt ?? turns[0]?.startedAt ?? new Date().toISOString(),
    turns,
    keywords,
  };
}

function shouldStartNewTopic(currentTurns: ConversationTurn[], nextTurn: ConversationTurn): boolean {
  const previousTurn = currentTurns.at(-1);
  if (!previousTurn) {
    return false;
  }

  if (currentTurns.length >= MAX_TOPIC_TURNS) {
    return true;
  }

  if (getGapMs(previousTurn.endedAt, nextTurn.startedAt) > MAX_TOPIC_GAP_MS) {
    return true;
  }

  if (currentTurns.length >= MIN_TOPIC_TURNS && startsWithTopicShiftCue(nextTurn.text)) {
    return true;
  }

  if (currentTurns.length < MIN_TOPIC_TURNS) {
    return false;
  }

  const topicTokens = new Set(tokenize(currentTurns.map((turn) => turn.text).join(" ")));
  const nextTokens = tokenize(nextTurn.text);
  if (!nextTokens.length) {
    return false;
  }

  return nextTokens.every((token) => !topicTokens.has(token));
}

function scoreTopic(topic: ConversationTopic, query: string): number {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) {
    return 0;
  }

  const topicTokens = new Set(tokenize(`${topic.title} ${topic.keywords.join(" ")} ${topic.turns.map((turn) => turn.text).join(" ")}`));
  let score = 0;
  for (const token of queryTokens) {
    if (topicTokens.has(token)) {
      score += 1;
    }
  }

  return score;
}

export function buildConversationTopics(transcript: TranscriptSegment[]): ConversationTopic[] {
  const turns = buildConversationTurns(transcript);
  if (!turns.length) {
    return [];
  }

  const topics: ConversationTopic[] = [];
  let currentTurns: ConversationTurn[] = [];

  for (const turn of turns) {
    if (currentTurns.length && shouldStartNewTopic(currentTurns, turn)) {
      topics.push(createTopic(topics.length + 1, currentTurns));
      currentTurns = [];
    }

    currentTurns.push(turn);
  }

  if (currentTurns.length) {
    topics.push(createTopic(topics.length + 1, currentTurns));
  }

  return topics;
}

export function selectQuestionRelevantTopics(
  transcript: TranscriptSegment[],
  question: string,
  options?: { recentCount?: number; relevantCount?: number },
): ConversationTopic[] {
  const topics = buildConversationTopics(transcript);
  if (!topics.length) {
    return [];
  }

  const selectedIndexes = new Set<number>();
  const recentCount = options?.recentCount ?? 2;
  const relevantCount = options?.relevantCount ?? 3;

  for (let index = Math.max(0, topics.length - recentCount); index < topics.length; index += 1) {
    selectedIndexes.add(index);
  }

  const rankedTopics = topics
    .map((topic, index) => ({
      index,
      score: scoreTopic(topic, question),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, relevantCount);

  for (const item of rankedTopics) {
    selectedIndexes.add(item.index);
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => topics[index]);
}