import { Cons, cons } from "./linkedlist";
import { Monad, monad } from "@funkia/jabz";
import { Observer, State, Reactive, Time } from "./common";

import { Future, BehaviorFuture } from "./future";
import * as F from "./future";
import { Stream } from "./stream";

/**
 * A behavior is a value that changes over time. Conceptually it can
 * be thought of as a function from time to a value. I.e. `type
 * Behavior<A> = (t: Time) => A`.
 */
export type SemanticBehavior<A> = (time: Time) => A;

@monad
export abstract class Behavior<A> extends Reactive<A> implements Observer<A>, Monad<A> {
  // Push behaviors cache their last value in `last`.
  // Pull behaviors do not use `last`.
  last: A;
  nrOfListeners: number;
  parents: Cons<Reactive<any>>;
  child: Observer<any>;
  // The streams and behaviors that this behavior depends upon
  dependencies: Cons<Reactive<any>>;
  // Amount of nodes that wants to pull the behavior without actively
  // listening for updates
  nrOfPullers: number;

  constructor() {
    super();
    this.nrOfPullers = 0;
  }
  map<B>(fn: (a: A) => B): Behavior<B> {
    return new MapBehavior<A, B>(this, fn);
  }
  mapTo<A>(v: A): Behavior<A> {
    return new ConstantBehavior(v);
  }
  static of<A>(v: A): Behavior<A> {
    return new ConstantBehavior(v);
  }
  of<A>(v: A): Behavior<A> {
    return new ConstantBehavior(v);
  }
  ap<B>(f: Behavior<(a: A) => B>): Behavior<B> {
    return new ApBehavior<A, B>(f, this);
  }
  lift<T1, R>(f: (t: T1) => R, m: Behavior<T1>): Behavior<R>;
  lift<T1, T2, R>(f: (t: T1, u: T2) => R, m1: Behavior<T1>, m2: Behavior<T2>): Behavior<R>;
  lift<T1, T2, T3, R>(f: (t1: T1, t2: T2, t3: T3) => R, m1: Behavior<T1>, m2: Behavior<T2>, m3: Behavior<T3>): Behavior<R>;
  lift(/* arguments */): any {
    // TODO: Experiment with faster specialized `lift` implementation
    const f = arguments[0];
    switch (arguments.length - 1) {
      case 1:
        return arguments[1].map(f);
      case 2:
        return arguments[2].ap(arguments[1].map((a: any) => (b: any) => f(a, b)));
      case 3:
        return arguments[3].ap(arguments[2].ap(arguments[1].map(
          (a: any) => (b: any) => (c: any) => f(a, b, c)
        )));
    }
  }
  static multi: boolean = true;
  multi: boolean = true;
  chain<B>(fn: (a: A) => Behavior<B>): Behavior<B> {
    return new ChainBehavior<A, B>(this, fn);
  }
  flatten: <B>() => Behavior<B>;
  at(): A {
    return this.state === State.Push ? this.last : this.pull();
  }
  push(a: any): void {
    this.last = this.pull();
    this.child.push(this.last);
  }
  pull(): A {
    return this.last;
  }
  activate(): void {
    throw new Error("The behavior can't activate");
  }
  deactivate(): void {
    throw new Error("The behavior can't deactivate");
  }
  changePullers(n: number): void {
    this.nrOfPullers += n;
  }
  semantic(): SemanticBehavior<A> {
    throw new Error("The behavior does not have a semantic representation");
  }
  log(prefix?: string): Behavior<A> {
    this.subscribe(a => console.log(`${prefix || ""} ${a}`));
    return this;
  }
}

function addListenerParents(
  child: Observer<any>, parents: Cons<Reactive<any>>, state: State
): State {
  const parentState = parents.value.addListener(child);
  const newState = parentState !== State.Push ? parentState : state;
  if (parents.tail !== undefined) {
    return addListenerParents(child, parents.tail, newState);
  } else {
    return newState;
  }
}

function removeListenerParents(
  child: Observer<any>, parents: Cons<Reactive<any>>
): void {
  parents.value.removeListener(child);
  if (parents.tail !== undefined) {
    removeListenerParents(child, parents.tail);
  }
}

function changePullersParents(n: number, parents: Cons<Reactive<any>>): void {
  if (isBehavior(parents.value)) {
    parents.value.changePullers(n);
  }
  if (parents.tail !== undefined) {
    changePullersParents(n, parents.tail);
  }
}

