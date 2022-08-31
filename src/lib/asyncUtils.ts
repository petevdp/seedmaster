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
  tap,
  mergeAll,
  scan,
  toArray,
  combineLatestAll,
  map,
  distinctUntilChanged,
  filter
} from 'rxjs/operators';
import { isNonNulled, isTruthy, ReadOnlyMap } from './typeUtils';


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
export class Future<T> implements Promise<T> {
  public resolve: Resolve<T>;
  public reject: Reject;
  public fulfilled: boolean = false;
  private promise: Promise<T>;
  public then: Promise<T>['then'];
  public catch: Promise<T>['catch'];
  public finally: Promise<T>['finally'];


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

    this.then = ((...args: any[]) => this.promise.then(...args)) as typeof this.promise.then;
    this.catch = ((...args: any[]) => this.promise.catch(...args)) as typeof this.promise.catch;
    this.finally = ((...args: any[]) => this.promise.finally(...args)) as typeof this.promise.finally;
  }

  get [Symbol.toStringTag]() {
    return 'FUTURREEEEEE WOOOO SPOOOOOKYYYY';
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
    o.pipe(
      scan((map, change) => {
        let changed = false;
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
      }, new Map<K, T>())
    );
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

export function auditChanges<T>(getKey: (elt: T) => string) {
  return (o: Observable<ChangeLike<T>>): Observable<ChangeLike<T>> => {
    const keys = new Set<string>();
    return o.pipe(
      tap((change) => {
        const key = getKey(change.elt);
        switch (change.type) {
          case 'added':
            if (keys.has(key)) throw new ChangeError(`Added Duplicate element with key ${key}`, change);
            keys.add(key);
            break;
          case 'removed':
            if (!keys.has(key)) throw new ChangeError(`Removed non existant element with key ${key}`, change);
            keys.delete(key);
            break;
        }
      })
    );
  };
}

export type AddResource<T> = {
  type: 'added';
  elt: T;
}

export type UpdateResource<K, E, R> = {
  type: 'updated';
  edit: (elt: R) => E;
  key: K;
};

export type RemoveResource<K> = {
  type: 'removed';
  key: K;
};


export type ResourceChange<T, K, E, R> =
  AddResource<T>
  | UpdateResource<K, E, R>
  | RemoveResource<K>

// function filterResourceChangeType<T,K,E>(type: ResourceChange<T,K,E>['type']) {
//   return (o: Observable<>)
// }
