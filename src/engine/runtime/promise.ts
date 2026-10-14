import type { PromiseState, TaskKind } from '../types';
import type { RtFrame } from './tracer';

/**
 * ECMA-262 §27.2 Promise implemented in user land so the simulator owns the
 * microtask queue. Algorithms (resolving functions, PromiseResolveThenableJob,
 * reaction jobs, species, finally, combinators) follow the spec step-for-step,
 * which is what makes tick counts match V8 (e.g. `return promise` from an async
 * function costing two extra ticks).
 */

export interface JobInfo {
  kind: Extract<TaskKind, 'promise' | 'thenable' | 'await'>;
  label: string;
  fnId?: number;
  promiseId?: number;
  frame?: RtFrame;
}

export interface PromiseHost {
  enqueueJob(run: () => void, info: JobInfo): void;
  rejectionTracker(p: object, op: 'reject' | 'handle'): void;
  trace(op: 'create' | 'settle', p: object): void;
  /** Runs user-reachable code; on throw, unwinds the shadow stack and returns the error (signals re-throw). */
  guard<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: unknown };
  fnLabel(fn: unknown): { label: string; fnId?: number; name?: string };
}

type Capability = { promise: object; resolve: (v?: unknown) => void; reject: (r?: unknown) => void };
type Reaction = {
  capability: Capability | undefined;
  type: 'fulfill' | 'reject';
  handler: Function | undefined;
  info?: Partial<JobInfo>;
};

export interface PromiseInternals {
  pid: number;
  state: PromiseState;
  value: unknown;
  origin: string;
  reactions: number;
  handled: boolean;
  internal: boolean;
}

const isObject = (x: unknown): x is object => (typeof x === 'object' && x !== null) || typeof x === 'function';
const isConstructor = (f: unknown): f is new (...a: unknown[]) => object => {
  if (typeof f !== 'function') return false;
  try {
    Reflect.construct(String, [], f);
    return true;
  } catch {
    return false;
  }
};

