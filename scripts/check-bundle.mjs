#!/usr/bin/env node
// Fails if the built web bundle contains anything that looks like an API key, or the actual
// key values from the environment / .env. Run after `pnpm build` (CI and `pnpm e2e` do).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'apps/web/dist';
if (!existsSync(dist)) {
  console.error(`check-bundle: ${dist} not found; build the web app first.`);
  process.exit(2);
}

const patterns = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/, 'Anthropic key (sk-ant-…)'],
  [/AIza[0-9A-Za-z_-]{30,}/, 'Google API key (AIza…)'],
  [/ANTHROPIC_API_KEY|GEMINI_API_KEY/, 'key variable name'],
];
const values = new Set();
for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) if (process.env[name]?.trim()) values.add(process.env[name].trim());
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^(ANTHROPIC_API_KEY|GEMINI_API_KEY)=(.+)$/.exec(line.trim());
    if (m?.[2]?.trim()) values.add(m[2].trim().replace(/^["']|["']$/g, ''));
  }
}

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(dist);

const problems = [];
for (const f of files) {
  const text = readFileSync(f, 'latin1');
  for (const [re, label] of patterns) if (re.test(text)) problems.push(`${f}: ${label}`);
  for (const v of values) if (v.length >= 8 && text.includes(v)) problems.push(`${f}: contains a configured API key value`);
}
if (problems.length) {
  console.error(`check-bundle: secrets found in the web bundle!\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-bundle: ${files.length} files clean (no API keys).`);
