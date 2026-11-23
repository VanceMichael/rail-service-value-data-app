import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = new URL('../tools/service-review.mjs', import.meta.url).pathname;

async function runCli(args, options = {}) {
  const { stdout } = await run(process.execPath, [cli, ...args], { ...options, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

test('review 默认出审议包，--json 可被解析', async () => {
  const text = await runCli(['review']);
  assert.match(text, /候选方案 S0、S1、S2/);
  assert.match(text, /推荐：S2/);
  assert.match(text, /不可外推/);

  const json = JSON.parse(await runCli(['review', '--json']));
  assert.ok(json.comparison.summary.length >= 3);
  assert.ok(Array.isArray(json.suppressed.rows));
});

test('allocate 与 lot 子命令给出计法与交付窗口', async () => {
  const text = await runCli(['allocate', 'S2']);
  assert.match(text, /车底衔接：可行/);
  assert.match(text, /分站：/);

  const infeasible = await runCli(['allocate', 'S1']);
  assert.match(infeasible, /车底衔接：不可行/);
  assert.match(infeasible, /不能报复运收益/);

  const lot = JSON.parse(await runCli(['lot', 'L2', '--option', 'S2', '--json']));
  assert.equal(lot.deliveryWindow.from, 5);
  assert.equal(lot.allocation.obligationMet, true);
});

test('--source 指向别处资料，坏引用会报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-'));
  try {
    for (const name of ['format.json', 'loads.csv', 'transfers.csv', 'road-survey.csv', 'legs.csv',
      'obligations.csv', 'port-calls.csv', 'vehicle-rules.csv', 'freight-profile.csv',
      'service-capture.csv', 'shipment-receipts.csv']) {
      await writeFile(join(dir, name), await readFile(new URL(`../fixtures/${name}`, import.meta.url)));
    }
    const ok = await runCli(['compare', '--source', dir]);
    assert.match(ok, /S2/);

    const csv = await readFile(join(dir, 'loads.csv'), 'utf8');
    // destination 是 format.json 里声明的引用；改成不存在的站应被拒绝。
    await writeFile(join(dir, 'loads.csv'), csv.replace('L1,F1,A,P', 'L1,F1,A,Q'));
    await assert.rejects(runCli(['compare', '--source', dir]), /无对应记录/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('未知方案与坏参数给出明确错误', async () => {
  await assert.rejects(runCli(['allocate', 'S9']), /未知方案 S9/);
  await assert.rejects(runCli(['allocate', 'S2', '--mode', 'fast']), /--mode/);
  await assert.rejects(runCli(['lot']), /需要货批号/);
});