export function createPromiseClass(host: PromiseHost) {
  let nextId = 1;
  let pendingOrigin: { origin: string; internal: boolean } | null = null;
  const internalLabels = new WeakMap<Function, string>();
  const labelFor = (fn: unknown) => (typeof fn === 'function' && internalLabels.get(fn)) || host.fnLabel(fn).label;
  const withOrigin = <T>(origin: string, internal: boolean, fn: () => T): T => {
    pendingOrigin = { origin, internal };
    return fn();
  };

  class VPromise {
    #state: PromiseState = 'pending';
    #result: unknown = undefined;
    #fulfillReactions: Reaction[] = [];
    #rejectReactions: Reaction[] = [];
    #handled = false;
    #pid: number;
    #origin: string;
    #internal: boolean;
    #reactionCount = 0;

    constructor(executor: unknown) {
      if (new.target === undefined) throw new TypeError("Promise constructor cannot be invoked without 'new'");
      if (typeof executor !== 'function') throw new TypeError(`Promise resolver ${describe(executor)} is not a function`);
      this.#pid = nextId++;
      this.#origin = pendingOrigin?.origin ?? 'new Promise()';
      this.#internal = pendingOrigin?.internal ?? false;
      pendingOrigin = null;
      host.trace('create', this);
      const { resolve, reject } = createResolvingFunctions(this);
      const r = host.guard(() => executor.call(undefined, resolve, reject));
      if (!r.ok) reject(r.error);
    }

    then(onFulfilled?: unknown, onRejected?: unknown): object {
      if (!isPromise(this)) throw new TypeError('Method Promise.prototype.then called on incompatible receiver');
      const C = speciesConstructor(this, VPromise);
      const cap = withOrigin(`.then(${shortLabel(onFulfilled ?? onRejected)})`, false, () => newPromiseCapability(C));
      return performPromiseThen(this, onFulfilled, onRejected, cap)!;
    }

    catch(onRejected?: unknown): object {
      return (this as unknown as { then: Function }).then(undefined, onRejected);
    }

    finally(onFinally?: unknown): object {
      if (!isObject(this)) throw new TypeError('Method Promise.prototype.finally called on a non-object');
      const C = speciesConstructor(this, VPromise);
      let thenFinally: unknown = onFinally;
      let catchFinally: unknown = onFinally;
      if (typeof onFinally === 'function') {
        const label = `finally(${shortLabel(onFinally)})`;
        thenFinally = (value: unknown) => {
          const result = onFinally();
          const p = promiseResolve(C, result) as VPromise;
          const valueThunk = () => value;
          internalLabels.set(valueThunk, 'finally: pass value through');
          return p.then(valueThunk);
        };
        catchFinally = (reason: unknown) => {
          const result = onFinally();
          const p = promiseResolve(C, result) as VPromise;
          const thrower = () => {
            throw reason;
          };
          internalLabels.set(thrower, 'finally: re-throw reason');
          return p.then(thrower);
        };
        internalLabels.set(thenFinally as Function, label);
        internalLabels.set(catchFinally as Function, label);
      }
      return (this as unknown as { then: Function }).then(thenFinally, catchFinally);
    }

    static resolve(this: unknown, x?: unknown): object {
      if (!isObject(this)) throw new TypeError('Promise.resolve called on non-object');
      return withOrigin('Promise.resolve()', false, () => promiseResolve(this, x));
    }

    static reject(this: unknown, r?: unknown): object {
      const cap = withOrigin('Promise.reject()', false, () => newPromiseCapability(this));
      cap.reject(r);
      return cap.promise;
    }

    static withResolvers(this: unknown) {
      const cap = withOrigin('Promise.withResolvers()', false, () => newPromiseCapability(this));
      return { promise: cap.promise, resolve: cap.resolve, reject: cap.reject };
    }

    static try(this: unknown, fn: unknown, ...args: unknown[]): object {
      const cap = withOrigin('Promise.try()', false, () => newPromiseCapability(this));
      const r = host.guard(() => (fn as Function)(...args));
      if (r.ok) cap.resolve(r.value);
      else cap.reject(r.error);
      return cap.promise;
    }

    static all(this: unknown, iterable: unknown): object {
      return combinator(this, iterable, 'all');
    }
    static allSettled(this: unknown, iterable: unknown): object {
      return combinator(this, iterable, 'allSettled');
    }
    static any(this: unknown, iterable: unknown): object {
      return combinator(this, iterable, 'any');
    }
    static race(this: unknown, iterable: unknown): object {
      const C = this;
      const cap = withOrigin('Promise.race()', false, () => newPromiseCapability(C));
      const r = host.guard(() => {
        const resolveFn = (C as { resolve: Function }).resolve;
        if (typeof resolveFn !== 'function') throw new TypeError('Promise resolve is not a function');
        for (const next of iterable as Iterable<unknown>) {
          const p = resolveFn.call(C, next) as { then: Function };
          p.then(cap.resolve, cap.reject);
        }
      });
      if (!r.ok) cap.reject(r.error);
      return cap.promise;
    }

    static get [Symbol.species]() {
      return this;
    }

    /** Runtime-only introspection (not reachable from user code: requires the module-private class). */
    static inspect(p: unknown): PromiseInternals | undefined {
      if (!isPromise(p)) return undefined;
      return {
        pid: p.#pid,
        state: p.#state,
        value: p.#result,
        origin: p.#origin,
        reactions: p.#reactionCount,
        handled: p.#handled,
        internal: p.#internal,
      };
    }

    static #isPromise(x: unknown): x is VPromise {
      return isObject(x) && #state in x;
    }

    static fulfill(p: VPromise, value: unknown) {
      const reactions = p.#fulfillReactions;
      p.#result = value;
      p.#fulfillReactions = [];
      p.#rejectReactions = [];
      p.#state = 'fulfilled';
      host.trace('settle', p);
      triggerReactions(reactions, value, p.#pid);
    }

    static rejectInternal(p: VPromise, reason: unknown) {
      const reactions = p.#rejectReactions;
      p.#result = reason;
      p.#fulfillReactions = [];
      p.#rejectReactions = [];
      p.#state = 'rejected';
      host.trace('settle', p);
      if (!p.#handled) host.rejectionTracker(p, 'reject');
      triggerReactions(reactions, reason, p.#pid);
    }

    static performThen(p: VPromise, onF: unknown, onR: unknown, cap: Capability | undefined, info?: Partial<JobInfo>) {
      const fr: Reaction = { capability: cap, type: 'fulfill', handler: typeof onF === 'function' ? onF : undefined, info };
      const rr: Reaction = { capability: cap, type: 'reject', handler: typeof onR === 'function' ? onR : undefined, info };
      p.#reactionCount++;
      if (p.#state === 'pending') {
        p.#fulfillReactions.push(fr);
        p.#rejectReactions.push(rr);
      } else if (p.#state === 'fulfilled') {
        enqueueReactionJob(fr, p.#result, p.#pid);
      } else {
        if (!p.#handled) host.rejectionTracker(p, 'handle');
        enqueueReactionJob(rr, p.#result, p.#pid);
      }
      p.#handled = true;
      return cap?.promise;
    }

    static checkBrand(x: unknown): x is VPromise {
      return VPromise.#isPromise(x);
    }
  }

  // Runtime-only internals: captured, then removed so user code sees a standard Promise API.
  const internals = {
    inspect: VPromise.inspect,
    fulfill: VPromise.fulfill,
    rejectInternal: VPromise.rejectInternal,
    performThen: VPromise.performThen,
    checkBrand: VPromise.checkBrand,
  };
  for (const k of Object.keys(internals)) delete (VPromise as unknown as Record<string, unknown>)[k];
  Object.defineProperty(VPromise, 'name', { value: 'Promise' });
  Object.defineProperty(VPromise.prototype, Symbol.toStringTag, { value: 'Promise', configurable: true });

  const isPromise = (x: unknown): x is VPromise => internals.checkBrand(x);
  const PromiseCtor = VPromise as unknown as Function;

  function describe(v: unknown): string {
    if (v === null || v === undefined || typeof v !== 'object') return String(v);
    return '#<Object>';
  }
  function shortLabel(fn: unknown): string {
    if (typeof fn !== 'function') return '';
    const l = labelFor(fn);
    return l.length > 28 ? `${l.slice(0, 27)}…` : l;
  }

  function createResolvingFunctions(promise: VPromise) {
    let alreadyResolved = false;
    const resolve = (resolution?: unknown) => {
      if (alreadyResolved) return;
      alreadyResolved = true;
      if (resolution === promise) {
        internals.rejectInternal(promise, new TypeError('Chaining cycle detected for promise #<Promise>'));
        return;
      }
      if (!isObject(resolution)) {
        internals.fulfill(promise, resolution);
        return;
      }
      const got = host.guard(() => (resolution as { then?: unknown }).then);
      if (!got.ok) {
        internals.rejectInternal(promise, got.error);
        return;
      }
      const thenAction = got.value;
      if (typeof thenAction !== 'function') {
        internals.fulfill(promise, resolution);
        return;
      }
      const target = internals.inspect(promise)!;
      host.enqueueJob(
        () => {
          const fns = createResolvingFunctions(promise);
          const r = host.guard(() => thenAction.call(resolution, fns.resolve, fns.reject));
          if (!r.ok) fns.reject(r.error);
        },
        {
          kind: 'thenable',
          label: `adopt thenable → promise #${target.pid}`,
          promiseId: target.pid,
        },
      );
    };
    const reject = (reason?: unknown) => {
      if (alreadyResolved) return;
      alreadyResolved = true;
      internals.rejectInternal(promise, reason);
    };
    return { resolve, reject };
  }

  function triggerReactions(reactions: Reaction[], argument: unknown, pid: number) {
    for (const r of reactions) enqueueReactionJob(r, argument, pid);
  }

  function enqueueReactionJob(reaction: Reaction, argument: unknown, pid: number) {
    const { handler, type, capability } = reaction;
    const meta = handler ? host.fnLabel(handler) : undefined;
    const label =
      reaction.info?.label ??
      (handler ? labelFor(handler) : type === 'fulfill' ? 'pass value through' : 'pass rejection through');
    host.enqueueJob(
      () => {
        let ok = true;
        let result: unknown = argument;
        if (handler === undefined) ok = type === 'fulfill';
        else {
          const r = host.guard(() => handler.call(undefined, argument));
          if (r.ok) result = r.value;
          else {
            ok = false;
            result = r.error;
          }
        }
        if (!capability) return;
        if (ok) capability.resolve(result);
        else capability.reject(result);
      },
      {
        kind: reaction.info?.kind ?? 'promise',
        label,
        fnId: reaction.info?.fnId ?? meta?.fnId,
        promiseId: pid,
        frame: reaction.info?.frame,
      },
    );
  }

  function newPromiseCapability(C: unknown): Capability {
    if (C === PromiseCtor) {
      let res!: Capability['resolve'];
      let rej!: Capability['reject'];
      const promise = new VPromise((a: Capability['resolve'], b: Capability['reject']) => {
        res = a;
        rej = b;
      });
      return { promise, resolve: res, reject: rej };
    }
    if (!isConstructor(C)) throw new TypeError('Promise capability target is not a constructor');
    let resolve: unknown;
    let reject: unknown;
    const executor = (a: unknown, b: unknown) => {
      if (resolve !== undefined || reject !== undefined) throw new TypeError('Promise executor has already been invoked');
      resolve = a;
      reject = b;
    };
    const promise = new C(executor);
    if (typeof resolve !== 'function' || typeof reject !== 'function') throw new TypeError('Promise resolve or reject function is not callable');
    return { promise, resolve: resolve as Capability['resolve'], reject: reject as Capability['reject'] };
  }

  function speciesConstructor(O: object, fallback: unknown): unknown {
    const C = (O as { constructor?: unknown }).constructor;
    if (C === undefined) return fallback;
    if (!isObject(C)) throw new TypeError('object.constructor is not an object');
    const S = (C as { [Symbol.species]?: unknown })[Symbol.species];
    if (S === undefined || S === null) return fallback;
    if (isConstructor(S)) return S;
    throw new TypeError('object.constructor[Symbol.species] is not a constructor');
  }

  function promiseResolve(C: unknown, x: unknown): object {
    if (isPromise(x) && (x as { constructor?: unknown }).constructor === C) return x;
    const cap = newPromiseCapability(C);
    cap.resolve(x);
    return cap.promise;
  }

  function performPromiseThen(p: VPromise, onF: unknown, onR: unknown, cap: Capability | undefined, info?: Partial<JobInfo>) {
    return internals.performThen(p, onF, onR, cap, info);
  }

  function combinator(C: unknown, iterable: unknown, kind: 'all' | 'allSettled' | 'any'): object {
    const cap = withOrigin(`Promise.${kind}()`, false, () => newPromiseCapability(C));
    const r = host.guard(() => {
      const resolveFn = (C as { resolve: Function }).resolve;
      if (typeof resolveFn !== 'function') throw new TypeError('Promise resolve is not a function');
      const values: unknown[] = [];
      let remaining = 1;
      let index = 0;
      const done = () => {
        if (kind === 'any') {
          const err = new AggregateError(values, 'All promises were rejected');
          cap.reject(err);
        } else cap.resolve(values);
      };
      for (const next of iterable as Iterable<unknown>) {
        const i = index++;
        values.push(undefined);
        const p = resolveFn.call(C, next) as { then: Function };
        let called = false;
        const settle = (status: 'fulfilled' | 'rejected') => (x: unknown) => {
          if (called) return;
          called = true;
          values[i] = kind === 'allSettled' ? (status === 'fulfilled' ? { status, value: x } : { status, reason: x }) : x;
          if (--remaining === 0) done();
        };
        remaining++;
        const onF = kind === 'any' ? cap.resolve : settle('fulfilled');
        const onR = kind === 'all' ? cap.reject : settle('rejected');
        internalLabels.set(onF, `Promise.${kind} element #${i}`);
        internalLabels.set(onR, `Promise.${kind} element #${i}`);
        p.then(onF, onR);
      }
      if (--remaining === 0) done();
    });
    if (!r.ok) cap.reject(r.error);
    return cap.promise;
  }

  return {
    Promise: VPromise as unknown as PromiseConstructor,
    inspect: internals.inspect,
    isPromise,
    /** `await` semantics: PromiseResolve(%Promise%, v) + PerformPromiseThen without a derived promise. */
    awaitValue(value: unknown, onF: (v: unknown) => void, onR: (e: unknown) => void, info: Partial<JobInfo>): { ok: true } | { ok: false; error: unknown } {
      const r = host.guard(() => withOrigin('await', true, () => promiseResolve(PromiseCtor, value)) as VPromise);
      if (!r.ok) return r;
      internalLabels.set(onF, info.label ?? 'await');
      internals.performThen(r.value, onF, onR, undefined, { ...info, kind: 'await' });
      return { ok: true };
    },
    newCapability: (origin: string, internal = false) => withOrigin(origin, internal, () => newPromiseCapability(PromiseCtor)),
  };
}

export type PromiseRuntime = ReturnType<typeof createPromiseClass>;
