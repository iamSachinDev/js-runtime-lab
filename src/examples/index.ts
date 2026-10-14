import type { RuntimeMode } from '../engine/types';

export type Difficulty = 'Beginner' | 'Intermediate' | 'Advanced' | 'Interview';

export interface Example {
  id: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  mode: RuntimeMode;
  tags: string[];
  code: string;
  /** Node examples whose stdout is deterministic in real Node.js (verified in tests). */
  compare?: boolean;
}

export const DIFFICULTIES: Difficulty[] = ['Beginner', 'Intermediate', 'Advanced', 'Interview'];

const ex = (e: Example): Example => ({ ...e, code: `${e.code.trim()}\n` });

export const EXAMPLES: Example[] = [
  ex({
    id: 'node-event-loop-phases',
    title: 'Event loop phases after I/O',
    description: 'nextTick, promises, setImmediate and setTimeout scheduled from inside an fs.readFile callback.',
    difficulty: 'Advanced',
    mode: 'node',
    tags: ['event loop', 'nextTick', 'setImmediate', 'fs', 'microtasks'],
    compare: true,
    code: `
const fs = require('fs');

fs.readFile(__filename, () => {
    setTimeout(() => console.log('1. setTimeout'), 0);

    setImmediate(() => {
        console.log('2. setImmediate');

        process.nextTick(() =>
            console.log('3. nextTick inside setImmediate')
        );

        Promise.resolve().then(() =>
            console.log('4. Promise inside setImmediate')
        );
    });

    process.nextTick(() => console.log('5. nextTick'));

    Promise.resolve().then(() => console.log('6. Promise'));
});`,
  }),
  ex({
    id: 'call-stack-basics',
    title: 'The call stack',
    description: 'Watch frames pile up and unwind as functions call each other.',
    difficulty: 'Beginner',
    mode: 'browser',
    tags: ['call stack', 'functions'],
    code: `
function multiply(a, b) {
  return a * b;
}

function square(n) {
  return multiply(n, n);
}

function printSquare(n) {
  const result = square(n);
  console.log(result);
}

printSquare(4);`,
  }),
  ex({
    id: 'closures-counter',
    title: 'Closures: a private counter',
    description: 'Each call to makeCounter creates a scope that outlives the call.',
    difficulty: 'Beginner',
    mode: 'node',
    tags: ['closures', 'scope', 'heap'],
    compare: true,
    code: `
function makeCounter() {
  let count = 0;
  return function increment() {
    count += 1;
    return count;
  };
}

const counter = makeCounter();
console.log(counter()); // 1
console.log(counter()); // 2

const other = makeCounter();
console.log(other()); // 1: a separate closure`,
  }),
  ex({
    id: 'hoisting',
    title: 'Hoisting: var and function',
    description: 'Function declarations are usable before they appear; var starts as undefined.',
    difficulty: 'Beginner',
    mode: 'node',
    tags: ['hoisting', 'var', 'scope'],
    compare: true,
    code: `
console.log(typeof greet); // 'function': declarations are hoisted whole
console.log(answer);       // undefined: only the declaration is hoisted

var answer = 42;

function greet() {
  return 'hello';
}

console.log(greet(), answer);`,
  }),
  ex({
    id: 'temporal-dead-zone',
    title: 'The temporal dead zone',
    description: 'let and const are hoisted but unusable until their declaration runs.',
    difficulty: 'Intermediate',
    mode: 'node',
    tags: ['TDZ', 'let', 'const', 'hoisting'],
    compare: true,
    code: `
function readLater() {
  return value; // fine: only called after initialization
}

try {
  console.log(value); // still in the temporal dead zone
} catch (err) {
  console.log(\`\${err.name}: \${err.message}\`);
}

let value = 'ready';
console.log(readLater());`,
  }),
  ex({
    id: 'lexical-scope',
    title: 'Lexical scope',
    description: 'Variables resolve where a function is written, not where it is called.',
    difficulty: 'Beginner',
    mode: 'node',
    tags: ['scope', 'closures'],
    compare: true,
    code: `
const level = 'global';

function outer() {
  const level = 'outer';
  function inner() {
    console.log(level); // resolved where inner was written
  }
  return inner;
}

function caller() {
  const level = 'caller';
  const fn = outer();
  fn(); // where it's called from doesn't matter
}

caller();`,
  }),
  ex({
    id: 'this-binding',
    title: 'this: the binding rules',
    description: 'Implicit, default, explicit and lexical this, plus a lost binding.',
    difficulty: 'Intermediate',
    mode: 'browser',
    tags: ['this', 'arrow functions'],
    code: `
var name = 'window';

const user = {
  name: 'Ada',
  regular() {
    return this.name;
  },
  arrow: () => this.name,
  later() {
    setTimeout(() => console.log('arrow inside a callback:', this.name), 0);
  },
};

function standalone() {
  return this.name;
}

console.log(user.regular());        // implicit binding
console.log(standalone());          // default binding (sloppy mode)
console.log(standalone.call(user)); // explicit binding
console.log(user.arrow());          // lexical this
const detached = user.regular;
console.log(detached());            // lost binding
user.later();`,
  }),
  ex({
    id: 'recursion',
    title: 'Recursion: factorial',
    description: 'Each recursive call gets its own frame until the base case returns.',
    difficulty: 'Beginner',
    mode: 'node',
    tags: ['recursion', 'call stack'],
    compare: true,
    code: `
function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

console.log(factorial(5));`,
  }),
  ex({
    id: 'array-methods',
    title: 'Array methods and callbacks',
    description: 'filter, map and reduce call your callbacks synchronously, one element at a time.',
    difficulty: 'Beginner',
    mode: 'node',
    tags: ['arrays', 'callbacks'],
    compare: true,
    code: `
const orders = [
  { id: 1, total: 30, paid: true },
  { id: 2, total: 75, paid: false },
  { id: 3, total: 120, paid: true },
];

const paidTotals = orders
  .filter((order) => order.paid)
  .map((order) => order.total);

const revenue = paidTotals.reduce((sum, total) => sum + total, 0);

console.log(paidTotals, revenue);`,
  }),
  ex({
    id: 'timeout-zero',
    title: 'setTimeout(0) is not immediate',
    description: 'Synchronous code, then microtasks, then the timer.',
    difficulty: 'Beginner',
    mode: 'browser',
    tags: ['timers', 'microtasks', 'event loop'],
    code: `
console.log('1: script start');

setTimeout(() => console.log('4: timeout'), 0);

Promise.resolve().then(() => console.log('3: promise'));

console.log('2: script end');`,
  }),
  ex({
    id: 'microtasks-vs-tasks',
    title: 'Microtasks vs tasks',
    description: 'All microtasks run between tasks, including ones queued by a task.',
    difficulty: 'Intermediate',
    mode: 'browser',
    tags: ['microtasks', 'tasks', 'event loop'],
    code: `
setTimeout(() => {
  console.log('timeout 1');
  Promise.resolve().then(() => console.log('microtask from timeout 1'));
}, 0);

setTimeout(() => console.log('timeout 2'), 0);

Promise.resolve()
  .then(() => console.log('microtask 1'))
  .then(() => console.log('microtask 2'));

queueMicrotask(() => console.log('queueMicrotask'));`,
  }),
  ex({
    id: 'promise-chain',
    title: 'Promise chains',
    description: 'Values flow down the chain; returning a promise makes the next step wait.',
    difficulty: 'Intermediate',
    mode: 'node',
    tags: ['promises', 'timers'],
    compare: true,
    code: `
const wait = (ms, value) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

wait(100, 2)
  .then((n) => n * 10)
  .then((n) => {
    console.log('got', n);
    return wait(50, n + 1);
  })
  .then((n) => console.log('then', n))
  .catch((err) => console.log('never runs', err))
  .finally(() => console.log('cleanup'));`,
  }),
  ex({
    id: 'async-await-classic',
    title: 'Guess the output: async/await',
    description: 'The classic interview puzzle mixing async functions, promises and a timer.',
    difficulty: 'Interview',
    mode: 'node',
    tags: ['async/await', 'microtasks', 'interview'],
    compare: true,
    code: `
async function async1() {
  console.log('async1 start');
  await async2();
  console.log('async1 end');
}

async function async2() {
  console.log('async2');
}

console.log('script start');

setTimeout(() => console.log('setTimeout'), 0);

async1();

new Promise((resolve) => {
  console.log('promise1');
  resolve();
}).then(() => console.log('promise2'));

console.log('script end');`,
  }),
  ex({
    id: 'sequential-vs-parallel',
    title: 'Sequential vs parallel awaits',
    description: 'Two simulated requests awaited one after another, then together with Promise.all.',
    difficulty: 'Advanced',
    mode: 'browser',
    tags: ['async/await', 'fetch', 'Promise.all'],
    code: `
async function sequential() {
  const start = performance.now();
  const user = await fetch('/api/user').then((r) => r.json());
  const todos = await fetch('/api/todos').then((r) => r.json());
  console.log('sequential:', Math.round(performance.now() - start), 'ms');
  return [user.name, todos.length];
}

async function parallel() {
  const start = performance.now();
  const [user, todos] = await Promise.all([
    fetch('/api/user').then((r) => r.json()),
    fetch('/api/todos').then((r) => r.json()),
  ]);
  console.log('parallel:', Math.round(performance.now() - start), 'ms');
  return [user.name, todos.length];
}

sequential()
  .then((result) => console.log(result))
  .then(parallel)
  .then((result) => console.log(result));`,
  }),
  ex({
    id: 'nexttick-promise-immediate',
    title: 'nextTick vs promises vs setImmediate',
    description: 'How Node drains the nextTick queue and the microtask queue, and when immediates run.',
    difficulty: 'Advanced',
    mode: 'node',
    tags: ['nextTick', 'microtasks', 'setImmediate'],
    compare: true,
    code: `
setImmediate(() => console.log('immediate'));

process.nextTick(() => {
  console.log('tick 1');
  process.nextTick(() => console.log('tick 2 (nested)'));
  Promise.resolve().then(() => console.log('promise from tick 1'));
});

Promise.resolve().then(() => {
  console.log('promise 1');
  process.nextTick(() => console.log('tick from promise 1'));
});

console.log('sync');`,
  }),
  ex({
    id: 'callback-nesting',
    title: 'Callback nesting with fs',
    description: 'Three dependent file reads (from an in-memory file system), including an error.',
    difficulty: 'Intermediate',
    mode: 'node',
    tags: ['callbacks', 'fs', 'I/O', 'errors'],
    code: `
const fs = require('fs');

fs.readFile('/app/config.json', 'utf8', (err, config) => {
  if (err) return console.error(err.message);
  const { retries } = JSON.parse(config);
  console.log('retries:', retries);

  fs.readFile('/app/data.json', 'utf8', (err, data) => {
    if (err) return console.error(err.message);
    const names = JSON.parse(data).users.map((u) => u.name);
    console.log('users:', names.join(', '));

    fs.readFile('/app/missing.txt', 'utf8', (err) => {
      console.log('third read failed:', err.code);
    });
  });
});

console.log('reads started');`,
  }),
  ex({
    id: 'error-handling',
    title: 'Errors across async boundaries',
    description: 'try/catch for sync and async code, and what an unhandled rejection does to Node.',
    difficulty: 'Intermediate',
    mode: 'node',
    tags: ['errors', 'async/await', 'promises'],
    compare: true,
    code: `
function risky() {
  throw new Error('sync failure');
}

try {
  risky();
} catch (err) {
  console.log('caught sync:', err.message);
}

async function load() {
  try {
    await Promise.reject(new Error('async failure'));
  } catch (err) {
    console.log('caught async:', err.message);
  } finally {
    console.log('finally runs either way');
  }
}

load();

// Nobody handles this one: Node.js 15+ crashes the process.
Promise.reject(new Error('nobody handles me'));
setTimeout(() => console.log('never printed'), 0);`,
  }),
  ex({
    id: 'starving-the-loop',
    title: 'Microtasks block timers',
    description: 'A chain of microtasks runs to completion before a 0 ms timer gets its turn.',
    difficulty: 'Advanced',
    mode: 'node',
    tags: ['microtasks', 'timers', 'starvation'],
    compare: true,
    code: `
let count = 0;

function spin() {
  count++;
  // Each microtask queues another one, so the timer has to wait.
  if (count < 5) Promise.resolve().then(spin);
}

setTimeout(() => console.log('timer runs after', count, 'microtasks'), 0);
spin();
console.log('sync code done, count =', count);`,
  }),
  ex({
    id: 'guess-the-output',
    title: 'Guess the output: Node edition',
    description: 'Every scheduling API at once. One pair is a genuine race in real Node.js.',
    difficulty: 'Interview',
    mode: 'node',
    tags: ['interview', 'event loop', 'nextTick', 'setImmediate'],
    code: `
console.log('A');

setTimeout(() => console.log('B'), 0);
setImmediate(() => console.log('C'));

process.nextTick(() => console.log('D'));
Promise.resolve().then(() => console.log('E'));

(async () => {
  console.log('F');
  await null;
  console.log('G');
})();

console.log('H');`,
  }),
  ex({
    id: 'closures-in-loops',
    title: 'Closures in loops: var vs let',
    description: 'One shared var binding versus a fresh let binding per iteration.',
    difficulty: 'Interview',
    mode: 'node',
    tags: ['closures', 'var', 'let', 'timers', 'interview'],
    compare: true,
    code: `
for (var i = 0; i < 3; i++) {
  setTimeout(() => console.log('var i =', i), 0);
}

for (let j = 0; j < 3; j++) {
  setTimeout(() => console.log('let j =', j), 0);
}`,
  }),
  ex({
    id: 'promise-executor',
    title: 'The promise executor',
    description: 'The executor runs synchronously, and a promise settles only once.',
    difficulty: 'Interview',
    mode: 'node',
    tags: ['promises', 'interview'],
    compare: true,
    code: `
console.log('1');

const p = new Promise((resolve) => {
  console.log('2: the executor runs synchronously');
  resolve('first');
  resolve('ignored: a promise settles once');
  console.log('3: code after resolve still runs');
});

p.then((value) => console.log('5:', value));

console.log('4');`,
  }),
  ex({
    id: 'debounce',
    title: 'Build a debounce',
    description: 'Each call cancels the pending timer, so only the last call goes through.',
    difficulty: 'Interview',
    mode: 'browser',
    tags: ['timers', 'closures', 'clearTimeout', 'interview'],
    code: `
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const save = debounce((text) => console.log('saved:', text), 100);

save('H');
save('He');
save('Hel');
setTimeout(() => save('Hello'), 50);`,
  }),
  ex({
    id: 'animation-frames',
    title: 'requestAnimationFrame timing',
    description: 'Animation callbacks run in the render step, once per frame.',
    difficulty: 'Advanced',
    mode: 'browser',
    tags: ['requestAnimationFrame', 'rendering'],
    code: `
let frames = 0;
const start = performance.now();

function animate(time) {
  frames++;
  console.log(\`frame \${frames} at \${Math.round(time - start)} ms\`);
  if (frames < 3) requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
setTimeout(() => console.log('a 0 ms timeout runs before the first frame'), 0);`,
  }),
  ex({
    id: 'event-emitter',
    title: 'EventEmitter is synchronous',
    description: 'emit() calls every listener immediately, in registration order.',
    difficulty: 'Intermediate',
    mode: 'node',
    tags: ['events', 'EventEmitter'],
    compare: true,
    code: `
const EventEmitter = require('events');
const orders = new EventEmitter();

orders.on('created', (id) => console.log('send email for order', id));
orders.once('created', (id) => console.log('first-order bonus for', id));

console.log('before emit');
orders.emit('created', 1); // listeners run right here, synchronously
orders.emit('created', 2);
console.log('after emit');`,
  }),
  ex({
    id: 'generators',
    title: 'Generators pause and resume',
    description: 'A generator frame leaves the stack at every yield and comes back on next().',
    difficulty: 'Advanced',
    mode: 'node',
    tags: ['generators', 'call stack'],
    compare: true,
    code: `
function* idGenerator() {
  let id = 1;
  while (true) {
    const reset = yield id++;
    if (reset) id = 1;
  }
}

const ids = idGenerator();
console.log(ids.next().value); // 1
console.log(ids.next().value); // 2
console.log(ids.next(true).value); // 1 again`,
  }),
];

export const DEFAULT_EXAMPLE = EXAMPLES[0]!;