export abstract class StatelessBehavior<A> extends Behavior<A> {
  activate(): void {
    this.state = addListenerParents(this, this.parents, State.Push);
    if (this.state === State.Push) {
      this.last = this.pull();
    }
  }
  deactivate(): void {
    removeListenerParents(this, this.parents);
    this.state = State.Inactive;
  }
  changePullers(n: number): void {
    this.nrOfPullers += n;
    changePullersParents(n, this.parents);
  }
}

/** Behaviors that are always active */
export abstract class StatefulBehavior<A> extends Behavior<A> {
  activate(): void {
    // noop, behavior is always active
  }
  deactivate(): void { }
}

export abstract class ProducerBehavior<A> extends Behavior<A> {
  push(a: A): void {
    this.last = a;
    if (this.state === State.Push) {
      this.child.push(a);
    }
  }
  changePullers(n: number): void {
    this.nrOfPullers += n;
    if (this.nrOfPullers === 1 && this.state === State.Inactive) {
      this.state = State.Pull;
      this.activateProducer();
    } else if (this.nrOfPullers === 0 && this.state === State.Pull) {
      this.deactivateProducer();
    }
  }
  activate(): void {
    if (this.state === State.Inactive) {
      this.activateProducer();
    }
    this.state = State.Push;
  }
  deactivate(): void {
    if (this.nrOfPullers === 0) {
      this.state = State.Inactive;
      this.deactivateProducer();
    } else {
      this.state = State.Pull;
    }
  }
  abstract activateProducer(): void;
  abstract deactivateProducer(): void;
}

export type ProducerBehaviorFunction<A> = (push: (a: A) => void) => () => void;

class ProducerBehaviorFromFunction<A> extends ProducerBehavior<A> {
  constructor(private activateFn: ProducerBehaviorFunction<A>, private initial: A) {
    super();
    this.last = initial;
  }
  deactivateFn: () => void;
  activateProducer(): void {
    this.state = State.Push;
    this.deactivateFn = this.activateFn(this.push.bind(this));
  }
  deactivateProducer(): void {
    this.state = State.Inactive;
    this.deactivateFn();
  }
}

export function producerBehavior<A>(activate: ProducerBehaviorFunction<A>, initial: A): Behavior<A> {
  return new ProducerBehaviorFromFunction(activate, initial);
}

export class SinkBehavior<A> extends ProducerBehavior<A> {
  constructor(public last: A) {
    super();
  }
  push(a: A): void {
    if (this.last === a) {
      return;
    }
    this.last = a;
    if (this.state === State.Push) {
      this.child.push(a);
    }
  }
  pull(): A {
    return this.last;
  }
  activateProducer(): void {
  }
  deactivateProducer(): void {
  }
}

/**
 * Creates a behavior for imperative impure pushing.
 */
export function sinkBehavior<A>(initial: A): SinkBehavior<A> {
  return new SinkBehavior<A>(initial);
}

/**
 * Impure function that gets the current value of a behavior. For a
 * pure variant see `sample`.
 */
export function at<B>(b: Behavior<B>): B {
  return b.at();
}

export class ConstantBehavior<A> extends StatefulBehavior<A> {
  constructor(public last: A) {
    super();
    this.state = State.Push;
  }
  pull(): A {
    return this.last;
  }
  semantic(): SemanticBehavior<A> {
    return (_) => this.last;
  }
}

export class MapBehavior<A, B> extends StatelessBehavior<B> {
  constructor(
    private parent: Behavior<any>,
    private f: (a: A) => B
  ) {
    super();
    this.parents = cons(parent);
  }
  push(a: A): void {
    this.last = this.f(a);
    this.child.push(this.last);
  }
  pull(): B {
    return this.f(this.parent.at());
  }
  semantic(): SemanticBehavior<B> {
    const g = this.parent.semantic();
    return (t) => this.f(g(t));
  }
}

class ApBehavior<A, B> extends StatelessBehavior<B> {
  last: B;
  constructor(
    private fn: Behavior<(a: A) => B>,
    private val: Behavior<A>
  ) {
    super();
    this.parents = cons<any>(fn, cons(val));
  }
  push(): void {
    const fn = at(this.fn);
    const val = at(this.val);
    this.last = fn(val);
    this.child.push(this.last);
  }
  pull(): B {
    return at(this.fn)(at(this.val));
  }
}

/**
 * Apply a function valued behavior to a value behavior.
 *
 * @param fnB behavior of functions from `A` to `B`
 * @param valB A behavior of `A`
 * @returns Behavior of the function in `fnB` applied to the value in `valB`
 */
export function ap<A, B>(fnB: Behavior<(a: A) => B>, valB: Behavior<A>): Behavior<B> {
  return valB.ap(fnB);
}

