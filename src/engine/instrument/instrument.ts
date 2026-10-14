import { parse } from '@babel/parser';
import traverseImport, { type NodePath, type Binding, type Scope } from '@babel/traverse';
import generateImport from '@babel/generator';
import * as t from '@babel/types';
import type { Diagnostic, FnMeta, InstrumentResult, ProgramMeta, StmtMeta } from '../types';

// CJS/ESM interop: these packages expose their function on `.default` under some bundlers.
const traverse = ((traverseImport as unknown as { default?: typeof traverseImport }).default ??
  traverseImport) as typeof traverseImport;
const generate = ((generateImport as unknown as { default?: typeof generateImport }).default ??
  generateImport) as typeof generateImport;

const RESERVED = /^(__rt|__env|__f\d+)$/;
type VarRef = { n: string; o: number; guarded: boolean };
type FnNode =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ObjectMethod
  | t.ClassMethod
  | t.ClassPrivateMethod;

interface FnInfo {
  meta: FnMeta;
  node: t.Node;
  path: NodePath;
  specName?: string;
  usesArguments: boolean;
  closures: Map<Binding, { name: string; ownerId: number }>;
}

interface Ctx {
  fnId: number;
  frame: string;
  inAsync: boolean;
  inGenerator: boolean;
  finallyDepth: number;
}

