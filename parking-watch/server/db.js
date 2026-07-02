const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");

// Simple per-file write queue so concurrent requests can't corrupt the JSON.
const queues = {};

function withQueue(file, fn) {
  const prev = queues[file] || Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of previous outcome
  queues[file] = next.catch(() => {}); // don't let one failure jam the queue
  return next;
}

async function ensureFile(file) {
  const full = path.join(DATA_DIR, file);
  try {
    await fs.access(full);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(full, "[]", "utf8");
  }
  return full;
}

async function readAll(file) {
  const full = await ensureFile(file);
  const raw = await fs.readFile(full, "utf8");
  try {
    return JSON.parse(raw || "[]");
  } catch {
    // Corrupt file — back it up and start fresh rather than crash the server.
    await fs.writeFile(full + ".corrupt-" + Date.now(), raw, "utf8");
    await fs.writeFile(full, "[]", "utf8");
    return [];
  }
}

async function writeAll(file, arr) {
  const full = await ensureFile(file);
  const tmp = full + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(arr, null, 2), "utf8");
  await fs.rename(tmp, full); // atomic on the same filesystem
}

function readCollection(file) {
  return withQueue(file, () => readAll(file));
}

function writeCollection(file, arr) {
  return withQueue(file, () => writeAll(file, arr));
}

async function appendOrReplace(file, item, matchFn) {
  return withQueue(file, async () => {
    const arr = await readAll(file);
    const idx = matchFn ? arr.findIndex(matchFn) : -1;
    if (idx >= 0) arr[idx] = item;
    else arr.unshift(item);
    await writeAll(file, arr);
    return arr;
  });
}

// For mutations more complex than a single append/replace (e.g. merging
// into an existing record's array field). `mutateFn` receives the current
// array, mutates or returns a new one, and the result is written back —
// all inside the same write queue so concurrent requests can't interleave.
async function withCollection(file, mutateFn) {
  return withQueue(file, async () => {
    const arr = await readAll(file);
    const next = await mutateFn(arr);
    await writeAll(file, next);
    return next;
  });
}

module.exports = { readCollection, writeCollection, appendOrReplace, withCollection };
