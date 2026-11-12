#!/usr/bin/env node
// 拉取 GitHub 统计并生成 assets/stats.svg，同时把卡片写入 README.md 的 STATS 标记之间。
// 依赖：Node 18+（内置 fetch），无需安装任何包。
// 环境变量：GITHUB_TOKEN（必填）、GITHUB_LOGIN（可选，默认 humyue）

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com/graphql";
const SVG_PATH = join(ROOT, "assets", "stats.svg");
const README_PATH = join(ROOT, "README.md");

const W = 720;
const H = 316;

/* ---------------------------------- 数据 ---------------------------------- */

const PROFILE_QUERY = `
query($login: String!) {
  user(login: $login) {
    followers { totalCount }
    repositories(ownerAffiliations: OWNER, isFork: false) { totalCount }
    contributionsCollection {
      restrictedContributionsCount
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

const REPO_PAGE_QUERY = `
query($login: String!, $cursor: String) {
  user(login: $login) {
    repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { stargazerCount primaryLanguage { name } }
    }
  }
}`;

async function graphql(query, variables) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-card",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    throw new Error(`GitHub API 调用失败: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

export async function fetchStats(login) {
  const profile = await graphql(PROFILE_QUERY, { login });
  const user = profile.user;
  if (!user) throw new Error(`找不到用户: ${login}`);

  // 分页累加所有非 fork 仓库的 star，避免只统计前 100 个
  let stars = 0;
  let cursor = null;
  const languages = new Map();
  do {
    const page = await graphql(REPO_PAGE_QUERY, { login, cursor });
    const repos = page.user.repositories;
    for (const repo of repos.nodes) {
      stars += repo.stargazerCount;
      const name = repo.primaryLanguage?.name;
      if (name) languages.set(name, (languages.get(name) ?? 0) + 1);
    }
    cursor = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
  } while (cursor);

  const c = user.contributionsCollection;
  const contributions =
    c.totalCommitContributions +
    c.totalPullRequestContributions +
    c.totalIssueContributions +
    c.totalPullRequestReviewContributions +
    c.restrictedContributionsCount;

  const days = c.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount }));

  const { current: currentStreak } = computeStreaks(days);

  return {
    login,
    stars,
    repos: user.repositories.totalCount,
    followers: user.followers.totalCount,
    contributions,
    commits: c.totalCommitContributions,
    currentStreak,
    languages: topLanguages(languages, 5),
    updatedAt: formatNow(),
  };
}

export function computeStreaks(days) {
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const day of days) {
    if (day.count > 0) {
      run = prev && Date.parse(day.date) - Date.parse(prev) === 86400000 ? run + 1 : 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
    prev = day.date;
  }
  // 今天还没贡献不应算断签，所以从倒数第二天继续往前数
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i -= 1;
  let current = 0;
  while (i >= 0 && days[i].count > 0) {
    current += 1;
    i -= 1;
  }
  return { current, longest };
}

function topLanguages(counter, limit) {
  const total = [...counter.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  const sorted = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, limit);
  const rest = sorted.slice(limit).reduce((a, [, n]) => a + n, 0);
  const items = head.map(([name, n]) => ({ name, percent: Math.round((n / total) * 100) }));
  if (rest > 0) items.push({ name: "Other", percent: Math.round((rest / total) * 100) });
  return items;
}

function formatNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/* ---------------------------------- 渲染 ---------------------------------- */

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

const num = (n) => n.toLocaleString("en-US");