const collapse = (s: string, max: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export function friendlyParseError(err: unknown): Diagnostic {
  const e = err as { message?: string; loc?: { line: number; column: number } };
  const raw = (e.message ?? String(err)).replace(/\s*\(\d+:\d+\)\s*$/, '');
  let hint: string | undefined;
  if (/import' and 'export'|sourceType: "module"/.test(raw))
    hint = 'ES module syntax is not supported. Use require() in Node.js mode, or plain scripts.';
  else if (/await/i.test(raw) && /async/i.test(raw))
    hint = 'Top-level await is not supported (Node CommonJS semantics). Wrap the code in an async function.';
  return {
    severity: 'error',
    message: `SyntaxError: ${raw}`,
    line: e.loc?.line ?? 1,
    column: (e.loc?.column ?? 0) + 1,
    hint,
  };
}

export function instrument(code: string, opts: { wrapProgram?: boolean } = {}): InstrumentResult {
  const empty: ProgramMeta = { functions: [], statements: [], exitVars: {} };
  let ast: t.File;
  try {
    ast = parse(code, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: false });
  } catch (err) {
    return { ok: false, code: '', meta: empty, diagnostics: [friendlyParseError(err)] };
  }

  const diagnostics: Diagnostic[] = [];
  const src = (n: t.Node) => code.slice(n.start ?? 0, n.end ?? 0);
  const diag = (n: t.Node, message: string, hint?: string) =>
    diagnostics.push({
      severity: 'error',
      message,
      hint,
      line: n.loc?.start.line ?? 1,
      column: (n.loc?.start.column ?? 0) + 1,
    });

  // ---------------------------------------------------------------- pass 1
  const fnInfoOf = new Map<t.Node, FnInfo>();
  const functions: FnMeta[] = [];
  const statements: StmtMeta[] = [];
  const stmtMetaOf = new Map<t.Node, StmtMeta>();
  const arrowBodyMetaOf = new Map<t.Node, StmtMeta>();
  const pendingStmts: { meta: StmtMeta; scopePath: NodePath; anchor: NodePath; fn: FnInfo }[] = [];
  let programPath!: NodePath<t.Program>;

  const programInfo: FnInfo = {
    meta: {
      id: 0,
      name: '(main script)',
      kind: 'program',
      async: false,
      generator: false,
      params: [],
      line: 1,
      endLine: ast.program.loc?.end.line ?? 1,
      start: 0,
      end: code.length,
      parentId: null,
      snippet: '',
      captures: [],
    },
    node: ast.program,
    path: undefined as unknown as NodePath,
    usesArguments: false,
    closures: new Map(),
  };
  fnInfoOf.set(ast.program, programInfo);
  functions.push(programInfo.meta);

  const enclosingFn = (p: NodePath): FnInfo => {
    const f = p.getFunctionParent();
    return fnInfoOf.get(f ? f.node : ast.program)!;
  };

  const inferNames = (path: NodePath<FnNode>): { display: string; spec?: string } => {
    const n = path.node;
    if ((t.isFunctionDeclaration(n) || t.isFunctionExpression(n)) && n.id) return { display: n.id.name };
    if (t.isObjectMethod(n) || t.isClassMethod(n) || t.isClassPrivateMethod(n)) {
      const k = n.key;
      let key = t.isIdentifier(k) ? k.name : t.isPrivateName(k) ? `#${k.id.name}` : t.isStringLiteral(k) ? k.value : '[computed]';
      const cls = path.findParent((p) => p.isClass())?.node as t.Class | undefined;
      const owner = cls && cls.id ? `${cls.id.name}.` : '';
      if (n.kind === 'constructor') return { display: `new ${cls?.id?.name ?? 'class'}` };
      if (n.kind === 'get') key = `get ${key}`;
      if (n.kind === 'set') key = `set ${key}`;
      return { display: owner + key };
    }
    const parent = path.parentPath;
    let spec: string | undefined;
    if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) spec = parent.node.id.name;
    else if (parent?.isAssignmentExpression() && t.isIdentifier(parent.node.left)) spec = parent.node.left.name;
    else if ((parent?.isObjectProperty() || parent?.isClassProperty()) && t.isIdentifier(parent.node.key))
      spec = parent.node.key.name;
    else if (parent?.isAssignmentPattern() && t.isIdentifier(parent.node.left)) spec = parent.node.left.name;
    if (spec) return { display: spec, spec };
    if (parent?.isAssignmentExpression() && t.isMemberExpression(parent.node.left))
      return { display: collapse(src(parent.node.left), 28) };
    if (parent?.isCallExpression() || parent?.isNewExpression()) {
      const callee = parent.node.callee;
      const name = t.isMemberExpression(callee) && t.isIdentifier(callee.property)
        ? callee.property.name
        : t.isIdentifier(callee) ? callee.name : null;
      if (name) return { display: `${name} callback` };
    }
    return { display: '(anonymous)' };
  };

  const stmtDetail = (n: t.Statement): StmtMeta['detail'] => {
    if (t.isVariableDeclaration(n))
      return {
        kind: 'declare',
        declKind: n.kind,
        names: n.declarations.flatMap((d) => Object.keys(t.getBindingIdentifiers(d.id))),
        text: n.declarations[0]?.init ? collapse(src(n.declarations[0].init), 60) : undefined,
      };
    if (t.isExpressionStatement(n)) {
      let e = n.expression;
      if (t.isAwaitExpression(e)) return { kind: 'await', text: collapse(src(e.argument), 60) };
      if (t.isAssignmentExpression(e) || t.isUpdateExpression(e)) return { kind: 'assign', text: collapse(src(e), 60) };
      if (t.isCallExpression(e) || t.isNewExpression(e)) {
        while (t.isMemberExpression(e.callee) && (t.isCallExpression(e.callee.object))) e = e.callee.object;
        return { kind: 'call', text: collapse(src(e.callee), 60) };
      }
      return { kind: 'expression' };
    }
    if (t.isReturnStatement(n)) return { kind: 'return' };
    if (t.isIfStatement(n)) return { kind: 'if', text: collapse(src(n.test), 60) };
    if (t.isLoop(n)) return { kind: 'loop' };
    if (t.isThrowStatement(n)) return { kind: 'throw' };
    if (t.isTryStatement(n)) return { kind: 'try' };
    if (t.isSwitchStatement(n)) return { kind: 'switch' };
    if (t.isClassDeclaration(n)) return { kind: 'class', names: n.id ? [n.id.name] : [] };
    if (t.isBreakStatement(n) || t.isContinueStatement(n)) return { kind: 'jump' };
    if (t.isDebuggerStatement(n)) return { kind: 'debugger' };
    return { kind: n.type };
  };

  const makeStmtMeta = (node: t.Node, fn: FnInfo, type: string, detail: StmtMeta['detail']): StmtMeta => {
    const meta: StmtMeta = {
      id: statements.length,
      fnId: fn.meta.id,
      type,
      line: node.loc?.start.line ?? 1,
      column: (node.loc?.start.column ?? 0) + 1,
      endLine: node.loc?.end.line ?? 1,
      endColumn: (node.loc?.end.column ?? 0) + 1,
      snippet: collapse(src(node).split('\n')[0] ?? '', 90),
      detail,
      vars: [],
      tdz: [],
    };
    statements.push(meta);
    return meta;
  };

  const isHookable = (path: NodePath<t.Statement>): boolean => {
    const n = path.node;
    if (t.isFunctionDeclaration(n) || t.isEmptyStatement(n) || t.isBlockStatement(n)) return false;
    const parent = path.parentPath;
    if (!parent) return false;
    const fnLike = path.findParent((p) => p.isFunction() || p.isStaticBlock() || p.isProgram());
    if (fnLike?.isStaticBlock()) return false;
    if (path.listKey === 'body' && (parent.isProgram() || parent.isBlockStatement())) return true;
    if (path.listKey === 'consequent' && parent.isSwitchCase()) return true;
    if (path.key === 'body' && parent.isLoop()) return true;
    if ((path.key === 'consequent' || path.key === 'alternate') && parent.isIfStatement()) return true;
    if (path.key === 'body' && parent.isLabeledStatement()) return !t.isLoop(n);
    return false;
  };

  traverse(ast, {
    Program(path) {
      programPath = path;
      programInfo.path = path;
    },
    Function(path) {
      const n = path.node as FnNode;
      if (n.async && n.generator)
        diag(n, 'Async generator functions are not supported by the simulator.', 'Use a regular async function with a loop instead.');
      const names = inferNames(path as NodePath<FnNode>);
      const parent = enclosingFn(path.parentPath!);
      const kind: FnMeta['kind'] = t.isArrowFunctionExpression(n)
        ? 'arrow'
        : t.isObjectMethod(n) || t.isClassMethod(n) || t.isClassPrivateMethod(n)
          ? n.kind === 'constructor' ? 'constructor' : n.kind === 'get' ? 'getter' : n.kind === 'set' ? 'setter' : 'method'
          : 'function';
      const info: FnInfo = {
        meta: {
          id: functions.length,
          name: names.display,
          kind,
          async: !!n.async,
          generator: !!n.generator,
          params: n.params.flatMap((p) => Object.keys(t.getBindingIdentifiers(p as t.Node))),
          line: n.loc?.start.line ?? 1,
          endLine: n.loc?.end.line ?? 1,
          start: n.start ?? 0,
          end: n.end ?? 0,
          parentId: parent.meta.id,
          snippet: collapse(src(n), 48),
          captures: [],
        },
        node: n,
        path,
        specName: names.spec,
        usesArguments: false,
        closures: new Map(),
      };
      fnInfoOf.set(n, info);
      functions.push(info.meta);
      if (t.isArrowFunctionExpression(n) && !t.isBlockStatement(n.body)) {
        const meta = makeStmtMeta(n.body, info, 'ArrowBody', { kind: 'return', text: collapse(src(n.body), 60) });
        arrowBodyMetaOf.set(n, meta);
        const bodyPath = path.get('body') as NodePath;
        pendingStmts.push({ meta, scopePath: bodyPath, anchor: bodyPath, fn: info });
      }
    },
    Statement(path) {
      if (!isHookable(path)) return;
      const fn = enclosingFn(path);
      const meta = makeStmtMeta(path.node, fn, path.node.type, stmtDetail(path.node));
      stmtMetaOf.set(path.node, meta);
      pendingStmts.push({ meta, scopePath: path.parentPath!, anchor: path, fn });
    },
    CallExpression(path) {
      const c = path.node.callee;
      if (t.isImport(c)) diag(path.node, 'Dynamic import() is not supported: the simulator runs one self-contained file.');
      if (t.isIdentifier(c, { name: 'eval' }))
        diag(path.node, 'eval() is not supported: evaluated code would bypass instrumentation.');
      if (t.isIdentifier(c, { name: 'Function' }))
        diag(path.node, 'Function() is not supported: generated code would bypass instrumentation.');
    },
    NewExpression(path) {
      if (t.isIdentifier(path.node.callee, { name: 'Function' }))
        diag(path.node, 'new Function() is not supported: generated code would bypass instrumentation.');
    },
    WithStatement(path) {
      diag(path.node, 'The with statement is not supported (it is also forbidden in strict mode).');
    },
    ForOfStatement(path) {
      if (path.node.await) diag(path.node, 'for await…of is not supported by the simulator.');
    },
    Super(path) {
      const fn = path.getFunctionParent();
      let p: NodePath | null = fn;
      while (p && p.isArrowFunctionExpression()) p = p.getFunctionParent();
      if ((fn && (fn.node as FnNode).async) || (p && (p.node as FnNode).async))
        diag(path.node, 'super inside async functions is not supported by the simulator.');
    },
    Identifier(path) {
      const name = path.node.name;
      if (RESERVED.test(name)) diag(path.node, `"${name}" is reserved by the runtime instrumentation.`);
      const fnPath = path.getFunctionParent();
      if (name === 'arguments' && fnPath?.isArrowFunctionExpression()) {
        let f: NodePath | null = fnPath;
        while (f) {
          fnInfoOf.get(f.node)!.usesArguments = true;
          if (!f.isArrowFunctionExpression()) break;
          f = f.getFunctionParent();
        }
      }
      const parent = path.parent;
      const isWrite =
        (t.isAssignmentExpression(parent) && parent.left === path.node) || t.isUpdateExpression(parent);
      if (!fnPath || !(path.isReferencedIdentifier() || isWrite)) return;
      const binding = path.scope.getBinding(name);
      if (!binding || binding.kind === 'local' || binding.kind === 'module') return;
      const ownerScope = binding.scope.getFunctionParent();
      const ownerNode = ownerScope ? ownerScope.path.node : ast.program;
      if (ownerNode === fnPath.node) return;
      const owner = fnInfoOf.get(ownerNode);
      if (!owner) return;
      // Every function between the reference and the owner keeps the owner's scope alive.
      for (let f: NodePath | null = fnPath; f && f.node !== ownerNode; f = f.getFunctionParent()) {
        const info = fnInfoOf.get(f.node);
        if (info && !info.closures.has(binding)) info.closures.set(binding, { name, ownerId: owner.meta.id });
      }
    },
  });
  void programPath;

  if (diagnostics.length) return { ok: false, code: '', meta: empty, diagnostics };

  // Visible-variable analysis for readers (scope info is still pristine here).
  const fnScopeNode = (fn: FnInfo) => fn.node;
  const classify = (b: Binding, anchor: NodePath): 'plain' | 'tdz' | 'guard' => {
    if (b.kind === 'var' || b.kind === 'param' || b.kind === 'hoisted') return 'plain';
    const bp = b.path;
    let decl: NodePath | null = null;
    if (bp.isCatchClause()) return 'plain';
    if (bp.isVariableDeclarator()) {
      const vd = bp.parentPath!;
      if (vd.parentPath && (vd.parentPath.isFor() || vd.parentPath.isForXStatement())) return 'plain';
      decl = vd;
    } else if (bp.isClassDeclaration()) decl = bp;
    if (!decl || decl.listKey == null || typeof decl.key !== 'number') return 'guard';
    if (decl.parentPath?.isSwitchCase()) return 'guard';
    const anc = anchor.find((p) => p.parentPath === decl!.parentPath && p.listKey === decl!.listKey);
    if (!anc || typeof anc.key !== 'number') return 'guard';
    return anc.key > decl.key ? 'plain' : 'tdz';
  };

  const visibleVars = (scope: Scope, anchor: NodePath, fn: FnInfo, forExit: boolean) => {
    const vars: VarRef[] = [];
    const tdz: string[] = [];
    const seen = new Set<string>();
    let s: Scope | undefined = scope;
    while (s) {
      for (const [name, b] of Object.entries(s.bindings)) {
        if (seen.has(name) || RESERVED.test(name)) continue;
        seen.add(name);
        if (b.kind === 'local' || b.kind === 'unknown' || b.kind === 'module') continue;
        const c = forExit ? (b.kind === 'var' || b.kind === 'param' || b.kind === 'hoisted' ? 'plain' : 'guard') : classify(b, anchor);
        if (c === 'tdz') tdz.push(name);
        else vars.push({ n: name, o: -1, guarded: c === 'guard' });
      }
      if (s.path.node === fnScopeNode(fn)) break;
      s = s.parent;
    }
    for (const [binding, cv] of fn.closures) {
      if (seen.has(cv.name) || scope.getBinding(cv.name) !== binding) continue;
      seen.add(cv.name);
      const plain = binding.kind === 'var' || binding.kind === 'param' || binding.kind === 'hoisted';
      vars.push({ n: cv.name, o: cv.ownerId, guarded: !plain });
    }
    return { vars, tdz };
  };

  const readerOf = new Map<number, VarRef[]>();
  for (const { meta, scopePath, anchor, fn } of pendingStmts) {
    const { vars, tdz } = visibleVars(scopePath.scope, anchor, fn, false);
    meta.vars = vars.map(({ n, o }) => ({ n, o }));
    meta.tdz = tdz;
    readerOf.set(meta.id, vars);
  }
  for (const info of fnInfoOf.values()) info.meta.captures = [...new Set([...info.closures.values()].map((c) => c.ownerId))];
  const exitVars: ProgramMeta['exitVars'] = {};
  const exitReaderOf = new Map<number, VarRef[]>();
  for (const info of fnInfoOf.values()) {
    const scope = info.meta.id === 0 ? programPath.scope : info.path.scope;
    const { vars } = visibleVars(scope, info.path ?? programPath, info, true);
    exitReaderOf.set(info.meta.id, vars);
    exitVars[info.meta.id] = vars.map(({ n, o }) => ({ n, o }));
  }

  // ---------------------------------------------------------------- pass 2
  const rt = (m: string) => t.memberExpression(t.identifier('__rt'), t.identifier(m));
  const call = (m: string, args: t.Expression[]) => t.callExpression(rt(m), args);
  const id = (n: string) => t.identifier(n);
  const num = (n: number) => t.numericLiteral(n);
  const undef = () => t.unaryExpression('void', num(0));

  const readerExpr = (vars: VarRef[] | undefined): t.Expression | null => {
    if (!vars || vars.length === 0) return null;
    return t.arrowFunctionExpression(
      [],
      t.arrayExpression(vars.map((v) => (v.guarded ? call('q', [t.arrowFunctionExpression([], id(v.n))]) : id(v.n)))),
    );
  };
  const hookStmt = (meta: StmtMeta, ctx: Ctx) => {
    const r = readerExpr(readerOf.get(meta.id));
    return t.expressionStatement(call('s', [id(ctx.frame), num(meta.id), ...(r ? [r] : [])]));
  };
  const blockify = (s: t.Statement): t.BlockStatement => (t.isBlockStatement(s) ? s : t.blockStatement([s]));

  const list = (stmts: t.Statement[], ctx: Ctx): t.Statement[] => {
    const regs: t.Statement[] = [];
    const out: t.Statement[] = [];
    for (const s of stmts) {
      if (t.isFunctionDeclaration(s) && s.id) {
        const info = fnInfoOf.get(s)!;
        out.push(walk(s, ctx) as t.Statement);
        regs.push(t.expressionStatement(call('fn', [num(info.meta.id), id(s.id.name), id(ctx.frame)])));
        continue;
      }
      const meta = stmtMetaOf.get(s);
      const ws = walk(s, ctx) as t.Statement;
      if (meta) out.push(hookStmt(meta, ctx));
      out.push(ws);
    }
    return [...regs, ...out];
  };

  const walkChildren = (node: t.Node, ctx: Ctx) => {
    const keys = t.VISITOR_KEYS[node.type] ?? [];
    const rec = node as unknown as Record<string, unknown>;
    for (const key of keys) {
      const child = rec[key];
      if (Array.isArray(child)) rec[key] = child.map((c) => (c && typeof c === 'object' ? walk(c as t.Node, ctx) : c));
      else if (child && typeof child === 'object' && 'type' in (child as object)) rec[key] = walk(child as t.Node, ctx);
    }
  };

  const transformFunction = (fn: FnNode, ctx: Ctx): t.Node => {
    const info = fnInfoOf.get(fn)!;
    const meta = info.meta;
    const frame = `__f${meta.id}`;
    if ((t.isObjectMethod(fn) || t.isClassMethod(fn)) && fn.computed) fn.key = walk(fn.key, ctx) as t.Expression;
    fn.params = fn.params.map((p) => walk(p, ctx) as typeof p);
    const inner: Ctx = { fnId: meta.id, frame, inAsync: !!fn.async && !fn.generator, inGenerator: !!fn.generator, finallyDepth: 0 };

    let stmts: t.Statement[];
    let directives: t.Directive[] = [];
    if (!t.isBlockStatement(fn.body)) {
      const bm = arrowBodyMetaOf.get(fn)!;
      const expr = walk(fn.body, inner) as t.Expression;
      const r = readerExpr(readerOf.get(bm.id));
      stmts = [hookStmt(bm, inner), t.returnStatement(call('r', [id(frame), expr, num(bm.id), ...(r ? [r] : [])]))];
    } else {
      directives = fn.body.directives;
      stmts = list(fn.body.body, inner);
    }
    const enter = t.variableDeclaration('const', [
      t.variableDeclarator(
        id(frame),
        call('e', [num(meta.id), id(ctx.frame), t.arrayExpression(meta.params.map((p) => id(p)))]),
      ),
    ]);
    const exitReader = readerExpr(exitReaderOf.get(meta.id));
    const epilogue = t.expressionStatement(call('r', [id(frame), undef(), num(-1), ...(exitReader ? [exitReader] : [])]));
    let body = t.blockStatement([enter, ...stmts, epilogue], directives);

    if (fn.async && !fn.generator) {
      const gen = t.functionExpression(null, [], t.blockStatement(body.body), true, false);
      const isArrow = t.isArrowFunctionExpression(fn);
      const args: t.Expression[] = [
        gen,
        t.thisExpression(),
        !isArrow || info.usesArguments ? id('arguments') : t.nullLiteral(),
        num(meta.id),
      ];
      body = t.blockStatement([t.returnStatement(call('async', args))], directives);
      fn.async = false;
    }
    fn.body = body;

    if (t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn)) {
      const args: t.Expression[] = [num(meta.id), fn, id(ctx.frame)];
      if (info.specName) args.push(t.stringLiteral(info.specName));
      return call('fn', args);
    }
    return fn;
  };

  function walk(node: t.Node, ctx: Ctx): t.Node {
    if (!node || typeof node !== 'object') return node;
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ObjectMethod':
      case 'ClassMethod':
      case 'ClassPrivateMethod':
        return transformFunction(node, ctx);
      case 'StaticBlock':
        return node;
      case 'BlockStatement':
        node.body = list(node.body, ctx);
        return node;
      case 'SwitchCase':
        if (node.test) node.test = walk(node.test, ctx) as t.Expression;
        node.consequent = list(node.consequent, ctx);
        return node;
      case 'IfStatement':
        node.test = walk(node.test, ctx) as t.Expression;
        node.consequent = walk(blockify(node.consequent), ctx) as t.Statement;
        if (node.alternate) node.alternate = walk(blockify(node.alternate), ctx) as t.Statement;
        return node;
      case 'ForStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const body = blockify(node.body);
        node.body = t.emptyStatement();
        walkChildren(node, ctx);
        const wb = walk(body, ctx) as t.BlockStatement;
        wb.body.unshift(t.expressionStatement(call('g', [])));
        node.body = wb;
        return node;
      }
      case 'LabeledStatement':
        node.body = walk(t.isLoop(node.body) ? node.body : blockify(node.body), ctx) as t.Statement;
        return node;
      case 'ReturnStatement': {
        const arg = node.argument ? (walk(node.argument, ctx) as t.Expression) : undef();
        const meta = stmtMetaOf.get(node);
        if (ctx.finallyDepth > 0) node.argument = call('rv', [id(ctx.frame), arg]);
        else {
          const r = meta ? readerExpr(readerOf.get(meta.id)) : null;
          node.argument = call('r', [id(ctx.frame), arg, num(meta ? meta.id : -2), ...(r ? [r] : [])]);
        }
        return node;
      }
      case 'TryStatement': {
        const inner = node.finalizer ? { ...ctx, finallyDepth: ctx.finallyDepth + 1 } : ctx;
        node.block = walk(node.block, inner) as t.BlockStatement;
        if (node.handler) node.handler = walk(node.handler, inner) as t.CatchClause;
        if (node.finalizer) node.finalizer = walk(node.finalizer, ctx) as t.BlockStatement;
        return node;
      }
      case 'CatchClause': {
        if (!node.param) node.param = id('__err');
        node.body = walk(node.body, ctx) as t.BlockStatement;
        const errArg = t.isIdentifier(node.param) ? id(node.param.name) : undef();
        node.body.body.unshift(t.expressionStatement(call('c', [id(ctx.frame), errArg])));
        return node;
      }
      case 'AwaitExpression': {
        const arg = walk(node.argument, ctx) as t.Expression;
        return t.yieldExpression(call('aw', [id(ctx.frame), arg]));
      }
      case 'YieldExpression': {
        const arg = node.argument ? (walk(node.argument, ctx) as t.Expression) : undef();
        return call('yr', [id(ctx.frame), t.yieldExpression(call('ys', [id(ctx.frame), arg]), node.delegate)]);
      }
      default:
        walkChildren(node, ctx);
        return node;
    }
  }

  const progCtx: Ctx = { fnId: 0, frame: '__f0', inAsync: false, inGenerator: false, finallyDepth: 0 };
  const body = list(ast.program.body, progCtx);
  const exitReader = readerExpr(exitReaderOf.get(0));
  const programBody: t.Statement[] = [
    t.variableDeclaration('const', [t.variableDeclarator(id('__f0'), call('e', [num(0), t.nullLiteral(), t.arrayExpression([])]))]),
    ...body,
    t.expressionStatement(call('r', [id('__f0'), undef(), num(-1), ...(exitReader ? [exitReader] : [])])),
  ];
  // Global-code mode: the block keeps let/const/class out of the shared global lexical scope.
  ast.program.body = opts.wrapProgram ? [t.blockStatement(programBody)] : programBody;

  const out = generate(ast.program, { comments: false }).code;
  return { ok: true, code: out, meta: { functions, statements, exitVars }, diagnostics: [] };
}

/** Lines that contain at least one traceable statement (valid breakpoint targets). */
export function breakpointLines(meta: ProgramMeta): Set<number> {
  return new Set(meta.statements.map((s) => s.line));
}
