import { BehaviorSubject, from, Observable, Subject } from 'rxjs';
import {
  catchError,
  combineLatestAll,
  concatMap,
  distinctUntilChanged,
  filter, first,
  mergeAll,
  scan,
  share,
  startWith
} from './rxOperators';
import { Future } from './future';
import { map } from './rxOperators';
import { isNonNulled } from './typeUtils';


export class AlreadyFulfilledError extends Error {
  constructor() {
    super('This promise has already been fi');
  }
}


// export type DeferredSubject<T> = Promise<Subject<T>>;
export type DeferredBehaviorSubject<T> = Promise<BehaviorSubject<T>>;
export type FutureBehaviorSubject<T> = Future<BehaviorSubject<T>>;


export type Change<T> = {
  elt: T;
  type: 'added' | 'removed' | 'updated';
}

export type TimedChange<T> = Change<T> & { time: Date };

export function flattenDeferred<T, O extends Observable<T>>(promise: Promise<O>): O {
  return from(promise).pipe(mergeAll()) as unknown as O;
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

export function scanToMap<K, T>(getKey: (elt: T) => K) {
  return (o: Observable<T>): Observable<Map<K, T>> => {
    const eltMap = new Map<K, T>();
    return o.pipe(
      map((elt) => {
        eltMap.set(getKey(elt), elt);
        return eltMap;
      }, new Map<K, T>()),
      startWith(eltMap)
    );
  };
}

export function scanChangesToMap<K, T>(getKey: (elt: T) => K) {
  return (o: Observable<ChangeLike<T>>): Observable<Map<K, T>> => {
    const eltMap = new Map<K, T>();
    return o.pipe(
      map((change) => {
        let changed = false;
        switch (change.type) {
          case 'added':
          case 'updated':
            eltMap.set(getKey(change.elt), change.elt);
            changed = true;
            break;
          case 'removed':
            eltMap.delete(getKey(change.elt));
            changed = true;
            break;
        }
        return (changed) ? eltMap : null;
      }, new Map<K, T>()),
      filter(isNonNulled),
      startWith(eltMap)
    );
  };
}

export function scanChangesToSet<T>() {
  return (o: Observable<ChangeLike<T>>): Observable<Set<T>> => {
    const eltSet = new Set<T>();
    return o.pipe(
      map((change) => {
        let changed = false;
        switch (change.type) {
          case 'added':
            eltSet.add(change.elt);
            changed = true;
            break;
          case 'removed':
            eltSet.delete(change.elt);
            changed = true;
            break;
        }
        return changed ? eltSet : null;
      }),
      filter(isNonNulled),
      startWith(eltSet),
      share()
    );
  };
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

export type ChangeLike<T> = Change<T> | TimedChange<T>;

export function mapChange<T, O>(mapper: (elt: T) => O) {
  return (o: Observable<ChangeLike<T>>): Observable<ChangeLike<O>> =>
    o.pipe(map(change => ({ ...change, elt: mapper(change.elt) })));
}

export function getElt<T>(change: ChangeLike<T>): T {
  return change.elt;
}

export function noOP() {
}

export function changeOfType<T>(changeType: Change<T>['type']) {
  return (o: Observable<Change<T>>): Observable<T> =>
    o.pipe(
      map(change => changeType === change.type ? change.elt : null),
      filter(isNonNulled)
    );

}

export function toChange<T>(type: Change<T>['type']) {
  return (elt: T): Change<T> => ({
    type,
    elt
  });
}

export function countEntities<T>(getKey: (elt: T) => string) {
  return (o: Observable<Change<T>>): Observable<number> => {
    return o.pipe(
      auditChanges(getKey),
      scan((count, change) => {
        if (change.type === 'added') return count + 1;
        if (change.type === 'removed') return count - 1;
        return count;
      }, 0),
      distinctUntilChanged()
    );
  };
}


export class ChangeError<T> extends Error {
  constructor(msg: string, change: ChangeLike<T>) {
    super(msg);
  }
}

export function auditChanges<T, K, C extends ChangeLike<T>>(getKey: (elt: T) => K) {
  return (o: Observable<C>): Observable<C> => {
    const keys = new Set<K>();
    return o.pipe(
      map((change) => {
        const key = getKey(change.elt);
        switch (change.type) {
          case 'added':
            if (keys.has(key)) throw new ChangeError(`Added Duplicate element with key ${key}`, change);
            keys.add(key);
            break;
          case 'removed':
            if (!keys.has(key)) throw new ChangeError(`Removed non existent element with key ${key}`, change);
            keys.delete(key);
            break;
        }
        return change;
      })
    );
  };
}


export function ignoreRedundantChange<T, K, C extends ChangeLike<T>>(getKey: (elt: T) => K) {
  return (o: Observable<C>): Observable<C> => {
    const keys = new Set<K>();
    return o.pipe(
      map((change): C | null => {
        const key = getKey(change.elt);
        const keySeen = keys.has(key);
        switch (change.type) {
          case 'added': {
            if (keySeen) return null;
            keys.add(key);
            return change;
          }
          case 'removed': {
            if (!keySeen) return null;
            keys.delete(key);
            return change;
          }
          case 'updated': {
            return change;
          }
        }
      }),
      filter(isNonNulled)
    );
  };
}

/**
 * A subject that explicitely tracks its dependant observables, and completes when none are left.
 * Will only work when dependent observables are using a non-sync scheduler
 */
export class DependentSubject<T> {
  private _subject = new Subject<T>();
  private observeCount = 0;

  public addDependency(o: Observable<T>) {
    this.observeCount++;

    const sub = o.subscribe({
      next: (elt) => this.subject.next(elt),
      error: (err) => this.subject.error(err),
      complete: () => {
        this.observeCount--;
        if (this.observeCount === 0) this.subject.complete();
      }
    });


    this.subject.subscribe({
      complete: () => sub.unsubscribe()
    });
  }

  public get observable() {
    return this.subject as Observable<T>;
  }

  protected get subject() {
    return this._subject;
  }
}


export interface BehaviorObservable<T> extends Observable<T> {
  value: T;
}

export async function getFirstAfterDeferred<T>(deferredSubject: Promise<Observable<T>>): Promise<T> {
  return (await deferredSubject).pipe(first()).toPromise() as Promise<T>
}


export function catchErrorsOfClass<T>(errorType: Error['constructor']) {
  return (observable: Observable<T>): Observable<T> => observable.pipe(catchError((err, innerObservable) => {
    if (err instanceof errorType) return innerObservable;
    throw err;
  }));
}

export function isDeferred<T>(elt: any): elt is Promise<T> | Future<T> {
  return (elt instanceof  Promise) || (elt instanceof Future);
}
