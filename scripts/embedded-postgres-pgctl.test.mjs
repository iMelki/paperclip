import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Execute the actual added lifecycle blocks, with no vendor install or database.
const patch = readFileSync(new URL('../patches/embedded-postgres@18.1.0-beta.16.patch', import.meta.url), 'utf8');
const blocks = patch.split(/^@@/m).map((hunk) => hunk.split('\n')
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .map((line) => line.slice(1)).join('\n'));
const startBlock = blocks.find((block) => block.includes('this.process = spawn(pg_ctl'));
const stopBlock = blocks.find((block) => block.includes('const stopProcess = spawn(pg_ctl'));
assert.ok(startBlock && stopBlock, 'both lifecycle blocks must exist');
const startSource = startBlock.slice(startBlock.indexOf("            if (platform() === 'win32')"));
const stopSource = stopBlock.slice(stopBlock.indexOf("            if (platform() === 'win32')"),
  stopBlock.lastIndexOf('            this.serverPid'));

async function runGenerator(generator) {
  let result = generator.next();
  while (!result.done) {
    try {
      result = generator.next(await result.value);
    } catch (error) {
      result = generator.throw(error);
    }
  }
  return result.value;
}

function harness(outcome = { code: 0 }, platform = 'win32') {
  const calls = [];
  const reads = [];
  const logs = [];
  const errors = [];
  const context = {
    path: path.win32, platform: () => platform,
    postgres: 'C:\\Postgres Bin\\postgres.exe', pg_ctl: 'C:\\Postgres Bin\\pg_ctl.exe',
    bin: Promise.resolve({ pg_ctl: 'C:\\Postgres Bin\\pg_ctl.exe' }),
    permissionIds: {}, LC_MESSAGES_LOCALE: 'C',
    process: { env: { SystemRoot: 'C:\\Windows' } },
    ensureBinIsExecutable() {},
    __awaiter: (self, args, ignored, generator) => runGenerator(generator.call(self)),
    fs: {
      async rm() {},
      async readFile(file) {
        reads.push(file);
        return file.endsWith('postmaster.pid') ? '4321\r\n' : 'database ready';
      },
    },
    spawn(file, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      calls.push({ file, args: Array.from(args), options, child });
      queueMicrotask(() => {
        if (outcome.error) child.emit('error', outcome.error);
        else {
          child.stderr.emit('data', Buffer.from('pg_ctl diagnostic'));
          child.emit('exit', outcome.code);
        }
      });
      return child;
    },
  };
  const instance = {
    process: new EventEmitter(), serverPid: 99,
    options: {
      databaseDir: 'C:\\DB Dir', port: 54329,
      postgresFlags: ['-c', 'max_connections=20'],
      onLog: (message) => logs.push(message), onError: (error) => errors.push(error),
    },
  };
  const execute = (source) => runGenerator(
    new vm.Script(`(function* () { ${source} })`).runInNewContext(context).call(instance),
  );
  return { calls, reads, logs, errors, instance,
    start: () => execute(startSource), stop: () => execute(stopSource) };
}

for (const operation of ['start', 'stop']) {
  for (const code of ['ENOENT', 'EACCES']) {
    test(`${operation} rejects the original ${code} spawn error`, { timeout: 1000 }, async () => {
      const error = Object.assign(new Error(`spawn pg_ctl ${code}`), { code });
      const subject = harness({ error });
      await assert.rejects(subject[operation](), (actual) => actual === error);
      assert.equal(subject.calls.length, 1);
      assert.equal(subject.calls[0].options.windowsHide, true, `${operation} must set windowsHide`);
      assert.equal(subject.reads.length, 0);
    });
  }
  test(`${operation} rejects nonzero exit with diagnostics`, { timeout: 1000 }, async () => {
    const subject = harness({ code: 1 });
    await assert.rejects(subject[operation](), new RegExp(`pg_ctl ${operation} exited with code 1.*diagnostic`));
  });
}

test('start forwards ordinary flags and recovers the server PID', async () => {
  const subject = harness();
  await subject.start();
  const call = subject.calls[0];
  assert.equal(call.file, 'C:\\Postgres Bin\\pg_ctl.exe');
  assert.deepEqual(call.args.slice(0, 7), ['start', '-D', 'C:\\DB Dir', '-l', 'C:\\DB Dir\\server.log', '-w', '-o']);
  assert.equal(call.args[7], '-p 54329 -c max_connections=20');
  assert.equal(call.options.windowsHide, true, 'start must set windowsHide');
  assert.equal(call.options.shell, undefined);
  assert.equal(call.options.env.SystemRoot, 'C:\\Windows');
  assert.equal(call.options.env.LC_MESSAGES, 'C');
  assert.equal(subject.instance.serverPid, 4321);
  assert.ok(subject.logs.includes('database ready'));
});

test('stop waits for pg_ctl fast shutdown instead of the old child exit', async () => {
  const subject = harness();
  await subject.stop();
  assert.deepEqual(subject.calls[0].args, ['stop', '-D', 'C:\\DB Dir', '-m', 'fast', '-w']);
  assert.equal(subject.calls[0].options.windowsHide, true, 'stop must set windowsHide');
  assert.equal(subject.calls[0].options.shell, undefined);
});

test('POSIX stop still signals and waits for the server', async () => {
  const subject = harness({ code: 0 }, 'linux');
  subject.instance.process.kill = (signal) => {
    assert.equal(signal, 'SIGINT');
    queueMicrotask(() => subject.instance.process.emit('exit', 0));
  };
  await subject.stop();
  assert.equal(subject.calls.length, 0);
});
