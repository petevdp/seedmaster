import {
  BehaviorSubject,
  concatMap,
  EMPTY,
  from,
  Observable,
  ObservableInput,
  of, Subject
} from 'rxjs';
import {
  first,
  mergeAll,
  scan,
  toArray,
  combineLatestAll,
  map
} from 'rxjs/operators';
import { Change, getScanned, TimedChange } from './manageSeeders';
import { ReadOnlyMap } from './typeUtils';


type Resolve<T> = (value: (T | PromiseLike<T>)) => void;
type Reject = (reason?: any) => void;

export class AlreadyFulfilledError extends Error {
  constructor() {
    super('This promise has already been fi');
  }
}

/**
 * A Promise that can be resolved or rejected externally
 */
export class Future<T> implements PromiseLike<T> {
  public resolve: Resolve<T>;
  public reject: Reject;
  public fulfilled: boolean = false;
  private promise: Promise<T>;
  public then: PromiseLike<T>['then'];


  constructor() {
    let _resolve: Resolve<T>;
    let _reject: Reject;

    this.promise = new Promise(
      (resolve, reject) => {
      _resolve = resolve;
      _reject = reject;
    });

    this.resolve = (value) => {
      if (this.fulfilled) throw new AlreadyFulfilledError();
      _resolve(value);
    };
    this.reject = (value: any) => {
      if (this.fulfilled) throw new AlreadyFulfilledError();
      _reject(value);
    };

    this.then = (...args) =>  this.promise.then(...args);
  }
}

// export type DeferredSubject<T> = Promise<Subject<T>>;
export type DeferredBehaviorSubject<T> = Promise<BehaviorSubject<T>>;
export type FutureBehaviorSubject<T> = Future<BehaviorSubject<T>>;

export function flattenDeferred<T, O extends Observable<T>>(promise: Promise<O>): O {
  return from(promise).pipe(mergeAll()) as unknown as O;
}

export async function getFirstAfterDeferred<T>(deferredSubject: DeferredBehaviorSubject<T>): Promise<T> {
  return (await deferredSubject).value;
}


/**
 * mutates set with accumulated change elements
 * @param set
 */
export function accumulateSet<T>(set: Set<T>) {
  return (change: Change<T>) => {
    switch (change.type) {
      case 'added':
        set.add(change.elt);
        break;
      case 'removed':
        set.delete(change.elt);
        break;
    }
  };
}

/**
 * mutates map with accumulated change elements
 * @param map
 * @param getKey
 */
export function accumulateMap<T, K>(map: Map<K, T>, getKey: (elt: T) => K) {
  return (change: Change<T>) => {
    const key = getKey(change.elt);
    switch (change.type) {
      case 'added':
      case 'updated':
        map.set(key, change.elt);
        break;
      case 'removed':
        map.delete(key);
        break;
    }
  };
}

/**
 * derive a many -> one change stream mapping where the resulting observable tracks elements which are currently present across all source observables
 */
export function trackUnifiedState<T>(predicates: boolean[]) {
  return (o: Observable<Observable<ChangeLike<T>>>) =>
    o.pipe(
      map(scanChangesToSet()),
      combineLatestAll(),
      map((sets) => {
        if (predicates.length !== sets.length) throw new Error('predicates not same length as input higher order observable');
        const allElts = sets.map(s => [...s]).flat();
        let matchedAll = new Set<T>();
        allElts.forEach((elt, idx) => {
          const matchesAllPredicates = !sets.some(m => m.has(elt) !== predicates[idx]);
          if (matchesAllPredicates) matchedAll.add(elt);
        });
        return matchedAll;
      }),
      trackSet()
    );
}

export function scanChangesToMap<K, T>(getKey: (elt: T) => K) {
  return (o: Observable<ChangeLike<T>>): Observable<ReadOnlyMap<K, T>> =>
    o.pipe(scan((map, change) => {
      switch (change.type) {
        case 'added':
        case 'updated':
          map.set(getKey(change.elt), change.elt);
          break;
        case 'removed':
          map.delete(getKey(change.elt));
          break;
      }
      return map;
    }, new Map<K, T>()));
}

export function scanChangesToSet<T>() {
  return (o: Observable<ChangeLike<T>>): Observable<Set<T>> =>
    o.pipe(scan((map, change) => {
      switch (change.type) {
        case 'added':
        case 'updated':
          map.add(change.elt);
          break;
        case 'removed':
          map.delete(change.elt);
          break;
      }
      return map;
    }, new Set<T>()));
}

export function trackSet<T>() {
  let prevSet: Set<T> = new Set();
  return (o: Observable<Set<T>>): Observable<Change<T>> =>
    o.pipe(concatMap((currSet) => {
      const changes: Change<T>[] = [];
      for (let key of currSet) {
        if (!prevSet.has(key)) {
          changes.push({
            type: 'added',
            elt: key
          });
        }
      }
      for (let key of prevSet) {
        if (!currSet.has(key)) {
          changes.push({
            type: 'removed',
            elt: key
          });
        }
      }
      return from(changes);
    }));
}

type ChangeLike<T> = Change<T> | TimedChange<T>;

export function mapChange<T, O>(mapper: (elt: T) => O) {
  return (o: Observable<ChangeLike<T>>): Observable<ChangeLike<O>> =>
    o.pipe(map(change => ({ ...change, elt: mapper(change.elt) })));
}

export function getElt<T>(change: ChangeLike<T>): T {
  return change.elt;
}

export function noOP() {
}