class ChainOuter<A> extends Behavior<A> {
  constructor(public child: ChainBehavior<A, any>) {
    super();
  }
  push(a: A): void {
    this.child.pushOuter(a);
  }
}

class ChainBehavior<A, B> extends Behavior<B> {
  // The last behavior returned by the chain function
  private innerB: Behavior<B>;
  private outerConsumer: Observer<A>;
  constructor(
    private outer: Behavior<A>,
    private fn: (a: A) => Behavior<B>
  ) {
    super();
  }
  activate(): void {
    // Create the outer consumer
    this.outerConsumer = new ChainOuter(this);
    // Make the consumers listen to inner and outer behavior
    this.outer.addListener(this.outerConsumer);
    if (this.outer.state === State.Push) {
      this.innerB = this.fn(at(this.outer));
      this.innerB.addListener(this);
      this.state = this.innerB.state;
      this.last = at(this.innerB);
    }
  }
  pushOuter(a: A): void {
    // The outer behavior has changed. This means that we will have to
    // call our function, which will result in a new inner behavior.
    // We therefore stop listening to the old inner behavior and begin
    // listening to the new one.
    if (this.innerB !== undefined) {
      this.innerB.removeListener(this);
    }
    const newInner = this.innerB = this.fn(a);
    newInner.addListener(this);
    this.state = newInner.state;
    this.changeStateDown(this.state);
    if (this.state === State.Push) {
      this.push(newInner.at());
    }
  }
  push(b: B): void {
    this.last = b;
    this.child.push(b);
  }
  pull(): B {
    return this.fn(this.outer.at()).at();
  }
}

/** @private */
class FunctionBehavior<A> extends Behavior<A> {
  constructor(private fn: () => A) {
    super();
    this.state = State.OnlyPull;
  }
  pull(): A {
    return this.fn();
  }
  activate(): void { }
  deactivate(): void { }
}

/** @private */
class WhenBehavior extends Behavior<Future<{}>> {
  constructor(private parent: Behavior<boolean>) {
    super();
    this.push(at(parent));
  }
  push(val: boolean): void {
    if (val === true) {
      this.last = Future.of({});
    } else {
      this.last = new BehaviorFuture(this.parent);
    }
  }
  pull(): Future<{}> {
    return this.last;
  }
}

export function when(b: Behavior<boolean>): Behavior<Future<{}>> {
  return new WhenBehavior(b);
}

// FIXME: This can probably be made less ugly.
/** @private */
class SnapshotBehavior<A> extends Behavior<Future<A>> {
  private afterFuture: boolean;
  constructor(private parent: Behavior<A>, future: Future<any>) {
    super();
    if (future.occurred === true) {
      // Future has occurred at some point in the past
      this.afterFuture = true;
      this.state = parent.state;
      parent.addListener(this);
      this.last = Future.of(at(parent));
    } else {
      this.afterFuture = false;
      this.state = State.Push;
      this.last = F.sinkFuture<A>();
      future.listen(this);
    }
  }
  push(val: any): void {
    if (this.afterFuture === false) {
      // The push is coming from the Future, it has just occurred.
      this.afterFuture = true;
      this.last.resolve(at(this.parent));
      this.parent.addListener(this);
    } else {
      // We are receiving an update from `parent` after `future` has
      // occurred.
      this.last = Future.of(val);
    }
  }
  pull(): Future<A> {
    return this.last;
  }
}

export function snapshotAt<A>(
  b: Behavior<A>, f: Future<any>
): Behavior<Future<A>> {
  return new SnapshotBehavior(b, f);
}

/** @private */
class SwitcherBehavior<A> extends StatefulBehavior<A> {
  constructor(
    private b: Behavior<A>,
    next: Future<Behavior<A>> | Stream<Behavior<A>>
  ) {
    super();
    b.addListener(this);
    this.state = b.state;
    if (this.state === State.Push) {
      this.last = at(b);
    }
    // FIXME: Using `bind` is hardly optimal for performance.
    next.subscribe(this.doSwitch.bind(this));
  }
  push(val: A): void {
    this.last = val;
    if (this.child !== undefined) {
      this.child.push(val);
    }
  }
  pull(): A {
    return at(this.b);
  }
  private doSwitch(newB: Behavior<A>): void {
    this.b.removeListener(this);
    this.b = newB;
    newB.addListener(this);
    const newState = newB.state;
    if (newState === State.Push) {
      this.push(newB.at());
    }
    this.state = newState;
    if (this.child !== undefined) {
      this.child.changeStateDown(this.state);
    }
  }
  changeStateDown(state: State): void {
    if (this.child !== undefined) {
      this.child.changeStateDown(state);
    }
  }
}