export function renderCard(stats) {
  // 网格：3 列 × 2 行，行/列之间留 1px 分隔线
  const gridX = 24;
  const gridW = W - 24 * 2;
  const tileW = (gridW - 2) / 3;
  const tileH = 62;
  const gridY = 64;

  const tiles = [
    { value: num(stats.stars), label: "Total Stars · 总 Star", hero: true },
    { value: num(stats.repos), label: "Public Repos · 公开仓库" },
    { value: num(stats.followers), label: "Followers · 关注者" },
    { value: num(stats.contributions), label: "Contributions 1y · 近一年贡献" },
    { value: num(stats.commits), label: "Commits 1y · 近一年提交" },
    { value: `${num(stats.currentStreak)} 天`, label: "Current Streak · 当前连击" },
  ];

  const tileRects = [];
  const tileTexts = [];
  tiles.forEach((tile, i) => {
    const x = gridX + (i % 3) * (tileW + 1);
    const y = gridY + Math.floor(i / 3) * (tileH + 1);
    tileRects.push(`<rect x="${f(x)}" y="${y}" width="${f(tileW)}" height="${tileH}" class="tile"/>`);
    tileTexts.push(
      `<text x="${f(x + 16)}" y="${y + 27}" class="val${tile.hero ? " hero" : ""}">${numText(tile.value)}</text>`,
      `<text x="${f(x + 16)}" y="${y + 47}" class="lab">${escapeXml(tile.label)}</text>`,
    );
  });

  // 语言占比条
  const barX = 24;
  const barW = gridW;
  const barY = 224;
  const series = ["s1", "s2", "s3", "s4", "so"];
  let cursorX = barX;
  const barSegs = stats.languages.map((lang, i) => {
    const segW = Math.max((lang.percent / 100) * barW - (i === stats.languages.length - 1 ? 0 : 2), 0);
    const rect = `<rect x="${f(cursorX)}" y="${barY}" width="${f(segW)}" height="8" class="${series[i] ?? "so"}"/>`;
    cursorX += segW + 2;
    return rect;
  });

  const legend = stats.languages.map((lang, i) => {
    const x = barX + i * (barW / Math.max(stats.languages.length, 1));
    const name = lang.name.length > 14 ? `${lang.name.slice(0, 13)}…` : lang.name;
    return `<circle cx="${f(x + 4)}" cy="250" r="4" class="${series[i] ?? "so"}"/><text x="${f(x + 14)}" y="254" class="lab">${escapeXml(name)} <tspan class="strong">${lang.percent}%</tspan></text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub stats for ${escapeXml(stats.login)}">
  <style>
    .bg { fill: #FDFCF8; }
    .tile { fill: #F5F2E9; }
    .bd { fill: rgba(28, 25, 23, 0.12); }
    .ln { stroke: rgba(28, 25, 23, 0.12); stroke-width: 1; }
    .t { fill: #1C1917; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 16px; font-weight: 500; }
    .val { fill: #1C1917; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .val.hero { fill: #78350F; }
    .lab { fill: #57534E; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 12px; font-weight: 400; }
    .strong { fill: #1C1917; font-weight: 500; }
    .tm { fill: #57534E; font-size: 12px; font-weight: 400; }
    .bt { fill: #78350F; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 12px; font-weight: 500; }
    .chip { fill: #FEF3C7; stroke: #FDE68A; stroke-width: 1; }
    .s1 { fill: #B45309; }
    .s2 { fill: #FDE68A; }
    .s3 { fill: #D97706; }
    .s4 { fill: #F97316; }
    .so { fill: #D6D3D1; }
    .accent { fill: #D97706; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #1C1917; }
      .tile { fill: #292524; }
      .bd { fill: rgba(231, 229, 228, 0.12); }
      .ln { stroke: rgba(231, 229, 228, 0.12); }
      .t, .val, .strong { fill: #E7E5E4; }
      .val.hero { fill: #FEF3C7; }
      .lab, .tm { fill: #A8A29E; }
      .bt { fill: #FEF3C7; }
      .chip { fill: #78350F; stroke: #B45309; }
      .s1 { fill: #F59E0B; }
      .s2 { fill: #92400E; }
      .s3 { fill: #D97706; }
      .s4 { fill: #FB923C; }
      .so { fill: #57534E; }
      .accent { fill: #F59E0B; }
    }
  </style>
  <defs><clipPath id="card"><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12"/></clipPath></defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" class="bg"/>
  <g clip-path="url(#card)"><rect x="0" y="0" width="${W}" height="3" class="accent"/></g>
  <text x="24" y="41" class="t">GitHub Stats<tspan class="tm"> · GitHub 统计</tspan></text>
  <rect x="627" y="23" width="69" height="24" rx="12" class="chip"/>
  <text x="661.5" y="39" class="bt" text-anchor="middle">@${escapeXml(stats.login)}</text>
  <rect x="${gridX}" y="${gridY}" width="${gridW}" height="${tileH * 2 + 1}" class="bd"/>
  ${tileRects.join("\n  ")}
  ${tileTexts.join("\n  ")}
  <text x="24" y="213" class="tm">Top Languages · 常用语言</text>
  ${barSegs.length ? `<clipPath id="bar"><rect x="${barX}" y="${barY}" width="${barW}" height="8" rx="4"/></clipPath>\n  <g clip-path="url(#bar)">${barSegs.join("")}</g>` : `<text x="24" y="${barY + 8}" class="lab">No data</text>`}
  ${legend.join("\n  ")}
  <line x1="24" y1="276" x2="696" y2="276" class="ln"/>
  <text x="24" y="296" class="lab">Updated ${stats.updatedAt} (UTC+8) · 每日自动更新</text>
  <text x="696" y="296" class="lab" text-anchor="end">Powered by GitHub Actions</text>
</svg>
`;
}

const f = (n) => Math.round(n * 100) / 100;
const numText = (s) => String(s).replace(/&/g, "&amp;");

/* ---------------------------------- 主流程 -------------------------------- */

const README_BLOCK = `<!-- STATS:START -->
![GitHub Stats](./assets/stats.svg)
<!-- STATS:END -->`;

async function writeIfChanged(path, content, made) {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === content) {
    made.push(`${path} 未变化`);
    return false;
  }
  await writeFile(path, content);
  made.push(`${path} 已更新`);
  return true;
}

export async function main() {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("缺少 GITHUB_TOKEN 环境变量");
  }
  const login = process.env.GITHUB_LOGIN || "humyue";
  const stats = await fetchStats(login);

  await mkdir(join(ROOT, "assets"), { recursive: true });
  const made = [];
  await writeIfChanged(SVG_PATH, renderCard(stats), made);

  const readme = await readFile(README_PATH, "utf8");
  const marker = /<!-- STATS:START -->[\s\S]*?<!-- STATS:END -->/;
  const next = marker.test(readme)
    ? readme.replace(marker, README_BLOCK)
    : `${readme.trimEnd()}\n\n${README_BLOCK}\n`;
  await writeIfChanged(README_PATH, next, made);

  console.log(made.join("\n"));
  return stats;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