/**
 * From an initial behavior and a future of a behavior, `switcher`
 * creates a new behavior that acts exactly like `initial` until
 * `next` occurs, after which it acts like the behavior it contains.
 */
export function switchTo<A>(
  init: Behavior<A>,
  next: Future<Behavior<A>>
): Behavior<A> {
  return new SwitcherBehavior(init, next);
}

export function switcher<A>(
  init: Behavior<A>, stream: Stream<Behavior<A>>
): Behavior<Behavior<A>> {
  return fromFunction(() => new SwitcherBehavior(init, stream));
}

/** @private */
class StepperBehavior<B> extends Behavior<B> {
  constructor(initial: B, private steps: Stream<B>) {
    super();
    this.last = initial;
  }
  activate(): void {
    this.state = State.Push;
    this.steps.addListener(this);
  }
  deactivate(): void {
    this.steps.removeListener(this);
  }
  push(val: B): void {
    this.last = val;
    this.child.push(val);
  }
}

/**
 * Creates a Behavior whose value is the last occurrence in the stream.
 * @param initial - the initial value that the behavior has
 * @param steps - the stream that will change the value of the behavior
 */
export function stepper<B>(initial: B, steps: Stream<B>): Behavior<B> {
  return new StepperBehavior(initial, steps);
}

/** @private */
class ScanBehavior<A, B> extends StatefulBehavior<B> {
  constructor(
    initial: B,
    private fn: (a: A, b: B) => B,
    private source: Stream<A>
  ) {
    super();
    this.state = State.Push;
    this.last = initial;
    source.addListener(this);
  }
  push(val: A): void {
    this.last = this.fn(val, this.last);
    if (this.child) {
      this.child.push(this.last);
    }
  }
}

export function scan<A, B>(fn: (a: A, b: B) => B, init: B, source: Stream<A>): Behavior<Behavior<B>> {
  return fromFunction(() => new ScanBehavior(init, fn, source));
}

export function toggle(
  initial: boolean, turnOn: Stream<any>, turnOff: Stream<any>
): Behavior<boolean> {
  return stepper(initial, turnOn.mapTo(true).combine(turnOff.mapTo(false)));
}

export function fromFunction<B>(fn: () => B): Behavior<B> {
  return new FunctionBehavior(fn);
}

export function isBehavior(b: any): b is Behavior<any> {
  return typeof b === "object" && ("at" in b);
}

class TestBehavior<A> extends Behavior<A> {
  constructor(private semanticBehavior: SemanticBehavior<A>) {
    super();
  }
  semantic(): SemanticBehavior<A> {
    return this.semanticBehavior;
  }
}

export function testBehavior<A>(b: SemanticBehavior<A>): Behavior<A> {
  return new TestBehavior(b);
}

class TimeFromBehavior extends Behavior<Time> {
  private startTime: Time;
  constructor() {
    super();
    this.startTime = Date.now();
    this.state = State.Pull;
  }
  pull(): Time {
    return Date.now() - this.startTime;
  }
}

class TimeBehavior extends FunctionBehavior<Time> {
  constructor() {
    super(Date.now);
  }
  semantic(): SemanticBehavior<Time> {
    return (time: Time) => time;
  }
}

/**
 * A behavior whose value is the number of milliseconds elapsed in
 * UNIX epoch. I.e. its current value is equal to the value got by
 * calling `Date.now`.
 */
export const time: Behavior<Time> = new TimeBehavior();

/**
 * A behavior giving access to continuous time. When sampled the outer
 * behavior gives a behavior with values that contain the difference
 * between the current sample time and the time at which the outer
 * behavior was sampled.
 */
export const timeFrom: Behavior<Behavior<Time>>
  = fromFunction(() => new TimeFromBehavior());

class IntegrateBehavior extends Behavior<number> {
  private lastPullTime: Time;
  private value: number;
  constructor(private parent: Behavior<number>) {
    super();
    this.lastPullTime = Date.now();
    this.state = State.Pull;
    this.value = 0;
  }
  pull(): Time {
    const currentPullTime = Date.now();
    const deltaSeconds = (currentPullTime - this.lastPullTime) / 1000;
    this.value += deltaSeconds * at(this.parent);
    this.lastPullTime = currentPullTime;
    return this.value;
  }
}

export function integrate(behavior: Behavior<number>): Behavior<Behavior<number>> {
  return fromFunction(() => new IntegrateBehavior(behavior));
}
